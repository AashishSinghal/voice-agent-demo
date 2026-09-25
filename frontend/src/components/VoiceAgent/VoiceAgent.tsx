import { useState, useCallback, useEffect, useRef } from 'react';
import { History, Mic, PhoneOff, SlidersHorizontal } from 'lucide-react';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { useMicStream } from '../../hooks/useMicStream';
import { useConversationRecorder } from '../../hooks/useConversationRecorder';
import { useSocketConnection } from '../../hooks/useSocketConnection';
import { useVoiceActivityDetection } from '../../hooks/useVoiceActivityDetection';
import { useBotStateStore, type CallState } from '../../stores/useBotStateStore';
import Orb from './Orb';
import Transcript from './Transcript';
import DebugPanel from './DebugPanel';
import Attribution from './Attribution';
import Changelog from '../Changelog';
import { toast } from 'sonner';
import { diag } from '../../lib/diagnostics';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

/**
 * Thresholds are calibrated from the room by the VAD hook; these are the
 * multipliers applied to the measured noise floor.
 */
const SPEECH_FACTOR = 3.0;
const SILENCE_FACTOR = 1.8;

/**
 * How often the client tells the server it is still playing.
 *
 * Comfortably inside the server's stuck-state timeout, and short enough that a
 * single long sentence cannot pass without one.
 */
const PLAYBACK_HEARTBEAT_MS = 4_000;

/** Longest single utterance before we send it regardless. */
const MAX_TURN_MS = 15_000;
/**
 * A recording holding nothing but silence is recycled after this long, to cap
 * how much audio is buffered. The server trims to the speech onset anyway, so
 * this only bounds memory rather than affecting what gets transcribed.
 */
const IDLE_RECYCLE_MS = 10_000;

/**
 * Audio kept before the detected speech onset when trimming.
 *
 * Detection needs 250ms of sustained sound to be confident, and people do not
 * start a sentence at full volume, so the true onset is earlier than the
 * detection. Without this margin the first word is clipped — which is exactly
 * how "explain software engineering" arrived as "engineering".
 */
const PREROLL_MS = 700;

/**
 * Minimum audible speech before a clip is worth transcribing.
 *
 * Whisper does not return nothing when handed near-silence — it returns
 * caption boilerplate ("Thank you."), which then becomes a conversational turn
 * and derails the call. Not sending the clip is the cheap half of the fix; the
 * server rejects the artefact as the other half.
 */
const MIN_SPOKEN_MS = 300;

/**
 * How long a pause has to last before the caller is considered finished.
 *
 * A normal turn can afford to wait — cutting someone off mid-thought is worse
 * than a short pause. Triaging over-speech cannot: the agent is already silent
 * and every extra millisecond is dead air before it either resumes or answers.
 * Backchannels are short by nature, so a much tighter window is safe there.
 */
const ENDPOINT_MS = 900;
const ENDPOINT_OVER_SPEECH_MS = 450;

const CAPTION: Record<CallState, string> = {
  idle: 'Tap to start talking',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking — just talk to interrupt',
  paused: 'Go on…',
  ended: 'Call ended',
};

const VoiceAgent = () => {
  const [isCallActive, setIsCallActive] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);

  /**
   * Off by default and never uploaded. This runs on a public URL, so recording
   * a visitor's voice is something they opt into, not something that happens
   * because the audio would be useful to us.
   */
  const [recordCall, setRecordCall] = useState(false);
  const conversationRecorder = useConversationRecorder();

  const {
    state,
    substatus,
    userSpeaking,
    setUserSpeaking,
    setState: setCallState,
    logEvent,
    startTimeline,
    markTimeline,
  } = useBotStateStore();

  const trace = useCallback(
    (label: string, detail?: string) => {
      console.log(`[AGENT] ${label}${detail ? ` — ${detail}` : ''}`);
      logEvent(label, detail);
    },
    [logEvent]
  );
  const { stream, acquire, release, error: micError } = useMicStream();

  const stateRef = useRef(state);
  stateRef.current = state;

  const callActiveRef = useRef(isCallActive);
  callActiveRef.current = isCallActive;

  /** True while the current recording is over-speech rather than a normal turn. */
  const bargeRef = useRef(false);
  /** Chunks the agent had fully spoken when the caller cut in. */
  const spokenAtBargeRef = useRef(0);
  /** Guards against sending a recording that contains no speech. */
  const sawSpeechRef = useRef(false);
  /** When the current recording began, and when speech within it began. */
  const recordingStartedAtRef = useRef(0);
  const speechStartedAtRef = useRef(0);
  /** How long the caller was actually audible in this recording. */
  const spokenMsRef = useRef(0);

  /**
   * What to send with the recording being stopped right now.
   *
   * Captured at stop time rather than read from live refs in the recorder
   * callback: onstop is async, the next recording starts before it fires, and
   * starting it used to reset bargeRef — so an interruption was delivered as
   * an ordinary turn. The server then never classified it, never told the
   * client to resume, and playback stayed paused while chunks piled up behind
   * it.
   */
  const pendingSendRef = useRef({
    duringPlayback: false,
    spokenChunks: 0,
    trimStartMs: 0,
    spokenMs: 0,
    clipMs: 0,
  });

  const notifyCompleteRef = useRef<(turnId: number) => void>(() => {});

  const playback = useAudioPlayback({
    onTurnPlayed: (turnId) => notifyCompleteRef.current(turnId),
  });

  const {
    connected,
    messages,
    metrics,
    costReport,
    sendAudio,
    startCall,
    endCall,
    notifyBarge,
    cancelBarge,
    notifyPlaybackProgress,
    notifyPlaybackComplete,
  } = useSocketConnection(SERVER_URL, {
    onAudioChunk: (chunk) => playback.enqueue(chunk),
    onTurnComplete: (turnId) => playback.markTurnComplete(turnId),
    onResumePlayback: () => {
      bargeRef.current = false;
      playback.resume();
    },
    onInterrupted: () => {
      bargeRef.current = false;
      playback.stop();
    },
    onCallEnded: () => setIsCallActive(false),
    onReadyToListen: () => {
      // Control is back with the caller, so nothing is mid-playback. Clearing
      // here matters: a pause with no matching resume would otherwise leave
      // the queue permanently blocked and every later turn silent.
      playback.stop();
      playback.resetCounter();
    },
  });

  notifyCompleteRef.current = notifyPlaybackComplete;

  const recorder = useAudioRecorder((blob) => {
    // A recorder flushing after the caller hung up must not start a new turn.
    if (!callActiveRef.current) {
      diag.log('audio', 'recording dropped', { reason: 'call ended', bytes: blob.size });
      return;
    }

    markTimeline('audio sent');
    sendAudio(blob, pendingSendRef.current);
  });

  useEffect(() => {
    const error = micError || recorder.error;
    if (error) toast.error(error);
  }, [micError, recorder.error]);

  /**
   * The microphone is always recording for the whole call, not just while the
   * agent is idle. Starting a recording only once speech is confirmed loses
   * the onset by definition — the first word is already spoken by the time
   * detection fires. Recording continuously means the onset is always
   * captured; the server trims back to it.
   */
  const beginRecording = useCallback(() => {
    if (!stream || recorder.isRecording) return;
    sawSpeechRef.current = false;
    speechStartedAtRef.current = 0;
    recordingStartedAtRef.current = Date.now();
    recorder.startRecording(stream);
    trace('recording started', 'always-on capture');
  }, [stream, recorder, trace]);

  useEffect(() => {
    if (!isCallActive || !stream) return;
    if (!recorder.isRecording) beginRecording();
  }, [isCallActive, stream, recorder.isRecording, beginRecording, recorder]);

  // Watchdog. Two failure modes to contain: a recording that is all silence
  // (throw it away before it accumulates), and one where speech-end never
  // fires (send it rather than listening forever).
  useEffect(() => {
    if (!recorder.isRecording) return;

    const interval = window.setInterval(() => {
      const now = Date.now();

      if (!sawSpeechRef.current) {
        // Only recycle during genuine quiet. Speech needs 250ms of sustained
        // sound before it is confirmed, so a recycle fired on a timer alone
        // lands squarely on the start of a sentence and throws the onset away
        // — which is how "explain software engineering" became "engineering".
        const level = levelRef.current ?? 0;
        const quiet = level < (calibrationRef.current?.silenceThreshold ?? 0);

        if (quiet && now - recordingStartedAtRef.current > IDLE_RECYCLE_MS) {
          trace('recycled recording', 'only silence captured');
          recorder.discardRecording();
        }
        return;
      }

      if (now - speechStartedAtRef.current > MAX_TURN_MS) {
        trace('max turn length', 'force-sending recording');
        sawSpeechRef.current = false;
        setUserSpeaking(false);
        recorder.stopRecording();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [recorder.isRecording, recorder, trace, setUserSpeaking]);

  /**
   * Caller started speaking over the agent.
   *
   * Playback is paused rather than dropped, and nothing is cancelled yet — this
   * might only be "mhm". The server decides once it has heard the words, and
   * either tells us to resume or confirms the interruption.
   */
  const handleSpeechStart = useCallback(() => {
    if (!sawSpeechRef.current) speechStartedAtRef.current = Date.now();
    sawSpeechRef.current = true;
    // Reflect this immediately. Waiting for the server to say so costs a round
    // trip and makes the interface feel a beat behind the caller.
    setUserSpeaking(true);
    trace('speech start', `state=${stateRef.current}`);

    if (stateRef.current !== 'speaking') return;

    // Clock starts the instant we hear the caller over the agent — this is
    // what "how fast does it react to an interruption" actually means.
    startTimeline('interruption');
    markTimeline('speech detected');

    const played = playback.chunksPlayed();
    spokenAtBargeRef.current = played;
    bargeRef.current = true;

    playback.pause();
    markTimeline('playback paused');
    trace('over-speech', `paused after ${played} chunk(s)`);

    // The real turn id matters: the server ignores a barge reported against a
    // turn it does not recognise, and then never enters its paused state.
    notifyBarge(playback.latestTurn() ?? 0, played);
  }, [playback, notifyBarge, trace, setUserSpeaking, startTimeline, markTimeline]);

  const handleSpeechEnd = useCallback(() => {
    if (!recorder.isRecording) {
      trace('speech end ignored', 'not recording');
      return;
    }
    if (!sawSpeechRef.current) {
      trace('speech end ignored', 'no speech captured yet');
      return;
    }
    // How much of this recording was actually audible speech. Speech-end
    // fires one endpoint window after the caller fell quiet, so subtracting it
    // gives the span that was genuinely audible.
    const endpointWindow =
      stateRef.current === 'paused' ? ENDPOINT_OVER_SPEECH_MS : ENDPOINT_MS;
    const spokenMs = Math.max(
      0,
      Math.round(Date.now() - endpointWindow - speechStartedAtRef.current)
    );
    spokenMsRef.current = spokenMs;

    sawSpeechRef.current = false;
    setUserSpeaking(false);

    if (spokenMs < MIN_SPOKEN_MS) {
      // Too brief to be speech — a cough, a door, a burst of noise. Sending it
      // invites a hallucinated transcript, so recycle instead.
      trace('discarded utterance', `only ${spokenMs}ms audible`);
      recorder.discardRecording();

      // If this false alarm had paused the agent mid-sentence, pick it back up
      // rather than leaving the call waiting for audio that is never coming.
      if (bargeRef.current) {
        bargeRef.current = false;
        trace('resuming', 'over-speech contained no speech');
        playback.resume();
        cancelBarge('no speech detected');
      }
      return;
    }

    markTimeline('caller stopped');

    // Snapshot everything the send depends on, before anything can restart.
    const trimStartMs = Math.max(
      0,
      Math.round(speechStartedAtRef.current - recordingStartedAtRef.current - PREROLL_MS)
    );

    pendingSendRef.current = {
      duringPlayback: bargeRef.current,
      spokenChunks: spokenAtBargeRef.current,
      trimStartMs,
      spokenMs,
      // What the server will actually send for transcription, which is what
      // gets billed. The transcription response carries no duration.
      clipMs: Math.max(0, Math.round(Date.now() - recordingStartedAtRef.current - trimStartMs)),
    };

    trace('speech end', bargeRef.current ? 'sending over-speech' : 'sending turn');

    // Optimistic: the server will confirm, but showing "thinking" now removes
    // a visible round trip of dead air.
    if (!bargeRef.current) setCallState('thinking', 'optimistic (audio sent)');

    recorder.stopRecording();
  }, [recorder, trace, setUserSpeaking, markTimeline, setCallState, playback, cancelBarge]);

  const { levelRef, peakRef, calibrationRef, inputAnalyserRef } = useVoiceActivityDetection(
    stream,
    isCallActive,
    {
      onSpeechStart: handleSpeechStart,
      onSpeechEnd: handleSpeechEnd,
      silenceDuration: state === 'paused' ? ENDPOINT_OVER_SPEECH_MS : ENDPOINT_MS,
      speechDuration: 250,
      speechFactor: SPEECH_FACTOR,
      silenceFactor: SILENCE_FACTOR,
    }
  );

  const handleStart = useCallback(async () => {
    diag.reset();
    const micStream = await acquire();
    if (!micStream) return;

    // Audio problems are usually environmental, so record the environment.
    const track = micStream.getAudioTracks()[0];
    diag.setMeta({
      userAgent: navigator.userAgent,
      serverUrl: SERVER_URL,
      micLabel: track?.label ?? 'unknown',
      micSettings: track?.getSettings?.() ?? {},
      speechFactor: SPEECH_FACTOR,
      silenceFactor: SILENCE_FACTOR,
      endpointMs: ENDPOINT_MS,
      endpointOverSpeechMs: ENDPOINT_OVER_SPEECH_MS,
      maxTurnMs: MAX_TURN_MS,
      idleRecycleMs: IDLE_RECYCLE_MS,
    });
    diag.log('client', 'call started');

    if (recordCall) {
      // Build the playback graph now so the agent's track exists from the
      // first word rather than from the first chunk played.
      playback.ensureGraph();
      conversationRecorder.start(micStream, playback.outputTapRef.current?.stream ?? null);
    }

    setIsCallActive(true);
    startCall();
  }, [acquire, startCall, recordCall, conversationRecorder, playback]);

  const handleEnd = useCallback(() => {
    recorder.discardRecording();
    void conversationRecorder.stop();
    playback.stop();
    release();
    setIsCallActive(false);
    // endCall clears the transcript, metrics and call state together, so the
    // next call starts from the same blank slate as the first.
    endCall();
  }, [recorder, playback, release, endCall, conversationRecorder]);

  /**
   * While audio is playing the client otherwise sends nothing, so a 26-second
   * answer looked exactly like a wedged call and the server's watchdog cut it
   * off mid-sentence.
   */
  useEffect(() => {
    if (!isCallActive || !playback.isPlaying) return;

    const beat = () => {
      const turnId = playback.latestTurn();
      if (turnId !== null) notifyPlaybackProgress(turnId);
    };

    beat();
    const interval = window.setInterval(beat, PLAYBACK_HEARTBEAT_MS);
    return () => clearInterval(interval);
  }, [isCallActive, playback.isPlaying, playback, notifyPlaybackProgress]);

  useEffect(() => release, [release]);

  return (
    <div className="relative flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Three columns so the title stays optically centred whatever the
          buttons on either side do. */}
      <header className="grid grid-cols-[1fr_auto_1fr] items-center px-6 py-5">
        <div className="flex items-center justify-start">
          <button
            onClick={() => setChangelogOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            <History className="h-3.5 w-3.5" />
            what broke
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tracking-tight text-zinc-300">Voice Agent</span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>

        <div className="flex items-center justify-end">
          <button
            onClick={() => setDebugOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            debug
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <Orb
          state={state}
          inputAnalyserRef={inputAnalyserRef}
          outputAnalyserRef={playback.outputAnalyserRef}
        />

        <div className="h-6 text-center">
          <p className="text-sm text-zinc-400">
            {userSpeaking && (state === 'listening' || state === 'paused')
              ? 'Hearing you…'
              : (substatus ?? CAPTION[state])}
          </p>
        </div>

        <div className="min-h-0 w-full flex-1 overflow-hidden">
          <Transcript messages={messages} />
        </div>
      </main>

      <footer className="flex flex-col items-center gap-5 px-6 pb-7 pt-8">
        {!isCallActive ? (
          <button
            onClick={handleStart}
            disabled={!connected}
            className="flex items-center gap-2.5 rounded-full bg-white px-7 py-3.5 text-sm font-medium text-zinc-900 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            <Mic className="h-4 w-4" />
            Start talking
          </button>
        ) : (
          <button
            onClick={handleEnd}
            className="flex items-center gap-2.5 rounded-full bg-red-500/90 px-7 py-3.5 text-sm font-medium text-white transition hover:bg-red-500"
          >
            <PhoneOff className="h-4 w-4" />
            End
          </button>
        )}

        <Attribution />
      </footer>

      <Changelog open={changelogOpen} onClose={() => setChangelogOpen(false)} />

      <DebugPanel
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        connected={connected}
        metrics={metrics}
        levelRef={levelRef}
        peakRef={peakRef}
        calibrationRef={calibrationRef}
        isRecording={recorder.isRecording}
        cost={costReport}
        recordCall={recordCall}
        onToggleRecordCall={setRecordCall}
        conversationRecording={conversationRecorder.recording}
        isRecordingCall={conversationRecorder.isRecording}
      />
    </div>
  );
};

export default VoiceAgent;
