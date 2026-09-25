import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

/**
 * Prepare a recording for transcription.
 *
 * Whisper accepts webm directly, so there is no reason to decode Opus and
 * re-encode to PCM — and a strong reason not to. On a 0.1 vCPU free instance
 * that transcode took about five seconds per clip; remuxing with a stream copy
 * does no signal processing at all, and skipping ffmpeg entirely costs nothing.
 *
 * `trimStartMs` drops everything before the caller actually started talking.
 * The microphone records for the whole call, so a clip can otherwise open with
 * seconds of room tone — or the agent's own voice, when the caller spoke over
 * it — both of which the transcriber will happily try to make words out of.
 *
 * Returns the path to send, which may be the input untouched.
 */
export async function prepareForTranscription(
  inputPath: string,
  trimStartMs = 0
): Promise<string> {
  if (trimStartMs <= 0) return inputPath;

  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}_trimmed${path.extname(inputPath)}`
  );

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(trimStartMs / 1000)
      .outputOptions(['-c copy']) // remux only: no decode, no encode
      .save(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        // A stream copy can fail on an awkward cut point. The untrimmed clip
        // is still transcribable, so fall back rather than losing the turn.
        console.warn(`⚠️  Trim failed, sending untrimmed: ${err.message}`);
        resolve(inputPath);
      });
  });
}

export async function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 0);
      }
    });
  });
}

export function extractPCM(wavBuffer: Buffer): Buffer {
  // WAV header is typically 44 bytes
  return wavBuffer.slice(44);
}

export async function cleanupAudioFile(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      console.log(`🗑️  Cleaned up: ${filePath}`);
    }
  } catch (error) {
    console.error(`Failed to cleanup ${filePath}:`, error);
  }
}
