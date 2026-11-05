/**
 * Turn-taking: who is speaking, and what to do when the caller talks over the
 * agent.
 *
 * One pure module. Events come in (the caller started or stopped speaking,
 * audio arrived, the server said something); commands go out (pause playback,
 * tell the server about a barge-in, send a recording). It touches no React, no
 * microphone, no clock and no audio element: everything it needs to know about
 * the outside world arrives *inside* the event, so the same sequence of events
 * always produces the same commands.
 *
 * That is the point of it. Interruption bugs here were never in one decision;
 * they were in how decisions were ordered across a dozen refs, and none could be
 * reproduced without a microphone. A diagnostics bundle is already an ordered
 * event log, so it replays through this module as a test (see replay.ts).
 *
 * The caller of `step` owns execution: it feeds events in and performs the
 * commands that come back.
 */

import type { CallState, TimelineKind } from '../stores/useBotStateStore';

/** Thresholds and windows, all in milliseconds. */
export const TIMING = {
  /**
   * Sustained sound needed before a normal turn believes someone is talking.
   * Keeps coughs and door slams out.
   */
  SPEECH_ONSET_MS: 250,
  /**
   * The same, while the agent is speaking. "Stop" is a quarter of a second
   * long, so under the normal rule one loud sample registered and nothing was
   * detected. A false alarm here only costs a brief pause the server resumes.
   */
  BARGE_SPEECH_MS: 120,
  /**
   * Minimum audible speech before a clip is worth transcribing. Whisper does not
   * return nothing for near-silence; it returns caption boilerplate ("Thank
   * you."), which becomes a conversational turn. Not sending the clip is the
   * cheap half of the fix; the server rejects the artefact as the other half.
   * Counted from when the caller began, onset included: it was once counted from
   * when speech was confirmed, so a 430 ms "stop" read as 180 ms and was dropped.
   */
  MIN_SPOKEN_MS: 300,
  /** The same for an interruption, for the same reason as BARGE_SPEECH_MS. */
  BARGE_MIN_SPOKEN_MS: 150,
  /**
   * How long a pause has to last before the caller is considered finished. A
   * normal turn can afford to wait: cutting someone off mid-thought is worse
   * than a short pause. Triaging over-speech cannot, because the agent is
   * already silent and every extra millisecond is dead air.
   */
  ENDPOINT_MS: 900,
  ENDPOINT_OVER_SPEECH_MS: 450,
  /**
   * Audio kept before the detected speech onset when trimming. Detection needs
   * sustained sound to be confident, and people do not start a sentence at full
   * volume, so the true onset is earlier than the detection. Without the margin
   * the first word is clipped ("explain software engineering" arrived as
   * "engineering").
   */
  PREROLL_MS: 700,
  /** Longest single utterance before it is sent regardless. */
  MAX_TURN_MS: 15_000,
  /**
   * A recording of nothing but silence is recycled after this long, to cap how
   * much audio is buffered.
   */
  IDLE_RECYCLE_MS: 10_000,
} as const;

/** The speech-detector windows to use right now. */
export function vadTuning(callState: CallState): {
  speechDurationMs: number;
  silenceDurationMs: number;
} {
  return {
    speechDurationMs: callState === 'speaking' ? TIMING.BARGE_SPEECH_MS : TIMING.SPEECH_ONSET_MS,
    silenceDurationMs: callState === 'paused' ? TIMING.ENDPOINT_OVER_SPEECH_MS : TIMING.ENDPOINT_MS,
  };
}

/** What accompanies a recording to the server. */
export interface SendPayload {
  /** True when the clip is the caller talking over the agent. */
  duringPlayback: boolean;
  /** Chunks of the agent's reply that had finished playing. */
  spokenChunks: number;
  trimStartMs: number;
  /** How long the caller was actually audible in the clip. */
  spokenMs: number;
  /** What the server will transcribe, which is what gets billed. */
  clipMs: number;
}

export interface TurnTakingState {
  callActive: boolean;
  /** The caller is mid-utterance in the current recording. */
  sawSpeech: boolean;
  speechStartedAt: number;
  recordingStartedAt: number;
  /** The current recording is over-speech rather than a normal turn. */
  barging: boolean;
  /**
   * Clips requested by `stopRecording` and not yet delivered. A clip that
   * arrives with none owed (a discard that raced a stop, say) is dropped: it
   * has no metadata, and sending it would put a nameless clip in front of the
   * transcriber.
   */
  clipsOwed: number;
  /** Chunks the agent had fully spoken when the caller cut in. */
  spokenAtBarge: number;
  /**
   * What to send with the recording being stopped. Captured at stop time rather
   * than read live: the recorder stops asynchronously and the next recording
   * starts before it finishes, which once delivered an interruption as an
   * ordinary turn.
   */
  pendingSend: SendPayload;
}

export const initialState = (): TurnTakingState => ({
  callActive: false,
  sawSpeech: false,
  speechStartedAt: 0,
  recordingStartedAt: 0,
  barging: false,
  clipsOwed: 0,
  spokenAtBarge: 0,
  pendingSend: { duringPlayback: false, spokenChunks: 0, trimStartMs: 0, spokenMs: 0, clipMs: 0 },
});

// -- events -----------------------------------------------------------------

export type TurnTakingEvent =
  | { type: 'callStarted' }
  | { type: 'callEnded' }
  | { type: 'recordingStarted'; now: number }
  /** The recorder produced its clip. */
  | { type: 'recordingReady' }
  | {
      type: 'speechStart';
      now: number;
      callState: CallState;
      chunksPlayed: number;
      latestTurn: number | null;
    }
  | {
      type: 'speechEnd';
      now: number;
      callState: CallState;
      /** Whether the recorder is actually running. */
      recording: boolean;
      chunksPlayed: number;
    }
  | {
      type: 'audioChunk';
      turnId: number;
      /** Playback's counters as they stand before this chunk is queued. */
      chunksPlayed: number;
      latestTurn: number | null;
    }
  /** Once a second. `quiet` is whether the microphone is below the silence threshold. */
  | { type: 'tick'; now: number; quiet: boolean; chunksPlayed: number }
  | { type: 'serverResume' }
  | { type: 'serverInterrupted' }
  | { type: 'readyToListen' };

// -- commands ---------------------------------------------------------------

export type TurnTakingCommand =
  /** Queue the chunk; `hold` starts it paused. */
  | { type: 'enqueueAudio'; hold: boolean }
  | { type: 'pausePlayback' }
  | { type: 'resumePlayback' }
  | { type: 'stopPlayback' }
  | { type: 'resetPlaybackCounter' }
  | { type: 'notifyBarge'; turnId: number; chunksPlayed: number }
  | { type: 'cancelBarge'; reason: string }
  /** Stop the recorder; its clip will arrive as `recordingReady`. */
  | { type: 'stopRecording' }
  | { type: 'discardRecording' }
  | { type: 'sendClip'; send: SendPayload }
  | { type: 'dropClip'; reason: string }
  | { type: 'setUserSpeaking'; value: boolean }
  | { type: 'setThinking'; reason: string }
  | { type: 'trace'; label: string; detail?: string }
  | { type: 'timeline'; op: 'start'; kind: TimelineKind; backdateMs?: number }
  | { type: 'timeline'; op: 'mark'; label: string };

export interface Step {
  state: TurnTakingState;
  commands: TurnTakingCommand[];
}

const trace = (label: string, detail?: string): TurnTakingCommand => ({ type: 'trace', label, detail });

/**
 * The caller is talking over the agent: pause playback and tell the server.
 *
 * Shared by the two ways this starts: speech detected while the agent speaks,
 * and the agent's audio arriving while the caller is already speaking.
 */
function beginBarge(
  state: TurnTakingState,
  played: number,
  turnId: number | null
): Step {
  return {
    state: { ...state, spokenAtBarge: played, barging: true },
    commands: [
      // The clock starts the instant the caller is heard over the agent: that
      // is what "how fast does it react to an interruption" actually means.
      { type: 'timeline', op: 'start', kind: 'interruption' },
      { type: 'timeline', op: 'mark', label: 'speech detected' },
      { type: 'pausePlayback' },
      { type: 'timeline', op: 'mark', label: 'playback paused' },
      trace('over-speech', `paused after ${played} chunk(s)`),
      // The real turn id matters: the server ignores a barge reported against a
      // turn it does not recognise, and then never enters its paused state.
      { type: 'notifyBarge', turnId: turnId ?? 0, chunksPlayed: played },
    ],
  };
}

function payload(
  state: TurnTakingState,
  now: number,
  spokenMs: number,
  chunksPlayed: number
): SendPayload {
  const trimStartMs = Math.max(
    0,
    Math.round(state.speechStartedAt - state.recordingStartedAt - TIMING.PREROLL_MS)
  );
  return {
    duringPlayback: state.barging,
    // For a normal turn this is how much of the previous answer finished
    // playing, so the server records only what was heard if it replaces it.
    spokenChunks: state.barging ? state.spokenAtBarge : chunksPlayed,
    trimStartMs,
    spokenMs,
    clipMs: Math.max(0, Math.round(now - state.recordingStartedAt - trimStartMs)),
  };
}

export function step(state: TurnTakingState, event: TurnTakingEvent): Step {
  switch (event.type) {
    case 'callStarted':
      return { state: { ...initialState(), callActive: true }, commands: [] };

    case 'callEnded':
      return { state: { ...initialState(), callActive: false }, commands: [] };

    case 'recordingStarted':
      // The microphone records for the whole call, not only once speech is
      // confirmed: confirming takes a moment, and by then the first word has
      // already been said. Recording continuously means the onset is captured.
      return {
        state: { ...state, sawSpeech: false, speechStartedAt: 0, recordingStartedAt: event.now },
        commands: [trace('recording started', 'always-on capture')],
      };

    case 'recordingReady':
      // A recorder flushing after the caller hung up must not start a new turn.
      if (!state.callActive) return { state, commands: [{ type: 'dropClip', reason: 'call ended' }] };
      if (state.clipsOwed <= 0) return { state, commands: [{ type: 'dropClip', reason: 'not requested' }] };
      return {
        state: { ...state, clipsOwed: state.clipsOwed - 1 },
        commands: [
          { type: 'timeline', op: 'mark', label: 'audio sent' },
          { type: 'sendClip', send: state.pendingSend },
        ],
      };

    case 'speechStart': {
      let next: TurnTakingState = {
        ...state,
        speechStartedAt: state.sawSpeech ? state.speechStartedAt : event.now,
        sawSpeech: true,
      };
      const commands: TurnTakingCommand[] = [
        // Reflect it at once; waiting for the server costs a round trip and makes
        // the interface feel a beat behind the caller.
        { type: 'setUserSpeaking', value: true },
        trace('speech start', `state=${event.callState}`),
      ];
      // Playback is paused rather than dropped, and nothing is cancelled yet: it
      // may only be "mhm". The server decides once it has heard the words.
      if (event.callState === 'speaking') {
        const barge = beginBarge(next, event.chunksPlayed, event.latestTurn);
        next = barge.state;
        commands.push(...barge.commands);
      }
      return { state: next, commands };
    }

    case 'speechEnd': {
      if (!event.recording) return { state, commands: [trace('speech end ignored', 'not recording')] };
      if (!state.sawSpeech) {
        return { state, commands: [trace('speech end ignored', 'no speech captured yet')] };
      }

      // Speech-end fires one endpoint window after the caller fell quiet, so
      // subtracting it gives the span that was genuinely audible. The clock
      // starts when speech is confirmed, which is one onset window after the
      // caller began; add that back or a short word is undercounted by it (a
      // 430 ms "stop" read as 180 ms and was dropped as noise).
      const endpointWindow =
        event.callState === 'paused' ? TIMING.ENDPOINT_OVER_SPEECH_MS : TIMING.ENDPOINT_MS;
      const spokenMs = Math.max(
        0,
        Math.round(
          event.now -
            endpointWindow -
            state.speechStartedAt +
            (state.barging ? TIMING.BARGE_SPEECH_MS : TIMING.SPEECH_ONSET_MS)
        )
      );
      const base: TurnTakingCommand[] = [{ type: 'setUserSpeaking', value: false }];
      const minimum = state.barging ? TIMING.BARGE_MIN_SPOKEN_MS : TIMING.MIN_SPOKEN_MS;

      if (spokenMs < minimum) {
        // Too brief to be speech: a cough, a door, a burst of noise. Sending it
        // invites a hallucinated transcript, so recycle instead.
        const commands: TurnTakingCommand[] = [
          ...base,
          trace('discarded utterance', `only ${spokenMs}ms audible`),
          { type: 'discardRecording' },
        ];
        // If this false alarm paused the agent mid-sentence, pick it back up
        // rather than leave the call waiting for audio that is never coming.
        if (state.barging) {
          commands.push(
            trace('resuming', 'over-speech contained no speech'),
            { type: 'resumePlayback' },
            { type: 'cancelBarge', reason: 'no speech detected' }
          );
        }
        return { state: { ...state, sawSpeech: false, barging: false }, commands };
      }

      const send = payload(state, event.now, spokenMs, event.chunksPlayed);
      const commands: TurnTakingCommand[] = [
        ...base,
        { type: 'timeline', op: 'mark', label: 'caller stopped' },
        trace('speech end', state.barging ? 'sending over-speech' : 'sending turn'),
      ];
      // Optimistic: the server will confirm, but showing "thinking" now removes
      // a visible round trip of dead air.
      if (!state.barging) {
        // What the caller feels runs from when they fell silent, not from when
        // the detector gave up waiting, so the endpoint wait is part of it.
        commands.push({ type: 'timeline', op: 'start', kind: 'turn', backdateMs: endpointWindow });
        commands.push({ type: 'setThinking', reason: 'optimistic (audio sent)' });
      }
      commands.push({ type: 'stopRecording' });
      return {
        state: { ...state, sawSpeech: false, pendingSend: send, clipsOwed: state.clipsOwed + 1 },
        commands,
      };
    }

    case 'audioChunk': {
      // The agent's first audio can land while the caller is already mid
      // sentence: in the gap before speech is confirmed, or while the state
      // still reads "thinking" and barge-in is not armed. Playing it would talk
      // over them, so it is held and treated as an interruption from the start.
      const barge = state.callActive && state.sawSpeech && !state.barging;
      const commands: TurnTakingCommand[] = [{ type: 'enqueueAudio', hold: barge }];
      if (!barge) return { state, commands };

      // A chunk from a newer turn resets playback's counter to zero.
      const isNewTurn = event.latestTurn !== null && event.turnId !== event.latestTurn;
      const played = isNewTurn ? 0 : event.chunksPlayed;
      const begun = beginBarge(state, played, event.turnId);
      return { state: begun.state, commands: [...commands, ...begun.commands] };
    }

    case 'tick': {
      if (!state.sawSpeech) {
        // Only recycle during genuine quiet. Speech needs sustained sound before
        // it is confirmed, so a recycle fired on a timer alone lands on the start
        // of a sentence and throws the onset away.
        if (event.quiet && event.now - state.recordingStartedAt > TIMING.IDLE_RECYCLE_MS) {
          return {
            state,
            commands: [trace('recycled recording', 'only silence captured'), { type: 'discardRecording' }],
          };
        }
        return { state, commands: [] };
      }

      if (event.now - state.speechStartedAt > TIMING.MAX_TURN_MS) {
        // The clip is sent as it is, so it carries the same metadata a normal
        // send does. It once went out with the previous send's leftovers: zero
        // length, no trim, so the server billed and trimmed the wrong thing.
        const spokenMs = Math.round(
          event.now - state.speechStartedAt + (state.barging ? TIMING.BARGE_SPEECH_MS : TIMING.SPEECH_ONSET_MS)
        );
        const send = payload(state, event.now, spokenMs, event.chunksPlayed);
        return {
          state: { ...state, sawSpeech: false, pendingSend: send, clipsOwed: state.clipsOwed + 1 },
          commands: [
            trace('max turn length', 'force-sending recording'),
            { type: 'setUserSpeaking', value: false },
            { type: 'stopRecording' },
          ],
        };
      }
      return { state, commands: [] };
    }

    case 'serverResume':
      return { state: { ...state, barging: false }, commands: [{ type: 'resumePlayback' }] };

    case 'serverInterrupted':
      return { state: { ...state, barging: false }, commands: [{ type: 'stopPlayback' }] };

    case 'readyToListen':
      // Control is back with the caller, so nothing is mid-playback. Clearing
      // here matters: a pause with no matching resume would otherwise leave the
      // queue permanently blocked and every later turn silent.
      return { state, commands: [{ type: 'stopPlayback' }, { type: 'resetPlaybackCounter' }] };

    default:
      // An event this version does not know. Ignoring it keeps one unexpected
      // message from taking the whole call down.
      return { state, commands: [] };
  }
}
