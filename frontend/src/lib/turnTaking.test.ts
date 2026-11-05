import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialState,
  step,
  TIMING,
  vadTuning,
  type TurnTakingCommand,
  type TurnTakingEvent,
  type TurnTakingState,
} from './turnTaking.ts';

/** Feed events through the module, collecting every command in order. */
function run(events: TurnTakingEvent[], start: TurnTakingState = initialState()) {
  let state = start;
  const commands: TurnTakingCommand[] = [];
  for (const event of events) {
    const next = step(state, event);
    state = next.state;
    commands.push(...next.commands);
  }
  return { state, commands };
}

const of = <T extends TurnTakingCommand['type']>(commands: TurnTakingCommand[], type: T) =>
  commands.filter((c): c is Extract<TurnTakingCommand, { type: T }> => c.type === type);

/** A call with the recorder running from t=1000. */
const inCall: TurnTakingEvent[] = [{ type: 'callStarted' }, { type: 'recordingStarted', now: 1000 }];

const start = (now: number, callState: 'listening' | 'speaking' | 'thinking', extra = {}) =>
  ({ type: 'speechStart', now, callState, chunksPlayed: 0, latestTurn: null, ...extra }) as TurnTakingEvent;
const end = (now: number, callState: 'listening' | 'paused' | 'speaking' | 'thinking', extra = {}) =>
  ({ type: 'speechEnd', now, callState, recording: true, chunksPlayed: 0, ...extra }) as TurnTakingEvent;

// --- a normal turn -----------------------------------------------------------

test('a normal turn is sent as a turn, and the screen goes to thinking at once', () => {
  const { commands } = run([...inCall, start(2000, 'listening'), end(5000, 'listening'), { type: 'recordingReady' }]);
  const send = of(commands, 'sendClip')[0].send;
  assert.equal(send.duringPlayback, false);
  assert.equal(send.spokenMs, 5000 - TIMING.ENDPOINT_MS - 2000 + TIMING.SPEECH_ONSET_MS);
  assert.equal(send.trimStartMs, Math.max(0, 2000 - 1000 - TIMING.PREROLL_MS));
  assert.ok(of(commands, 'setThinking').length === 1, 'optimistic thinking');
  assert.equal(of(commands, 'notifyBarge').length, 0);
});

test('a normal turn starts the latency clock at the moment the caller fell silent', () => {
  const { commands } = run([...inCall, start(2000, 'listening'), end(5000, 'listening')]);
  assert.deepEqual(of(commands, 'timeline').filter((c) => c.op === 'start'), [
    { type: 'timeline', op: 'start', kind: 'turn', backdateMs: TIMING.ENDPOINT_MS },
  ]);
});

test('an interruption is not timed as a turn', () => {
  const { commands } = run([
    ...inCall,
    start(4000, 'speaking', { latestTurn: 3 }),
    end(6000, 'paused'),
  ]);
  assert.equal(of(commands, 'timeline').filter((c) => c.op === 'start' && c.kind === 'turn').length, 0);
});

test('a brief burst is discarded rather than transcribed', () => {
  const { commands } = run([...inCall, start(2000, 'listening'), end(2000 + TIMING.ENDPOINT_MS + 10, 'listening')]);
  assert.equal(of(commands, 'discardRecording').length, 1);
  assert.equal(of(commands, 'stopRecording').length, 0);
});

test('speech end with nothing recording or nothing heard does nothing', () => {
  assert.equal(of(run([...inCall, end(3000, 'listening', { recording: false })]).commands, 'stopRecording').length, 0);
  assert.equal(of(run([...inCall, end(3000, 'listening')]).commands, 'stopRecording').length, 0);
});

// --- barge-in ----------------------------------------------------------------

test('speaking over the agent pauses it and tells the server which turn and how far', () => {
  const { commands, state } = run([
    ...inCall,
    start(4000, 'speaking', { chunksPlayed: 2, latestTurn: 5 }),
  ]);
  assert.equal(of(commands, 'pausePlayback').length, 1);
  assert.deepEqual(of(commands, 'notifyBarge'), [{ type: 'notifyBarge', turnId: 5, chunksPlayed: 2 }]);
  assert.equal(state.barging, true);
});

test('an interruption is sent as over-speech with the chunks heard at the moment of the barge', () => {
  const { commands } = run([
    ...inCall,
    start(4000, 'speaking', { chunksPlayed: 2, latestTurn: 5 }),
    end(6000, 'paused', { chunksPlayed: 3 }),
    { type: 'recordingReady' },
  ]);
  const send = of(commands, 'sendClip')[0].send;
  assert.equal(send.duringPlayback, true);
  assert.equal(send.spokenChunks, 2, 'not the later count');
  assert.equal(of(commands, 'setThinking').length, 0, 'the server decides, so no optimistic thinking');
});

test('a barge that was only noise resumes the agent and tells the server', () => {
  const { commands, state } = run([
    ...inCall,
    start(4000, 'speaking', { chunksPlayed: 1, latestTurn: 2 }),
    end(4000 + TIMING.ENDPOINT_OVER_SPEECH_MS + 20, 'paused'),
  ]);
  assert.equal(of(commands, 'resumePlayback').length, 1);
  assert.deepEqual(of(commands, 'cancelBarge'), [{ type: 'cancelBarge', reason: 'no speech detected' }]);
  assert.equal(state.barging, false);
});

test('"stop" is long enough to count as an interruption', () => {
  // A 300 ms word, confirmed after BARGE_SPEECH_MS, then the over-speech silence window.
  const confirmed = 5000;
  const wordEnds = confirmed + (300 - TIMING.BARGE_SPEECH_MS);
  const { commands } = run([
    ...inCall,
    start(confirmed, 'speaking', { latestTurn: 3 }),
    end(wordEnds + TIMING.ENDPOINT_OVER_SPEECH_MS, 'paused'),
  ]);
  const stopped = of(commands, 'stopRecording');
  assert.equal(stopped.length, 1, 'it is sent, not discarded as under the minimum');
});

test('the same word under the normal rules would have been dropped', () => {
  const confirmed = 5000;
  const wordEnds = confirmed + 20; // onset + 20 ms: 270 ms audible, under the 300 ms minimum
  const { commands } = run([
    ...inCall,
    start(confirmed, 'listening'),
    end(wordEnds + TIMING.ENDPOINT_MS, 'listening'),
  ]);
  assert.equal(of(commands, 'discardRecording').length, 1);
});

// --- audio arriving into live speech -----------------------------------------

test('audio that arrives while the caller is mid-sentence is held and reported as a barge', () => {
  // The real case: speech began while the state still read "thinking", then the
  // agent's first chunk landed 10 ms later and started talking over the caller.
  const { commands } = run([
    ...inCall,
    start(15340, 'thinking'),
    { type: 'audioChunk', turnId: 6, chunksPlayed: 0, latestTurn: null },
  ]);
  assert.deepEqual(of(commands, 'enqueueAudio'), [{ type: 'enqueueAudio', hold: true }]);
  assert.deepEqual(of(commands, 'notifyBarge'), [{ type: 'notifyBarge', turnId: 6, chunksPlayed: 0 }]);
  assert.equal(of(commands, 'pausePlayback').length, 1);
});

test('a chunk from a newer turn counts from zero', () => {
  const { commands } = run([
    ...inCall,
    start(15340, 'thinking'),
    { type: 'audioChunk', turnId: 7, chunksPlayed: 4, latestTurn: 6 },
  ]);
  assert.equal(of(commands, 'notifyBarge')[0].chunksPlayed, 0);
});

test('audio into a quiet room plays normally', () => {
  const { commands } = run([...inCall, { type: 'audioChunk', turnId: 1, chunksPlayed: 0, latestTurn: null }]);
  assert.deepEqual(of(commands, 'enqueueAudio'), [{ type: 'enqueueAudio', hold: false }]);
  assert.equal(of(commands, 'pausePlayback').length, 0);
});

test('later chunks of an interruption are not reported twice', () => {
  const { commands } = run([
    ...inCall,
    start(15340, 'thinking'),
    { type: 'audioChunk', turnId: 6, chunksPlayed: 0, latestTurn: null },
    { type: 'audioChunk', turnId: 6, chunksPlayed: 0, latestTurn: 6 },
  ]);
  assert.equal(of(commands, 'notifyBarge').length, 1);
  assert.deepEqual(of(commands, 'enqueueAudio').map((c) => c.hold), [true, false]);
});

test('no barge once the call has ended', () => {
  const { commands } = run([
    ...inCall,
    start(15340, 'thinking'),
    { type: 'callEnded' },
    { type: 'audioChunk', turnId: 6, chunksPlayed: 0, latestTurn: null },
  ]);
  assert.equal(of(commands, 'notifyBarge').length, 0);
});

// --- the watchdog ------------------------------------------------------------

test('a forced send at the maximum turn carries real metadata, not the previous send\'s', () => {
  // It used to go out with spokenMs 0, clipMs 0 and no trim, so the server
  // billed and trimmed the wrong thing.
  const { commands } = run([
    ...inCall,
    start(2000, 'listening'),
    { type: 'tick', now: 2000 + TIMING.MAX_TURN_MS + 1, quiet: false, chunksPlayed: 0 },
    { type: 'recordingReady' },
  ]);
  const send = of(commands, 'sendClip')[0].send;
  assert.ok(send.spokenMs >= TIMING.MAX_TURN_MS, `spokenMs ${send.spokenMs}`);
  assert.ok(send.clipMs >= TIMING.MAX_TURN_MS, `clipMs ${send.clipMs}`);
  assert.ok(send.trimStartMs >= 0);
});

test('silence is recycled, but never while the caller may be about to speak', () => {
  const idle = 1000 + TIMING.IDLE_RECYCLE_MS + 1;
  assert.equal(of(run([...inCall, { type: 'tick', now: idle, quiet: true, chunksPlayed: 0 }]).commands, 'discardRecording').length, 1);
  assert.equal(of(run([...inCall, { type: 'tick', now: idle, quiet: false, chunksPlayed: 0 }]).commands, 'discardRecording').length, 0);
  assert.equal(of(run([...inCall, { type: 'tick', now: 1000 + 500, quiet: true, chunksPlayed: 0 }]).commands, 'discardRecording').length, 0);
});

// --- the server speaking back ------------------------------------------------

test('server decisions release playback', () => {
  const barged = run([...inCall, start(4000, 'speaking', { latestTurn: 1 })]);
  const resumed = run([{ type: 'serverResume' }], barged.state);
  assert.equal(of(resumed.commands, 'resumePlayback').length, 1);
  assert.equal(resumed.state.barging, false);

  const interrupted = run([{ type: 'serverInterrupted' }], barged.state);
  assert.equal(of(interrupted.commands, 'stopPlayback').length, 1);
  assert.equal(interrupted.state.barging, false);

  const ready = run([{ type: 'readyToListen' }]);
  assert.deepEqual(ready.commands.map((c) => c.type), ['stopPlayback', 'resetPlaybackCounter']);
});

test('a clip that arrives after hanging up is dropped', () => {
  const { commands } = run([...inCall, start(2000, 'listening'), end(6000, 'listening'), { type: 'callEnded' }, { type: 'recordingReady' }]);
  assert.deepEqual(of(commands, 'dropClip'), [{ type: 'dropClip', reason: 'call ended' }]);
  assert.equal(of(commands, 'sendClip').length, 0);
});

test('a new call does not inherit the last one\'s barge', () => {
  const stale = run([...inCall, start(4000, 'speaking', { latestTurn: 1 })]);
  assert.equal(stale.state.barging, true);
  assert.equal(step(stale.state, { type: 'callStarted' }).state.barging, false);
});

test('the speech detector listens harder while the agent talks', () => {
  assert.equal(vadTuning('speaking').speechDurationMs, TIMING.BARGE_SPEECH_MS);
  assert.equal(vadTuning('listening').speechDurationMs, TIMING.SPEECH_ONSET_MS);
  assert.equal(vadTuning('paused').silenceDurationMs, TIMING.ENDPOINT_OVER_SPEECH_MS);
  assert.equal(vadTuning('speaking').silenceDurationMs, TIMING.ENDPOINT_MS);
});

test('a clip nobody asked for is dropped, not sent with empty metadata', () => {
  const { commands } = run([...inCall, { type: 'recordingReady' }]);
  assert.deepEqual(of(commands, 'dropClip'), [{ type: 'dropClip', reason: 'not requested' }]);
  assert.equal(of(commands, 'sendClip').length, 0);
});

test('an unknown event is ignored rather than breaking the call', () => {
  const before = run(inCall).state;
  const after = step(before, { type: 'somethingNew' } as never);
  assert.deepEqual(after.state, before);
  assert.deepEqual(after.commands, []);
});
