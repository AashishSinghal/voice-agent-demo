/**
 * Mirrors what the server prints to connected clients.
 *
 * Previously only calls that went through the socket tracer were forwarded, so
 * a plain console.log anywhere in a service — the reason a generation stopped,
 * an ffmpeg complaint, a library warning — existed only in the terminal and
 * never reached an exported diagnostic file. Since the whole point of that file
 * is to be readable somewhere else, the interesting half was missing.
 *
 * Patching console rather than routing every call site through a logger means
 * output from dependencies is captured too, and nothing has to be remembered
 * when adding a log line later.
 *
 * Mirrored lines are scoped to the session that produced them. The process is
 * shared by every caller, so forwarding everything to everyone would show one
 * caller's transcripts and replies to the next. A line printed inside
 * `runInSession(id, ...)` (including everything that code awaits) reaches only
 * subscribers of that session; a line printed outside any session reaches
 * nobody but the terminal and global subscribers.
 *
 * Mirrored text is also scrubbed of credentials, since it leaves the machine.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogLine {
  level: 'log' | 'warn' | 'error';
  text: string;
}

type Subscriber = (line: LogLine) => void;

/** Receives every line from every session. For tests and operators only. */
const subscribers = new Set<Subscriber>();
const sessionSubscribers = new Map<string, Set<Subscriber>>();
const sessionContext = new AsyncLocalStorage<string>();
let installed = false;
/** Guards against a subscriber that logs, which would recurse forever. */
let dispatching = false;

/** Subscribe to every line from every session. Never hand this to a client. */
export function subscribeToLogs(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Subscribe to only the lines produced inside one session. */
export function subscribeToSessionLogs(sessionId: string, fn: Subscriber): () => void {
  let set = sessionSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionSubscribers.set(sessionId, set);
  }
  const owned = set;
  owned.add(fn);
  return () => {
    owned.delete(fn);
    if (owned.size === 0 && sessionSubscribers.get(sessionId) === owned) {
      sessionSubscribers.delete(sessionId);
    }
  };
}

/** Run `fn` so that anything it logs, now or after an await, belongs to `sessionId`. */
export function runInSession<T>(sessionId: string, fn: () => T): T {
  return sessionContext.run(sessionId, fn);
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgsk_[A-Za-z0-9_-]{8,}/g, // Groq keys
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:authorization|x-api-key|api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi,
];

/** Mask credentials in text that is about to leave the process. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const name of ['GROQ_API_KEY', 'ACCESS_TOKEN']) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: unknown) =>
      `${typeof prefix === 'string' ? prefix : ''}[redacted]`
    );
  }
  return out;
}

/**
 * A log-safe description of an error.
 *
 * SDK errors carry the request and response headers, so printing the object
 * can include an Authorization header. Only the name, status and message are
 * kept, and the result is scrubbed.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    const head = typeof status === 'number' ? `${error.name} (${status})` : error.name;
    return redactSecrets(`${head}: ${error.message}`);
  }
  return redactSecrets(String(error));
}

function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return describeError(arg);
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

export function installLogBridge(): void {
  if (installed) return;
  installed = true;

  (['log', 'warn', 'error'] as const).forEach((level) => {
    const original = console[level].bind(console);

    console[level] = (...args: unknown[]) => {
      original(...args);

      const sessionId = sessionContext.getStore();
      const scoped = sessionId ? sessionSubscribers.get(sessionId) : undefined;
      if (dispatching || (subscribers.size === 0 && !scoped)) return;
      dispatching = true;
      try {
        const line: LogLine = { level, text: redactSecrets(render(args)) };
        const deliver = (fn: Subscriber) => {
          try {
            fn(line);
          } catch {
            // A broken subscriber must never break logging.
          }
        };
        subscribers.forEach(deliver);
        scoped?.forEach(deliver);
      } finally {
        dispatching = false;
      }
    };
  });
}
