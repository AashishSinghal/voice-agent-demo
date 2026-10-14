import type { CallState } from '../models/types.js';

/**
 * What to do when the client reports that a barge-in contained no speech.
 *
 * The client resumes its own playback straight away, but the server paused too
 * (`barge:detected` moves it to `paused`). Without this the server stays paused
 * until the watchdog notices, 20 seconds later, and in that window a
 * `playback:complete` or a fresh turn is handled against the wrong state.
 *
 *   resume  — a turn is still in flight, so go back to speaking
 *   listen  — the turn finished while paused; nothing is left to resume
 *   ignore  — the call was not paused, so this cancel is stale (the over-speech
 *             was already classified, or the call ended) and acting on it
 *             would clobber a state that has since moved on
 */
export type BargeCancelAction = 'resume' | 'listen' | 'ignore';

export function resolveBargeCancel(state: CallState, turnInFlight: boolean): BargeCancelAction {
  if (state !== 'paused') return 'ignore';
  return turnInFlight ? 'resume' : 'listen';
}
