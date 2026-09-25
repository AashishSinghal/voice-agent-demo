import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Groq from 'groq-sdk';

/**
 * Text-to-speech, pluggable by provider.
 *
 *   TTS_PROVIDER=piper  — bundled Piper binary + ONNX voice. Used in Docker
 *                         and in deployment: no API, no quota, no key.
 *   TTS_PROVIDER=say    — macOS built-in `say`. Used for local development,
 *                         because the piper-tts macOS arm64 wheel (1.8.0)
 *                         ships a broken espeak-ng data path and cannot
 *                         synthesise at all. The bug is macOS-specific; the
 *                         Linux wheel used in the container is fine.
 *
 * Synthesis runs once per sentence rather than once per response, so every
 * provider must be cancellable: on barge-in the in-flight process is killed
 * instead of finishing audio nobody will hear.
 */

export type TtsProvider = 'piper' | 'say' | 'groq';

export function activeTtsProvider(): TtsProvider {
  const raw = (process.env.TTS_PROVIDER || 'groq').toLowerCase();
  if (raw === 'say') return 'say';
  if (raw === 'piper') return 'piper';
  return 'groq';
}

/** Hosted synthesis. No local CPU, at the cost of a request from the quota. */
async function synthesizeWithGroq(text: string, signal?: AbortSignal): Promise<Buffer> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const groq = new Groq({ apiKey });

  const response = await groq.audio.speech.create(
    {
      model: process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
      voice: process.env.GROQ_TTS_VOICE || 'troy',
      input: text,
      response_format: 'wav',
    },
    { signal }
  );

  return Buffer.from(await response.arrayBuffer());
}

function tempWavPath(): string {
  return path.join('/tmp', `tts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`);
}

/** Spawn a synthesiser, honouring `signal`, and resolve when it exits 0. */
function runSynth(
  bin: string,
  args: string[],
  stdin: string | null,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args);

    const onAbort = () => {
      proc.kill('SIGKILL');
      reject(new DOMException('Synthesis aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (stdin !== null) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return; // already rejected
      if (code !== 0) {
        console.error(`❌ ${bin} stderr:`, stderr);
        reject(new Error(`${bin} exited with code ${code}`));
        return;
      }
      resolve();
    });

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export async function synthesizeSpeechFromText(
  text: string,
  signal?: AbortSignal
): Promise<Buffer> {
  if (signal?.aborted) throw new DOMException('Synthesis aborted', 'AbortError');

  const provider = activeTtsProvider();

  // Hosted synthesis never touches the filesystem.
  if (provider === 'groq') return synthesizeWithGroq(text, signal);

  const outputPath = tempWavPath();

  try {
    if (provider === 'say') {
      const voice = process.env.SAY_VOICE || 'Samantha';
      // LEI16 gives a plain PCM WAV the browser can decode directly.
      await runSynth(
        'say',
        ['-v', voice, '-o', outputPath, '--data-format=LEI16@22050', text],
        null,
        signal
      );
    } else {
      const modelPath = process.env.PIPER_MODEL_PATH || './models/piper';
      const voiceModel = process.env.PIPER_MODEL || 'en_US-lessac-medium';
      const piperBin = process.env.PIPER_BIN || 'piper';
      const modelFile = path.join(modelPath, `${voiceModel}.onnx`);

      if (!fs.existsSync(modelFile)) {
        throw new Error(`Piper model not found at: ${modelFile}`);
      }

      await runSynth(
        piperBin,
        ['--model', modelFile, '--output_file', outputPath],
        text,
        signal
      );
    }

    const audio = await fs.promises.readFile(outputPath);
    await fs.promises.unlink(outputPath).catch(() => {});
    return audio;
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
}
