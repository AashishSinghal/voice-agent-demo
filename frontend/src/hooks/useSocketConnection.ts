import { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { useBotStateStore, type CallState } from '../stores/useBotStateStore';
import { diag } from '../lib/diagnostics';

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text?: string;
  timestamp: Date;
  status?: 'streaming' | 'complete' | 'error' | 'interrupted';
  turnId?: number;
  /** User turns only: spoken over the agent rather than in reply to it. */
  overSpeech?: boolean;
  /** User turns only: how the over-speech was classified. */
  kind?: 'backchannel' | 'resume' | 'interruption';
}

export interface TurnMetrics {
  sttMs: number | null;
  firstTokenMs: number | null;
  firstAudioMs: number | null;
  totalMs: number;
  chunks: number;
}

export interface AudioChunk {
  turnId: number;
  index: number;
  text: string;
  audio: ArrayBuffer;
}

interface Handlers {
  onAudioChunk: (chunk: AudioChunk) => void;
  onTurnComplete: (turnId: number) => void;
  /** Over-speech was only a backchannel — carry on from the pause point. */
  onResumePlayback: () => void;
  /** Over-speech was a real interruption — drop queued audio. */
  onInterrupted: (spokenText: string) => void;
  onReadyToListen: () => void;
  /** The call is over — the caller hung up, or the server ended it. */
  onCallEnded: () => void;
}

export const useSocketConnection = (serverUrl: string, handlers: Handlers) => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);

  const { setState, setSubstatus, logEvent, attachServerMarks, finishTimeline } =
    useBotStateStore();

  /**
   * Return to the pre-call view.
   *
   * Deliberately does not clear the diagnostic log: hanging up is exactly when
   * someone wants to export it, and it is reset at the start of the next call
   * instead.
   */
  const resetSession = useCallback(() => {
    setMessages([]);
    setMetrics(null);
    useBotStateStore.getState().reset();
    diag.log('client', 'session reset');
  }, []);

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const addMessage = useCallback((message: Omit<ConversationMessage, 'id' | 'timestamp'>) => {
    setMessages((prev) => [
      ...prev,
      { ...message, id: `m-${Date.now()}-${Math.random()}`, timestamp: new Date() },
    ]);
  }, []);

  const appendDelta = useCallback((turnId: number, token: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant' && last.turnId === turnId && last.status === 'streaming') {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text: (last.text ?? '') + token };
        return updated;
      }
      return [
        ...prev,
        {
          id: `m-${Date.now()}-${Math.random()}`,
          type: 'assistant' as const,
          text: token,
          timestamp: new Date(),
          status: 'streaming' as const,
          turnId,
        },
      ];
    });
  }, []);

  const finalise = useCallback(
    (turnId: number, status: ConversationMessage['status'], text?: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].type === 'assistant' && updated[i].turnId === turnId) {
            updated[i] = { ...updated[i], status, ...(text !== undefined ? { text } : {}) };
            break;
          }
        }
        return updated;
      });
    },
    []
  );

  useEffect(() => {
    const socket = io(serverUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    // Everything the server sends, logged once, centrally. Audio is recorded
    // by size only — the bytes are useless in a log and enormous.
    socket.onAny((event: string, payload?: Record<string, unknown>) => {
      if (event === 'debug:trace') return; // mirrored server line, handled below
      const audio = payload?.audio as ArrayBuffer | undefined;
      const rest = payload
        ? Object.fromEntries(
            Object.entries(payload)
              .filter(([key]) => key !== 'audio')
              .map(([key, value]) => [
                key,
                typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value,
              ])
          )
        : {};
      diag.log('socket-in', event, { ...rest, ...(audio ? { audioBytes: audio.byteLength } : {}) });
    });

    // Every line the server prints, interleaved into the same timeline.
    socket.on('debug:trace', (d: { level?: string; text?: string }) => {
      if (!d?.text) return;
      diag.log('server', d.text, d.level && d.level !== 'log' ? { level: d.level } : undefined);
    });

    socket.on('connect', () => {
      diag.log('socket-in', 'connect');
      setConnected(true);
    });
    socket.on('disconnect', (reason: string) => {
      diag.log('socket-in', 'disconnect', { reason });
      setConnected(false);
    });

    // The server is the source of truth for call state.
    socket.on('state', (data: { state: CallState }) => {
      if (data.state === 'ended') {
        // Reset rather than parking in a terminal state. Previously the local
        // reset ran first and this arrived afterwards, so the interface sat on
        // "Call ended" with the last conversation still on screen.
        resetSession();
        handlersRef.current.onCallEnded();
        return;
      }

      setState(data.state, 'server');
      setSubstatus(
        data.state === 'thinking' ? 'thinking…' : data.state === 'paused' ? 'checking…' : null
      );
    });

    socket.on(
      'transcription:complete',
      (data: { text: string; overSpeech?: boolean; kind?: ConversationMessage['kind'] }) => {
        addMessage({
          type: 'user',
          text: data.text,
          status: 'complete',
          overSpeech: data.overSpeech,
          kind: data.kind,
        });
      }
    );

    // Server-side stage breakdown for the turn just handled.
    socket.on(
      'turn:timeline',
      (data: { marks: { label: string; at: number; delta: number }[] }) => {
        attachServerMarks(data.marks ?? []);
      }
    );

    socket.on('response:text:delta', (d: { turnId: number; token: string }) =>
      appendDelta(d.turnId, d.token)
    );

    socket.on('response:audio:chunk', (chunk: AudioChunk) => {
      setSubstatus(null);
      handlersRef.current.onAudioChunk(chunk);
    });

    socket.on(
      'response:done',
      (d: { turnId: number; text: string; metrics: TurnMetrics | null }) => {
        finalise(d.turnId, 'complete', d.text);
        if (d.metrics) setMetrics(d.metrics);
        handlersRef.current.onTurnComplete(d.turnId);
      }
    );

    socket.on('playback:resume', () => {
      finishTimeline('playback resumed', 'backchannel');
      logEvent('backchannel', 'not an interruption — resuming');
      handlersRef.current.onResumePlayback();
    });

    socket.on('turn:interrupted', (d: { turnId: number; spokenText: string }) => {
      finishTimeline('interrupt confirmed', 'interruption');
      logEvent('interrupted', `heard: "${d.spokenText.slice(0, 40)}…"`);
      // Show only what the caller actually heard.
      finalise(d.turnId, 'interrupted', d.spokenText);
      handlersRef.current.onInterrupted(d.spokenText);
    });

    socket.on('ready:listening', () => handlersRef.current.onReadyToListen());

    socket.on('error', (d: { message: string }) => {
      console.error('[SOCKET]', d.message);
      setSubstatus(null);
      addMessage({ type: 'system', text: d.message, status: 'error' });
    });

    return () => {
      socket.disconnect();
    };
  }, [
    serverUrl,
    addMessage,
    appendDelta,
    finalise,
    setState,
    setSubstatus,
    logEvent,
    attachServerMarks,
    finishTimeline,
    resetSession,
  ]);

  const sendAudio = useCallback(
    (
      blob: Blob,
      opts: {
        duringPlayback: boolean;
        spokenChunks: number;
        trimStartMs: number;
        spokenMs: number;
      }
    ) => {
      if (!socketRef.current?.connected) return;
      diag.log('socket-out', 'audio:input', {
        bytes: blob.size,
        duringPlayback: opts.duringPlayback,
        spokenChunks: opts.spokenChunks,
        trimStartMs: opts.trimStartMs,
        spokenMs: opts.spokenMs,
      });
      blob.arrayBuffer().then((audio) =>
        socketRef.current?.emit('audio:input', {
          audio,
          duringPlayback: opts.duringPlayback,
          spokenChunks: opts.spokenChunks,
          trimStartMs: opts.trimStartMs,
          spokenMs: opts.spokenMs,
        })
      );
    },
    []
  );

  const startCall = useCallback(() => {
    if (!socketRef.current?.connected) return;
    setMessages([]);
    setMetrics(null);
    diag.log('socket-out', 'call:start');
    socketRef.current.emit('call:start');
  }, []);

  const endCall = useCallback(() => {
    diag.log('socket-out', 'call:end');
    socketRef.current?.emit('call:end');
    // Reset locally too. The server confirms with state 'ended', but if the
    // socket is down that never arrives and the interface would stay in a call
    // the caller has already left.
    resetSession();
  }, [resetSession]);

  /** Caller began speaking over the agent; playback is paused pending triage. */
  const notifyBarge = useCallback((turnId: number, chunksPlayed: number) => {
    diag.log('socket-out', 'barge:detected', { turnId, chunksPlayed });
    socketRef.current?.emit('barge:detected', { turnId, chunksPlayed });
  }, []);

  const notifyPlaybackComplete = useCallback((turnId: number) => {
    diag.log('socket-out', 'playback:complete', { turnId });
    socketRef.current?.emit('playback:complete', { turnId });
  }, []);

  return {
    connected,
    messages,
    metrics,
    sendAudio,
    startCall,
    endCall,
    resetSession,
    notifyBarge,
    notifyPlaybackComplete,
  };
};
