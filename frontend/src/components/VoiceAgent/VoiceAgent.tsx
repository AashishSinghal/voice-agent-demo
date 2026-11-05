import { useState, useCallback, useEffect, useRef } from 'react';
import { History, MessageSquare, MessageSquareOff, Mic, PhoneOff, SlidersHorizontal } from 'lucide-react';
import { useAudioRecorder } from '../../hooks/useAudioRecorder';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { useMicStream } from '../../hooks/useMicStream';
import { useConversationRecorder } from '../../hooks/useConversationRecorder';
import { useSocketConnection, type AudioChunk } from '../../hooks/useSocketConnection';
import { useVoiceActivityDetection } from '../../hooks/useVoiceActivityDetection';
import { useBotStateStore, type CallState } from '../../stores/useBotStateStore';
import Orb from './Orb';
import Transcript from './Transcript';
import DebugPanel from './DebugPanel';
import Attribution from './Attribution';
import Changelog from '../Changelog';
import { toast } from 'sonner';
import { diag } from '../../lib/diagnostics';
import {
  initialState,
  step,
  TIMING,
  vadTuning,
  type TurnTakingCommand,
  type TurnTakingEvent,
  type TurnTakingState,
} from '../../lib/turnTaking';

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
   * On by default, and never uploaded: the audio lives in this browser's memory
   * and is saved only if the visitor clicks download. Because it is a voice on a
   * public URL, every call says so up front (see the notice in handleStart) and
   * the visitor can turn it off there or in the debug panel. The choice lasts
   * for this page load only: a remembered "off" once left every later call
   * unrecorded, so the diagnostics bundles that need the audio had none.
   */
  const [recordCall, setRecordCall] = useState(true);
  /** Transcript under the orb. Off gives the orb the whole centre; lasts for this page load. */
  const [showTranscript, setShowTranscript] = useState(true);
  /** Which LLM path the server is on ('brain', 'groq', 'ollama'), announced on connect. */
  const [llmProvider, setLlmProvider] = useState<string | null>(null);
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

  /**
   * Turn-taking is a pure module (lib/turnTaking.ts): events go in, commands
   * come out. This component supplies the readings an event needs and carries
   * the commands out, and nothing else decides who is speaking.
   */
  const turn = useRef<TurnTakingState>(initialState());
  const execute = useRef<(command: TurnTakingCommand) => void>(() => {});
  /** The chunk or clip a command refers to; each arrives together with its event. */
  const chunkRef = useRef<AudioChunk | null>(null);
  const clipRef = useRef<Blob | null>(null);
  const dispatch = useCallback((event: TurnTakingEvent) => {
    const next = step(turn.current, event);
    turn.current = next.state;
    for (const command of next.commands) execute.current(command);
  }, []);

  const notifyCompleteRef = useRef<(turnId: number) => void>(() => {});

  const playback = useAudioPlayback({
    onTurnPlayed: (turnId) => notifyCompleteRef.current(turnId),
    // The end of the caller's wait. Only a normal turn is timed here; a barge
    // or backchannel finishes its own timeline when the server answers.
    onFirstAudio: () => {
      const store = useBotStateStore.getState();
      if (store.timelineKind === 'turn') store.finishTimeline('first audio playing');
    },
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
    onAudioChunk: (chunk) => {
      chunkRef.current = chunk;
      dispatch({
        type: 'audioChunk',
        turnId: chunk.turnId,
        chunksPlayed: playback.chunksPlayed(),
        latestTurn: playback.latestTurn(),
      });
    },
    onTurnComplete: (turnId) => playback.markTurnComplete(turnId),
    onResumePlayback: () => dispatch({ type: 'serverResume' }),
    onInterrupted: () => dispatch({ type: 'serverInterrupted' }),
    onServerInfo: (info) => {
      setLlmProvider(info.llmProvider);
      // The bundle otherwise never says which LLM path answered the call.
      diag.log('client', 'server info', { llmProvider: info.llmProvider });
    },
    onCallEnded: () => {
      dispatch({ type: 'callEnded' });
      setIsCallActive(false);
    },
    onReadyToListen: () => dispatch({ type: 'readyToListen' }),
  });

  notifyCompleteRef.current = notifyPlaybackComplete;

  const recorder = useAudioRecorder((blob) => {
    clipRef.current = blob;
    dispatch({ type: 'recordingReady' });
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
    recorder.startRecording(stream);
    dispatch({ type: 'recordingStarted', now: Date.now() });
  }, [stream, recorder, dispatch]);

  useEffect(() => {
    if (!isCallActive || !stream) return;
    if (!recorder.isRecording) beginRecording();
  }, [isCallActive, stream, recorder.isRecording, beginRecording, recorder]);

  const playbackRef = useRef(playback);

  /** Carries a command of the turn-taking module out into the world. */
  useEffect(() => {
    playbackRef.current = playback;
    execute.current = (command) => {
      switch (command.type) {
        case 'enqueueAudio':
          if (chunkRef.current) playback.enqueue(chunkRef.current, { startPaused: command.hold });
          break;
        case 'pausePlayback':
          playback.pause();
          break;
        case 'resumePlayback':
          playback.resume();
          break;
        case 'stopPlayback':
          playback.stop();
          break;
        case 'resetPlaybackCounter':
          playback.resetCounter();
          break;
        case 'notifyBarge':
          notifyBarge(command.turnId, command.chunksPlayed);
          break;
        case 'cancelBarge':
          cancelBarge(command.reason);
          break;
        case 'stopRecording':
          recorder.stopRecording();
          break;
        case 'discardRecording':
          recorder.discardRecording();
          break;
        case 'sendClip':
          if (clipRef.current) sendAudio(clipRef.current, command.send);
          break;
        case 'dropClip':
          diag.log('audio', 'recording dropped', { reason: command.reason, bytes: clipRef.current?.size ?? 0 });
          break;
        case 'setUserSpeaking':
          setUserSpeaking(command.value);
          break;
        case 'setThinking':
          setCallState('thinking', command.reason);
          break;
        case 'trace':
          trace(command.label, command.detail);
          break;
        case 'timeline':
          if (command.op === 'start') startTimeline(command.kind, command.backdateMs);
          else markTimeline(command.label);
          break;
      }
    };
  });

  /** Speech detected: the module decides whether this is a turn or a barge-in. */
  const handleSpeechStart = useCallback(() => {
    dispatch({
      type: 'speechStart',
      now: Date.now(),
      callState: useBotStateStore.getState().state,
      chunksPlayed: playback.chunksPlayed(),
      latestTurn: playback.latestTurn(),
    });
  }, [dispatch, playback]);

  const handleSpeechEnd = useCallback(() => {
    dispatch({
      type: 'speechEnd',
      now: Date.now(),
      callState: useBotStateStore.getState().state,
      recording: recorder.isRecording,
      chunksPlayed: playback.chunksPlayed(),
    });
  }, [dispatch, playback, recorder]);

  const tuning = vadTuning(state);

  const { levelRef, peakRef, calibrationRef, inputAnalyserRef } = useVoiceActivityDetection(
    stream,
    isCallActive,
    {
      onSpeechStart: handleSpeechStart,
      onSpeechEnd: handleSpeechEnd,
      silenceDuration: tuning.silenceDurationMs,
      speechDuration: tuning.speechDurationMs,
      speechFactor: SPEECH_FACTOR,
      silenceFactor: SILENCE_FACTOR,
    }
  );

  // The watchdog: once a second the module recycles a recording of silence, or
  // sends one whose speech never ended.
  useEffect(() => {
    if (!recorder.isRecording) return;
    const interval = window.setInterval(() => {
      const level = levelRef.current ?? 0;
      dispatch({
        type: 'tick',
        now: Date.now(),
        quiet: level < (calibrationRef.current?.silenceThreshold ?? 0),
        chunksPlayed: playbackRef.current.chunksPlayed(),
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [recorder.isRecording, dispatch, levelRef, calibrationRef]);

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
      endpointMs: TIMING.ENDPOINT_MS,
      endpointOverSpeechMs: TIMING.ENDPOINT_OVER_SPEECH_MS,
      maxTurnMs: TIMING.MAX_TURN_MS,
      idleRecycleMs: TIMING.IDLE_RECYCLE_MS,
    });
    diag.log('client', 'call started');

    if (recordCall) {
      // Build the playback graph now so the agent's track exists from the
      // first word rather than from the first chunk played.
      playback.ensureGraph();
      const started = conversationRecorder.start(micStream, playback.outputTapRef.current?.stream ?? null);

      // Say so at the moment it begins, and only if it really did. It fades on
      // its own, but the choice to stop is one tap away while it is up.
      if (started) {
        toast('This call is being recorded', {
          id: 'recording-notice',
          description:
            'Your voice and the agent’s are kept in this browser only. Nothing is uploaded, and you decide whether to download it.',
          duration: 10_000,
          action: {
            label: 'Turn off',
            onClick: () => {
              conversationRecorder.discard();
              setRecordCall(false);
              toast('Recording stopped and deleted', { id: 'recording-notice', duration: 3000 });
            },
          },
        });
      }
    }

    dispatch({ type: 'callStarted' });
    setIsCallActive(true);
    startCall();
  }, [acquire, startCall, recordCall, setRecordCall, conversationRecorder, playback, dispatch]);

  const handleEnd = useCallback(() => {
    dispatch({ type: 'callEnded' });
    recorder.discardRecording();
    void conversationRecorder.stop();
    playback.stop();
    release();
    setIsCallActive(false);
    // endCall clears the transcript, metrics and call state together, so the
    // next call starts from the same blank slate as the first.
    endCall();
  }, [recorder, playback, release, endCall, conversationRecorder, dispatch]);

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
            title={
              connected
                ? 'Green: connected to the voice server'
                : 'Red: not connected to the voice server'
            }
          />
          {llmProvider && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${llmProvider === 'brain' ? 'bg-violet-400' : 'bg-amber-400'}`}
              title={
                llmProvider === 'brain'
                  ? 'Violet: running on the brain (LangGraph service with tools, memory and approvals)'
                  : `Amber: gateway only, calling the ${llmProvider} model directly (no brain)`
              }
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => setShowTranscript((v) => !v)}
            aria-pressed={showTranscript}
            aria-label={showTranscript ? 'Hide transcript' : 'Show transcript'}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            {showTranscript ? (
              <MessageSquare className="h-3.5 w-3.5" />
            ) : (
              <MessageSquareOff className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">text</span>
          </button>
          <button
            onClick={() => setDebugOpen((v) => !v)}
            aria-label="Debug panel"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">debug</span>
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6">
        <Orb
          state={state}
          inputAnalyserRef={inputAnalyserRef}
          outputAnalyserRef={playback.outputAnalyserRef}
          large={!showTranscript}
        />

        <div className="h-6 text-center">
          <p className="text-sm text-zinc-400">
            {userSpeaking && (state === 'listening' || state === 'paused')
              ? 'Hearing you…'
              : (substatus ?? CAPTION[state])}
          </p>
        </div>

        {showTranscript && (
          <div className="min-h-0 w-full flex-1 overflow-hidden">
            <Transcript messages={messages} />
          </div>
        )}
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
        snapshotRecording={conversationRecorder.snapshot}
        isRecordingCall={conversationRecorder.isRecording}
      />
    </div>
  );
};

export default VoiceAgent;
