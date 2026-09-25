/**
 * Reads a diagnostic log back into structured events.
 *
 * The log already contains everything needed to label a recording: when the
 * caller spoke, what was transcribed, how the over-speech was classified, and
 * whether it was thrown away. Pairing that with the audio from the same call
 * turns one long recording into individually labelled clips, without anyone
 * listening to it and typing what they hear.
 *
 * Kept free of file and process access so it can be tested against a fixture.
 */

export interface LogEvent {
  /** Seconds since the log started. */
  at: number;
  source: string;
  name: string;
  data: Record<string, unknown>;
}

export interface Utterance {
  index: number;
  /** Bytes of the clip, which joins the send to its transcript. */
  bytes: number;
  /** Spoken over the agent rather than in reply to it. */
  overSpeech: boolean;
  spokenMs: number;
  clipMs: number;
  trimStartMs: number;
  transcript: string | null;
  sttMs: number | null;
  classification: 'backchannel' | 'resume' | 'interruption' | null;
  discarded: boolean;
  discardReason: string | null;
  /** Where this sits in the caller's track, in seconds from its start. */
  audio: { startSec: number; endSec: number } | null;
}

export interface ParsedCall {
  /** When call recording began, in log seconds. Null if it was not recorded. */
  recordingStartedAt: number | null;
  recordingDurationMs: number | null;
  utterances: Utterance[];
  events: LogEvent[];
}

const LINE = /^\s*([\d.]+)s\s+(\S+)\s+(.+)$/;

export function parseEvents(text: string): LogEvent[] {
  const events: LogEvent[] = [];

  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;

    const [, seconds, source, remainder] = match;

    // Server notes are prefixed with a bullet; socket traces have none.
    const body = remainder.replace(/^·\s*/, '');
    const brace = body.indexOf('{');
    if (brace === -1) continue; // a trace line with no payload

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body.slice(brace));
    } catch {
      continue; // truncated or not JSON; nothing to learn from it
    }

    events.push({
      at: Number(seconds),
      source,
      name: body.slice(0, brace).trim(),
      data,
    });
  }

  return events;
}

/** Margin kept either side of detected speech when cutting a clip. */
const CLIP_PADDING_SEC = 0.3;

export function parseCall(text: string): ParsedCall {
  const events = parseEvents(text);

  let recordingStartedAt: number | null = null;
  let recordingDurationMs: number | null = null;

  const utterances: Utterance[] = [];
  const byBytes = new Map<number, Utterance>();

  let lastSpeechStartAt: number | null = null;
  let lastSpeechEndAt: number | null = null;
  let lastSilenceWindowMs = 900;
  let lastTranscribed: Utterance | null = null;

  for (const event of events) {
    if (event.name === 'conversation recording started') {
      recordingStartedAt = event.at;
      continue;
    }

    if (event.name === 'conversation recording stopped') {
      recordingDurationMs = Number(event.data.durationMs ?? 0) || null;
      continue;
    }

    if (event.source === 'vad' && event.name === 'speech start') {
      lastSpeechStartAt = event.at;
      continue;
    }

    if (event.source === 'vad' && event.name === 'speech end') {
      lastSpeechEndAt = event.at;
      lastSilenceWindowMs = Number(event.data.silenceWindowMs ?? 900);
      continue;
    }

    if (event.source === 'socket-out' && event.name === 'audio:input') {
      const bytes = Number(event.data.bytes ?? 0);

      // Speech-end fires on every silent stretch, so only the one paired with
      // an actual send describes a real utterance.
      let audio: Utterance['audio'] = null;
      if (recordingStartedAt !== null && lastSpeechStartAt !== null) {
        const endAt =
          lastSpeechEndAt !== null && lastSpeechEndAt >= lastSpeechStartAt
            ? lastSpeechEndAt - lastSilenceWindowMs / 1000
            : event.at;

        audio = {
          startSec: Math.max(0, lastSpeechStartAt - recordingStartedAt - CLIP_PADDING_SEC),
          endSec: Math.max(0, endAt - recordingStartedAt + CLIP_PADDING_SEC),
        };
      }

      const utterance: Utterance = {
        index: utterances.length,
        bytes,
        overSpeech: Boolean(event.data.duringPlayback),
        spokenMs: Number(event.data.spokenMs ?? 0),
        clipMs: Number(event.data.clipMs ?? 0),
        trimStartMs: Number(event.data.trimStartMs ?? 0),
        transcript: null,
        sttMs: null,
        classification: null,
        discarded: false,
        discardReason: null,
        audio,
      };

      utterances.push(utterance);
      if (bytes) byBytes.set(bytes, utterance);

      lastSpeechStartAt = null;
      lastSpeechEndAt = null;
      continue;
    }

    if (event.name === 'transcript') {
      // `bytes` is the reliable join: it appears on both the send and the
      // transcript, and survives events arriving out of order.
      const match = byBytes.get(Number(event.data.bytes ?? -1));
      if (match) {
        match.transcript = String(event.data.text ?? '') || null;
        match.sttMs = Number(event.data.ms ?? 0) || null;
        lastTranscribed = match;
      }
      continue;
    }

    if (event.name === 'classification') {
      const target = lastTranscribed ?? utterances[utterances.length - 1];
      if (target) {
        const kind = String(event.data.kind ?? '');
        if (kind === 'backchannel' || kind === 'resume' || kind === 'interruption') {
          target.classification = kind;
        }
      }
      continue;
    }

    if (event.name === 'discarded transcript' || event.name === 'discarded over-speech') {
      const target = lastTranscribed ?? utterances[utterances.length - 1];
      if (target) {
        target.discarded = true;
        target.discardReason = String(event.data.reason ?? 'silence artefact');
        if (!target.transcript) target.transcript = String(event.data.text ?? '') || null;
      }
      continue;
    }
  }

  return { recordingStartedAt, recordingDurationMs, utterances, events };
}
