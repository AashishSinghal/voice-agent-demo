/**
 * Play a recorded voice through the caller's side of a call, offline.
 *
 * The audio goes frame by frame through the real speech detector (`vad.ts`) on a
 * simulated clock, and what it reports goes into the real turn-taking module
 * (`turnTaking.ts`), exactly as `VoiceAgent.tsx` wires them. The result says
 * what the browser would have done with that clip: send it to the server, or
 * throw it away. No microphone, browser, server or network is involved.
 *
 * Out of scope: what the server then does (transcription, classification).
 * `replay.ts` covers the browser's reaction to server events; this covers the
 * microphone half.
 */

import type { CallState } from '../stores/useBotStateStore';
import {
  initialState,
  step,
  vadTuning,
  type SendPayload,
  type TurnTakingCommand,
  type TurnTakingEvent,
} from './turnTaking.ts';
import { createVad } from './vad.ts';

/** The detector's analysis window (the analyser's `fftSize`) and frame cadence. */
const WINDOW = 1024;
const FRAME_MS = 16;
/** The thresholds' multipliers, as `VoiceAgent.tsx` passes them. */
const SPEECH_FACTOR = 3;
const SILENCE_FACTOR = 1.8;
/** A quiet room: matches the floor measured on a MacBook mic in a real call. */
const ROOM_RMS = 0.0055;

export interface SimulationOptions {
  /** `agent`: the clip is the caller talking over the agent. Default: an idle call. */
  during?: 'idle' | 'agent';
  /** Room tone before the clip, long enough for the noise floor to settle. */
  leadMs?: number;
  /** Room tone after it, longer than the endpoint window. */
  trailMs?: number;
  /** Scale the clip so its loudest sample is this (0-1). Omit to leave as is. */
  peak?: number;
}

export interface SimulationResult {
  /** The clip the browser would have sent, if any. */
  sent: SendPayload | null;
  /** Recordings thrown away as too brief to be speech. */
  discarded: number;
  /** The module's own notes, for working out why. */
  traces: string[];
}

/** Deterministic room tone: a seeded generator keeps a failure reproducible. */
function roomTone(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    // Uniform in [-1, 1) has an RMS of 1/sqrt(3); scale to the target level.
    out[i] = ((x / 2 ** 32) * 2 - 1) * ROOM_RMS * Math.sqrt(3);
  }
  return out;
}

export function simulateCall(
  clip: Float32Array,
  sampleRate: number,
  options: SimulationOptions = {}
): SimulationResult {
  const { during = 'idle', leadMs = 3000, trailMs = 2500, peak } = options;
  const perMs = sampleRate / 1000;

  let voice = clip;
  if (peak !== undefined) {
    const loudest = clip.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (loudest > 0) voice = clip.map((v) => (v * peak) / loudest);
  }

  const lead = Math.round(leadMs * perMs);
  const trail = Math.round(trailMs * perMs);
  const samples = roomTone(lead + voice.length + trail, 1);
  for (let i = 0; i < voice.length; i++) samples[lead + i] += voice[i];

  const vad = createVad();
  const result: SimulationResult = { sent: null, discarded: 0, traces: [] };
  // A real clock value, not zero: the module treats 0 as "not set".
  const t0 = 1_000_000;
  let now = t0;
  let callState: CallState = during === 'agent' ? 'speaking' : 'listening';
  const chunksPlayed = during === 'agent' ? 1 : 0;
  const latestTurn = during === 'agent' ? 1 : null;
  let state = initialState();

  const dispatch = (event: TurnTakingEvent) => {
    const next = step(state, event);
    state = next.state;
    for (const command of next.commands) execute(command);
  };

  function execute(command: TurnTakingCommand) {
    switch (command.type) {
      case 'stopRecording':
        // The recorder stops asynchronously, then a fresh one starts.
        dispatch({ type: 'recordingReady' });
        dispatch({ type: 'recordingStarted', now });
        break;
      case 'discardRecording':
        result.discarded += 1;
        dispatch({ type: 'recordingStarted', now });
        break;
      case 'sendClip':
        result.sent = command.send;
        break;
      case 'pausePlayback':
        // The server answers a barge with the paused state.
        callState = 'paused';
        break;
      case 'resumePlayback':
        callState = 'speaking';
        break;
      case 'trace':
        result.traces.push(command.detail ? `${command.label}: ${command.detail}` : command.label);
        break;
    }
  }

  dispatch({ type: 'callStarted' });
  dispatch({ type: 'recordingStarted', now });

  let nextTick = t0 + 1000;
  for (let end = WINDOW; end <= samples.length && !result.sent; end += Math.round(FRAME_MS * perMs)) {
    now = t0 + end / perMs;

    let sumSquares = 0;
    for (let i = end - WINDOW; i < end; i++) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / WINDOW);

    const tuning = vadTuning(callState);
    const events = vad.push(rms, now, {
      speechDuration: tuning.speechDurationMs,
      silenceDuration: tuning.silenceDurationMs,
      speechFactor: SPEECH_FACTOR,
      silenceFactor: SILENCE_FACTOR,
    });
    for (const event of events) {
      if (event === 'start') {
        dispatch({ type: 'speechStart', now, callState, chunksPlayed, latestTurn });
      } else {
        dispatch({ type: 'speechEnd', now, callState, recording: true, chunksPlayed });
      }
    }
    if (now >= nextTick) {
      nextTick += 1000;
      dispatch({ type: 'tick', now, quiet: rms < vad.calibration.silenceThreshold, chunksPlayed });
    }
  }
  return result;
}
