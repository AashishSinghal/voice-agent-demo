import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

export async function synthesizeSpeechFromText(text: string): Promise<Buffer> {
  const modelPath = process.env.PIPER_MODEL_PATH || './models/piper';
  const voiceModel = process.env.PIPER_MODEL || 'en_US-lessac-medium';
  const piperBin = process.env.PIPER_BIN || 'piper';
  const modelFile = path.join(modelPath, `${voiceModel}.onnx`);
  const outputPath = path.join('/tmp', `tts_${Date.now()}.wav`);

  if (!fs.existsSync(modelFile)) {
    throw new Error(`Piper model not found at: ${modelFile}`);
  }

  try {
    console.log(`🔊 Starting Piper TTS synthesis...`);

    await new Promise<void>((resolve, reject) => {
      const piper = spawn(piperBin, [
        '--model', modelFile,
        '--output_file', outputPath,
      ]);

      // Send text to stdin
      piper.stdin.write(text);
      piper.stdin.end();

      let errorOutput = '';
      piper.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      piper.on('close', (code) => {
        if (code !== 0) {
          console.error('❌ Piper stderr:', errorOutput);
          reject(new Error(`Piper process exited with code ${code}`));
          return;
        }
        resolve();
      });

      piper.on('error', (error) => {
        console.error('❌ Piper spawn error:', error);
        reject(error);
      });
    });

    const audioBuffer = await fs.promises.readFile(outputPath);

    console.log(`✅ TTS synthesis complete (${audioBuffer.length} bytes)`);

    await fs.promises.unlink(outputPath);

    return audioBuffer;
  } catch (error) {
    try {
      if (fs.existsSync(outputPath)) {
        await fs.promises.unlink(outputPath);
      }
    } catch {}

    throw new Error(`TTS synthesis failed: ${error}`);
  }
}
