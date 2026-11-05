/**
 * Drop the log lines that carry nothing the full bundle does not already say.
 *
 * A call's timeline is mostly bulk: one line per streamed token (twice, once
 * from each side), the same event logged by both the server and the browser,
 * and the microphone level every quarter second. Reading it costs tokens in
 * proportion, so the exported text leaves those out. The raw entries are kept
 * in memory, and `toText({ full: true })` still gives everything.
 *
 * What is kept is what a call can be understood from: speech start and end, the
 * clip metadata, transcripts, classification, state changes, timings, cost,
 * errors and disconnects.
 */

export interface CompactEntry {
  t: number;
  source: string;
  event: string;
  data?: Record<string, unknown>;
}

/** A server line mirrors a browser line when the same event reaches the page this soon after. */
const MIRROR_WINDOW_MS = 1500;
/** Quiet microphone samples are thinned to this; loud ones (above the speech threshold) are all kept. */
const QUIET_LEVEL_MS = 1000;

const SERVER_EVENT = /^\[[^\]]+\]\s*->\s*(\S+)/;

export function compactEntries(entries: CompactEntry[]): CompactEntry[] {
  // When each event last reached the browser, for matching the server's copy.
  const arrivals = new Map<string, number[]>();
  for (const e of entries) {
    if (e.source !== 'socket-in') continue;
    const list = arrivals.get(e.event) ?? [];
    list.push(e.t);
    arrivals.set(e.event, list);
  }

  const out: CompactEntry[] = [];
  let lastQuietLevelAt = -Infinity;
  let speechStartedSinceEnd = false;

  for (const e of entries) {
    // The reply text is whole in `response:done`; per-token lines only repeat it.
    if (e.event.includes('response:text:delta')) continue;
    // A heartbeat that proves nothing the chunk lifecycle lines do not.
    if (e.source === 'server' && e.event.includes('<- playback:progress')) continue;
    if (e.source === 'server' && e.event.includes('Cleaned up:')) continue;

    if (e.source === 'server') {
      const sent = SERVER_EVENT.exec(e.event)?.[1];
      if (sent) {
        const seen = arrivals.get(sent);
        if (seen?.some((t) => t >= e.t - MIRROR_WINDOW_MS && t <= e.t + MIRROR_WINDOW_MS)) continue;
      }
    }

    if (e.source === 'vad' && e.event === 'level') {
      const loud = Number(e.data?.rms) >= Number(e.data?.speechAt);
      if (!loud && e.t - lastQuietLevelAt < QUIET_LEVEL_MS) continue;
      if (!loud) lastQuietLevelAt = e.t;
    }

    if (e.source === 'vad' && e.event === 'speech start') speechStartedSinceEnd = true;
    // The detector re-reports "speech end" every window while the room stays
    // quiet. Only the one that closes an utterance means anything.
    if (e.source === 'vad' && e.event === 'speech end') {
      if (!speechStartedSinceEnd) continue;
      speechStartedSinceEnd = false;
    }

    out.push(e);
  }
  return out;
}
