/**
 * Voice recordings played through the caller's side of a call.
 *
 * Each clip in `fixtures/audio/` goes through the real speech detector and the
 * real turn-taking module (`simulateCall.ts`); `manifest.json` says whether the
 * browser should send it or discard it. To cover a bad real call, drop its
 * recording in that directory and add a line to the manifest.
 *
 * Needs ffmpeg to decode; skipped without it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { simulateCall } from './simulateCall.ts';

const DIR = new URL('./fixtures/audio/', import.meta.url);
const RATE = 48_000;

interface Case {
  file: string;
  during: 'idle' | 'agent';
  expect: 'send' | 'drop';
  /** What the module must report as audible; a floor, not an exact figure. */
  minSpokenMs?: number;
  /** Loudest sample after scaling. Speech is brought to a normal level; steady noise is not. */
  peak?: number;
  /** A real recording, already at microphone level: do not rescale it. */
  raw?: boolean;
  /** A limitation we know about and have a step for. The case must keep failing until fixed. */
  known?: string;
  duringPlayback?: boolean;
  note: string;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Any format ffmpeg reads, as mono float samples at the microphone's rate. */
function decode(file: string): Float32Array {
  const raw = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', new URL(file, DIR).pathname, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'],
    { maxBuffer: 256 * 1024 * 1024 }
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

const load = (path: string): Case[] => JSON.parse(readFileSync(new URL(path, DIR), 'utf8'));
// `real/` holds recordings from actual calls, committed with the owner's
// consent so CI runs them; the rest are synthetic (scripts/make-audio-fixtures.sh).
const cases: Case[] = [...load('manifest.json'), ...load('real/manifest.json')];

for (const c of cases) {
  test(`${c.file} (${c.during}) is ${c.expect === 'send' ? 'sent' : 'not sent'}: ${c.note}`, {
    skip: !hasFfmpeg() && !process.env.CI && 'ffmpeg not installed',
  }, () => {
    // Synthetic clips are brought up to a normal speaking level, as a mic's
    // gain would; the detector adapts to the room, not to a clip's loudness.
    const result = simulateCall(decode(c.file), RATE, { during: c.during, peak: c.raw ? undefined : (c.peak ?? 0.6) });
    const why = `traces: ${result.traces.join(' | ')}`;

    if (c.known) {
      const behavesAsExpected = c.expect === 'send' ? result.sent !== null : result.sent === null;
      assert.equal(behavesAsExpected, false, `fixed? remove "known" from the manifest. (${c.known})`);
      return;
    }

    if (c.expect === 'send') {
      assert.ok(result.sent, `expected the clip to be sent. ${why}`);
      if (c.duringPlayback !== undefined) assert.equal(result.sent.duringPlayback, c.duringPlayback, why);
      if (c.minSpokenMs !== undefined) assert.ok(result.sent.spokenMs >= c.minSpokenMs, `${result.sent.spokenMs}ms audible. ${why}`);
    } else {
      assert.equal(result.sent, null, `expected nothing to be sent. ${why}`);
    }
  });
}

test('VAD scorecard: false positives (noise sent) and false negatives (speech dropped)', {
  skip: !hasFfmpeg() && !process.env.CI && 'ffmpeg not installed',
}, () => {
  let falsePositives = 0;
  let falseNegatives = 0;
  let known = 0;
  for (const c of cases) {
    if (c.known) {
      known += 1;
      continue;
    }
    const sent = simulateCall(decode(c.file), RATE, { during: c.during, peak: c.raw ? undefined : (c.peak ?? 0.6) }).sent !== null;
    if (sent && c.expect === 'drop') falsePositives += 1;
    if (!sent && c.expect === 'send') falseNegatives += 1;
  }
  console.log(`# VAD: ${cases.length} clips, ${falsePositives} false positive, ${falseNegatives} false negative, ${known} known limitation(s)`);
  assert.equal(falsePositives + falseNegatives, 0);
});
