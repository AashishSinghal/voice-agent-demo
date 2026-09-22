import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import * as audioProcessor from './services/audioProcessor.js';
import * as whisperService from './services/whisperService.js';
import * as piperService from './services/piperService.js';
import * as llm from './services/llmService.js';
import { SentenceChunker } from './services/sentenceChunker.js';
import type { Message } from './models/types.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
app.use('/audio', express.static('uploads'));

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    llmProvider: llm.activeProvider(),
    services: {
      ollama: process.env.OLLAMA_HOST || 'http://localhost:11434',
      groq: process.env.GROQ_API_KEY ? 'configured' : 'missing',
      piper: process.env.PIPER_BIN || 'piper',
    },
  });
});

/** Collect a full (non-streamed) response — used by the REST test endpoints. */
async function generateComplete(query: string, history: Message[] = []) {
  const controller = new AbortController();
  let text = '';
  for await (const token of llm.streamResponse(query, history, controller.signal)) {
    text += token;
  }
  text = text.trim();
  return { text, shouldDeflect: llm.isDeflection(text) };
}

app.post('/api/test-query', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'No query provided' });

    const response = await generateComplete(query);
    res.json({ success: true, query, result: { response } });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to process query',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  let convertedPath: string | null = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    convertedPath = await audioProcessor.convertToWav(req.file.path);
    const transcription = await whisperService.transcribeAudioToText(convertedPath);

    if (!transcription.text?.trim()) throw new Error('No speech detected in audio');

    const response = await generateComplete(transcription.text);
    const audio = await piperService.synthesizeSpeechFromText(response.text);
    const audioOutputPath = path.join('uploads', `response_${Date.now()}.wav`);
    await fs.promises.writeFile(audioOutputPath, audio);

    await audioProcessor.cleanupAudioFile(req.file.path);
    await audioProcessor.cleanupAudioFile(convertedPath);

    res.json({
      success: true,
      result: {
        transcription: { text: transcription.text },
        response: { ...response, audioPath: `/audio/${path.basename(audioOutputPath)}` },
      },
    });
  } catch (error) {
    if (req.file?.path) await audioProcessor.cleanupAudioFile(req.file.path);
    if (convertedPath) await audioProcessor.cleanupAudioFile(convertedPath);
    res.status(500).json({
      error: 'Failed to process audio',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// Realtime pipeline
// ---------------------------------------------------------------------------

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024,
});

const GREETING =
  'Hello! Thank you for calling Wise customer support. How can I help you with your money transfer today?';

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Mutable state for one connected caller. */
interface CallSession {
  history: Message[];
  turnId: number;
  controller: AbortController | null;
}

io.on('connection', (socket: Socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  const session: CallSession = { history: [], turnId: 0, controller: null };

  /** Cancel whatever the agent is currently doing. */
  const cancelActiveTurn = (reason: string) => {
    if (!session.controller) return false;
    console.log(`✋ Cancelling turn ${session.turnId} (${reason})`);
    session.controller.abort();
    session.controller = null;
    return true;
  };

  /**
   * Streams one assistant response: LLM tokens out as they arrive, audio
   * synthesised and emitted per sentence so the caller hears the first
   * sentence while the rest is still being generated.
   */
  const speakStreaming = async (
    userText: string,
    turnId: number,
    signal: AbortSignal
  ): Promise<void> => {
    const startedAt = Date.now();
    const chunker = new SentenceChunker();
    let fullText = '';
    let firstTokenMs: number | null = null;
    let firstAudioMs: number | null = null;
    let chunkIndex = 0;

    const speak = async (chunk: string) => {
      if (signal.aborted) return;

      const audio = await piperService.synthesizeSpeechFromText(chunk, signal);
      if (signal.aborted) return;

      if (firstAudioMs === null) firstAudioMs = Date.now() - startedAt;

      socket.emit('response:audio:chunk', {
        turnId,
        index: chunkIndex++,
        text: chunk,
        audio,
      });
    };

    socket.emit('processing:llm', { turnId });

    for await (const token of llm.streamResponse(userText, session.history, signal)) {
      if (signal.aborted) return;

      if (firstTokenMs === null) {
        firstTokenMs = Date.now() - startedAt;
        socket.emit('processing:tts', { turnId });
      }

      fullText += token;
      socket.emit('response:text:delta', { turnId, token });

      for (const chunk of chunker.push(token)) {
        await speak(chunk);
      }
    }

    for (const chunk of chunker.flush()) {
      await speak(chunk);
    }

    if (signal.aborted) return;

    const text = fullText.trim();
    const shouldDeflect = llm.isDeflection(text);

    session.history.push({ role: 'assistant', content: text, timestamp: new Date() });

    const metrics = {
      firstTokenMs,
      firstAudioMs,
      totalMs: Date.now() - startedAt,
      chunks: chunkIndex,
    };

    console.log(
      `📊 turn ${turnId}: first token ${firstTokenMs}ms · first audio ${firstAudioMs}ms · ` +
        `total ${metrics.totalMs}ms · ${chunkIndex} chunks`
    );

    socket.emit('response:done', { turnId, text, shouldDeflect, metrics });

    if (shouldDeflect) {
      socket.emit('call:end', {
        reason: 'deflection',
        message: 'Connecting you with a human agent...',
      });
    }
  };

  socket.on('call:start', async () => {
    console.log(`📞 Call started: ${socket.id}`);
    session.history = [];
    session.turnId += 1;
    const turnId = session.turnId;

    const controller = new AbortController();
    session.controller = controller;

    try {
      session.history.push({ role: 'assistant', content: GREETING, timestamp: new Date() });

      socket.emit('response:text:delta', { turnId, token: GREETING });

      const audio = await piperService.synthesizeSpeechFromText(GREETING, controller.signal);
      if (controller.signal.aborted) return;

      socket.emit('response:audio:chunk', { turnId, index: 0, text: GREETING, audio });
      socket.emit('response:done', {
        turnId,
        text: GREETING,
        shouldDeflect: false,
        isGreeting: true,
        metrics: null,
      });
    } catch (error) {
      if (!isAbort(error)) {
        console.error('❌ Greeting failed:', error);
        socket.emit('error', { message: 'Failed to send greeting' });
      }
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  });

  socket.on('audio:input', async (data: { audio: ArrayBuffer }) => {
    // A new utterance supersedes anything still in flight.
    cancelActiveTurn('new user audio');

    session.turnId += 1;
    const turnId = session.turnId;
    const controller = new AbortController();
    session.controller = controller;

    const tempInputPath = path.join(
      'uploads',
      `input_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`
    );
    let convertedPath: string | null = null;

    try {
      socket.emit('processing:start', { turnId });
      await fs.promises.writeFile(tempInputPath, Buffer.from(data.audio));

      convertedPath = await audioProcessor.convertToWav(tempInputPath);
      if (controller.signal.aborted) return;

      socket.emit('processing:stt', { turnId });
      const transcription = await whisperService.transcribeAudioToText(convertedPath);
      if (controller.signal.aborted) return;

      if (!transcription.text?.trim()) {
        socket.emit('error', { message: 'No speech detected' });
        socket.emit('ready:listening', { turnId });
        return;
      }

      session.history.push({
        role: 'user',
        content: transcription.text,
        timestamp: new Date(),
      });
      socket.emit('transcription:complete', { turnId, text: transcription.text });

      await speakStreaming(transcription.text, turnId, controller.signal);
    } catch (error) {
      if (isAbort(error)) {
        console.log(`✋ Turn ${turnId} aborted`);
      } else {
        console.error('❌ Turn failed:', error);
        socket.emit('error', {
          message: error instanceof Error ? error.message : 'Processing failed',
        });
        socket.emit('ready:listening', { turnId });
      }
    } finally {
      if (session.controller === controller) session.controller = null;
      await audioProcessor.cleanupAudioFile(tempInputPath);
      if (convertedPath) await audioProcessor.cleanupAudioFile(convertedPath);
    }
  });

  /**
   * Barge-in: the caller started speaking over the agent. Stop generating and
   * stop synthesising immediately, and tell the client to drop queued audio.
   */
  socket.on('interrupt', () => {
    const cancelled = cancelActiveTurn('barge-in');
    socket.emit('turn:cancelled', { turnId: session.turnId, cancelled });
  });

  /**
   * The client has finished playing every queued chunk for this turn. This
   * replaces the old character-count timer, which guessed at playback length.
   */
  socket.on('playback:complete', (data: { turnId: number }) => {
    if (data?.turnId !== session.turnId) return; // stale turn, ignore
    socket.emit('ready:listening', { turnId: session.turnId });
  });

  socket.on('disconnect', () => {
    cancelActiveTurn('client disconnected');
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT} — LLM provider: ${llm.activeProvider()}`);
});
