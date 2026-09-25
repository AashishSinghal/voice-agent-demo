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
import { classifyUtterance, looksHallucinated } from './services/backchannel.js';
import { Conversation } from './services/conversation.js';
import { Timeline } from './services/timeline.js';
import { installLogBridge, subscribeToLogs } from './services/logBridge.js';
import type { CallState, TurnMetrics } from './models/types.js';

dotenv.config();

// Capture every console line so it can be mirrored to connected clients.
installLogBridge();

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
/**
 * How long a busy state may go without progress before the watchdog steps in.
 * Generous: a long final sentence can take several seconds to play out on the
 * client before playback:complete arrives.
 */
const STUCK_TIMEOUT_MS = 20_000;

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

/** A server-side note with no socket direction. */
function note(event: string, data?: Record<string, unknown>) {
  console.log(`· ${event}${data ? ` ${JSON.stringify(data)}` : ''}`);
}

io.on('connection', (socket: Socket) => {
  // Bind the raw emitter first: the log bridge uses it, and the wrapper below
  // logs — going through the wrapper would recurse.
  const rawEmit = socket.emit.bind(socket);
  const trace = traceFactory(socket.id);

  // Everything this process prints, from here or from any service, goes to the
  // client so one exported file holds both halves of the conversation.
  const unsubscribeLogs = subscribeToLogs((line) => {
    rawEmit('debug:trace', { level: line.level, text: line.text });
  });

  console.log(`🔌 Client connected: ${socket.id}`);

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

  socket.onAny((event: string, payload?: Record<string, unknown>) => {
    const audio = payload?.audio as ArrayBuffer | undefined;
    const parts = payload
      ? Object.entries(payload)
          .filter(([key]) => key !== 'audio')
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      : [];
    if (audio) parts.push(`audio=${audio.byteLength}B`);
    trace('<-', event, parts.join(' '));
    progress();
  });

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

  /** Last time anything moved. A busy state with no recent progress is stuck. */
  let lastProgressAt = Date.now();
  const progress = () => {
    lastProgressAt = Date.now();
  };

  const setState = (state: CallState) => {
    if (session.state === state) return;
    session.state = state;
    progress();
    socket.emit('state', { state });
  };

  const backToListening = (why: string) => {
    note('return to listening', { why, from: session.state });
    session.pendingText = null;
    session.pendingTurnId = null;
    setState('listening');
    socket.emit('ready:listening', { turnId: session.turnId });
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
      progress();
      socket.emit('response:audio:chunk', { turnId, index: chunkIndex++, text: chunk, audio });
    };

    setState('thinking');

    const finish: { info: llm.FinishInfo | null } = { info: null };

    for await (const token of llm.streamResponse(
      query,
      session.conversation.history(),
      signal,
      resumeHint,
      (info) => {
        finish.info = info;
      }
    )) {
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

    note('generation finished', {
      turnId,
      reason: finish.info?.reason ?? 'unreported',
      tokens: finish.info?.tokens ?? 0,
      chars: text.length,
    });

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
    note('turn metrics', { turnId, ...metrics, text });

    socket.emit('response:done', { turnId, text, metrics });
  };

  /** Transcribe a recorded blob. Returns null if nothing usable was heard. */
  const transcribe = async (
    audio: ArrayBuffer,
    timeline?: Timeline,
    trimStartMs = 0
  ): Promise<{ text: string; ms: number } | null> => {
    const tempPath = path.join(
      'uploads',
      `input_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webm`
    );
    // May be the input itself when no trim is needed, so only clean up a
    // genuinely separate file.
    let preparedPath: string | null = null;
    const startedAt = Date.now();

    try {
      await fs.promises.mkdir('uploads', { recursive: true });
      await fs.promises.writeFile(tempPath, Buffer.from(audio));
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

  /** Run a caller utterance through generation, as a fresh turn. */
  const handleUtterance = async (text: string, sttMs: number | null) => {
    abortActiveTurn('new caller turn');

    // If a turn was in flight and nobody committed it, record it now. Without
    // this the assistant's half-finished answer vanishes from history, and the
    // agent genuinely cannot recall a topic it had started explaining.
    if (session.conversation.hasPending()) {
      const salvaged = session.conversation.commitPendingAsInterrupted();
      note('salvaged in-flight turn', { chars: salvaged.length });
    }
    session.pendingText = null;
    session.pendingTurnId = null;

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
    // Accept the barge whenever a turn is in flight. Matching the reported id
    // exactly was too strict: while playback is paused the client's notion of
    // the current turn lags the server's, and a dropped barge left the call
    // without its paused state.
    const inFlight = session.controller !== null || session.pendingTurnId !== null;
    if (!inFlight) {
      note('barge ignored', { turnId: data?.turnId, reason: 'nothing in flight' });
      return;
    }

    if (data?.turnId !== session.pendingTurnId && data?.turnId !== session.turnId) {
      note('barge turn mismatch', {
        reported: data?.turnId,
        pending: session.pendingTurnId,
        current: session.turnId,
      });
    }

    session.bargeChunksPlayed = data.chunksPlayed ?? 0;
    setState('paused');
    console.log(`⏸  Barge on turn ${data?.turnId} after ${session.bargeChunksPlayed} chunks`);
  });

  socket.on(
    'audio:input',
    async (data: {
      audio: ArrayBuffer;
      duringPlayback?: boolean;
      spokenChunks?: number;
      trimStartMs?: number;
      /** How long the caller was actually above the speech threshold. */
      spokenMs?: number;
    }) => {
      try {
        if (!data?.audio) return;

        // The caller has hung up. Recorders can still flush buffered audio
        // after call:end, and acting on it makes the agent answer into a
        // finished call.
        if (session.state === 'ended') {
          note('ignored audio after call end', { bytes: data.audio.byteLength });
          return;
        }

        if (!data.duringPlayback) {
          const timeline = new Timeline();
          setState('thinking');

          const result = await transcribe(data.audio, timeline, data.trimStartMs ?? 0);

          if (!result || looksHallucinated(result.text, data.spokenMs ?? 0)) {
            note('discarded transcript', {
              text: result?.text ?? null,
              spokenMs: data.spokenMs ?? 0,
              reason: result ? 'looks like a silence artefact' : 'nothing heard',
            });
            setState('listening');
            socket.emit('ready:listening', { turnId: session.turnId });
            return;
          }

          socket.emit('transcription:complete', { text: result.text });
          socket.emit('turn:timeline', {
            kind: 'turn',
            marks: timeline.snapshot(),
            total: timeline.total,
          });

          await handleUtterance(result.text, result.ms);
          return;
        }

        // --- spoken over the agent: backchannel or real interruption? -------
        const spokenChunks = data.spokenChunks ?? session.bargeChunksPlayed;
        const interruptedTurnId = session.pendingTurnId ?? session.turnId;

        const timeline = new Timeline();

        const result = await transcribe(data.audio, timeline, data.trimStartMs ?? 0);

        // Silence artefacts must never stop the agent mid-sentence.
        const hallucinated = looksHallucinated(result?.text ?? '', data.spokenMs ?? 0);
        if (hallucinated) {
          note('discarded over-speech', {
            text: result?.text ?? null,
            spokenMs: data.spokenMs ?? 0,
          });
        }

        const classification = hallucinated
          ? ({ kind: 'backchannel', normalised: '' } as const)
          : classifyUtterance(result?.text ?? '');
        timeline.mark(`classified ${classification.kind}`);

        console.log(
          `🔎 Over-speech classified as ${classification.kind}: "${classification.normalised}"`
        );
        note('classification', {
          kind: classification.kind,
          normalised: classification.normalised,
          spokenChunks,
        });

        // The caller said something either way — it belongs in the transcript,
        // marked so a backchannel is not mistaken for a real question.
        if (result?.text && !hallucinated) {
          socket.emit('transcription:complete', {
            text: result.text,
            overSpeech: true,
            kind: classification.kind,
          });
        }

        if (classification.kind === 'backchannel') {
          // Only meaningful if a turn is still in flight. After a rapid series
          // of interruptions there may be nothing left to resume, and telling
          // the client to resume silence strands the call in 'speaking'.
          const resumable = session.controller !== null || session.pendingTurnId !== null;
          if (!resumable) {
            backToListening('backchannel with no turn in flight');
            socket.emit('turn:timeline', {
              kind: 'backchannel',
              marks: timeline.snapshot(),
              total: timeline.total,
            });
            return;
          }

          // Not an interruption — pick up exactly where playback paused.
          socket.emit('playback:resume', { turnId: interruptedTurnId });
          setState('speaking');
          console.log(`⏱  backchannel handled: ${timeline.format()} · total ${timeline.total}ms`);
          socket.emit('turn:timeline', {
            kind: 'backchannel',
            marks: timeline.snapshot(),
            total: timeline.total,
          });
          return;
        }

        // A genuine interruption. Stop generating, and record only what the
        // caller actually heard.
        abortActiveTurn('confirmed interruption');
        const spoken = session.conversation.commitInterrupted(interruptedTurnId, spokenChunks);
        session.pendingText = null;
        session.pendingTurnId = null;

        timeline.mark('interrupt committed');
        socket.emit('turn:interrupted', { turnId: interruptedTurnId, spokenText: spoken });

        console.log(`⏱  interruption handled: ${timeline.format()} · total ${timeline.total}ms`);
        socket.emit('turn:timeline', {
          kind: 'interruption',
          marks: timeline.snapshot(),
          total: timeline.total,
        });

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
    if (data?.turnId !== session.pendingTurnId) {
      // Stale or unknown turn — usually a turn that was interrupted after its
      // audio was queued. Dropping it silently used to leave the call wedged,
      // because nothing else would ever move it back to listening.
      note('stale playback:complete', {
        received: data?.turnId,
        pending: session.pendingTurnId,
      });
      if (session.controller === null && session.pendingTurnId === null) {
        backToListening('stale playback:complete with nothing in flight');
      }
      return;
    }

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

  /**
   * Backstop for the state machine.
   *
   * Rapid interruptions can abandon a turn with no successor — the aborted
   * generation returns silently, the client has dropped its queued audio, and
   * nobody is left to move the call on. Rather than enumerate every such race,
   * recover from any busy state that has stopped making progress.
   */
  const watchdog = setInterval(() => {
    const busy =
      session.state === 'thinking' || session.state === 'speaking' || session.state === 'paused';
    if (!busy) return;
    if (session.controller !== null) return; // generation genuinely in flight
    if (Date.now() - lastProgressAt < STUCK_TIMEOUT_MS) return;

    console.warn(`⚠️  watchdog: stuck in '${session.state}' — returning to listening`);
    backToListening('watchdog');
  }, 2000);

  socket.on('disconnect', () => {
    unsubscribeLogs();
    clearInterval(watchdog);
    abortActiveTurn('client disconnected');
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `🚀 Server on :${PORT} — LLM ${llm.activeProvider()} · TTS ${tts.activeTtsProvider()}`
  );
});
