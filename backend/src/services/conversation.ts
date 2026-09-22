import type { Turn } from '../models/types.js';

/**
 * Conversation state for one call.
 *
 * The important job here is keeping the model's view of the conversation
 * honest. When the caller interrupts, the agent has usually generated more
 * text than it managed to speak. If the full generated text goes into the
 * history, the model believes it said things the caller never heard, and the
 * next turn makes no sense ("as I mentioned, ..." — it didn't).
 *
 * So an assistant turn is only committed once we know how much of it was
 * actually spoken, and the remainder is kept separately so the caller can ask
 * the agent to carry on.
 */

const MAX_TURNS = 16;

export class Conversation {
  private turns: Turn[] = [];

  /** Sentence chunks emitted for the turn currently being spoken. */
  private pendingChunks: string[] = [];
  private pendingTurnId: number | null = null;

  reset(): void {
    this.turns = [];
    this.pendingChunks = [];
    this.pendingTurnId = null;
  }

  addUserTurn(content: string): void {
    this.turns.push({ role: 'user', content, timestamp: new Date() });
    this.trim();
  }

  /** Record a chunk as it is handed to the client for playback. */
  trackChunk(turnId: number, text: string): void {
    if (this.pendingTurnId !== turnId) {
      this.pendingTurnId = turnId;
      this.pendingChunks = [];
    }
    this.pendingChunks.push(text);
  }

  /** The assistant finished speaking everything it generated. */
  commitComplete(turnId: number, fullText: string): void {
    this.turns.push({ role: 'assistant', content: fullText.trim(), timestamp: new Date() });
    this.clearPending(turnId);
    this.trim();
  }

  /**
   * The caller cut in. `spokenChunks` is how many sentence chunks finished
   * playing; anything after that was generated but never heard.
   *
   * Returns the text the caller actually heard.
   */
  commitInterrupted(turnId: number, spokenChunks: number): string {
    const chunks = this.pendingTurnId === turnId ? this.pendingChunks : [];

    const spoken = chunks.slice(0, Math.max(0, spokenChunks)).join(' ').trim();
    const unspoken = chunks.slice(Math.max(0, spokenChunks)).join(' ').trim();

    // Nothing was heard at all — there is no assistant turn worth recording.
    if (spoken) {
      this.turns.push({
        role: 'assistant',
        content: spoken,
        timestamp: new Date(),
        interrupted: true,
        unspoken: unspoken || undefined,
      });
      this.trim();
    }

    this.clearPending(turnId);
    return spoken;
  }

  /** Is there an assistant turn part-spoken and not yet committed? */
  hasPending(turnId?: number): boolean {
    if (this.pendingTurnId === null) return false;
    if (turnId !== undefined && this.pendingTurnId !== turnId) return false;
    return this.pendingChunks.length > 0;
  }

  /**
   * Commit whatever is in flight as interrupted, assuming everything emitted
   * was heard. Used when a turn is abandoned without the client reporting how
   * much it played — losing the turn entirely is worse, because the agent then
   * has no record of a topic it demonstrably started explaining.
   */
  commitPendingAsInterrupted(): string {
    if (this.pendingTurnId === null) return '';
    return this.commitInterrupted(this.pendingTurnId, this.pendingChunks.length);
  }

  /** What the agent was about to say when it was cut off, if anything. */
  lastUnspoken(): string | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.role !== 'assistant') continue;
      return turn.unspoken ?? null;
    }
    return null;
  }

  /** Was the most recent assistant turn cut short? */
  lastTurnInterrupted(): boolean {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === 'assistant') return !!this.turns[i].interrupted;
    }
    return false;
  }

  history(): Turn[] {
    return [...this.turns];
  }

  private clearPending(turnId: number): void {
    if (this.pendingTurnId === turnId) {
      this.pendingChunks = [];
      this.pendingTurnId = null;
    }
  }

  private trim(): void {
    if (this.turns.length > MAX_TURNS) {
      this.turns = this.turns.slice(-MAX_TURNS);
    }
  }
}
