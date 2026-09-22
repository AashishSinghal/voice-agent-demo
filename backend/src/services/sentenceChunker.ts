/**
 * Buffers a token stream and emits complete, speakable chunks.
 *
 * Why this exists: TTS latency scales with text length, so waiting for the
 * full LLM response before synthesising anything costs us the entire
 * generation time before the user hears a single word. Chunking at sentence
 * boundaries lets us synthesise and stream the first sentence while the model
 * is still writing the rest.
 *
 * The first chunk is deliberately allowed to be short (FIRST_CHUNK_MIN_CHARS)
 * so time-to-first-audio stays low; later chunks use a larger minimum so we
 * don't fragment speech into unnatural bursts.
 */

const FIRST_CHUNK_MIN_CHARS = 12;
const CHUNK_MIN_CHARS = 40;

// Abbreviations whose trailing period must not be treated as a sentence end.
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'e.g', 'i.e', 'etc', 'vs', 'approx', 'no',
];

function endsWithAbbreviation(text: string): boolean {
  const match = text.trimEnd().match(/([A-Za-z.]+)\.$/);
  if (!match) return false;
  return ABBREVIATIONS.includes(match[1].toLowerCase());
}

/** A decimal point (3.5) or an ellipsis is not a sentence boundary. */
function isRealBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char !== '.') return true;

  const prev = text[index - 1];
  const next = text[index + 1];

  if (prev && next && /\d/.test(prev) && /\d/.test(next)) return false; // 3.5
  if (next === '.') return false;                                       // ...
  if (endsWithAbbreviation(text.slice(0, index + 1))) return false;     // Dr.

  return true;
}

export class SentenceChunker {
  private buffer = '';
  private emitted = 0;

  /**
   * Feed a token. Returns any chunks that are now complete — usually zero or
   * one, but a token containing several boundaries can yield more.
   */
  push(token: string): string[] {
    this.buffer += token;
    return this.drain(false);
  }

  /** Flush whatever is left when the stream ends. */
  flush(): string[] {
    const chunks = this.drain(true);
    const tail = this.buffer.trim();
    this.buffer = '';

    if (tail) {
      this.emitted++;
      chunks.push(tail);
    }
    return chunks;
  }

  get chunksEmitted(): number {
    return this.emitted;
  }

  private minChars(): number {
    return this.emitted === 0 ? FIRST_CHUNK_MIN_CHARS : CHUNK_MIN_CHARS;
  }

  private drain(final: boolean): string[] {
    const chunks: string[] = [];

    for (;;) {
      const cut = this.findBoundary();
      if (cut === -1) break;

      const candidate = this.buffer.slice(0, cut + 1).trim();

      // Too short to be worth speaking on its own — unless the stream is
      // ending, in which case there is nothing more to wait for.
      if (candidate.length < this.minChars() && !final) break;

      this.buffer = this.buffer.slice(cut + 1);
      if (candidate) {
        this.emitted++;
        chunks.push(candidate);
      }
    }

    return chunks;
  }

  /** Index of the first usable sentence-ending punctuation, or -1. */
  private findBoundary(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char !== '.' && char !== '!' && char !== '?' && char !== '\n') continue;
      if (!isRealBoundary(this.buffer, i)) continue;

      // Require the boundary to be followed by whitespace or end-of-buffer, so
      // we never cut mid-token while the stream is still arriving.
      const next = this.buffer[i + 1];
      if (next === undefined || /\s/.test(next)) return i;
    }
    return -1;
  }
}
