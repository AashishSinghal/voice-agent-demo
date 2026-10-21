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
import { SentenceChunker } from './services/sentenceChunker.js';
import { classifyUtterance, looksHallucinated } from './services/backchannel.js';
import { Conversation } from './services/conversation.js';
import { Timeline } from './services/timeline.js';
import { resolveBargeCancel } from './services/bargeCancel.js';
import {
  installLogBridge,
  subscribeToSessionLogs,
  runInSession,
  describeError,
} from './services/logBridge.js';
import {
  Limiter,
  clientIp,
  tokenMatches,
  trustProxyFromEnv,
} from './services/limits.js';
import {
  DEFAULT_MAX_AUDIO_BYTES,
  validateAudioInput,
  validateBarge,
  validatePlayback,
} from './services/validate.js';
import type { CallState, CostReport, TurnMetrics } from './models/types.js';
import * as cost from './services/cost.js';

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
/** Spoken when the model returns no text at all, rather than saying nothing. */
const EMPTY_ANSWER = "Sorry, I lost my train of thought. Could you say that again?";
const GREETING = process.env.AGENT_GREETING || "Hey, I'm listening. What can I help you with?";
const STT_TIMEOUT_MS = 20_000;
/**
 * How long a busy state may go without progress before the watchdog steps in.
 *
 * The client heartbeats while it plays, so silence for this long genuinely
 * means something is stuck rather than that the answer is simply long.
 */
const STUCK_TIMEOUT_MS = 20_000;
/**
 * Speaking gets a longer budget than thinking.
 *
 * While the agent talks, the only thing that can move is the client's
 * playback, and a long answer runs half a minute. Heartbeats should keep this
 * from ever being reached; it exists so that if they stop, the agent is cut
 * off late rather than in the middle of a sentence.
 */
const SPEAKING_STUCK_TIMEOUT_MS = 45_000;

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
  /** Running spend for the call, and how many turns produced it. */
  spend: cost.TurnCost | null;
  spendTurns: number;
  /** Length of the clip that started the current turn, for STT billing. */
  clipSeconds: number;
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
  const ip = String(socket.data.ip ?? 'unknown');
  /** Set on disconnect so work that outlives the socket can stand down. */
  let closed = false;
  const trace = traceFactory(socket.id);

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
    progress();
  }));

  const session: Session = {
    conversation: new Conversation(),
    turnId: 0,
    controller: null,
    state: 'idle',
    pendingText: null,
    pendingTurnId: null,
    bargeChunksPlayed: 0,
    resumeHint: null,
    spend: null,
    spendTurns: 0,
    clipSeconds: 0,
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
    // Text-to-speech bills per character, so this is the meter that matters.
    let spokenCharacters = 0;

    const resumeHint = session.resumeHint;
    session.resumeHint = null;

    const emitChunk = async (chunk: string) => {
      if (signal.aborted) return;

      const audio = await tts.synthesizeSpeechFromText(chunk, signal);
      if (signal.aborted) return;

      spokenCharacters += chunk.length;

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
      },
      socket.id
    )) {
      if (signal.aborted) return;

      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;

      fullText += token;
      socket.emit('response:text:delta', { turnId, token });

      for (const chunk of chunker.push(token)) await emitChunk(chunk);
    }

    for (const chunk of chunker.flush()) await emitChunk(chunk);

    // A generation that produced nothing must not be silent. The call would
    // otherwise sit in "thinking" with no word spoken until the watchdog fired.
    if (!signal.aborted && !fullText.trim()) {
      note('empty generation', { turnId, reason: finish.info?.reason ?? 'unreported' });
      fullText = EMPTY_ANSWER;
      socket.emit('response:text:delta', { turnId, token: EMPTY_ANSWER });
      await emitChunk(EMPTY_ANSWER);
    }

    if (signal.aborted) {
      // Synthesis already happened for whatever played before the caller cut
      // in, and it was billed. Dropping the turn silently here would quietly
      // undercount every interruption.
      if (spokenCharacters > 0) {
        const abandoned = cost.turnCost({
          audioSeconds: session.clipSeconds,
          usage: { promptTokens: 0, completionTokens: 0 },
          spokenCharacters,
          sttModel: process.env.GROQ_STT_MODEL || undefined,
          llmModel: process.env.GROQ_MODEL || undefined,
          ttsModel: process.env.GROQ_TTS_MODEL || undefined,
        });
        session.spend = cost.addCost(session.spend, abandoned);
        note('interrupted turn cost', {
          turnId,
          totalUsd: Number(abandoned.totalUsd.toFixed(6)),
          spokenCharacters,
          note: 'synthesised before the caller interrupted',
        });
      }
      return;
    }

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

    const turnSpend = cost.turnCost({
      audioSeconds: session.clipSeconds,
      usage: {
        promptTokens: finish.info?.promptTokens ?? 0,
        completionTokens: finish.info?.completionTokens ?? 0,
      },
      spokenCharacters,
      sttModel: process.env.GROQ_STT_MODEL || undefined,
      llmModel: process.env.GROQ_MODEL || undefined,
      ttsModel: process.env.GROQ_TTS_MODEL || undefined,
    });

    session.spend = cost.addCost(session.spend, turnSpend);
    session.spendTurns += 1;

    const costReport: CostReport = {
      turn: {
        sttUsd: turnSpend.sttUsd,
        llmUsd: turnSpend.llmUsd,
        ttsUsd: turnSpend.ttsUsd,
        totalUsd: turnSpend.totalUsd,
      },
      session: {
        sttUsd: session.spend.sttUsd,
        llmUsd: session.spend.llmUsd,
        ttsUsd: session.spend.ttsUsd,
        totalUsd: session.spend.totalUsd,
        turns: session.spendTurns,
      },
      detail: turnSpend.detail,
    };

    const share = (part: number) =>
      turnSpend.totalUsd > 0 ? `${Math.round((part / turnSpend.totalUsd) * 100)}%` : '0%';

    note('turn cost', {
      turnId,
      totalUsd: Number(turnSpend.totalUsd.toFixed(6)),
      tts: `${Number(turnSpend.ttsUsd.toFixed(6))} (${share(turnSpend.ttsUsd)})`,
      stt: `${Number(turnSpend.sttUsd.toFixed(6))} (${share(turnSpend.sttUsd)})`,
      llm: `${Number(turnSpend.llmUsd.toFixed(6))} (${share(turnSpend.llmUsd)})`,
      spokenCharacters,
      audioSeconds: turnSpend.detail.actualAudioSeconds,
      billedAudioSeconds: turnSpend.detail.billedAudioSeconds,
    });

    // The running total, so an exported log stands on its own without
    // re-adding the turns by hand.
    note('call cost so far', {
      turns: session.spendTurns,
      totalUsd: Number(session.spend.totalUsd.toFixed(6)),
      ttsUsd: Number(session.spend.ttsUsd.toFixed(6)),
      sttUsd: Number(session.spend.sttUsd.toFixed(6)),
      llmUsd: Number(session.spend.llmUsd.toFixed(6)),
      perThousandTurnsUsd:
        session.spendTurns > 0
          ? Number(((session.spend.totalUsd / session.spendTurns) * 1000).toFixed(2))
          : 0,
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

    socket.emit('response:done', { turnId, text, metrics, cost: costReport });
  };

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

  /**
   * A new caller turn is replacing one that was still generating or playing.
   *
   * Aborting generation is not enough. Audio the server already sent is queued
   * or playing in the browser, and the browser cannot know the turn is dead:
   * the old answer used to play out in full, with the new transcript already on
   * screen. So tell the client to drop it, and record only what was heard.
   */
  const supersedeInFlightTurn = (spokenChunks?: number) => {
    const inFlight = session.controller !== null;
    const hadPending = session.conversation.hasPending();
    const oldTurnId = session.pendingTurnId ?? (inFlight || hadPending ? session.turnId : null);

    abortActiveTurn('new caller turn');

    let spoken = '';
    if (hadPending && oldTurnId !== null) {
      // The client reports how many chunks had finished playing; without it
      // assume everything emitted was heard, which is generous but never loses
      // the topic.
      spoken =
        spokenChunks !== undefined
          ? session.conversation.commitInterrupted(oldTurnId, spokenChunks)
          : session.conversation.commitPendingAsInterrupted();
      note('superseded in-flight turn', { turnId: oldTurnId, chars: spoken.length, spokenChunks });
      if (llm.activeProvider() === 'brain') {
        brain.reportHeard(socket.id, spoken, session.conversation.lastUnspoken());
      }
    }

    if (oldTurnId !== null) {
      socket.emit('turn:interrupted', { turnId: oldTurnId, spokenText: spoken });
    }
    session.pendingText = null;
    session.pendingTurnId = null;
  };

  /** Run a caller utterance through generation, as a fresh turn. */
  const handleUtterance = async (text: string, sttMs: number | null, spokenChunks?: number) => {
    supersedeInFlightTurn(spokenChunks);

    session.turnId += 1;
    const turnId = session.turnId;
    const controller = new AbortController();
    session.controller = controller;

    session.conversation.addUserTurn(text);

    try {
      await speak(text, turnId, controller.signal, sttMs);
    } catch (error) {
      if (isAbort(error)) return;
      console.error(`❌ Turn failed: ${describeError(error)}`);
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
    session.spend = null;
    session.spendTurns = 0;

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
        console.error(`❌ Greeting failed: ${describeError(error)}`);
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
  socket.on('barge:detected', (raw: unknown) => {
    const parsed = validateBarge(raw);
    if (!parsed.ok) {
      note('dropped barge:detected', { reason: parsed.reason });
      return;
    }
    const data = parsed.value;

    // Accept the barge whenever a turn is in flight. Matching the reported id
    // exactly was too strict: while playback is paused the client's notion of
    // the current turn lags the server's, and a dropped barge left the call
    // without its paused state.
    const inFlight = session.controller !== null || session.pendingTurnId !== null;
    if (!inFlight) {
      note('barge ignored', { turnId: data.turnId, reason: 'nothing in flight' });
      return;
    }

    if (data.turnId !== session.pendingTurnId && data.turnId !== session.turnId) {
      note('barge turn mismatch', {
        reported: data.turnId,
        pending: session.pendingTurnId,
        current: session.turnId,
      });
    }

    session.bargeChunksPlayed = data.chunksPlayed;
    setState('paused');
    console.log(`⏸  Barge on turn ${data.turnId} after ${session.bargeChunksPlayed} chunks`);
  });

  /**
   * The barge-in turned out to be nothing — a cough, a chair, a false trigger —
   * so no audio will follow. The client has already resumed playback; the
   * server must leave `paused` too, or it waits for the watchdog.
   */
  socket.on('barge:cancelled', (raw: unknown) => {
    // The payload carries only a diagnostic reason, so there is nothing to
    // trust: the decision comes from server state alone.
    const reason =
      raw && typeof raw === 'object' && typeof (raw as { reason?: unknown }).reason === 'string'
        ? (raw as { reason: string }).reason.slice(0, 80)
        : undefined;
    const turnInFlight = session.controller !== null || session.pendingTurnId !== null;
    const action = resolveBargeCancel(session.state, turnInFlight);
    note('barge cancelled', { reason, action, from: session.state });

    if (action === 'resume') {
      setState('speaking');
    } else if (action === 'listen') {
      backToListening('barge cancelled with no turn in flight');
    }
  });

  socket.on(
    'audio:input',
    async (raw: unknown) => {
      try {
        // Every field comes from an uncontrolled browser. Invalid payloads are
        // dropped, not answered: there is nothing useful to tell a bad client.
        const parsed = validateAudioInput(raw, MAX_AUDIO_BYTES);
        if (!parsed.ok) {
          note('dropped audio:input', { reason: parsed.reason });
          return;
        }
        const data = parsed.value;

        // The caller has hung up. Recorders can still flush buffered audio
        // after call:end, and acting on it makes the agent answer into a
        // finished call.
        if (session.state === 'ended') {
          note('ignored audio after call end', { bytes: data.audio.byteLength });
          return;
        }

        // Transcription is billed on clip length, and the response carries no
        // duration, so the client reports what it sent.
        session.clipSeconds = data.clipMs / 1000;

        // Spend a turn before any Groq call. Refusing here, rather than at
        // connect time, keeps the quota guard on the thing that costs money.
        const allowance = limiter.tryTurn(ip);
        if (!allowance.allowed) {
          note('turn refused', { scope: allowance.scope, retryAfterSec: allowance.retryAfterSec });
          abortActiveTurn('turn refused by limiter');
          socket.emit('limit:reached', {
            scope: allowance.scope,
            message: allowance.message,
            retryAfterSec: allowance.retryAfterSec,
          });
          socket.emit('error', { message: allowance.message });
          backToListening('turn refused by limiter');
          return;
        }

        if (!data.duringPlayback) {
          const timeline = new Timeline();
          setState('thinking');

          const result = await transcribe(data.audio, timeline, data.trimStartMs);
          if (closed) return;

          if (!result || looksHallucinated(result.text, data.spokenMs)) {
            note('discarded transcript', {
              text: result?.text ?? null,
              spokenMs: data.spokenMs,
              reason: result ? 'looks like a silence artefact' : 'nothing heard',
            });
            setState('listening');
            socket.emit('ready:listening', { turnId: session.turnId });
            return;
          }

          const spoke = classifyUtterance(result.text);
          socket.emit('transcription:complete', {
            text: result.text,
            ...(spoke.kind === 'halt' ? { kind: 'halt' } : {}),
          });

          if (spoke.kind === 'halt') {
            // "Stop" said without the agent being paused by it, e.g. the caller
            // spoke before audio had started. Silence what is coming and wait.
            supersedeInFlightTurn(data.spokenChunks);
            backToListening('caller said stop');
            return;
          }

          socket.emit('turn:timeline', {
            kind: 'turn',
            marks: timeline.snapshot(),
            total: timeline.total,
          });

          await handleUtterance(result.text, result.ms, data.spokenChunks);
          return;
        }

        // --- spoken over the agent: backchannel or real interruption? -------
        const spokenChunks = data.spokenChunks ?? session.bargeChunksPlayed;
        const interruptedTurnId = session.pendingTurnId ?? session.turnId;

        const timeline = new Timeline();

        const result = await transcribe(data.audio, timeline, data.trimStartMs);
        if (closed) return;

        // Silence artefacts must never stop the agent mid-sentence.
        const hallucinated = looksHallucinated(result?.text ?? '', data.spokenMs);
        if (hallucinated) {
          note('discarded over-speech', {
            text: result?.text ?? null,
            spokenMs: data.spokenMs,
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
        // The brain keeps its own history; tell it what was actually heard.
        if (llm.activeProvider() === 'brain') {
          brain.reportHeard(socket.id, spoken, session.conversation.lastUnspoken());
        }
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

        if (classification.kind === 'halt') {
          // The caller asked it to be quiet. The turn is over and nothing new
          // starts: answering "stop" with another answer is exactly wrong.
          backToListening('caller said stop');
          return;
        }

        if (classification.kind === 'resume') {
          session.resumeHint = session.conversation.lastUnspoken();
        }

        await handleUtterance(result!.text, result!.ms);
      } catch (error) {
        console.error(`❌ audio:input failed: ${describeError(error)}`);
        socket.emit('error', {
          message: error instanceof Error ? error.message : 'Could not process audio',
        });
        setState('listening');
        socket.emit('ready:listening', { turnId: session.turnId });
      }
    }
  );

  /**
   * The client is still playing audio.
   *
   * Between the last chunk being sent and playback finishing, the client would
   * otherwise say nothing at all — so a long answer looked identical to a
   * wedged call, and the watchdog cut it off mid-sentence. This is the client
   * saying it is fine.
   */
  socket.on('playback:progress', () => {
    // The inbound handler already marks progress; nothing else to do.
  });

  /** Every chunk for a turn has finished playing — the turn is now history. */
  socket.on('playback:complete', (raw: unknown) => {
    const parsed = validatePlayback(raw);
    if (!parsed.ok) {
      note('dropped playback:complete', { reason: parsed.reason });
      return;
    }
    const data = parsed.value;
    if (data.turnId !== session.pendingTurnId) {
      // Stale or unknown turn — usually a turn that was interrupted after its
      // audio was queued. Dropping it silently used to leave the call wedged,
      // because nothing else would ever move it back to listening.
      note('stale playback:complete', {
        received: data.turnId,
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
  const watchdog = setInterval(() => runInSession(socket.id, () => {
    const busy =
      session.state === 'thinking' || session.state === 'speaking' || session.state === 'paused';
    if (!busy) return;
    if (session.controller !== null) return; // generation genuinely in flight

    const idleFor = Date.now() - lastProgressAt;
    const budget = session.state === 'speaking' ? SPEAKING_STUCK_TIMEOUT_MS : STUCK_TIMEOUT_MS;
    if (idleFor < budget) return;

    console.warn(
      `⚠️  watchdog: '${session.state}' made no progress for ${idleFor}ms ` +
        `(budget ${budget}ms) — returning to listening`
    );
    backToListening('watchdog');
  }), 2000);

  socket.on('disconnect', () => {
    closed = true;
    clearInterval(watchdog);
    abortActiveTurn('client disconnected');
    // Nothing should answer into a socket that is gone.
    session.conversation.reset();
    session.pendingText = null;
    session.pendingTurnId = null;
    session.state = 'ended';
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
