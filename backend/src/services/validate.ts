/**
 * Validation for everything a socket client can send.
 *
 * The payloads come straight from a browser the server does not control, so
 * nothing in them is trusted: types are checked, numbers must be finite, and
 * ranges are clamped. A client-reported duration feeds the cost meter, so it
 * is also bounded by what the byte size could plausibly hold.
 *
 * Validators never throw. They return either a clean value or a reason string
 * that the caller logs and then drops the event.
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The server keeps the speech onset to 700ms before it; 30s is a generous ceiling. */
export const MAX_TRIM_START_MS = 30_000;
/**
 * Lowest bitrate a real clip could have, in bytes per second. Opus speech at
 * the browser's default is ~4KB/s; even very low rates stay above this, so a
 * clip claiming more seconds than size/MIN_BYTES_PER_SECOND is lying.
 */
export const MIN_BYTES_PER_SECOND = 500;
/** No single clip is plausibly longer than this, whatever its size. */
export const MAX_CLIP_MS = 10 * 60_000;
export const MAX_CHUNKS = 1000;
export const MAX_TURN_ID = 1_000_000_000;
/** Default cap on one audio upload. Overridable with MAX_AUDIO_BYTES. */
export const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface AudioInput {
  audio: Buffer;
  duringPlayback: boolean;
  spokenChunks: number | undefined;
  trimStartMs: number;
  spokenMs: number;
  clipMs: number;
}

export interface BargeInput {
  turnId: number;
  chunksPlayed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Absent is fine and takes the default; present but not a finite number is rejected. */
function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number
): Validated<number> {
  const raw = obj[key];
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: `${key} is not a finite number` };
  }
  return { ok: true, value: clamp(raw, min, max) };
}

/** Accept a Buffer or ArrayBuffer only. Typed-array views and strings are refused. */
export function toAudioBuffer(value: unknown, maxBytes: number): Validated<Buffer> {
  let buffer: Buffer;
  if (Buffer.isBuffer(value)) {
    buffer = value;
  } else if (value instanceof ArrayBuffer) {
    buffer = Buffer.from(value);
  } else {
    return { ok: false, reason: 'audio is not an ArrayBuffer or Buffer' };
  }
  if (buffer.byteLength === 0) return { ok: false, reason: 'audio is empty' };
  if (buffer.byteLength > maxBytes) {
    return { ok: false, reason: `audio is ${buffer.byteLength}B, over the ${maxBytes}B cap` };
  }
  return { ok: true, value: buffer };
}

/** The most seconds of audio `bytes` could plausibly hold, in ms. */
export function plausibleClipMs(bytes: number): number {
  return Math.min(MAX_CLIP_MS, Math.ceil((bytes / MIN_BYTES_PER_SECOND) * 1000));
}

export function validateAudioInput(
  data: unknown,
  maxBytes: number = DEFAULT_MAX_AUDIO_BYTES
): Validated<AudioInput> {
  if (!isRecord(data)) return { ok: false, reason: 'payload is not an object' };

  const audio = toAudioBuffer(data.audio, maxBytes);
  if (!audio.ok) return audio;
  const ceiling = plausibleClipMs(audio.value.byteLength);

  const dp = data.duringPlayback;
  if (dp !== undefined && dp !== null && typeof dp !== 'boolean') {
    return { ok: false, reason: 'duringPlayback is not a boolean' };
  }

  const trim = optionalNumber(data, 'trimStartMs', 0, MAX_TRIM_START_MS, 0);
  if (!trim.ok) return trim;
  const clip = optionalNumber(data, 'clipMs', 0, ceiling, 0);
  if (!clip.ok) return clip;
  // Time above the speech threshold cannot exceed the clip itself.
  const spoken = optionalNumber(data, 'spokenMs', 0, ceiling, 0);
  if (!spoken.ok) return spoken;
  const chunks = optionalNumber(data, 'spokenChunks', 0, MAX_CHUNKS, -1);
  if (!chunks.ok) return chunks;

  return {
    ok: true,
    value: {
      audio: audio.value,
      duringPlayback: dp === true,
      spokenChunks: chunks.value < 0 ? undefined : Math.floor(chunks.value),
      trimStartMs: trim.value,
      // When the client reported a clip length, spoken time is bounded by it.
      spokenMs: clip.value > 0 ? Math.min(spoken.value, clip.value) : spoken.value,
      clipMs: clip.value,
    },
  };
}

function validateTurnId(obj: Record<string, unknown>): Validated<number> {
  const raw = obj.turnId;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_TURN_ID) {
    return { ok: false, reason: 'turnId is not a sane integer' };
  }
  return { ok: true, value: raw };
}

export function validateBarge(data: unknown): Validated<BargeInput> {
  if (!isRecord(data)) return { ok: false, reason: 'payload is not an object' };
  const turnId = validateTurnId(data);
  if (!turnId.ok) return turnId;
  const played = optionalNumber(data, 'chunksPlayed', 0, MAX_CHUNKS, 0);
  if (!played.ok) return played;
  return { ok: true, value: { turnId: turnId.value, chunksPlayed: Math.floor(played.value) } };
}

/** `playback:complete` and `playback:progress` both carry just a turn id. */
export function validatePlayback(data: unknown): Validated<{ turnId: number }> {
  if (!isRecord(data)) return { ok: false, reason: 'payload is not an object' };
  const turnId = validateTurnId(data);
  if (!turnId.ok) return turnId;
  return { ok: true, value: { turnId: turnId.value } };
}
