import Groq from 'groq-sdk';
import fs from 'fs';
import type { TranscriptionResult } from '../models/types.js';
import { describeError } from './logBridge.js';

interface Segment {
  avg_logprob?: number;
  no_speech_prob?: number;
}

/**
 * Turn Whisper's per-segment statistics into one 0..1 confidence.
 *
 * `avg_logprob` is the mean token log-probability of a segment, so its
 * exponential is a geometric-mean token probability. Segments are averaged,
 * and the result is scaled down by the worst `no_speech_prob`, since a segment
 * Whisper suspects is silence is exactly the one it hallucinates text for.
 * Returns null when Whisper reported no usable segments, rather than guessing.
 */
export function confidenceFromSegments(segments: Segment[] | undefined): number | null {
  const scored = (segments ?? []).filter((s) => Number.isFinite(s.avg_logprob));
  if (scored.length === 0) return null;

  const meanProb =
    scored.reduce((sum, s) => sum + Math.exp(Math.min(0, s.avg_logprob as number)), 0) /
    scored.length;
  const worstNoSpeech = Math.max(
    0,
    ...scored.map((s) => (Number.isFinite(s.no_speech_prob) ? (s.no_speech_prob as number) : 0))
  );

  const confidence = meanProb * (1 - Math.min(1, worstNoSpeech));
  return Math.round(Math.min(1, Math.max(0, confidence)) * 1000) / 1000;
}

/** Spoken language handed to Whisper (ISO-639-1). Set STT_LANGUAGE to change it. */
export function sttLanguage(): string {
  return (process.env.STT_LANGUAGE || 'en').trim().toLowerCase() || 'en';
}

export async function transcribeAudioToText(audioPath: string): Promise<TranscriptionResult> {
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey || apiKey === 'your_groq_api_key_here') {
      throw new Error('Groq API key not configured. Set GROQ_API_KEY in .env file');
    }

    console.log(`🎤 Starting Whisper transcription via Groq API...`);

    const groq = new Groq({ apiKey });

    const audioFile = fs.createReadStream(audioPath);
    const language = sttLanguage();

    // verbose_json adds per-segment statistics (a few hundred bytes) so the
    // confidence is measured rather than assumed.
    const transcription = (await groq.audio.transcriptions.create({
      file: audioFile,
      // Must match what cost.ts bills for.
      model: process.env.GROQ_STT_MODEL || 'whisper-large-v3',
      language,
      response_format: 'verbose_json',
    })) as { text: string; segments?: Segment[] };

    const text = transcription.text.trim();

    console.log(`✅ Transcription: "${text}"`);

    return {
      text,
      confidence: confidenceFromSegments(transcription.segments),
      language,
    };
  } catch (error: any) {
    console.error(`❌ Whisper transcription error: ${describeError(error)}`);

    // Check if it's an API key error
    if (error?.status === 401 || error?.message?.includes('API key')) {
      throw new Error('Groq API key not configured. Set GROQ_API_KEY in .env file');
    }

    throw new Error(`Whisper transcription failed: ${error?.message || error}`);
  }
}
