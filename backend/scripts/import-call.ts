/**
 * Turns a downloaded debug bundle into evaluation data.
 *
 * The bundle already holds everything needed: the caller's audio, and a log
 * saying when they spoke, what was transcribed, how any over-speech was
 * classified and whether it was thrown away. This pairs the two, cuts the
 * recording into one clip per utterance, and writes the labels beside them —
 * so a corpus accumulates from ordinary use instead of someone listening to
 * recordings and typing what they hear.
 *
 *   npm run import:call -- ~/Downloads/voice-agent-1790375204729.zip
 *
 * Requires ffmpeg and unzip on PATH.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCall, type Utterance } from '../src/eval/parseDiagnostics.js';

const CORPUS_ROOT = resolve(process.cwd(), '..', 'eval', 'corpus');

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function requireTool(tool: string): void {
  try {
    run('which', [tool]);
  } catch {
    console.error(`${tool} is required and was not found on PATH`);
    process.exit(1);
  }
}

/** Extract the bundle, or accept a directory that was already unzipped. */
function materialise(input: string): { dir: string; cleanup: () => void } {
  if (!existsSync(input)) {
    console.error(`no such file: ${input}`);
    process.exit(1);
  }

  if (!input.endsWith('.zip')) return { dir: input, cleanup: () => {} };

  const dir = mkdtempSync(join(tmpdir(), 'voice-agent-import-'));
  run('unzip', ['-q', input, '-d', dir]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Rewrite the container so it carries a duration.
 *
 * Browsers write WebM as a live stream and never fill in the Duration element,
 * so nothing downstream can seek or measure without decoding the whole file. A
 * stream copy fixes the header without touching the audio.
 */
function remux(source: string, target: string): void {
  run('ffmpeg', ['-v', 'error', '-y', '-i', source, '-c', 'copy', target]);
}

/**
 * Cut one utterance out of the caller's track.
 *
 * Re-encodes rather than copying: a stream copy can only cut on cluster
 * boundaries, which moved the edges by seconds in testing and would have made
 * every clip's labels wrong.
 */
function sliceClip(source: string, startSec: number, endSec: number, target: string): void {
  run('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', startSec.toFixed(3),
    '-to', endSec.toFixed(3),
    '-i', source,
    '-c:a', 'libopus',
    target,
  ]);
}

function label(utterance: Utterance): string {
  if (utterance.discarded) return 'discarded';
  if (utterance.classification) return utterance.classification;
  return utterance.overSpeech ? 'over-speech' : 'turn';
}

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: npm run import:call -- <bundle.zip | extracted-dir>');
    process.exit(1);
  }

  requireTool('ffmpeg');
  if (input.endsWith('.zip')) requireTool('unzip');

  const { dir, cleanup } = materialise(input);

  try {
    const logPath = join(dir, 'diagnostics.txt');
    if (!existsSync(logPath)) {
      console.error('bundle contains no diagnostics.txt');
      process.exit(1);
    }

    const call = parseCall(readFileSync(logPath, 'utf8'));
    const callerTrack = join(dir, 'audio', 'you.webm');
    const agentTrack = join(dir, 'audio', 'agent.webm');
    const hasAudio = existsSync(callerTrack);

    const callId = basename(input).replace(/\.zip$/, '').replace(/^voice-agent-/, '');
    const outDir = join(CORPUS_ROOT, callId);
    mkdirSync(join(outDir, 'clips'), { recursive: true });

    if (hasAudio) {
      remux(callerTrack, join(outDir, 'you.webm'));
      if (existsSync(agentTrack)) remux(agentTrack, join(outDir, 'agent.webm'));
    }

    let clipped = 0;
    let skipped = 0;

    const entries = call.utterances.map((utterance) => {
      const name = `${String(utterance.index).padStart(3, '0')}-${label(utterance)}.webm`;
      let clip: string | null = null;

      if (hasAudio && utterance.audio && utterance.audio.endSec > utterance.audio.startSec) {
        try {
          sliceClip(
            join(outDir, 'you.webm'),
            utterance.audio.startSec,
            utterance.audio.endSec,
            join(outDir, 'clips', name)
          );
          clip = `clips/${name}`;
          clipped++;
        } catch (error) {
          console.warn(`  could not cut ${name}: ${(error as Error).message.split('\n')[0]}`);
          skipped++;
        }
      } else {
        skipped++;
      }

      return {
        index: utterance.index,
        clip,
        label: label(utterance),
        overSpeech: utterance.overSpeech,
        // The transcript the agent produced. Ground truth until someone
        // corrects it, which is the one thing a human still has to do.
        transcript: utterance.transcript,
        transcriptVerified: false,
        classification: utterance.classification,
        discarded: utterance.discarded,
        discardReason: utterance.discardReason,
        spokenMs: utterance.spokenMs,
        clipMs: utterance.clipMs,
        trimStartMs: utterance.trimStartMs,
        sttMs: utterance.sttMs,
        audio: utterance.audio,
      };
    });

    writeFileSync(
      join(outDir, 'entries.json'),
      JSON.stringify(
        {
          callId,
          importedFrom: basename(input),
          recordingDurationMs: call.recordingDurationMs,
          hasAudio,
          counts: entries.reduce<Record<string, number>>((acc, entry) => {
            acc[entry.label] = (acc[entry.label] ?? 0) + 1;
            return acc;
          }, {}),
          entries,
        },
        null,
        2
      )
    );

    console.log(`imported ${callId}`);
    console.log(`  ${entries.length} utterance(s): ${clipped} clipped, ${skipped} without audio`);
    for (const [name, count] of Object.entries(
      entries.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.label] = (acc[entry.label] ?? 0) + 1;
        return acc;
      }, {})
    )) {
      console.log(`  ${count} ${name}`);
    }
    console.log(`  -> eval/corpus/${callId}/`);

    if (entries.some((entry) => entry.transcript && !entry.transcriptVerified)) {
      console.log('\n  Transcripts come from the agent, so they are a starting point.');
      console.log('  Correct any that are wrong and set transcriptVerified to true.');
    }
  } finally {
    cleanup();
  }
}

main();
