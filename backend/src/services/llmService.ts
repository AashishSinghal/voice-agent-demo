import axios from 'axios';
import Groq from 'groq-sdk';
import type { Turn } from '../models/types.js';
import { streamTurn } from './brainClient.js';

/**
 * Streaming, provider-agnostic LLM client for a general-purpose voice agent.
 *
 * Providers:
 *   - `groq`   — hosted, low latency, free tier. Default.
 *   - `ollama` — fully local/offline.
 *   - `brain`  — the Python reasoning service (LangGraph). It keeps its own
 *                history, so the gateway sends only the new utterance.
 *
 * Every call takes an AbortSignal so an in-flight generation dies the instant
 * the caller interrupts.
 *
 * The prompt is built to survive interruption. An assistant turn that was cut
 * off is shown to the model as exactly what the caller heard, marked as
 * interrupted — never the full generated text. Otherwise the model refers back
 * to things it never actually said.
 */

export type LlmProvider = 'ollama' | 'groq' | 'brain';

export function activeProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
  if (raw === 'ollama') return 'ollama';
  if (raw === 'brain') return 'brain';
  return 'groq';
}

const DEFAULT_PERSONA = `You are a helpful voice assistant. You are having a spoken conversation, so:
- Keep answers short — two or three sentences unless asked for more.
- Write the way people speak. No lists, no markdown, no headings, no emoji.
- Expand numbers, symbols and abbreviations into words, since this is read aloud.
- If you do not know something, say so plainly and briefly.`;

function systemPrompt(): string {
  const persona = process.env.AGENT_PERSONA?.trim() || DEFAULT_PERSONA;

  return `${persona}

The caller can interrupt you at any time. If a previous turn of yours is marked
as cut off, the caller only heard the part shown. Anything in square brackets
after it was never spoken aloud — do not refer to it as if they had heard it,
but you do remember it, so you can pick that thread back up if they ask you to
return to it.`;
}

/**
 * Render the conversation as a transcript the model can reason about.
 *
 * Interrupted turns carry both halves: what the caller heard, and what was
 * cut off. Keeping the unsaid part in the transcript is what lets the caller
 * come back later — "go back to what you were explaining before" — and get a
 * continuation rather than a blank look. It is labelled explicitly as unheard
 * so the model does not treat it as already delivered.
 */
function renderHistory(history: Turn[]): string {
  return history
    .map((turn) => {
      if (turn.role === 'user') return `Caller: ${turn.content}`;
      if (!turn.interrupted) return `You: ${turn.content}`;

      const heard = `You (cut off here by the caller): ${turn.content}`;
      if (!turn.unspoken) return heard;

      return `${heard}\n  [not heard by the caller, you never got to say it: ${turn.unspoken}]`;
    })
    .join('\n');
}

function buildUserPrompt(query: string, history: Turn[], resumeHint?: string | null): string {
  const parts: string[] = [];

  const transcript = renderHistory(history);
  if (transcript) parts.push(transcript);

  if (resumeHint) {
    parts.push(
      `(You were cut off before you could say: "${resumeHint}". The caller has ` +
        `asked you to continue, so pick up from there naturally — do not repeat ` +
        `what they already heard.)`
    );
  }

  parts.push(`Caller: ${query}`);
  return parts.join('\n');
}

/** Why a generation ended — reported so a truncated answer is diagnosable. */
export interface FinishInfo {
  reason: string | null;
  tokens: number;
  /** Billable usage, when the provider reports it. */
  promptTokens: number;
  completionTokens: number;
}

export async function* streamResponse(
  query: string,
  history: Turn[],
  signal: AbortSignal,
  resumeHint?: string | null,
  onFinish?: (info: FinishInfo) => void,
  sessionId?: string
): AsyncGenerator<string> {
  if (activeProvider() === 'brain') {
    yield* streamFromBrain(query, sessionId ?? 'default', signal, onFinish);
    return;
  }

  const system = systemPrompt();
  const user = buildUserPrompt(query, history, resumeHint);

  if (activeProvider() === 'groq') {
    yield* streamFromGroq(system, user, signal, onFinish);
  } else {
    yield* streamFromOllama(system, user, signal, onFinish);
  }
}

async function* streamFromBrain(
  query: string,
  sessionId: string,
  signal: AbortSignal,
  onFinish?: (info: FinishInfo) => void
): AsyncGenerator<string> {
  let tokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let reason: string | null = null;

  for await (const event of streamTurn(sessionId, query, signal)) {
    if (signal.aborted) return;
    switch (event.type) {
      case 'token':
        tokens += 1;
        yield event.text;
        break;
      case 'usage':
        promptTokens += event.usage.promptTokens;
        completionTokens += event.usage.completionTokens;
        break;
      case 'tool_call':
        console.log(`🛠  brain tool call: ${event.name}(${JSON.stringify(event.args)})`);
        break;
      case 'tool_result':
        console.log(`🛠  brain tool result: ${event.name}`);
        break;
      case 'approval_required':
        // The question itself arrives as ordinary tokens and is spoken as such;
        // the caller's next utterance is the answer, routed back through here.
        console.log(`🔐 brain awaiting approval: ${event.tool}`);
        break;
      case 'done':
        reason = event.awaitingApproval ? 'awaiting_approval' : event.degraded ? 'degraded' : 'stop';
        break;
      case 'error':
        throw new Error(`Brain error: ${event.message}`);
    }
  }

  onFinish?.({ reason, tokens, promptTokens, completionTokens });
}

/**
 * gpt-oss models think before they speak, and the thinking is generated first
 * and counts against max_tokens. Measured on this prompt set at default effort:
 * "tell me a long story" spent 218 of its 220 tokens reasoning and returned an
 * empty answer; an ordinary question spent 128 of 204 on thoughts nobody hears.
 * At "low" reasoning fell to 5 to 12 tokens, every prompt answered, and there is
 * less to generate before the first word is spoken.
 *
 * Only sent to models that accept it. GROQ_REASONING_EFFORT=none turns it off.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'default';
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'default'];

export function reasoningParams(model: string): { reasoning_effort?: ReasoningEffort } {
  const configured = (process.env.GROQ_REASONING_EFFORT ?? 'low').toLowerCase();
  if (configured === 'none' || !model.includes('gpt-oss')) return {};
  // An unrecognised value falls back to low rather than sending something the
  // API would reject and leaving every turn failing.
  return { reasoning_effort: (EFFORTS.includes(configured) ? configured : 'low') as ReasoningEffort };
}

async function* streamFromGroq(
  system: string,
  user: string,
  signal: AbortSignal,
  onFinish?: (info: FinishInfo) => void
): AsyncGenerator<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    throw new Error('GROQ_API_KEY is not configured');
  }

  const groq = new Groq({ apiKey });
  // Groq's free tier dropped the Llama models in 2026; gpt-oss-20b is the
  // fastest current free chat model, which is what matters for voice latency.
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
      max_tokens: 220,
      stream: true,
      ...reasoningParams(model),
    },
    { signal }
  );

  let finishReason: string | null = null;
  let tokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    if (signal.aborted) return;

    const choice = chunk.choices[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;

    // Groq attaches billable usage to the final chunk under x_groq rather than
    // requiring stream_options, so a streamed call can still be costed.
    const usage = (chunk as { x_groq?: { usage?: { prompt_tokens?: number; completion_tokens?: number } } })
      .x_groq?.usage;
    if (usage) {
      promptTokens = usage.prompt_tokens ?? promptTokens;
      completionTokens = usage.completion_tokens ?? completionTokens;
    }

    const token = choice?.delta?.content;
    if (token) {
      tokens += 1;
      yield token;
    }
  }

  // Without this a truncated answer and a deliberate stop look identical.
  // "length" means max_tokens; "stop" means the model chose to end; null means
  // the stream ended without saying why, which points at the transport.
  onFinish?.({ reason: finishReason, tokens, promptTokens, completionTokens });
}

async function* streamFromOllama(
  system: string,
  user: string,
  signal: AbortSignal,
  onFinish?: (info: FinishInfo) => void
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
        num_predict: 220,
        stop: ['\nCaller:', '\nYou:'],
      },
    },
    { responseType: 'stream', signal, timeout: 60000 }
  );

  // Ollama streams newline-delimited JSON; a chunk may split a line in half.
  let pending = '';
  let tokens = 0;

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
        if (parsed.response) {
          tokens += 1;
          yield parsed.response as string;
        }
        if (parsed.done) {
          onFinish?.({
            reason: parsed.done_reason ?? 'done',
            tokens,
            promptTokens: parsed.prompt_eval_count ?? 0,
            completionTokens: parsed.eval_count ?? 0,
          });
          return;
        }
      } catch {
        // Partial or malformed line — skip rather than killing the stream.
      }
    }
  }
}
