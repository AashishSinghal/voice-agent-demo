import Groq from 'groq-sdk';
import fs from 'fs';
import type { TranscriptionResult } from '../models/types.js';

export async function transcribeAudioToText(audioPath: string): Promise<TranscriptionResult> {
  try {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey || apiKey === 'your_groq_api_key_here') {
      throw new Error('Groq API key not configured. Set GROQ_API_KEY in .env file');
    }

    console.log(`🎤 Starting Whisper transcription via Groq API...`);
    console.log(`🔑 API Key present: ${apiKey.substring(0, 10)}...`);

    const groq = new Groq({ apiKey });

    const audioFile = fs.createReadStream(audioPath);

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'json',
    });

    const text = transcription.text.trim();

    console.log(`✅ Transcription: "${text}"`);

    return {
      text,
      confidence: 0.9,
      language: 'en',
    };
  } catch (error: any) {
    console.error('❌ Whisper transcription error:', error);

    // Check if it's an API key error
    if (error?.status === 401 || error?.message?.includes('API key')) {
      throw new Error('Groq API key not configured. Set GROQ_API_KEY in .env file');
    }

    throw new Error(`Whisper transcription failed: ${error?.message || error}`);
  }
}
