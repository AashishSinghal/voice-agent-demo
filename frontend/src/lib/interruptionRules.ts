/**
 * Decisions about interrupting the agent, kept free of React and the audio
 * graph so they can be tested without a browser or a speaker.
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

/**
 * Is the caller already talking as the agent's audio arrives?
 *
 * Speech detection needs a moment of sustained sound, and the agent's first
 * chunk can land in that gap, or in the "thinking" state where barge-in is not
 * armed. Playing it would have the agent start talking over someone mid
 * sentence, so audio that arrives into live speech is held and treated as an
 * interruption from its first frame.
 */
export function shouldBargeOnArrival(input: {
  callerSpeaking: boolean;
  alreadyBarging: boolean;
  callActive: boolean;
}): boolean {
  return input.callActive && input.callerSpeaking && !input.alreadyBarging;
}
