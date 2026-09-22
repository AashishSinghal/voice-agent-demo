/**
 * Distinguishes a backchannel from a real interruption.
 *
 * When a caller says "mhm" or "yeah" while the agent is talking, they are
 * signalling attention, not asking it to stop. Treating that as an interrupt
 * makes an agent feel broken — it stops constantly and never finishes a
 * thought. Treating a real question as a backchannel is worse, so this errs
 * toward interrupting: anything that is not clearly an acknowledgement counts
 * as a genuine interruption.
 *
 * This is deliberately a lookup and not a model call. It sits on the critical
 * path between the caller speaking and the agent reacting, so it has to be
 * instant and predictable.
 */

const BACKCHANNEL_PHRASES = new Set([
  'mhm', 'mm', 'mmm', 'mmhm', 'hmm', 'huh',
  'yeah', 'yep', 'yup', 'yes', 'ya', 'yeah yeah',
  'ok', 'okay', 'k', 'kay',
  'right', 'sure', 'got it', 'gotcha', 'i see', 'i see okay',
  'uh huh', 'uhhuh', 'uh-huh', 'aha', 'ah', 'oh', 'ooh',
  'nice', 'cool', 'great', 'wow', 'really',
  'true', 'exactly', 'makes sense', 'fair enough',
  'go on', 'continue', 'carry on', 'keep going',
]);

/** Phrases that mean "resume what you were saying", not "new request". */
const RESUME_PHRASES = new Set(['go on', 'continue', 'carry on', 'keep going', 'sorry go on']);

const MAX_BACKCHANNEL_WORDS = 3;

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, '') // strip punctuation, keep letters/digits
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strings Whisper emits when handed silence or noise rather than speech.
 *
 * Large Whisper models are trained on subtitled video and fall back on caption
 * boilerplate when there is nothing to transcribe. Fed a few seconds of room
 * tone they will confidently return "Thank you." — which then becomes a real
 * conversational turn and derails the call. Recognising the artefact is far
 * cheaper than trying to stop the model producing it.
 */
const HALLUCINATIONS = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks for watching',
  'thank you for watching', 'thanks for watching!', 'please subscribe',
  'subscribe', 'you', 'bye', 'bye bye', 'okay bye', 'the end',
  'silence', 'music', 'applause', 'beep', 'blank_audio',
]);

/**
 * True if the transcript looks like a silence artefact rather than speech.
 * Only applied to short clips: someone genuinely saying "thank you" mid
 * conversation says it inside a longer utterance.
 */
export function looksHallucinated(text: string, spokenMs: number): boolean {
  const normalised = normalise(text);
  if (!normalised) return true;
  if (spokenMs > 1500) return false;
  return HALLUCINATIONS.has(normalised);
}

export interface UtteranceClassification {
  kind: 'backchannel' | 'resume' | 'interruption';
  normalised: string;
}

export function classifyUtterance(text: string): UtteranceClassification {
  const normalised = normalise(text);

  if (!normalised) {
    // Whisper heard nothing usable — most likely background noise, not speech.
    return { kind: 'backchannel', normalised };
  }

  if (RESUME_PHRASES.has(normalised)) {
    return { kind: 'resume', normalised };
  }

  const words = normalised.split(' ');
  if (words.length <= MAX_BACKCHANNEL_WORDS && BACKCHANNEL_PHRASES.has(normalised)) {
    return { kind: 'backchannel', normalised };
  }

  // A question is never a backchannel, however short.
  return { kind: 'interruption', normalised };
}
