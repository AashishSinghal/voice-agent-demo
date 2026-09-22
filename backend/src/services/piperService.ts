import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Piper TTS.
 *
 * Synthesis is per-sentence now rather than per-response, so this is called
 * several times per turn and must be cancellable: when the caller interrupts,
 * any in-flight Piper process is killed instead of finishing work whose audio
 * nobody will hear.
 */
export async function synthesizeSpeechFromText(
  text: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const modelPath = process.env.PIPER_MODEL_PATH || './models/piper';
  const voiceModel = process.env.PIPER_MODEL || 'en_US-lessac-medium';
  const piperBin = process.env.PIPER_BIN || 'piper';
  const modelFile = path.join(modelPath, `${voiceModel}.onnx`);

  // Random suffix: concurrent sentence synthesis would collide on a timestamp.
  const outputPath = path.join(
    '/tmp',
    `tts_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`
  );

  if (!fs.existsSync(modelFile)) {
    throw new Error(`Piper model not found at: ${modelFile}`);
  }

  if (signal?.aborted) {
    throw new DOMException('Synthesis aborted', 'AbortError');
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const piper = spawn(piperBin, ['--model', modelFile, '--output_file', outputPath]);

      const onAbort = () => {
        piper.kill('SIGKILL');
        reject(new DOMException('Synthesis aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      piper.stdin.write(text);
      piper.stdin.end();

      let errorOutput = '';
      piper.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      piper.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return; // already rejected by onAbort
        if (code !== 0) {
          console.error('❌ Piper stderr:', errorOutput);
          reject(new Error(`Piper process exited with code ${code}`));
          return;
        }
        resolve();
      });

      piper.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
    });

    const audioBuffer = await fs.promises.readFile(outputPath);
    await fs.promises.unlink(outputPath).catch(() => {});
    return audioBuffer;
  } catch (error) {
    await fs.promises.unlink(outputPath).catch(() => {});
    throw error;
  }
}
