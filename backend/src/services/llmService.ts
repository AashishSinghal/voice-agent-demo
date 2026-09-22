import axios from 'axios';
import Groq from 'groq-sdk';
import fs from 'fs';
import type { Message, FAQEntry } from '../models/types.js';

/**
 * Streaming, provider-agnostic LLM client.
 *
 * Two providers are supported so the same code runs locally and deployed:
 *   - `ollama` — local inference, no API key, good for offline development.
 *   - `groq`   — hosted inference, very low latency, free tier. Used in
 *                deployment, where running Ollama is not affordable.
 *
 * Select with LLM_PROVIDER. Every call takes an AbortSignal so an in-flight
 * generation can be cancelled the moment the user interrupts (barge-in).
 */

const faqsPath = new URL('../data/faqs.json', import.meta.url);
const allFAQs: FAQEntry[] = JSON.parse(fs.readFileSync(faqsPath, 'utf-8'));

// Keep the prompt from growing without bound over a long call.
const MAX_HISTORY_TURNS = 8;

export type LlmProvider = 'ollama' | 'groq';

export function activeProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  return raw === 'groq' ? 'groq' : 'ollama';
}

function buildSystemPrompt(): string {
  const faqContext = allFAQs
    .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
    .join('\n\n');

  return `You are a friendly customer support agent for Wise, helping customers track their money transfers.

You can ONLY answer questions about the topics covered in the FAQ below. For ANY other questions, you must politely deflect to a human agent.

FAQ Knowledge Base:
${faqContext}

Guidelines:
- Keep responses concise (2-3 sentences max)
- Speak naturally; this text will be read aloud
- If the question is outside the FAQ, say you are connecting them to a human agent`;
}

function buildUserPrompt(query: string, history: Message[]): string {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  if (recent.length === 0) return `User: ${query}`;

  const transcript = recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  return `${transcript}\nUser: ${query}`;
}

/** True if the assistant handed the caller off to a human. */
export function isDeflection(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('human agent') || lower.includes('outside my area');
}

/**
 * Yields response tokens as they are generated.
 * Throws `AbortError` if the signal fires mid-stream.
 */
export async function* streamResponse(
  query: string,
  history: Message[],
  signal: AbortSignal
): AsyncGenerator<string> {
  const provider = activeProvider();
  const system = buildSystemPrompt();
  const user = buildUserPrompt(query, history);

  if (provider === 'groq') {
    yield* streamFromGroq(system, user, signal);
  } else {
    yield* streamFromOllama(system, user, signal);
  }
}

async function* streamFromGroq(
  system: string,
  user: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const groq = new Groq({ apiKey });
  // Groq's free tier dropped the Llama models in 2026; gpt-oss-20b is the
  // fastest of the current free chat models, which matters for voice latency.
  // Current list: https://console.groq.com/docs/models
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

  const stream = await groq.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 200,
      stream: true,
    },
    { signal }
  );

  for await (const chunk of stream) {
    if (signal.aborted) return;
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield token;
  }
}

async function* streamFromOllama(
  system: string,
  user: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  const apiUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'phi3';

  const response = await axios.post(
    `${apiUrl}/api/generate`,
    {
      model,
      prompt: `${system}\n\n${user}`,
      stream: true,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 200,
        stop: ['\n\n', 'User:', 'Assistant:'],
      },
    },
    { responseType: 'stream', signal, timeout: 60000 }
  );

  // Ollama streams newline-delimited JSON; a chunk may split a line in half.
  let pending = '';

  for await (const buf of response.data as AsyncIterable<Buffer>) {
    if (signal.aborted) return;

    pending += buf.toString('utf-8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.response) yield parsed.response as string;
        if (parsed.done) return;
      } catch {
        // Partial or malformed line — skip it rather than killing the stream.
      }
    }
  }
}
