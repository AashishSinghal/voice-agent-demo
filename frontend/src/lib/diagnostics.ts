/**
 * Diagnostic recorder.
 *
 * A voice agent fails in ways a screenshot cannot show: a threshold that was
 * never crossed, an event that arrived in the wrong order, audio that was sent
 * but never transcribed. This captures the whole session — client events,
 * server events, socket traffic in both directions, and the microphone level
 * over time — as one structured log that can be exported and read elsewhere.
 *
 * Audio payloads are never stored, only their size. A minute of conversation
 * is tens of megabytes of PCM and none of it helps.
 */

export type DiagSource = 'client' | 'server' | 'socket-in' | 'socket-out' | 'vad' | 'audio';

export interface DiagEntry {
  /** ms since the recorder started. */
  t: number;
  source: DiagSource;
  event: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 3000;
/** Microphone level is sampled rather than logged every frame. */
const LEVEL_SAMPLE_MS = 250;

class Diagnostics {
  private entries: DiagEntry[] = [];
  private startedAt = performance.now();
  private lastLevelAt = 0;
  private listeners = new Set<() => void>();

  meta: Record<string, unknown> = {};

  reset(): void {
    this.entries = [];
    this.startedAt = performance.now();
    this.lastLevelAt = 0;
    this.notify();
  }

  /** Session context — browser, audio settings, thresholds. */
  setMeta(meta: Record<string, unknown>): void {
    this.meta = { ...this.meta, ...meta };
  }

  log(source: DiagSource, event: string, data?: Record<string, unknown>): void {
    const entry: DiagEntry = {
      t: Math.round(performance.now() - this.startedAt),
      source,
      event,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    console.log(`[${source}] ${event}`, data ?? '');
    this.notify();
  }

  /** Throttled — called every animation frame, kept at ~4 Hz in the log. */
  logLevel(rms: number, calibration: { noiseFloor: number; speechThreshold: number }): void {
    const now = performance.now();
    if (now - this.lastLevelAt < LEVEL_SAMPLE_MS) return;
    this.lastLevelAt = now;

    this.entries.push({
      t: Math.round(now - this.startedAt),
      source: 'vad',
      event: 'level',
      data: {
        rms: Number(rms.toFixed(4)),
        floor: Number(calibration.noiseFloor.toFixed(4)),
        speechAt: Number(calibration.speechThreshold.toFixed(4)),
      },
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  get count(): number {
    return this.entries.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      capturedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - this.startedAt),
      meta: this.meta,
      entries: this.entries,
    };
  }

  toJSON(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  /** Human-readable form — easier to skim and to paste into a conversation. */
  toText(): string {
    const snap = this.snapshot();
    const header = [
      `# voice-agent diagnostics`,
      `captured: ${snap.capturedAt}`,
      `duration: ${(snap.durationMs / 1000).toFixed(1)}s`,
      `entries:  ${snap.entries.length}`,
      '',
      '## environment',
      ...Object.entries(snap.meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      '',
      '## timeline',
    ];

    const lines = snap.entries.map((e) => {
      const time = (e.t / 1000).toFixed(2).padStart(7);
      const source = e.source.padEnd(10);
      const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
      return `${time}s ${source} ${e.event}${data}`;
    });

    return [...header, ...lines].join('\n');
  }

  async copy(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(this.toText());
      return true;
    } catch {
      return false;
    }
  }

  download(): void {
    const blob = new Blob([this.toText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `voice-agent-diagnostics-${Date.now()}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const diag = new Diagnostics();

if (import.meta.env.DEV) {
  // Console escape hatch: copy(__diag.toText()) or __diag.download()
  (window as unknown as Record<string, unknown>).__diag = diag;
}
