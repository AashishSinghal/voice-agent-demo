/**
 * Playback's own rule for when a new turn cuts off what is playing, kept free of
 * React and the audio graph so it can be tested without a speaker. Who is
 * speaking, and what to do about it, lives in turnTaking.ts.
 */

/**
 * Should the chunk now being queued cut off what is currently playing?
 *
 * A new turn supersedes the old one. The old rule only released playback when
 * chunks of the old turn were still *queued*, but the chunk playing right now
 * has already left the queue, so it survived: the caller heard the previous
 * answer to the end while the new transcript was already on screen. What is
 * playing belongs to the old turn if its id differs from the incoming one.
 */
export function shouldReleaseCurrent(input: {
  paused: boolean;
  droppedQueued: number;
  playingTurn: number | null;
  incomingTurn: number;
}): boolean {
  if (input.paused || input.droppedQueued > 0) return true;
  return input.playingTurn !== null && input.playingTurn !== input.incomingTurn;
}
