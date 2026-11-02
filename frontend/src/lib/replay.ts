/**
 * Replay a recorded call through the turn-taking module.
 *
 * A diagnostics bundle is an ordered log of everything the browser saw and did.
 * The module's inputs are exactly such events, so a real call can be fed back in
 * with no microphone and checked against what happened. Anything a future bundle
 * shows going wrong becomes a test by saving its sanitised log as a fixture.
 *
 * Pure: no file access. `parseDiagnostics` reads the text a bundle holds,
 * `sanitise` strips it to what replay needs (no transcripts, no server output),
 * and `replay` runs it.
 */

import type { CallState } from '../stores/useBotStateStore';
import {
  initialState,
  step,
  TIMING,
  type SendPayload,
  type TurnTakingCommand,
  type TurnTakingEvent,
  type TurnTakingState,
} from './turnTaking.ts';

export interface LogLine {
  /** Seconds since the call page opened. */
  t: number;
  source: string;
  name: string;
  data: Record<string, unknown>;
}

const LINE = /^\s*(\d+(?:\.\d+)?)s\s+(\S+)\s+(.*)$/;

/** Parse the `## timeline` section of diagnostics.txt. */
export function parseDiagnostics(text: string): LogLine[] {
  const lines: LogLine[] = [];
  let inTimeline = false;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('## ')) {
      inTimeline = raw.trim() === '## timeline';
      continue;
    }
    if (!inTimeline) continue;
    const match = LINE.exec(raw);
    if (!match) continue;

    const rest = match[3];
    const brace = rest.indexOf(' {');
    let name = rest;
    let data: Record<string, unknown> = {};
    if (brace !== -1) {
      name = rest.slice(0, brace);
      try {
        data = JSON.parse(rest.slice(brace + 1));
      } catch {
        // A truncated trailer is not worth failing a replay over.
      }
    }
    lines.push({ t: Number(match[1]), source: match[2], name: name.trim(), data });
  }
  return lines;
}

/**
 * What replay needs from a log, and nothing else.
 *
 * Bundles hold transcripts and the server's own output. This keeps only event
 * names, timings and numbers, so a fixture can be committed to a public
 * repository without publishing what anyone said.
 */
const KEEP: Record<string, Record<string, string[]>> = {
  client: { 'call started': [], state: ['from', 'to', 'reason'] },
  vad: {
    'speech start': [],
    'speech end': [],
    level: ['rms', 'floor'],
  },
  audio: {
    'recorder started': [],
    'recording ready': [],
    'recording discarded': [],
    'chunk queued': ['turnId', 'index'],
    'chunk ended': ['turnId', 'index'],
    'chunk error': ['turnId', 'index'],
    'playback stopped': [],
    'playback paused': [],
  },
  'socket-in': {
    'response:audio:chunk': ['turnId', 'index'],
    'turn:interrupted': ['turnId'],
    'playback:resume': [],
    'ready:listening': ['turnId'],
  },
  'socket-out': {
    'call:start': [],
    'call:end': [],
    'barge:detected': ['turnId', 'chunksPlayed'],
    'barge:cancelled': ['reason'],
    'audio:input': ['duringPlayback', 'spokenChunks', 'trimStartMs', 'spokenMs', 'clipMs'],
    'playback:complete': ['turnId'],
  },
};

export function sanitise(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  let lastLevelAt = -Infinity;
  for (const line of lines) {
    const keys = KEEP[line.source]?.[line.name];
    if (!keys) continue;
    // Microphone levels only matter once a second, for the idle-recycle check.
    if (line.name === 'level') {
      if (line.t - lastLevelAt < 1) continue;
      lastLevelAt = line.t;
    }
    const data: Record<string, unknown> = {};
    for (const key of keys) if (key in line.data) data[key] = line.data[key];
    out.push({ ...line, data });
  }
  return out;
}

// -- replay -----------------------------------------------------------------

/** What the browser itself reported sending, for comparison. */
export interface RecordedSend extends SendPayload {
  t: number;
}
export interface RecordedBarge {
  t: number;
  turnId: number;
  chunksPlayed: number;
}

export interface ReplayResult {
  /** Every command the module issued, with the time of the event that caused it. */
  commands: { t: number; command: TurnTakingCommand; cause: TurnTakingEvent['type'] }[];
  /** Checked against the module's pre-event state, one per event. */
  trail: { t: number; before: TurnTakingState; event: TurnTakingEvent; commands: TurnTakingCommand[] }[];
  recordedSends: RecordedSend[];
  recordedBarges: RecordedBarge[];
  final: TurnTakingState;
}

/** The slice of the outside world the module is told about with each event. */
interface World {
  callState: CallState;
  chunksPlayed: number;
  latestTurn: number | null;
  recording: boolean;
  lastLevel: { rms: number; floor: number } | null;
}

export function replay(lines: LogLine[]): ReplayResult {
  let state = initialState();
  const world: World = {
    callState: 'idle',
    chunksPlayed: 0,
    latestTurn: null,
    recording: false,
    lastLevel: null,
  };
  const commands: ReplayResult['commands'] = [];
  const trail: ReplayResult['trail'] = [];
  const recordedSends: RecordedSend[] = [];
  const recordedBarges: RecordedBarge[] = [];
  // The browser's watchdog ticks once a second from when recording began.
  let nextTick: number | null = null;

  const feed = (t: number, event: TurnTakingEvent) => {
    const before = state;
    const next = step(state, event);
    state = next.state;
    trail.push({ t, before, event, commands: next.commands });
    for (const command of next.commands) commands.push({ t, command, cause: event.type });
  };

  for (const line of lines) {
    const now = Math.round(line.t * 1000);

    // The watchdog ticks once a second in the browser; replay supplies the same.
    while (nextTick !== null && nextTick <= line.t) {
      const level = world.lastLevel;
      const quiet = level ? level.rms < Math.max(level.floor * 1.8, 0.006) : true;
      feed(nextTick, { type: 'tick', now: nextTick * 1000, quiet, chunksPlayed: world.chunksPlayed });
      nextTick += 1;
    }

    const key = `${line.source}/${line.name}`;
    switch (key) {
      case 'client/call started':
        feed(line.t, { type: 'callStarted' });
        break;
      case 'client/state':
        world.callState = line.data.to as CallState;
        break;
      case 'vad/level':
        world.lastLevel = { rms: Number(line.data.rms), floor: Number(line.data.floor) };
        break;
      case 'vad/speech start':
        feed(line.t, {
          type: 'speechStart',
          now,
          callState: world.callState,
          chunksPlayed: world.chunksPlayed,
          latestTurn: world.latestTurn,
        });
        break;
      case 'vad/speech end':
        feed(line.t, {
          type: 'speechEnd',
          now,
          callState: world.callState,
          recording: world.recording,
          chunksPlayed: world.chunksPlayed,
        });
        break;
      case 'audio/recorder started':
        world.recording = true;
        if (nextTick === null) nextTick = line.t + 1;
        feed(line.t, { type: 'recordingStarted', now });
        break;
      case 'audio/recording ready':
        // The next recorder is already running by now: logs show it starting just
        // before the old clip is reported, so recording stays true for the call.
        feed(line.t, { type: 'recordingReady' });
        break;
      case 'socket-in/response:audio:chunk': {
        const turnId = Number(line.data.turnId);
        feed(line.t, {
          type: 'audioChunk',
          turnId,
          chunksPlayed: world.chunksPlayed,
          latestTurn: world.latestTurn,
        });
        // What playback does with it: a newer turn restarts the count.
        if (world.latestTurn !== null && turnId !== world.latestTurn) world.chunksPlayed = 0;
        world.latestTurn = turnId;
        break;
      }
      case 'audio/chunk ended':
      case 'audio/chunk error':
        world.chunksPlayed += 1;
        break;
      case 'audio/playback stopped':
        world.chunksPlayed = 0;
        world.latestTurn = null;
        break;
      case 'socket-in/turn:interrupted':
        feed(line.t, { type: 'serverInterrupted' });
        break;
      case 'socket-in/playback:resume':
        feed(line.t, { type: 'serverResume' });
        break;
      case 'socket-in/ready:listening':
        feed(line.t, { type: 'readyToListen' });
        break;
      case 'socket-out/call:end':
        world.recording = false;
        feed(line.t, { type: 'callEnded' });
        break;
      case 'socket-out/audio:input': {
        const d = line.data as unknown as SendPayload;
        recordedSends.push({
          t: line.t,
          duringPlayback: Boolean(d.duringPlayback),
          spokenChunks: Number(d.spokenChunks),
          trimStartMs: Number(d.trimStartMs),
          spokenMs: Number(d.spokenMs),
          clipMs: Number(d.clipMs),
        });
        break;
      }
      case 'socket-out/barge:detected':
        recordedBarges.push({
          t: line.t,
          turnId: Number(line.data.turnId),
          chunksPlayed: Number(line.data.chunksPlayed),
        });
        break;
    }
  }

  return { commands, trail, recordedSends, recordedBarges, final: state };
}

/**
 * Properties that must hold for any call, recorded or invented. Returns a list
 * of violations; empty means the module behaved.
 */
export function checkInvariants(result: ReplayResult): string[] {
  const problems: string[] = [];
  let paused = 0;
  let notified = 0;

  for (const { t, before, event, commands } of result.trail) {
    const at = `t=${t.toFixed(2)}s ${event.type}`;
    const has = (type: TurnTakingCommand['type']) => commands.some((c) => c.type === type);
    const kinds = commands.map((c) => c.type);

    // Audio never starts playing over live speech.
    for (const c of commands) {
      if (c.type === 'enqueueAudio' && !c.hold && before.callActive && before.sawSpeech && !before.barging) {
        problems.push(`${at}: audio played over live speech`);
      }
    }

    // Pausing and telling the server are one act.
    if (has('pausePlayback') !== has('notifyBarge')) problems.push(`${at}: pause and notify disagree (${kinds})`);
    paused += commands.filter((c) => c.type === 'pausePlayback').length;
    notified += commands.filter((c) => c.type === 'notifyBarge').length;

    // An over-speech clip is never silently dropped: it is sent, or the agent resumes.
    if (event.type === 'speechEnd' && before.barging && event.recording && before.sawSpeech) {
      const sent = has('stopRecording');
      const resumed = has('resumePlayback') && has('cancelBarge');
      if (!sent && !resumed) problems.push(`${at}: barge ended with neither a send nor a resume`);
    }

    // Every clip carries real metadata.
    if (event.type === 'recordingReady') {
      for (const c of commands) {
        if (c.type !== 'sendClip') continue;
        const s = c.send;
        if (s.spokenMs <= 0) problems.push(`${at}: sent with spokenMs ${s.spokenMs}`);
        if (s.clipMs <= 0) problems.push(`${at}: sent with clipMs ${s.clipMs}`);
        if (s.trimStartMs < 0) problems.push(`${at}: negative trim`);
        if (s.clipMs + TIMING.BARGE_SPEECH_MS < s.spokenMs) problems.push(`${at}: clip shorter than the speech in it`);
      }
    }

    // Nothing is sent after hanging up, and only clips that were asked for.
    if (!before.callActive && has('sendClip')) problems.push(`${at}: sent a clip after the call ended`);
    if (before.clipsOwed <= 0 && has('sendClip')) problems.push(`${at}: sent a clip nobody asked for`);
  }

  if (paused !== notified) problems.push(`pauses (${paused}) and barge notifications (${notified}) differ`);
  return problems;
}
