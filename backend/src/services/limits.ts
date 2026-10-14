/**
 * Abuse protection for a public demo that spends a free quota.
 *
 * Groq's free tier is ~1,000 requests a day and a turn costs about five, so one
 * bored visitor can exhaust the day. Three guards, all in memory (the service is
 * a single instance by design) and all configurable from the environment:
 *
 *   - per IP: concurrent sockets and connections per minute;
 *   - per IP: turns per minute;
 *   - global: turns per UTC day, refused before the quota actually runs out.
 *
 * The clock is injectable so the windows can be tested without waiting.
 */
import crypto from 'node:crypto';

export interface LimitConfig {
  maxSocketsPerIp: number;
  maxConnectsPerMinPerIp: number;
  maxTurnsPerMinPerIp: number;
  maxTurnsPerDay: number;
}

/** Documented in .env.example. A value of 0 disables that limit. */
export const DEFAULT_LIMITS: LimitConfig = {
  maxSocketsPerIp: 3,
  maxConnectsPerMinPerIp: 20,
  maxTurnsPerMinPerIp: 8,
  // ~5 Groq requests per turn against ~1,000 a day, leaving headroom.
  maxTurnsPerDay: 150,
};

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): LimitConfig {
  return {
    maxSocketsPerIp: intFromEnv('MAX_SOCKETS_PER_IP', DEFAULT_LIMITS.maxSocketsPerIp, env),
    maxConnectsPerMinPerIp: intFromEnv(
      'MAX_CONNECTS_PER_MIN_PER_IP',
      DEFAULT_LIMITS.maxConnectsPerMinPerIp,
      env
    ),
    maxTurnsPerMinPerIp: intFromEnv(
      'MAX_TURNS_PER_MIN_PER_IP',
      DEFAULT_LIMITS.maxTurnsPerMinPerIp,
      env
    ),
    maxTurnsPerDay: intFromEnv('MAX_TURNS_PER_DAY', DEFAULT_LIMITS.maxTurnsPerDay, env),
  };
}

export type Decision =
  | { allowed: true }
  | { allowed: false; scope: 'ip-sockets' | 'ip-connects' | 'ip-turns' | 'daily'; message: string; retryAfterSec: number };

const MINUTE_MS = 60_000;

/** Timestamps of recent events per key, pruned to a sliding window. */
class SlidingWindow {
  private events = new Map<string, number[]>();

  constructor(private windowMs: number) {}

  /** Events still inside the window, oldest first. */
  recent(key: string, now: number): number[] {
    const kept = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length === 0) this.events.delete(key);
    else this.events.set(key, kept);
    return kept;
  }

  record(key: string, now: number): void {
    const list = this.recent(key, now);
    list.push(now);
    this.events.set(key, list);
  }

  /** Drop idle keys so the map cannot grow without bound. */
  sweep(now: number): void {
    for (const key of [...this.events.keys()]) this.recent(key, now);
  }
}

export class Limiter {
  private sockets = new Map<string, number>();
  private connects = new SlidingWindow(MINUTE_MS);
  private turns = new SlidingWindow(MINUTE_MS);
  private dayKey = '';
  private dayTurns = 0;

  constructor(
    private config: LimitConfig = limitsFromEnv(),
    private clock: () => number = Date.now
  ) {}

  private rollDay(now: number): void {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayTurns = 0;
    }
  }

  private secondsToMidnightUtc(now: number): number {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
  }

  /** Called when a socket tries to connect. Does not count it as open yet. */
  checkConnect(ip: string): Decision {
    const now = this.clock();
    const { maxSocketsPerIp, maxConnectsPerMinPerIp } = this.config;

    if (maxSocketsPerIp > 0 && (this.sockets.get(ip) ?? 0) >= maxSocketsPerIp) {
      return {
        allowed: false,
        scope: 'ip-sockets',
        message: 'Too many open connections from your network. Close another tab and try again.',
        retryAfterSec: 30,
      };
    }

    if (maxConnectsPerMinPerIp > 0) {
      const recent = this.connects.recent(ip, now);
      if (recent.length >= maxConnectsPerMinPerIp) {
        return {
          allowed: false,
          scope: 'ip-connects',
          message: 'Too many connection attempts. Wait a minute and try again.',
          retryAfterSec: Math.max(1, Math.ceil((recent[0] + MINUTE_MS - now) / 1000)),
        };
      }
    }
    return { allowed: true };
  }

  /** Register an accepted connection. Returns the matching release function. */
  open(ip: string): () => void {
    this.connects.record(ip, this.clock());
    this.sockets.set(ip, (this.sockets.get(ip) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; // disconnect can be reported twice
      released = true;
      const left = (this.sockets.get(ip) ?? 1) - 1;
      if (left <= 0) this.sockets.delete(ip);
      else this.sockets.set(ip, left);
    };
  }

  /**
   * Ask to spend one turn. On success the turn is counted immediately, so a
   * burst of concurrent requests cannot all slip past the cap.
   */
  tryTurn(ip: string): Decision {
    const now = this.clock();
    this.rollDay(now);
    const { maxTurnsPerMinPerIp, maxTurnsPerDay } = this.config;

    if (maxTurnsPerDay > 0 && this.dayTurns >= maxTurnsPerDay) {
      return {
        allowed: false,
        scope: 'daily',
        message:
          "This demo has reached its daily limit so it doesn't run past the free quota. " +
          'Please come back tomorrow.',
        retryAfterSec: this.secondsToMidnightUtc(now),
      };
    }

    if (maxTurnsPerMinPerIp > 0) {
      const recent = this.turns.recent(ip, now);
      if (recent.length >= maxTurnsPerMinPerIp) {
        return {
          allowed: false,
          scope: 'ip-turns',
          message: "You're talking faster than this demo can keep up. Give it a minute.",
          retryAfterSec: Math.max(1, Math.ceil((recent[0] + MINUTE_MS - now) / 1000)),
        };
      }
    }

    this.turns.record(ip, now);
    this.dayTurns += 1;
    return { allowed: true };
  }

  /** Turns spent so far today, for /health. */
  turnsToday(): number {
    this.rollDay(this.clock());
    return this.dayTurns;
  }

  /** Forget idle state. Cheap; call from a timer. */
  sweep(): void {
    const now = this.clock();
    this.connects.sweep(now);
    this.turns.sweep(now);
  }
}

/**
 * The address to rate-limit on.
 *
 * Behind a proxy (Render) the socket's own address is the proxy's, so every
 * visitor would share one bucket. X-Forwarded-For is honoured only when
 * TRUST_PROXY says there is a proxy to believe: a client can send that header
 * itself, and trusting it blindly lets anyone dodge the limits.
 *
 * `trustProxyHops` is the number of trusted proxies in front of the server;
 * the client is taken that many entries from the right of the header.
 */
export function clientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxyHops: number
): string {
  const direct = normaliseIp(remoteAddress) || 'unknown';
  if (trustProxyHops <= 0 || !forwardedFor) return direct;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const hops = header
    .split(',')
    .map((part) => normaliseIp(part))
    .filter(Boolean);
  if (hops.length === 0) return direct;
  return hops[Math.max(0, hops.length - trustProxyHops)];
}

function normaliseIp(raw: string | undefined): string {
  const ip = (raw ?? '').trim();
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * TRUST_PROXY: unset/false/0 = no proxy, true = one proxy, a number = that many.
 */
export function trustProxyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return 0;
  if (raw === 'true') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 0;
}

/** Constant-time comparison for the optional shared secret. */
export function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}
