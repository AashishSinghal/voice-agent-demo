import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  checkInvariants,
  parseDiagnostics,
  replay,
  sanitise,
  type LogLine,
} from './replay.ts';
import {
  initialState,
  step,
  TIMING,
  type TurnTakingCommand,
  type TurnTakingEvent,
  type TurnTakingState,
} from './turnTaking.ts';

const fixture = (name: string): { note: string; lines: LogLine[] } =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// --- reading a bundle --------------------------------------------------------

const SAMPLE = `# voice-agent diagnostics
## environment
micLabel: "Built-in"
## timeline
   2.35s client     call started
  11.32s vad        speech start {"rms":0.0985,"threshold":0.0262,"floor":0.0087}
  28.29s server     ✅ Transcription: "Here is something somebody said"
  28.29s socket-in  transcription:complete {"text":"Here is something somebody said"}
  30.57s socket-in  response:audio:chunk {"turnId":2,"index":0,"text":"A private reply","audioBytes":180550}
  38.34s socket-out barge:detected {"turnId":2,"chunksPlayed":1}
  40.97s socket-out audio:input {"bytes":57290,"duringPlayback":true,"spokenChunks":1,"trimStartMs":227,"spokenMs":2289,"clipMs":3319}
`;

test('a bundle parses into timed events with their data', () => {
  const lines = parseDiagnostics(SAMPLE);
  assert.equal(lines.length, 7);
  assert.deepEqual(lines[1], {
    t: 11.32,
    source: 'vad',
    name: 'speech start',
    data: { rms: 0.0985, threshold: 0.0262, floor: 0.0087 },
  });
});

test('sanitising keeps timings and numbers but never what anyone said', () => {
  const kept = sanitise(parseDiagnostics(SAMPLE));
  const text = JSON.stringify(kept);
  assert.ok(!text.includes('somebody said'), 'transcript leaked');
  assert.ok(!text.includes('private reply'), 'reply text leaked');
  assert.ok(!text.includes('audioBytes') && !text.includes('"bytes"'));
  assert.deepEqual(kept.map((l) => l.name), ['call started', 'speech start', 'response:audio:chunk', 'barge:detected', 'audio:input']);
});

test('committed fixtures contain nothing but event names and numbers', () => {
  for (const name of fs.readdirSync(new URL('./fixtures/', import.meta.url))) {
    const { lines } = fixture(name);
    for (const line of lines) {
      for (const [key, value] of Object.entries(line.data)) {
        assert.ok(
          typeof value === 'number' || typeof value === 'boolean' || ['from', 'to', 'reason'].includes(key),
          `${name}: ${line.name}.${key} is free text`
        );
      }
    }
  }
});

// --- a real call -------------------------------------------------------------

test('hosted call: every invariant holds', () => {
  const result = replay(fixture('hosted-2026-10-21.json').lines);
  assert.deepEqual(checkInvariants(result), []);
});

test('hosted call: each barge the browser reported is one the module also makes, with the same turn and count', () => {
  const result = replay(fixture('hosted-2026-10-21.json').lines);
  const made = result.commands.filter((c) => c.command.type === 'notifyBarge');
  assert.equal(result.recordedBarges.length, 2);
  for (const recorded of result.recordedBarges) {
    const match = made.find((m) => Math.abs(m.t - recorded.t) < 0.5);
    assert.ok(match, `no barge near ${recorded.t}s`);
    const cmd = match.command as Extract<TurnTakingCommand, { type: 'notifyBarge' }>;
    assert.equal(cmd.turnId, recorded.turnId);
    assert.equal(cmd.chunksPlayed, recorded.chunksPlayed);
  }
});

test('hosted call: the sends match what the browser sent, except the forced one it used to get wrong', () => {
  const result = replay(fixture('hosted-2026-10-21.json').lines);
  const made = result.commands.flatMap((c) => (c.command.type === 'sendClip' ? [{ t: c.t, send: c.command.send }] : []));
  assert.equal(made.length, result.recordedSends.length);

  result.recordedSends.forEach((recorded, i) => {
    const mine = made[i].send;
    assert.equal(mine.duringPlayback, recorded.duringPlayback, `send ${i}: over-speech flag`);
    if (recorded.spokenMs === 0 && recorded.clipMs === 0) {
      // The forced 15 s send went out with the previous send's leftovers. The
      // module now sends what the clip really is.
      assert.ok(mine.spokenMs >= TIMING.MAX_TURN_MS && mine.clipMs >= TIMING.MAX_TURN_MS, 'forced send has real metadata');
    } else {
      assert.ok(Math.abs(mine.spokenMs - recorded.spokenMs) <= 150, `send ${i}: spokenMs ${mine.spokenMs} vs ${recorded.spokenMs}`);
      assert.ok(Math.abs(mine.clipMs - recorded.clipMs) <= 150, `send ${i}: clipMs ${mine.clipMs} vs ${recorded.clipMs}`);
    }
  });
});

test('the 2026-10-14 call: audio landing on the caller is held and reported, not played over them', () => {
  const result = replay(fixture('audio-lands-on-caller-2026-10-14.json').lines);
  assert.deepEqual(checkInvariants(result), []);

  const arrival = result.commands.filter((c) => c.t === 15.36);
  const enqueue = arrival.find((c) => c.command.type === 'enqueueAudio')!.command as Extract<TurnTakingCommand, { type: 'enqueueAudio' }>;
  assert.equal(enqueue.hold, true);
  const barge = arrival.find((c) => c.command.type === 'notifyBarge')!.command as Extract<TurnTakingCommand, { type: 'notifyBarge' }>;
  assert.equal(barge.turnId, 6);

  // ...so the clip goes up as an interruption, which is what makes the server
  // drop the old answer, instead of as an ordinary turn.
  const late = result.commands.find((c) => c.t === 17.02 && c.command.type === 'sendClip')!.command as Extract<TurnTakingCommand, { type: 'sendClip' }>;
  assert.equal(late.send.duringPlayback, true);
});

// --- invented calls ----------------------------------------------------------

/** A small deterministic generator, so a failing sequence can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('invented calls: no sequence of events breaks an invariant', () => {
  const states = ['listening', 'thinking', 'speaking', 'paused'] as const;
  for (let seed = 1; seed <= 300; seed++) {
    const rand = rng(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    let state: TurnTakingState = initialState();
    let now = 1000;
    let chunksPlayed = 0;
    let latestTurn: number | null = null;
    const trail: { t: number; before: TurnTakingState; event: TurnTakingEvent; commands: TurnTakingCommand[] }[] = [];

    const feed = (event: TurnTakingEvent) => {
      const before = state;
      const next = step(state, event);
      state = next.state;
      trail.push({ t: now / 1000, before, event, commands: next.commands });
    };

    feed({ type: 'callStarted' });
    feed({ type: 'recordingStarted', now });
    for (let i = 0; i < 80; i++) {
      now += Math.floor(rand() * 2500) + 10;
      const callState = pick(states);
      const kind = rand();
      if (kind < 0.2) feed({ type: 'speechStart', now, callState, chunksPlayed, latestTurn });
      else if (kind < 0.4) feed({ type: 'speechEnd', now, callState, recording: rand() < 0.95, chunksPlayed });
      else if (kind < 0.55) {
        const turnId = Math.floor(rand() * 4) + 1;
        feed({ type: 'audioChunk', turnId, chunksPlayed, latestTurn });
        if (latestTurn !== null && turnId !== latestTurn) chunksPlayed = 0;
        latestTurn = turnId;
      } else if (kind < 0.65) feed({ type: 'tick', now, quiet: rand() < 0.5, chunksPlayed });
      else if (kind < 0.72) feed({ type: 'serverResume' });
      else if (kind < 0.79) feed({ type: 'serverInterrupted' });
      else if (kind < 0.85) { feed({ type: 'readyToListen' }); chunksPlayed = 0; latestTurn = null; }
      else if (kind < 0.93) feed({ type: 'recordingStarted', now });
      else if (kind < 0.98) feed({ type: 'recordingReady' });
      else feed({ type: 'chunkEnded' } as never) // ignored: unknown events must not throw
    }

    const problems = checkInvariants({ commands: [], trail, recordedSends: [], recordedBarges: [], final: state });
    assert.deepEqual(problems, [], `seed ${seed}`);
  }
});
