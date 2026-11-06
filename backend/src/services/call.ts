/**
 * One call's state machine: what the caller said, what the agent is doing about
 * it, and what was actually heard.
 *
 * Everything outside the call is a port, so a whole call (a turn, a barge-in, a
 * backchannel, "stop", a refused turn) can be driven in a test with scripted
 * collaborators and no socket, no Groq and no brain. `server.ts` wires the real
 * ones. Which LLM is answering is not this module's business: `reportHeard` and
 * `warmUp` are no-ops for providers that do not need them.
 */

import { SentenceChunker } from './sentenceChunker.js';
import { classifyUtterance, looksHallucinated } from './backchannel.js';
import { Conversation } from './conversation.js';
import { Timeline } from './timeline.js';
import { resolveBargeCancel } from './bargeCancel.js';
import { describeError } from './logBridge.js';
import { validateAudioInput, validateBarge, validatePlayback } from './validate.js';
import type { Limiter } from './limits.js';
import type { FinishInfo } from './llmService.js';
import type { CallState, CostReport, TurnMetrics } from '../models/types.js';
import * as cost from './cost.js';

/** Spoken when the model returns no text at all, rather than saying nothing. */
const EMPTY_ANSWER = "Sorry, I lost my train of thought. Could you say that again?";
const GREETING = process.env.AGENT_GREETING || "Hey, I'm listening. What can I help you with?";
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

/** A server-side note with no socket direction. */
export function note(event: string, data?: Record<string, unknown>) {
  console.log(`· ${event}${data ? ` ${JSON.stringify(data)}` : ''}`);
}

export interface CallPorts {
  /** Send an event to this caller. */
  emit(event: string, payload?: Record<string, unknown>): void;
  /** Speech to text. Null if nothing usable was heard. */
  transcribe(audio: Buffer, timeline: Timeline, trimStartMs: number): Promise<{ text: string; ms: number } | null>;
  /** The reply, token by token. */
  respond(input: {
    query: string;
    history: ReturnType<Conversation['history']>;
    signal: AbortSignal;
    resumeHint: string | null;
    onFinish: (info: FinishInfo) => void;
  }): AsyncIterable<string>;
  /** Text to speech. */
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
  /** Tell the answering model what the caller actually heard. May do nothing. */
  reportHeard(spoken: string, unspoken: string | null): void;
  /** Get the answering model ready before the first question. May do nothing. */
  warmUp(): void;
  /** Spend a turn from this caller's allowance. */
  tryTurn(): ReturnType<Limiter['tryTurn']>;
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

export class Call {
  readonly session: Session = {
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
  /** Set on disconnect so work that outlives the socket can stand down. */
  private closed = false;
  /** Last time anything moved. A busy state with no recent progress is stuck. */
  private lastProgressAt = Date.now();

  constructor(
    private readonly ports: CallPorts,
    private readonly options: { id: string; maxAudioBytes: number; now?: () => number }
  ) {}

  /** Anything inbound counts as the call being alive, for the watchdog. */
  progress() {
    this.lastProgressAt = (this.options.now ?? Date.now)();
  }

  private setState(state: CallState) {
    if (this.session.state === state) return;
    this.session.state = state;
    this.progress();
    this.ports.emit('state', { state });
  }

  private backToListening(why: string) {
    note('return to listening', { why, from: this.session.state });
    this.session.pendingText = null;
    this.session.pendingTurnId = null;
    this.setState('listening');
    this.ports.emit('ready:listening', { turnId: this.session.turnId });
  }

  private abortActiveTurn(reason: string) {
    if (!this.session.controller) return;
    console.log(`✋ Aborting turn ${this.session.turnId} (${reason})`);
    this.session.controller.abort();
    this.session.controller = null;
  }


  /**
   * Generate and speak one response, streaming sentence by sentence so the
   * caller hears the opening while the rest is still being written.
   */
  private async speak(
    query: string,
    turnId: number,
    signal: AbortSignal,
    sttMs: number | null
  ): Promise<void> {
    const startedAt = Date.now();
    const chunker = new SentenceChunker();
    let fullText = '';
    let firstTokenMs: number | null = null;
    let firstAudioMs: number | null = null;
    let chunkIndex = 0;
    // Text-to-speech bills per character, so this is the meter that matters.
    let spokenCharacters = 0;

    const resumeHint = this.session.resumeHint;
    this.session.resumeHint = null;

    const emitChunk = async (chunk: string) => {
      if (signal.aborted) return;

      const audio = await this.ports.synthesize(chunk, signal);
      if (signal.aborted) return;

      spokenCharacters += chunk.length;

      if (firstAudioMs === null) {
        firstAudioMs = Date.now() - startedAt;
        this.setState('speaking');
      }

      this.session.conversation.trackChunk(turnId, chunk);
      this.progress();
      this.ports.emit('response:audio:chunk', { turnId, index: chunkIndex++, text: chunk, audio });
    };

    this.setState('thinking');

    const finish: { info: FinishInfo | null } = { info: null };

    for await (const token of this.ports.respond({
      query,
      history: this.session.conversation.history(),
      signal,
      resumeHint,
      onFinish: (info) => {
        finish.info = info;
      },
    })) {
      if (signal.aborted) return;

      if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;

      fullText += token;
      this.ports.emit('response:text:delta', { turnId, token });

      for (const chunk of chunker.push(token)) await emitChunk(chunk);
    }

    for (const chunk of chunker.flush()) await emitChunk(chunk);

    // A generation that produced nothing must not be silent. The call would
    // otherwise sit in "thinking" with no word spoken until the watchdog fired.
    if (!signal.aborted && !fullText.trim()) {
      note('empty generation', { turnId, reason: finish.info?.reason ?? 'unreported' });
      fullText = EMPTY_ANSWER;
      this.ports.emit('response:text:delta', { turnId, token: EMPTY_ANSWER });
      await emitChunk(EMPTY_ANSWER);
    }

    if (signal.aborted) {
      // Synthesis already happened for whatever played before the caller cut
      // in, and it was billed. Dropping the turn silently here would quietly
      // undercount every interruption.
      if (spokenCharacters > 0) {
        const abandoned = cost.turnCost({
          audioSeconds: this.session.clipSeconds,
          usage: { promptTokens: 0, completionTokens: 0 },
          spokenCharacters,
          sttModel: process.env.GROQ_STT_MODEL || undefined,
          llmModel: process.env.GROQ_MODEL || undefined,
          ttsModel: process.env.GROQ_TTS_MODEL || undefined,
        });
        this.session.spend = cost.addCost(this.session.spend, abandoned);
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
    this.session.pendingText = text;
    this.session.pendingTurnId = turnId;

    note('generation finished', {
      turnId,
      reason: finish.info?.reason ?? 'unreported',
      tokens: finish.info?.tokens ?? 0,
      chars: text.length,
    });

    const turnSpend = cost.turnCost({
      audioSeconds: this.session.clipSeconds,
      usage: {
        promptTokens: finish.info?.promptTokens ?? 0,
        completionTokens: finish.info?.completionTokens ?? 0,
      },
      spokenCharacters,
      sttModel: process.env.GROQ_STT_MODEL || undefined,
      llmModel: process.env.GROQ_MODEL || undefined,
      ttsModel: process.env.GROQ_TTS_MODEL || undefined,
    });

    this.session.spend = cost.addCost(this.session.spend, turnSpend);
    this.session.spendTurns += 1;

    const costReport: CostReport = {
      turn: {
        sttUsd: turnSpend.sttUsd,
        llmUsd: turnSpend.llmUsd,
        ttsUsd: turnSpend.ttsUsd,
        totalUsd: turnSpend.totalUsd,
      },
      session: {
        sttUsd: this.session.spend.sttUsd,
        llmUsd: this.session.spend.llmUsd,
        ttsUsd: this.session.spend.ttsUsd,
        totalUsd: this.session.spend.totalUsd,
        turns: this.session.spendTurns,
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
      turns: this.session.spendTurns,
      totalUsd: Number(this.session.spend.totalUsd.toFixed(6)),
      ttsUsd: Number(this.session.spend.ttsUsd.toFixed(6)),
      sttUsd: Number(this.session.spend.sttUsd.toFixed(6)),
      llmUsd: Number(this.session.spend.llmUsd.toFixed(6)),
      perThousandTurnsUsd:
        this.session.spendTurns > 0
          ? Number(((this.session.spend.totalUsd / this.session.spendTurns) * 1000).toFixed(2))
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

    this.ports.emit('response:done', { turnId, text, metrics, cost: costReport });
  }

  /**
   * A new caller turn is replacing one that was still generating or playing.
   *
   * Aborting generation is not enough. Audio the server already sent is queued
   * or playing in the browser, and the browser cannot know the turn is dead:
   * the old answer used to play out in full, with the new transcript already on
   * screen. So tell the client to drop it, and record only what was heard.
   */
  private supersedeInFlightTurn(spokenChunks?: number) {
    const inFlight = this.session.controller !== null;
    const hadPending = this.session.conversation.hasPending();
    const oldTurnId = this.session.pendingTurnId ?? (inFlight || hadPending ? this.session.turnId : null);

    this.abortActiveTurn('new caller turn');

    let spoken = '';
    if (hadPending && oldTurnId !== null) {
      // The client reports how many chunks had finished playing; without it
      // assume everything emitted was heard, which is generous but never loses
      // the topic.
      spoken =
        spokenChunks !== undefined
          ? this.session.conversation.commitInterrupted(oldTurnId, spokenChunks)
          : this.session.conversation.commitPendingAsInterrupted();
      note('superseded in-flight turn', { turnId: oldTurnId, chars: spoken.length, spokenChunks });
      this.ports.reportHeard(spoken, this.session.conversation.lastUnspoken());
    }

    if (oldTurnId !== null) {
      this.ports.emit('turn:interrupted', { turnId: oldTurnId, spokenText: spoken });
    }
    this.session.pendingText = null;
    this.session.pendingTurnId = null;
  }

  /** Run a caller utterance through generation, as a fresh turn. */
  private async handleUtterance(text: string, sttMs: number | null, spokenChunks?: number) {
    this.supersedeInFlightTurn(spokenChunks);

    this.session.turnId += 1;
    const turnId = this.session.turnId;
    const controller = new AbortController();
    this.session.controller = controller;

    this.session.conversation.addUserTurn(text);

    try {
      await this.speak(text, turnId, controller.signal, sttMs);
    } catch (error) {
      if (isAbort(error)) return;
      console.error(`❌ Turn failed: ${describeError(error)}`);
      this.ports.emit('error', {
        message: error instanceof Error ? error.message : 'Something went wrong',
      });
      this.setState('listening');
      this.ports.emit('ready:listening', { turnId });
    } finally {
      if (this.session.controller === controller) this.session.controller = null;
    }
  }

  // -- events from the caller ------------------------------------------------

  async callStart() {
    console.log(`📞 Call started: ${this.options.id}`);
    this.ports.warmUp();
    this.session.conversation.reset();
    this.session.turnId += 1;
    this.session.resumeHint = null;
    this.session.spend = null;
    this.session.spendTurns = 0;

    const turnId = this.session.turnId;
    const controller = new AbortController();
    this.session.controller = controller;

    try {
      this.setState('thinking');
      this.ports.emit('response:text:delta', { turnId, token: GREETING });

      const audio = await this.ports.synthesize(GREETING, controller.signal);
      if (controller.signal.aborted) return;

      this.session.conversation.trackChunk(turnId, GREETING);
      this.setState('speaking');
      this.ports.emit('response:audio:chunk', { turnId, index: 0, text: GREETING, audio });

      this.session.pendingText = GREETING;
      this.session.pendingTurnId = turnId;
      this.ports.emit('response:done', { turnId, text: GREETING, metrics: null });
    } catch (error) {
      if (!isAbort(error)) {
        console.error(`❌ Greeting failed: ${describeError(error)}`);
        this.ports.emit('error', { message: 'Could not start the call' });
      }
    } finally {
      if (this.session.controller === controller) this.session.controller = null;
    }
  }

  /**
   * The caller started talking over the agent. The client has paused playback
   * and is recording. Nothing is cancelled yet — it may only be a backchannel,
   * and stopping for every "mhm" makes the agent unusable.
   */
  bargeDetected(raw: unknown) {
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
    const inFlight = this.session.controller !== null || this.session.pendingTurnId !== null;
    if (!inFlight) {
      note('barge ignored', { turnId: data.turnId, reason: 'nothing in flight' });
      return;
    }

    if (data.turnId !== this.session.pendingTurnId && data.turnId !== this.session.turnId) {
      note('barge turn mismatch', {
        reported: data.turnId,
        pending: this.session.pendingTurnId,
        current: this.session.turnId,
      });
    }

    this.session.bargeChunksPlayed = data.chunksPlayed;
    this.setState('paused');
    console.log(`⏸  Barge on turn ${data.turnId} after ${this.session.bargeChunksPlayed} chunks`);
  }

  /**
   * The barge-in turned out to be nothing — a cough, a chair, a false trigger —
   * so no audio will follow. The client has already resumed playback; the
   * server must leave `paused` too, or it waits for the watchdog.
   */
  bargeCancelled(raw: unknown) {
    // The payload carries only a diagnostic reason, so there is nothing to
    // trust: the decision comes from server state alone.
    const reason =
      raw && typeof raw === 'object' && typeof (raw as { reason?: unknown }).reason === 'string'
        ? (raw as { reason: string }).reason.slice(0, 80)
        : undefined;
    const turnInFlight = this.session.controller !== null || this.session.pendingTurnId !== null;
    const action = resolveBargeCancel(this.session.state, turnInFlight);
    note('barge cancelled', { reason, action, from: this.session.state });

    if (action === 'resume') {
      this.setState('speaking');
    } else if (action === 'listen') {
      this.backToListening('barge cancelled with no turn in flight');
    }
  }

  async audioInput(raw: unknown) {
      try {
        // Every field comes from an uncontrolled browser. Invalid payloads are
        // dropped, not answered: there is nothing useful to tell a bad client.
        const parsed = validateAudioInput(raw, this.options.maxAudioBytes);
        if (!parsed.ok) {
          note('dropped audio:input', { reason: parsed.reason });
          return;
        }
        const data = parsed.value;

        // The caller has hung up. Recorders can still flush buffered audio
        // after call:end, and acting on it makes the agent answer into a
        // finished call.
        if (this.session.state === 'ended') {
          note('ignored audio after call end', { bytes: data.audio.byteLength });
          return;
        }

        // Transcription is billed on clip length, and the response carries no
        // duration, so the client reports what it sent.
        this.session.clipSeconds = data.clipMs / 1000;

        // Spend a turn before any Groq call. Refusing here, rather than at
        // connect time, keeps the quota guard on the thing that costs money.
        const allowance = this.ports.tryTurn();
        if (!allowance.allowed) {
          note('turn refused', { scope: allowance.scope, retryAfterSec: allowance.retryAfterSec });
          this.abortActiveTurn('turn refused by limiter');
          this.ports.emit('limit:reached', {
            scope: allowance.scope,
            message: allowance.message,
            retryAfterSec: allowance.retryAfterSec,
          });
          this.ports.emit('error', { message: allowance.message });
          this.backToListening('turn refused by limiter');
          return;
        }

        if (!data.duringPlayback) {
          const timeline = new Timeline();
          this.setState('thinking');

          const result = await this.ports.transcribe(data.audio, timeline, data.trimStartMs);
          if (this.closed) return;

          if (!result || looksHallucinated(result.text, data.spokenMs)) {
            note('discarded transcript', {
              text: result?.text ?? null,
              spokenMs: data.spokenMs,
              reason: result ? 'looks like a silence artefact' : 'nothing heard',
            });
            this.setState('listening');
            this.ports.emit('ready:listening', { turnId: this.session.turnId });
            return;
          }

          const spoke = classifyUtterance(result.text);
          this.ports.emit('transcription:complete', {
            text: result.text,
            ...(spoke.kind === 'halt' ? { kind: 'halt' } : {}),
          });

          if (spoke.kind === 'halt') {
            // "Stop" said without the agent being paused by it, e.g. the caller
            // spoke before audio had started. Silence what is coming and wait.
            this.supersedeInFlightTurn(data.spokenChunks);
            this.backToListening('caller said stop');
            return;
          }

          this.ports.emit('turn:timeline', {
            kind: 'turn',
            marks: timeline.snapshot(),
            total: timeline.total,
          });

          await this.handleUtterance(result.text, result.ms, data.spokenChunks);
          return;
        }

        // --- spoken over the agent: backchannel or real interruption? -------
        const spokenChunks = data.spokenChunks ?? this.session.bargeChunksPlayed;
        const interruptedTurnId = this.session.pendingTurnId ?? this.session.turnId;

        const timeline = new Timeline();

        const result = await this.ports.transcribe(data.audio, timeline, data.trimStartMs);
        if (this.closed) return;

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
          this.ports.emit('transcription:complete', {
            text: result.text,
            overSpeech: true,
            kind: classification.kind,
          });
        }

        if (classification.kind === 'backchannel') {
          // Only meaningful if a turn is still in flight. After a rapid series
          // of interruptions there may be nothing left to resume, and telling
          // the client to resume silence strands the call in 'speaking'.
          const resumable = this.session.controller !== null || this.session.pendingTurnId !== null;
          if (!resumable) {
            this.backToListening('backchannel with no turn in flight');
            this.ports.emit('turn:timeline', {
              kind: 'backchannel',
              marks: timeline.snapshot(),
              total: timeline.total,
            });
            return;
          }

          // Not an interruption — pick up exactly where playback paused.
          this.ports.emit('playback:resume', { turnId: interruptedTurnId });
          this.setState('speaking');
          console.log(`⏱  backchannel handled: ${timeline.format()} · total ${timeline.total}ms`);
          this.ports.emit('turn:timeline', {
            kind: 'backchannel',
            marks: timeline.snapshot(),
            total: timeline.total,
          });
          return;
        }

        // A genuine interruption. Stop generating, and record only what the
        // caller actually heard.
        this.abortActiveTurn('confirmed interruption');
        const spoken = this.session.conversation.commitInterrupted(interruptedTurnId, spokenChunks);
        // The brain keeps its own history; tell it what was actually heard.
        this.ports.reportHeard(spoken, this.session.conversation.lastUnspoken());
        this.session.pendingText = null;
        this.session.pendingTurnId = null;

        timeline.mark('interrupt committed');
        this.ports.emit('turn:interrupted', { turnId: interruptedTurnId, spokenText: spoken });

        console.log(`⏱  interruption handled: ${timeline.format()} · total ${timeline.total}ms`);
        this.ports.emit('turn:timeline', {
          kind: 'interruption',
          marks: timeline.snapshot(),
          total: timeline.total,
        });

        if (classification.kind === 'halt') {
          // The caller asked it to be quiet. The turn is over and nothing new
          // starts: answering "stop" with another answer is exactly wrong.
          this.backToListening('caller said stop');
          return;
        }

        if (classification.kind === 'resume') {
          this.session.resumeHint = this.session.conversation.lastUnspoken();
        }

        await this.handleUtterance(result!.text, result!.ms);
      } catch (error) {
        console.error(`❌ audio:input failed: ${describeError(error)}`);
        this.ports.emit('error', {
          message: error instanceof Error ? error.message : 'Could not process audio',
        });
        this.setState('listening');
        this.ports.emit('ready:listening', { turnId: this.session.turnId });
      }
  }

  /** Every chunk for a turn has finished playing — the turn is now history. */
  playbackComplete(raw: unknown) {
    const parsed = validatePlayback(raw);
    if (!parsed.ok) {
      note('dropped playback:complete', { reason: parsed.reason });
      return;
    }
    const data = parsed.value;
    if (data.turnId !== this.session.pendingTurnId) {
      // Stale or unknown turn — usually a turn that was interrupted after its
      // audio was queued. Dropping it silently used to leave the call wedged,
      // because nothing else would ever move it back to listening.
      note('stale playback:complete', {
        received: data.turnId,
        pending: this.session.pendingTurnId,
      });
      if (this.session.controller === null && this.session.pendingTurnId === null) {
        this.backToListening('stale playback:complete with nothing in flight');
      }
      return;
    }

    if (this.session.pendingText) {
      this.session.conversation.commitComplete(data.turnId, this.session.pendingText);
    }
    this.session.pendingText = null;
    this.session.pendingTurnId = null;

    this.setState('listening');
    this.ports.emit('ready:listening', { turnId: data.turnId });
  }

  callEnd() {
    this.abortActiveTurn('caller ended the call');
    this.session.conversation.reset();
    this.setState('ended');
  }

  /**
   * Backstop for the state machine.
   *
   * Rapid interruptions can abandon a turn with no successor — the aborted
   * generation returns silently, the client has dropped its queued audio, and
   * nobody is left to move the call on. Rather than enumerate every such race,
   * recover from any busy state that has stopped making progress.
   */
  watchdogTick() {
    const busy =
      this.session.state === 'thinking' || this.session.state === 'speaking' || this.session.state === 'paused';
    if (!busy) return;
    if (this.session.controller !== null) return; // generation genuinely in flight

    const idleFor = (this.options.now ?? Date.now)() - this.lastProgressAt;
    const budget = this.session.state === 'speaking' ? SPEAKING_STUCK_TIMEOUT_MS : STUCK_TIMEOUT_MS;
    if (idleFor < budget) return;

    console.warn(
      `⚠️  watchdog: '${this.session.state}' made no progress for ${idleFor}ms ` +
        `(budget ${budget}ms) — returning to listening`
    );
    this.backToListening('watchdog');
  }

  disconnect() {
    this.closed = true;
    this.abortActiveTurn('client disconnected');
    // Nothing should answer into a socket that is gone.
    this.session.conversation.reset();
    this.session.pendingText = null;
    this.session.pendingTurnId = null;
    this.session.state = 'ended';
  }
}
