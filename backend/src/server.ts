import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import * as audioProcessor from './services/audioProcessor.js';
import * as whisperService from './services/whisperService.js';
import * as tts from './services/ttsService.js';
import * as llm from './services/llmService.js';
import * as brain from './services/brainClient.js';
import { Call, note } from './services/call.js';
import type { Timeline } from './services/timeline.js';
import {
  installLogBridge,
  subscribeToSessionLogs,
  runInSession,
} from './services/logBridge.js';
import {
  Limiter,
  clientIp,
  tokenMatches,
  trustProxyFromEnv,
} from './services/limits.js';
import {
  DEFAULT_MAX_AUDIO_BYTES,
  conversationKey,
} from './services/validate.js';

dotenv.config();

// Capture every console line so it can be mirrored to connected clients.
installLogBridge();

/** The .env.example placeholder counts as unset. */
function hasGroqKey(): boolean {
  const key = process.env.GROQ_API_KEY;
  return !!key && key !== 'your_groq_api_key_here';
}

const limiter = new Limiter();
/** How many proxies sit in front of us (Render: 1). 0 means ignore X-Forwarded-For. */
const TRUST_PROXY_HOPS = trustProxyFromEnv();
/** Optional shared secret. Unset means the demo is open, as before. */
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES) > 0
  ? Number(process.env.MAX_AUDIO_BYTES)
  : DEFAULT_MAX_AUDIO_BYTES;
/** Idle rate-limit state is dropped this often so the maps cannot grow forever. */
const LIMITER_SWEEP_MS = 5 * 60_000;
setInterval(() => limiter.sweep(), LIMITER_SWEEP_MS).unref();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

app.use(
  cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true })
);
app.use(express.json());

app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    llmProvider: llm.activeProvider(),
    ttsProvider: tts.activeTtsProvider(),
    groqKey: hasGroqKey() ? 'configured' : 'missing (set GROQ_API_KEY)',
    turnsToday: limiter.turnsToday(),
  });
});

// ---------------------------------------------------------------------------

const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  maxHttpBufferSize: 10 * 1024 * 1024,
});

// Gate and rate-limit connections before a session exists, so a refused client
// costs nothing. Rejections reach the browser as `connect_error` with the text.
io.use((socket, next) => {
  if (ACCESS_TOKEN && !tokenMatches(ACCESS_TOKEN, socket.handshake.auth?.token)) {
    console.warn('⛔ connection refused: bad or missing access token');
    return next(new Error('Access token required'));
  }

  const ip = clientIp(
    socket.handshake.address,
    socket.handshake.headers['x-forwarded-for'],
    TRUST_PROXY_HOPS
  );
  const decision = limiter.checkConnect(ip);
  if (!decision.allowed) {
    console.warn(`⛔ connection refused for ${ip}: ${decision.scope}`);
    return next(new Error(decision.message));
  }

  socket.data.ip = ip;
  const release = limiter.open(ip);
  socket.on('disconnect', release);
  next();
});

/** Per-process scratch space for uploaded clips; never the working directory. */
const UPLOAD_DIR = path.join(os.tmpdir(), 'voice-agent-uploads');
const STT_TIMEOUT_MS = 20_000;
/** Reject if a stage hangs, so one bad call cannot wedge the conversation. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Compact, timestamped event log for both directions of the socket.
 *
 * Lines are mirrored to the client over `debug:trace` so a single exported
 * diagnostic file contains both halves of the conversation, interleaved.
 * Without that, debugging a timing problem means correlating two logs by hand.
 */
function traceFactory(socketId: string) {
  const short = socketId.slice(0, 6);
  return (direction: '<-' | '->', event: string, detail?: string) => {
    console.log(`[${short}] ${direction} ${event}${detail ? ` ${detail}` : ''}`);
  };
}

io.on('connection', (socket: Socket) => {
  // Bind the raw emitter first: the log bridge uses it, and the wrapper below
  // logs — going through the wrapper would recurse.
  const rawEmit = socket.emit.bind(socket);
  const ip = String(socket.data.ip ?? 'unknown');
  const trace = traceFactory(socket.id);
  /** What the brain files this call's history under; survives a reconnect. */
  const threadId = conversationKey(socket.handshake.auth?.sessionId, socket.id);

  // Tell the page which model path it is on. Sent over the socket rather than
  // left for the page to fetch from /health: the socket is websocket-only and so
  // never subject to CORS, whereas /health is, and a CLIENT_URL that does not
  // match the page's domain (a trailing slash, or the old domain) silently hid it.
  rawEmit('server:info', { llmProvider: llm.activeProvider() });

  // Everything this process prints, from here or from any service, goes to the
  // client so one exported file holds both halves of the conversation.
  // Scoped to this socket: the process is shared, and mirroring every line to
  // every client would show one caller another's transcripts and replies.
  const unsubscribeLogs = subscribeToSessionLogs(socket.id, (line) => {
    rawEmit('debug:trace', { level: line.level, text: line.text });
  });

  // Event handlers run in whatever context emitted the packet, not the one
  // that registered them, so tag each handler's execution with this session.
  const registerOn = socket.on.bind(socket);
  socket.on = ((event: string, handler: (...args: unknown[]) => unknown) =>
    registerOn(event, (...args: unknown[]) =>
      runInSession(socket.id, () => handler(...args))
    )) as typeof socket.on;

  runInSession(socket.id, () => console.log(`🔌 Client connected: ${socket.id}`));

  // Log every outbound event. Audio payloads are summarised, not dumped.
  socket.emit = ((event: string, payload?: Record<string, unknown>) => {
    let detail = '';
    if (payload && typeof payload === 'object') {
      const audio = payload.audio as ArrayBuffer | Buffer | undefined;
      const parts = Object.entries(payload)
        .filter(([key]) => key !== 'audio')
        .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value.slice(0, 48)) : JSON.stringify(value)}`);
      if (audio) parts.push(`audio=${(audio as { byteLength?: number; length?: number }).byteLength ?? (audio as Buffer).length}B`);
      detail = parts.join(' ');
    }
    trace('->', event, detail);
    return rawEmit(event, payload as never);
  }) as typeof socket.emit;

  socket.onAny((event: string, payload?: Record<string, unknown>) => runInSession(socket.id, () => {
    const audio = payload?.audio as ArrayBuffer | undefined;
    const parts = payload
      ? Object.entries(payload)
          .filter(([key]) => key !== 'audio')
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      : [];
    if (audio) parts.push(`audio=${audio.byteLength}B`);
    trace('<-', event, parts.join(' '));
    call.progress();
  }));
  // The call itself lives in services/call.ts; this wires its ports to the real
  // services and the socket.
  /** Transcribe a recorded blob. Returns null if nothing usable was heard. */
  const transcribe = async (
    audio: Buffer,
    timeline?: Timeline,
    trimStartMs = 0
  ): Promise<{ text: string; ms: number } | null> => {
    const tempPath = path.join(
      UPLOAD_DIR,
      `input_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`
    );
    // May be the input itself when no trim is needed, so only clean up a
    // genuinely separate file.
    let preparedPath: string | null = null;
    const startedAt = Date.now();

    try {
      await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
      await fs.promises.writeFile(tempPath, audio);
      preparedPath = await audioProcessor.prepareForTranscription(tempPath, trimStartMs);
      timeline?.mark('audio prepared');

      const result = await withTimeout(
        whisperService.transcribeAudioToText(preparedPath),
        STT_TIMEOUT_MS,
        'Transcription'
      );
      timeline?.mark('transcribed');

      const text = result.text?.trim();
      const ms = Date.now() - startedAt;
      console.log(`🗣  transcript (${ms}ms): ${text ? JSON.stringify(text) : '<nothing heard>'}`);
      note('transcript', { ms, text: text ?? null, bytes: audio.byteLength });
      return text ? { text, ms } : null;
    } finally {
      if (preparedPath && preparedPath !== tempPath) {
        await audioProcessor.cleanupAudioFile(preparedPath);
      }
      await audioProcessor.cleanupAudioFile(tempPath);
    }
  };

  const call = new Call(
    {
      emit: (event, payload) => {
        socket.emit(event as never, payload as never);
      },
      transcribe,
      respond: ({ query, history, signal, resumeHint, onFinish }) =>
        llm.streamResponse(query, history, signal, resumeHint, onFinish, threadId),
      synthesize: (text, signal) => tts.synthesizeSpeechFromText(text, signal),
      // Only the brain keeps its own history, so only it needs telling.
      reportHeard: (spoken, unspoken) => {
        if (llm.activeProvider() === 'brain') brain.reportHeard(threadId, spoken, unspoken);
      },
      warmUp: () => {
        if (llm.activeProvider() === 'brain') brain.warmUp();
      },
      tryTurn: () => limiter.tryTurn(ip),
    },
    { id: socket.id, maxAudioBytes: MAX_AUDIO_BYTES }
  );


  socket.on('call:start', () => call.callStart());
  socket.on('barge:detected', (raw: unknown) => call.bargeDetected(raw));
  socket.on('barge:cancelled', (raw: unknown) => call.bargeCancelled(raw));
  socket.on('audio:input', (raw: unknown) => call.audioInput(raw));
  // The client heartbeat: the inbound-packet hook above already marks progress.
  socket.on('playback:progress', () => {});
  socket.on('playback:complete', (raw: unknown) => call.playbackComplete(raw));
  socket.on('call:end', () => call.callEnd());

  const watchdog = setInterval(() => runInSession(socket.id, () => call.watchdogTick()), 2000);

  socket.on('disconnect', () => {
    clearInterval(watchdog);
    call.disconnect();
    console.log(`🔌 Client disconnected: ${socket.id}`);
    // Last, so the line above still reaches the session's log.
    unsubscribeLogs();
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `🚀 Server on :${PORT} — LLM ${llm.activeProvider()} · TTS ${tts.activeTtsProvider()}`
  );
});
