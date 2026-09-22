import { useState, useCallback, useEffect, useRef } from 'react';
import { Mic, PhoneOff, SlidersHorizontal } from 'lucide-react';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { useMicStream } from '../../hooks/useMicStream';
import { useSocketConnection } from '../../hooks/useSocketConnection';
import { useVoiceActivityDetection } from '../../hooks/useVoiceActivityDetection';
import { useBotStateStore, type CallState } from '../../stores/useBotStateStore';
import Orb from './Orb';
import Transcript from './Transcript';
import DebugPanel from './DebugPanel';
import { toast } from 'sonner';
import { diag } from '../../lib/diagnostics';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

/**
 * Thresholds are calibrated from the room by the VAD hook; these are the
 * multipliers applied to the measured noise floor.
 */
const SPEECH_FACTOR = 3.0;
const SILENCE_FACTOR = 1.8;

/** Longest single utterance before we send it regardless. */
const MAX_TURN_MS = 15_000;
/**
 * A recording holding nothing but silence is thrown away and restarted after
 * this long. Without it the buffer grows for as long as the caller is quiet,
 * and the next utterance is delivered with minutes of dead air — or worse,
 * with earlier attempts that never flushed — glued to the front of it.
 */
const IDLE_RECYCLE_MS = 4_000;

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

  const {
    state,
    substatus,
    userSpeaking,
    setUserSpeaking,
    setState: setCallState,
    reset: resetState,
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

  const notifyCompleteRef = useRef<(turnId: number) => void>(() => {});

  const playback = useAudioPlayback({
    onTurnPlayed: (turnId) => notifyCompleteRef.current(turnId),
  });

  const {
    connected,
    messages,
    metrics,
    sendAudio,
    startCall,
    endCall,
    notifyBarge,
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
    onReadyToListen: () => {
      playback.resetCounter();
    },
  });

  notifyCompleteRef.current = notifyPlaybackComplete;

  const recorder = useAudioRecorder((blob) => {
    markTimeline('audio sent');
    sendAudio(blob, {
      duringPlayback: bargeRef.current,
      spokenChunks: spokenAtBargeRef.current,
    });
  });

  useEffect(() => {
    const error = micError || recorder.error;
    if (error) toast.error(error);
  }, [micError, recorder.error]);

  // Capture continuously whenever the agent is waiting on the caller.
  useEffect(() => {
    if (!isCallActive || !stream) return;
    if (state === 'listening' && !recorder.isRecording) {
      sawSpeechRef.current = false;
      bargeRef.current = false;
      recordingStartedAtRef.current = Date.now();
      recorder.startRecording(stream);
      trace('recording started', 'waiting for speech');
    }
  }, [state, isCallActive, stream, recorder, trace]);

  // Watchdog. Two failure modes to contain: a recording that is all silence
  // (throw it away before it accumulates), and one where speech-end never
  // fires (send it rather than listening forever).
  useEffect(() => {
    if (!recorder.isRecording) return;

    const interval = window.setInterval(() => {
      const now = Date.now();

      if (!sawSpeechRef.current) {
        if (now - recordingStartedAtRef.current > IDLE_RECYCLE_MS) {
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
    notifyBarge(0, played);

    if (stream && !recorder.isRecording) {
      recordingStartedAtRef.current = Date.now();
      recorder.startRecording(stream);
    }
  }, [playback, notifyBarge, stream, recorder, trace, setUserSpeaking, startTimeline, markTimeline]);

  const handleSpeechEnd = useCallback(() => {
    if (!recorder.isRecording) {
      trace('speech end ignored', 'not recording');
      return;
    }
    if (!sawSpeechRef.current) {
      trace('speech end ignored', 'no speech captured yet');
      return;
    }
    sawSpeechRef.current = false;
    setUserSpeaking(false);
    markTimeline('caller stopped');
    trace('speech end', bargeRef.current ? 'sending over-speech' : 'sending turn');

    // Optimistic: the server will confirm, but showing "thinking" now removes
    // a visible round trip of dead air.
    if (!bargeRef.current) setCallState('thinking', 'optimistic (audio sent)');

    recorder.stopRecording();
  }, [recorder, trace, setUserSpeaking, markTimeline, setCallState]);

  const { levelRef, peakRef, calibrationRef } = useVoiceActivityDetection(stream, isCallActive, {
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
    silenceDuration: state === 'paused' ? ENDPOINT_OVER_SPEECH_MS : ENDPOINT_MS,
    speechDuration: 250,
    speechFactor: SPEECH_FACTOR,
    silenceFactor: SILENCE_FACTOR,
  });

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
    setIsCallActive(true);
    startCall();
  }, [acquire, startCall]);

  const handleEnd = useCallback(() => {
    recorder.discardRecording();
    playback.stop();
    release();
    endCall();
    setIsCallActive(false);
    resetState();
  }, [recorder, playback, release, endCall, resetState]);

  useEffect(() => release, [release]);

  return (
    <div className="relative flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <style>{`@keyframes orb-spin { to { transform: rotate(360deg); } }`}</style>

      <header className="flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tracking-tight text-zinc-300">Voice Agent</span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`}
            title={connected ? 'Connected' : 'Disconnected'}
          />
        </div>
        <button
          onClick={() => setDebugOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          debug
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <Orb state={state} levelRef={levelRef} />

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

      <footer className="flex items-center justify-center gap-3 px-6 py-8">
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
      </footer>

      <DebugPanel
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        connected={connected}
        metrics={metrics}
        levelRef={levelRef}
        peakRef={peakRef}
        calibrationRef={calibrationRef}
        isRecording={recorder.isRecording}
      />
    </div>
  );
};

export default VoiceAgent;
