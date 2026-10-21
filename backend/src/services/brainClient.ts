/**
 * Client for the Python "brain" service (see docs/CONTRACT.md).
 *
 * The gateway keeps everything latency-critical: audio, interruptions, STT and
 * TTS. The brain owns reasoning. It sends back a stream of typed events and the
 * gateway reduces them to the one thing the voice loop consumes: text tokens.
 *
 * The brain keeps its own checkpointed history, so after an interruption the
 * gateway must tell it what the caller actually heard. Without that the brain
 * would keep the full generated reply and later refer to unspoken sentences.
 */

export interface BrainUsage {
  tier: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usd: number;
  degradedFrom: string | null;
}

export type BrainEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'approval_required'; callId: string; tool: string; args: Record<string, unknown>; prompt: string }
  | { type: 'context'; report: Record<string, unknown> }
  | { type: 'usage'; usage: BrainUsage }
  | { type: 'done'; text: string; turnUsd: number; steps: number; degraded: boolean; awaitingApproval: boolean }
  | { type: 'error'; message: string };

/**
 * Headers for every request to the brain. When BRAIN_API_KEY is set the brain
 * refuses callers without it; locally it is unset and the brain is open.
 */
export function brainHeaders(
  extra: Record<string, string> = {},
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const key = env.BRAIN_API_KEY;
  return { ...extra, ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

export function brainUrl(): string {
  return (process.env.BRAIN_URL || 'http://localhost:8000').replace(/\/$/, '');
}

/** Map one wire event (snake_case) onto the gateway's shape. */
export function parseBrainEvent(raw: Record<string, any>): BrainEvent | null {
  switch (raw.type) {
    case 'token':
      return { type: 'token', text: String(raw.text ?? '') };
    case 'tool_call':
      return { type: 'tool_call', id: raw.id, name: raw.name, args: raw.args ?? {} };
    case 'tool_result':
      return { type: 'tool_result', id: raw.id, name: raw.name, content: String(raw.content ?? '') };
    case 'approval_required':
      return {
        type: 'approval_required',
        callId: raw.call_id,
        tool: raw.tool,
        args: raw.args ?? {},
        prompt: String(raw.prompt ?? ''),
      };
    case 'context':
      return { type: 'context', report: raw.report ?? {} };
    case 'usage':
      return {
        type: 'usage',
        usage: {
          tier: raw.tier,
          model: raw.model,
          promptTokens: raw.prompt_tokens ?? 0,
          completionTokens: raw.completion_tokens ?? 0,
          usd: raw.usd ?? 0,
          degradedFrom: raw.degraded_from ?? null,
        },
      };
    case 'done':
      return {
        type: 'done',
        text: raw.text ?? '',
        turnUsd: raw.turn_usd ?? 0,
        steps: raw.steps ?? 0,
        degraded: !!raw.degraded,
        awaitingApproval: !!raw.awaiting_approval,
      };
    case 'error':
      return { type: 'error', message: String(raw.message ?? 'brain error') };
    default:
      return null;
  }
}

/**
 * Incremental Server-Sent Events parser. Chunks can split a line anywhere, and
 * the server may use \r\n, so normalise and only act on complete blocks.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): Record<string, any>[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: Record<string, any>[] = [];
    let cut: number;
    while ((cut = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue; // a comment or keep-alive
      try {
        out.push(JSON.parse(data));
      } catch {
        // A malformed block must not kill the stream.
      }
    }
    return out;
  }
}

/**
 * Heard-text reports in flight, per session. They are fired without blocking
 * the interruption path, so the next turn must wait for its own session's
 * report or the brain would answer from stale history.
 */
const pendingHeard = new Map<string, Promise<void>>();

export async function* streamTurn(
  sessionId: string,
  text: string,
  signal: AbortSignal
): AsyncGenerator<BrainEvent> {
  await pendingHeard.get(sessionId);
  const response = await fetch(`${brainUrl()}/v1/turn`, {
    method: 'POST',
    headers: brainHeaders({ 'content-type': 'application/json', accept: 'text/event-stream' }),
    body: JSON.stringify({ session_id: sessionId, text }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Brain returned ${response.status}`);
  }

  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    for (const raw of parser.push(decoder.decode(chunk, { stream: true }))) {
      const event = parseBrainEvent(raw);
      if (event) yield event;
    }
  }
}

/** Tell the brain what the caller actually heard of its last reply. */
export function reportHeard(sessionId: string, spoken: string, unspoken: string | null): void {
  const task = postHeard(sessionId, spoken, unspoken).finally(() => {
    if (pendingHeard.get(sessionId) === task) pendingHeard.delete(sessionId);
  });
  pendingHeard.set(sessionId, task);
}

async function postHeard(sessionId: string, spoken: string, unspoken: string | null): Promise<void> {
  try {
    await fetch(`${brainUrl()}/v1/threads/${encodeURIComponent(sessionId)}/heard`, {
      method: 'POST',
      headers: brainHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ spoken, unspoken }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    // The call must not stall on a bookkeeping failure.
    console.warn(`Could not report heard text to the brain: ${(error as Error).message}`);
  }
}

/**
 * Wake the brain before the first turn needs it.
 *
 * A serverless brain scales to zero, and its first request after idle pays for
 * starting Python and importing the graph. A call opens with a greeting that
 * takes seconds to synthesise and play, which is time the brain can spend
 * waking up, so the cost is hidden instead of landing on the caller's first
 * question. Failure is ignored: the first real turn simply pays it instead.
 */
export function warmUp(): void {
  fetch(`${brainUrl()}/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
}
