import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactEntries, type CompactEntry } from './compactDiagnostics.ts';

const e = (t: number, source: string, event: string, data?: Record<string, unknown>): CompactEntry => ({
  t,
  source,
  event,
  ...(data ? { data } : {}),
});

test('per-token lines are dropped from both sides; the whole reply in response:done stays', () => {
  const out = compactEntries([
    e(1000, 'server', '[abc] -> response:text:delta turnId=1 token="Hi"'),
    e(1002, 'socket-in', 'response:text:delta', { token: 'Hi' }),
    e(2000, 'socket-in', 'response:done', { text: 'Hi there' }),
  ]);
  assert.deepEqual(out.map((x) => x.event), ['response:done']);
});

test('a server line is dropped when the browser logged the same event, kept when it did not', () => {
  const out = compactEntries([
    e(1000, 'server', '[abc] -> state state="thinking"'),
    e(1010, 'socket-in', 'state', { state: 'thinking' }),
    e(5000, 'server', '[abc] -> limit:reached scope="ip-turns"'),
    e(9000, 'server', '[abc] · classification {"kind":"halt"}'),
  ]);
  assert.deepEqual(out.map((x) => x.event), [
    'state',
    '[abc] -> limit:reached scope="ip-turns"',
    '[abc] · classification {"kind":"halt"}',
  ]);
});

test('quiet mic levels are thinned to one a second, loud ones all kept', () => {
  const quiet = { rms: 0.005, speechAt: 0.016 };
  const loud = { rms: 0.05, speechAt: 0.016 };
  const out = compactEntries([
    ...[0, 250, 500, 750, 1000, 1250].map((t) => e(t, 'vad', 'level', quiet)),
    e(1300, 'vad', 'level', loud),
    e(1550, 'vad', 'level', loud),
  ]);
  assert.deepEqual(out.map((x) => x.t), [0, 1000, 1300, 1550]);
});

test('"speech end" repeated through silence is dropped; the one closing an utterance is kept', () => {
  const out = compactEntries([
    e(900, 'vad', 'speech end'),
    e(1800, 'vad', 'speech end'),
    e(2000, 'vad', 'speech start'),
    e(3000, 'vad', 'speech end'),
    e(3900, 'vad', 'speech end'),
  ]);
  assert.deepEqual(out.map((x) => `${x.t} ${x.event}`), ['2000 speech start', '3000 speech end']);
});

test('what a call is read from survives', () => {
  const kept = [
    e(100, 'socket-out', 'audio:input', { spokenMs: 400 }),
    e(200, 'socket-in', 'transcription:complete', { text: 'No.' }),
    e(300, 'socket-in', 'disconnect', { reason: 'transport close' }),
    e(400, 'client', 'timeline complete', { kind: 'turn', totalMs: 3000 }),
  ];
  assert.equal(compactEntries(kept).length, kept.length);
});
