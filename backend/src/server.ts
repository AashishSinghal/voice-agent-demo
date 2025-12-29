import express from 'express';
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
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// Serve audio files
app.use('/audio', express.static('uploads'));

// Health check endpoint
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

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Voice Agent Backend Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📍 Server running on: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🎤 Audio endpoint: POST http://localhost:${PORT}/api/process-audio`);
  console.log(`💬 Text endpoint: POST http://localhost:${PORT}/api/test-query`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
