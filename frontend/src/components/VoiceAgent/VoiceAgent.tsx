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

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';

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

  const { state, substatus, reset: resetState, logEvent } = useBotStateStore();
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
      recorder.startRecording(stream);
    }
  }, [state, isCallActive, stream, recorder]);

  /**
   * Caller started speaking over the agent.
   *
   * Playback is paused rather than dropped, and nothing is cancelled yet — this
   * might only be "mhm". The server decides once it has heard the words, and
   * either tells us to resume or confirms the interruption.
   */
  const handleSpeechStart = useCallback(() => {
    sawSpeechRef.current = true;

    if (stateRef.current !== 'speaking') return;

    const played = playback.chunksPlayed();
    spokenAtBargeRef.current = played;
    bargeRef.current = true;

    playback.pause();
    logEvent('over-speech', `paused after ${played} chunk(s)`);
    notifyBarge(0, played);

    if (stream && !recorder.isRecording) recorder.startRecording(stream);
  }, [playback, notifyBarge, stream, recorder, logEvent]);

  const handleSpeechEnd = useCallback(() => {
    if (!recorder.isRecording) return;
    if (!sawSpeechRef.current) return; // silence only — keep waiting
    sawSpeechRef.current = false;
    recorder.stopRecording();
  }, [recorder]);

  const { levelRef } = useVoiceActivityDetection(stream, isCallActive, {
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleSpeechEnd,
    silenceThreshold: 30,
    silenceDuration: 1200,
    speechThreshold: 45,
    speechDuration: 300,
  });

  const handleStart = useCallback(async () => {
    const micStream = await acquire();
    if (!micStream) return;
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
          <p className="text-sm text-zinc-400">{substatus ?? CAPTION[state]}</p>
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
      />
    </div>
  );
};

export default VoiceAgent;
