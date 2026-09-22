/**
 * Stage timings for a single turn.
 *
 * Interruption handling is a pipeline — convert, transcribe, classify, decide —
 * and the caller feels the sum of it as "how long until the agent reacted".
 * Measuring each stage separately is the only way to know which one to attack.
 */
export interface Mark {
  label: string;
  /** ms since the timeline started. */
  at: number;
  /** ms since the previous mark. */
  delta: number;
}

export class Timeline {
  private readonly startedAt = Date.now();
  private last = this.startedAt;
  private marks: Mark[] = [];

  mark(label: string): void {
    const now = Date.now();
    this.marks.push({ label, at: now - this.startedAt, delta: now - this.last });
    this.last = now;
  }

  get total(): number {
    return Date.now() - this.startedAt;
  }

  snapshot(): Mark[] {
    return [...this.marks];
  }

  /** One-line summary for the server log. */
  format(): string {
    return this.marks.map((m) => `${m.label} +${m.delta}ms`).join(' · ');
  }
}
