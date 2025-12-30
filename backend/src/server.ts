import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as audioProcessor from './services/audioProcessor.js';
import * as whisperService from './services/whisperService.js';
import * as piperService from './services/piperService.js';
import { OllamaService } from './services/ollamaService.js';

// Load environment variables
dotenv.config();

// Initialize Ollama service with all FAQs
const ollamaService = new OllamaService();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

app.use('/audio', express.static('uploads'));

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      ollama: process.env.OLLAMA_HOST || 'http://localhost:11434',
      groq: 'configured',
      piper: 'configured',
    },
  });
});

// Test endpoint - accepts audio file and returns processed result
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  let convertedPath: string | null = null;
  let audioOutputPath: string | null = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const audioPath = req.file.path;
    console.log(`\n🎤 Processing audio file: ${req.file.originalname}`);
    console.log(`📊 File size: ${req.file.size} bytes`);

    // 1. Convert audio to WAV format (16kHz mono) for Whisper
    convertedPath = await audioProcessor.convertToWav(audioPath);

    // 2. Transcribe with Whisper
    const transcription = await whisperService.transcribeAudioToText(convertedPath);

    if (!transcription.text || transcription.text.trim().length === 0) {
      throw new Error('No speech detected in audio');
    }

    console.log(`📝 Transcription: "${transcription.text}"`);

    // 3. Generate response with LLM (includes all FAQs in system prompt)
    const response = await ollamaService.generateResponse(transcription.text, []);

    console.log(`💬 Response: "${response.text}"`);
    console.log(`🚪 Should Deflect: ${response.shouldDeflect}`);

    // 4. Synthesize speech with Piper (or use pre-generated for deflection)
    if (response.shouldDeflect) {
      // Use pre-generated deflection audio
      const preGeneratedPath = path.join('test-audio', 'default_response.wav');

      if (fs.existsSync(preGeneratedPath)) {
        console.log(`🔊 Using pre-generated deflection audio: ${preGeneratedPath}`);
        // Copy to uploads directory so it can be served
        audioOutputPath = path.join('uploads', `deflection_${Date.now()}.wav`);
        await fs.promises.copyFile(preGeneratedPath, audioOutputPath);
      } else {
        console.log(`🔊 Generating TTS for deflection (pre-generated not found)`);
        const audioResponse = await piperService.synthesizeSpeechFromText(response.text);
        audioOutputPath = path.join('uploads', `response_${Date.now()}.wav`);
        await fs.promises.writeFile(audioOutputPath, audioResponse);
      }
    } else {
      console.log(`🔊 Generating TTS response with Piper...`);
      const audioResponse = await piperService.synthesizeSpeechFromText(response.text);
      audioOutputPath = path.join('uploads', `response_${Date.now()}.wav`);
      await fs.promises.writeFile(audioOutputPath, audioResponse);
    }

    console.log(`✅ Audio processing complete\n`);

    await audioProcessor.cleanupAudioFile(audioPath);
    await audioProcessor.cleanupAudioFile(convertedPath);

    res.json({
      success: true,
      file: {
        originalName: req.file.originalname,
        size: req.file.size,
      },
      result: {
        transcription: {
          text: transcription.text,
          confidence: transcription.confidence,
        },
        response: {
          text: response.text,
          shouldDeflect: response.shouldDeflect,
          confidence: response.confidence,
          audioPath: `/audio/${path.basename(audioOutputPath)}`,
        },
      },
    });
  } catch (error) {
    console.error('❌ Error processing audio:', error);

    if (req.file?.path) {
      await audioProcessor.cleanupAudioFile(req.file.path);
    }
    if (convertedPath) {
      await audioProcessor.cleanupAudioFile(convertedPath);
    }
    if (audioOutputPath) {
      await audioProcessor.cleanupAudioFile(audioOutputPath);
    }

    res.status(500).json({
      error: 'Failed to process audio',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Test endpoint - simple text query (no audio)
app.post('/api/test-query', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'No query provided' });
    }

    console.log(`\n📝 Processing text query: "${query}"`);

    const response = await ollamaService.generateResponse(query, []);

    console.log(`💬 Response: "${response.text}"`);
    console.log(`🚪 Should Deflect: ${response.shouldDeflect}`);
    console.log(`✅ Response generated successfully\n`);

    res.json({
      success: true,
      query,
      result: {
        response: {
          text: response.text,
          shouldDeflect: response.shouldDeflect,
          confidence: response.confidence,
        },
      },
    });
  } catch (error) {
    console.error('Error processing query:', error);
    res.status(500).json({
      error: 'Failed to process query',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Initialize Socket.io
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for audio files
});

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log(`\n🔌 Client connected: ${socket.id}`);

  // Track conversation history for this socket
  const conversationHistory: any[] = [];

  // Handle call start - send greeting
  socket.on('call:start', async () => {
    console.log(`📞 Call started by client: ${socket.id}`);

    try {
      const greetingText = "Hello! Thank you for calling Wise customer support. How can I help you with your money transfer today?";

      // Add greeting to history
      conversationHistory.push({
        role: 'assistant',
        content: greetingText,
      });

      // Send greeting text
      socket.emit('response:text', {
        text: greetingText,
        isGreeting: true,
      });

      // Generate greeting audio
      socket.emit('processing:tts');
      const greetingAudio = await piperService.synthesizeSpeechFromText(greetingText);

      socket.emit('response:audio', {
        audio: greetingAudio,
        isGreeting: true,
      });

      // Signal that bot is ready for input
      socket.emit('ready:listening');

      console.log(`✅ Greeting sent to client\n`);
    } catch (error) {
      console.error('❌ Error sending greeting:', error);
      socket.emit('error', {
        message: 'Failed to send greeting',
      });
    }
  });

  // Handle incoming audio
  socket.on('audio:input', async (data: { audio: ArrayBuffer }) => {
    let convertedPath: string | null = null;
    const tempInputPath = path.join('uploads', `input_${Date.now()}.webm`);

    try {
      console.log(`\n🎤 Received audio from client: ${socket.id}`);
      console.log(`📊 Audio size: ${data.audio.byteLength} bytes`);

      // Emit processing start
      socket.emit('processing:start');

      // Save ArrayBuffer to file
      await fs.promises.writeFile(tempInputPath, Buffer.from(data.audio));

      // 1. Convert audio to WAV format
      convertedPath = await audioProcessor.convertToWav(tempInputPath);

      // 2. Transcribe with Whisper
      socket.emit('processing:stt');
      const transcription = await whisperService.transcribeAudioToText(convertedPath);

      if (!transcription.text || transcription.text.trim().length === 0) {
        socket.emit('error', { message: 'No speech detected' });
        return;
      }

      console.log(`📝 Transcription: "${transcription.text}"`);

      // Add user message to conversation history
      conversationHistory.push({
        role: 'user',
        content: transcription.text,
      });

      // Emit transcription to client
      socket.emit('transcription:complete', {
        text: transcription.text,
        confidence: transcription.confidence,
      });

      // 3. Generate response with LLM (with conversation history)
      socket.emit('processing:llm');
      const response = await ollamaService.generateResponse(transcription.text, conversationHistory);

      console.log(`💬 Response: "${response.text}"`);
      console.log(`🚪 Should Deflect: ${response.shouldDeflect}`);

      // Add assistant response to conversation history
      conversationHistory.push({
        role: 'assistant',
        content: response.text,
      });

      // Emit response text to client
      socket.emit('response:text', {
        text: response.text,
        shouldDeflect: response.shouldDeflect,
      });

      // 4. Synthesize speech with Piper
      socket.emit('processing:tts');
      console.log(`🔊 Generating TTS response...`);
      const audioResponse = await piperService.synthesizeSpeechFromText(response.text);

      console.log(`✅ Sending audio response to client\n`);

      // Send audio response back to client
      socket.emit('response:audio', {
        audio: audioResponse,
        shouldDeflect: response.shouldDeflect,
      });

      // If deflecting, end the call after audio finishes
      if (response.shouldDeflect) {
        console.log(`🚪 Deflection detected - ending call in 5 seconds...`);
        setTimeout(() => {
          socket.emit('call:end', {
            reason: 'deflection',
            message: 'Connecting you with a human agent...',
          });
          console.log(`📞 Call ended - deflection\n`);
        }, 5000); // Wait 5s for audio to play
      } else {
        // If not deflecting, signal bot is ready for next input after audio finishes
        // Estimate audio duration and wait for it to finish
        const estimatedDuration = Math.max(response.text.length * 50, 3000); // ~50ms per character, min 3s
        console.log(`⏱️ Waiting ${estimatedDuration}ms for audio to finish before listening again...`);
        setTimeout(() => {
          socket.emit('ready:listening');
          console.log(`👂 Bot ready to listen again\n`);
        }, estimatedDuration);
      }

      // Cleanup
      await audioProcessor.cleanupAudioFile(tempInputPath);
      if (convertedPath) {
        await audioProcessor.cleanupAudioFile(convertedPath);
      }

    } catch (error) {
      console.error('❌ Error processing audio:', error);

      // Cleanup on error
      if (tempInputPath) {
        await audioProcessor.cleanupAudioFile(tempInputPath);
      }
      if (convertedPath) {
        await audioProcessor.cleanupAudioFile(convertedPath);
      }

      // Send fallback error message with pre-generated audio
      const fallbackMessage = "I'm having some technical difficulties. Could you please try again?";

      try {
        // Send error message as text
        socket.emit('response:text', {
          text: fallbackMessage,
          shouldDeflect: false,
        });

        // Try to generate audio for the fallback message
        console.log(`🔊 Generating fallback TTS response...`);
        socket.emit('processing:tts');
        const fallbackAudio = await piperService.synthesizeSpeechFromText(fallbackMessage);

        socket.emit('response:audio', {
          audio: fallbackAudio,
          shouldDeflect: false,
        });

        // Ready to listen again after fallback message
        const estimatedDuration = fallbackMessage.length * 50;
        setTimeout(() => {
          socket.emit('ready:listening');
          console.log(`👂 Bot ready to listen again after error recovery\n`);
        }, estimatedDuration);

      } catch (ttsError) {
        // If even the fallback TTS fails, just send error to client
        console.error('❌ Fallback TTS also failed:', ttsError);
        socket.emit('error', {
          message: 'Failed to process audio',
          details: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}\n`);
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`\n🚀 Voice Agent Backend Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 Server running on: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🎤 Audio endpoint: POST http://localhost:${PORT}/api/process-audio`);
  console.log(`💬 Text endpoint: POST http://localhost:${PORT}/api/test-query`);
  console.log(`🔌 Socket.io: ws://localhost:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
