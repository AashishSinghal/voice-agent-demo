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
  const model = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';

  try {
    const response = await groq.audio.speech.create(
      {
        model,
        voice: process.env.GROQ_TTS_VOICE || 'troy',
        input: text,
        response_format: 'wav',
      },
      { signal }
    );

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw explainGroqTtsFailure(error, model);
  }
}

/**
 * Turn a Groq API rejection into something actionable.
 *
 * These arrive as a bare 400 with the detail buried in a nested body. The
 * terms-acceptance one in particular is a single click in the console, but
 * unwrapped it reads like a broken request and sends you looking at the code.
 */
export function explainGroqTtsFailure(error: unknown, model: string): Error {
  if (error instanceof DOMException && error.name === 'AbortError') return error;

  // Where the code lands varies by SDK version: sometimes on the error itself,
  // sometimes inside the parsed body, which may or may not be wrapped again.
  const err = error as {
    status?: number;
    code?: string;
    message?: string;
    error?: { code?: string; error?: { code?: string } };
  };
  const code = err?.code ?? err?.error?.code ?? err?.error?.error?.code;

  if (code === 'model_terms_required') {
    return new Error(
      `The Groq model "${model}" needs its terms accepted before it can be used. ` +
        `An org admin has to accept them once at ` +
        `https://console.groq.com/playground?model=${encodeURIComponent(model)} — ` +
        `no redeploy needed afterwards.`
    );
  }

  if (err?.status === 429) {
    return new Error(
      'Groq rate limit reached. Hosted speech shares the free tier\'s daily ' +
        'request budget with transcription and the LLM.'
    );
  }

  if (err?.status === 401 || err?.status === 403) {
    return new Error('Groq rejected the API key for text-to-speech.');
  }

  return new Error(`Groq text-to-speech failed: ${err?.message ?? String(error)}`);
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
