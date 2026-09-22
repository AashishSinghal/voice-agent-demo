/**
 * Mirrors everything the server prints to connected clients.
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
 */

export interface LogLine {
  level: 'log' | 'warn' | 'error';
  text: string;
}

type Subscriber = (line: LogLine) => void;

const subscribers = new Set<Subscriber>();
let installed = false;
/** Guards against a subscriber that logs, which would recurse forever. */
let dispatching = false;

export function subscribeToLogs(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
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

      if (dispatching || subscribers.size === 0) return;
      dispatching = true;
      try {
        const line: LogLine = { level, text: render(args) };
        subscribers.forEach((fn) => {
          try {
            fn(line);
          } catch {
            // A broken subscriber must never break logging.
          }
        });
      } finally {
        dispatching = false;
      }
    };
  });
}
