import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import * as audioProcessor from './services/audioProcessor.js';
import * as whisperService from './services/whisperService.js';
import * as tts from './services/ttsService.js';
import * as llm from './services/llmService.js';
import { SentenceChunker } from './services/sentenceChunker.js';
import { classifyUtterance } from './services/backchannel.js';
import { Conversation } from './services/conversation.js';
import type { CallState, TurnMetrics } from './models/types.js';

dotenv.config();

/** The .env.example placeholder counts as unset. */
function hasGroqKey(): boolean {
  const key = process.env.GROQ_API_KEY;
  return !!key && key !== 'your_groq_api_key_here';
}

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

const GREETING = process.env.AGENT_GREETING || "Hey, I'm listening. What can I help you with?";
const STT_TIMEOUT_MS = 20_000;

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

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

interface Session {
  conversation: Conversation;
  turnId: number;
  controller: AbortController | null;
  state: CallState;
  /** Generated text for the turn currently being spoken, pending commit. */
  pendingText: string | null;
  pendingTurnId: number | null;
  /** Chunks the client had finished playing when it paused for a barge-in. */
  bargeChunksPlayed: number;
  /** Set when the caller asked the agent to carry on. */
  resumeHint: string | null;
}

io.on('connection', (socket: Socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  const session: Session = {
    conversation: new Conversation(),
    turnId: 0,
    controller: null,
    state: 'idle',
    pendingText: null,
    pendingTurnId: null,
    bargeChunksPlayed: 0,
    resumeHint: null,
  };

  const setState = (state: CallState) => {
    if (session.state === state) return;
    session.state = state;
    socket.emit('state', { state });
  };

  const abortActiveTurn = (reason: string) => {
    if (!session.controller) return;
    console.log(`✋ Aborting turn ${session.turnId} (${reason})`);
    session.controller.abort();
    session.controller = null;
  };

  /**
   * Generate and speak one response, streaming sentence by sentence so the
   * caller hears the opening while the rest is still being written.
   */
  const speak = async (
    query: string,
    turnId: number,
    signal: AbortSignal,
    sttMs: number | null
  ): Promise<void> => {
    const startedAt = Date.now();
    const chunker = new SentenceChunker();
    let fullText = '';
    let firstTokenMs: number | null = null;
    let firstAudioMs: number | null = null;
    let chunkIndex = 0;

    const resumeHint = session.resumeHint;
    session.resumeHint = null;

    const emitChunk = async (chunk: string) => {
      if (signal.aborted) return;

      const audio = await tts.synthesizeSpeechFromText(chunk, signal);
      if (signal.aborted) return;

      if (firstAudioMs === null) {
        firstAudioMs = Date.now() - startedAt;
        setState('speaking');
      }

      session.conversation.trackChunk(turnId, chunk);
      socket.emit('response:audio:chunk', { turnId, index: chunkIndex++, text: chunk, audio });
    };

    setState('thinking');

    for await (const token of llm.streamResponse(query, session.conversation.history(), signal, resumeHint)) {
      if (signal.aborted) return;

      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;

      fullText += token;
      socket.emit('response:text:delta', { turnId, token });

      for (const chunk of chunker.push(token)) await emitChunk(chunk);
    }

    for (const chunk of chunker.flush()) await emitChunk(chunk);
    if (signal.aborted) return;

    const text = fullText.trim();

    // The turn is NOT committed to history here. The caller may still interrupt
    // audio that is queued but unplayed, and history must record only what was
    // actually heard. Commit happens on playback:complete or on interrupt.
    session.pendingText = text;
    session.pendingTurnId = turnId;

    const metrics: TurnMetrics = {
      sttMs,
      firstTokenMs,
      firstAudioMs,
      totalMs: Date.now() - startedAt,
      chunks: chunkIndex,
    };

    console.log(
      `📊 turn ${turnId}: stt ${sttMs}ms · first token ${firstTokenMs}ms · ` +
        `first audio ${firstAudioMs}ms · total ${metrics.totalMs}ms · ${chunkIndex} chunks`
    );

    socket.emit('response:done', { turnId, text, metrics });
  };

  /** Transcribe a recorded blob. Returns null if nothing usable was heard. */
  const transcribe = async (audio: ArrayBuffer): Promise<{ text: string; ms: number } | null> => {
    const tempPath = path.join(
      'uploads',
      `input_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`
    );
    let convertedPath: string | null = null;
    const startedAt = Date.now();

    try {
      await fs.promises.mkdir('uploads', { recursive: true });
      await fs.promises.writeFile(tempPath, Buffer.from(audio));
      convertedPath = await audioProcessor.convertToWav(tempPath);

      const result = await withTimeout(
        whisperService.transcribeAudioToText(convertedPath),
        STT_TIMEOUT_MS,
        'Transcription'
      );

      const text = result.text?.trim();
      return text ? { text, ms: Date.now() - startedAt } : null;
    } finally {
      await audioProcessor.cleanupAudioFile(tempPath);
      if (convertedPath) await audioProcessor.cleanupAudioFile(convertedPath);
    }
  };

  /** Run a caller utterance through generation, as a fresh turn. */
  const handleUtterance = async (text: string, sttMs: number | null) => {
    abortActiveTurn('new caller turn');

    session.turnId += 1;
    const turnId = session.turnId;
    const controller = new AbortController();
    session.controller = controller;

    session.conversation.addUserTurn(text);

    try {
      await speak(text, turnId, controller.signal, sttMs);
    } catch (error) {
      if (isAbort(error)) return;
      console.error('❌ Turn failed:', error);
      socket.emit('error', {
        message: error instanceof Error ? error.message : 'Something went wrong',
      });
      setState('listening');
      socket.emit('ready:listening', { turnId });
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  };

  // -- events ---------------------------------------------------------------

  socket.on('call:start', async () => {
    console.log(`📞 Call started: ${socket.id}`);
    session.conversation.reset();
    session.turnId += 1;
    session.resumeHint = null;

    const turnId = session.turnId;
    const controller = new AbortController();
    session.controller = controller;

    try {
      setState('thinking');
      socket.emit('response:text:delta', { turnId, token: GREETING });

      const audio = await tts.synthesizeSpeechFromText(GREETING, controller.signal);
      if (controller.signal.aborted) return;

      session.conversation.trackChunk(turnId, GREETING);
      setState('speaking');
      socket.emit('response:audio:chunk', { turnId, index: 0, text: GREETING, audio });

      session.pendingText = GREETING;
      session.pendingTurnId = turnId;
      socket.emit('response:done', { turnId, text: GREETING, metrics: null });
    } catch (error) {
      if (!isAbort(error)) {
        console.error('❌ Greeting failed:', error);
        socket.emit('error', { message: 'Could not start the call' });
      }
    } finally {
      if (session.controller === controller) session.controller = null;
    }
  });

  /**
   * The caller started talking over the agent. The client has paused playback
   * and is recording. Nothing is cancelled yet — it may only be a backchannel,
   * and stopping for every "mhm" makes the agent unusable.
   */
  socket.on('barge:detected', (data: { turnId: number; chunksPlayed: number }) => {
    if (data?.turnId !== session.pendingTurnId && data?.turnId !== session.turnId) return;
    session.bargeChunksPlayed = data.chunksPlayed ?? 0;
    setState('paused');
    console.log(`⏸  Barge detected on turn ${data.turnId} after ${session.bargeChunksPlayed} chunks`);
  });

  socket.on(
    'audio:input',
    async (data: { audio: ArrayBuffer; duringPlayback?: boolean; spokenChunks?: number }) => {
      try {
        if (!data?.audio) return;

        if (!data.duringPlayback) {
          setState('thinking');
          const result = await transcribe(data.audio);
          if (!result) {
            setState('listening');
            socket.emit('ready:listening', { turnId: session.turnId });
            return;
          }
          socket.emit('transcription:complete', { text: result.text });
          await handleUtterance(result.text, result.ms);
          return;
        }

        // --- spoken over the agent: backchannel or real interruption? -------
        const spokenChunks = data.spokenChunks ?? session.bargeChunksPlayed;
        const interruptedTurnId = session.pendingTurnId ?? session.turnId;

        const result = await transcribe(data.audio);
        const classification = classifyUtterance(result?.text ?? '');

        console.log(
          `🔎 Over-speech classified as ${classification.kind}: "${classification.normalised}"`
        );

        if (classification.kind === 'backchannel') {
          // Not an interruption — pick up exactly where playback paused.
          socket.emit('playback:resume', { turnId: interruptedTurnId });
          setState('speaking');
          return;
        }

        // A genuine interruption. Stop generating, and record only what the
        // caller actually heard.
        abortActiveTurn('confirmed interruption');
        const spoken = session.conversation.commitInterrupted(interruptedTurnId, spokenChunks);
        session.pendingText = null;
        session.pendingTurnId = null;

        socket.emit('turn:interrupted', { turnId: interruptedTurnId, spokenText: spoken });

        if (classification.kind === 'resume') {
          session.resumeHint = session.conversation.lastUnspoken();
        }

        await handleUtterance(result!.text, result!.ms);
      } catch (error) {
        console.error('❌ audio:input failed:', error);
        socket.emit('error', {
          message: error instanceof Error ? error.message : 'Could not process audio',
        });
        setState('listening');
        socket.emit('ready:listening', { turnId: session.turnId });
      }
    }
  );

  /** Every chunk for a turn has finished playing — the turn is now history. */
  socket.on('playback:complete', (data: { turnId: number }) => {
    if (data?.turnId !== session.pendingTurnId) return;

    if (session.pendingText) {
      session.conversation.commitComplete(data.turnId, session.pendingText);
    }
    session.pendingText = null;
    session.pendingTurnId = null;

    setState('listening');
    socket.emit('ready:listening', { turnId: data.turnId });
  });

  socket.on('call:end', () => {
    abortActiveTurn('caller ended the call');
    session.conversation.reset();
    setState('ended');
  });

  socket.on('disconnect', () => {
    abortActiveTurn('client disconnected');
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `🚀 Server on :${PORT} — LLM ${llm.activeProvider()} · TTS ${tts.activeTtsProvider()}`
  );
});
