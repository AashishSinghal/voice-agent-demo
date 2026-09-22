import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

/**
 * Convert to the 16 kHz mono WAV Whisper expects.
 *
 * `trimStartMs` drops everything before the caller actually started talking.
 * The microphone records for the whole call, so a clip can otherwise open with
 * seconds of room tone — or the agent's own voice, when the caller spoke over
 * it — both of which the transcriber will happily try to make words out of.
 */
export async function convertToWav(inputPath: string, trimStartMs = 0): Promise<string> {
  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}_converted.wav`
  );

  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath);
    if (trimStartMs > 0) command.setStartTime(trimStartMs / 1000);

    command
      .audioFrequency(16000) // 16kHz for Whisper
      .audioChannels(1) // Mono
      .audioCodec('pcm_s16le') // 16-bit PCM
      .format('wav')
      .save(outputPath)
      .on('end', () => {
        console.log(`✅ Audio converted: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('❌ FFmpeg conversion error:', err);
        reject(err);
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
