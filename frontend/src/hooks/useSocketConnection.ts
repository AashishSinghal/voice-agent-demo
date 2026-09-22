import { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { useBotStateStore } from '../stores/useBotStateStore';

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text?: string;
  timestamp: Date;
  status?: 'transcribing' | 'streaming' | 'complete' | 'error' | 'interrupted';
  turnId?: number;
}

export interface TurnMetrics {
  firstTokenMs: number | null;
  firstAudioMs: number | null;
  totalMs: number;
  chunks: number;
}

export interface AudioChunk {
  turnId: number;
  index: number;
  audio: ArrayBuffer;
}

interface UseSocketConnectionOptions {
  onAudioChunk: (chunk: AudioChunk) => void;
  onTurnComplete: (turnId: number) => void;
  onCancelled: () => void;
  onReadyToListen: () => void;
  onCallEnd?: () => void;
}

export const useSocketConnection = (
  serverUrl: string,
  options: UseSocketConnectionOptions
) => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);

  const { setState, setProcessingSubstatus } = useBotStateStore();

  // Held in a ref so re-renders never rebuild the socket.
  const handlersRef = useRef(options);
  handlersRef.current = options;

  const addMessage = useCallback((message: Omit<ConversationMessage, 'id' | 'timestamp'>) => {
    setMessages((prev) => [
      ...prev,
      { ...message, id: `msg-${Date.now()}-${Math.random()}`, timestamp: new Date() },
    ]);
  }, []);

  /** Append a streamed token to the in-progress assistant message. */
  const appendDelta = useCallback((turnId: number, token: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];

      if (last && last.type === 'assistant' && last.turnId === turnId && last.status === 'streaming') {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, text: (last.text ?? '') + token };
        return updated;
      }

      return [
        ...prev,
        {
          id: `msg-${Date.now()}-${Math.random()}`,
          type: 'assistant' as const,
          text: token,
          timestamp: new Date(),
          status: 'streaming' as const,
          turnId,
        },
      ];
    });
  }, []);

  const finaliseMessage = useCallback(
    (turnId: number, status: ConversationMessage['status'], text?: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].type === 'assistant' && updated[i].turnId === turnId) {
            updated[i] = { ...updated[i], status, ...(text ? { text } : {}) };
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
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('processing:start', () => {
      setState('processing', 'Server started processing');
      setProcessingSubstatus('Processing audio...');
    });
    socket.on('processing:stt', () => setProcessingSubstatus('Transcribing speech...'));
    socket.on('processing:llm', () => setProcessingSubstatus('Generating response...'));
    socket.on('processing:tts', () => setProcessingSubstatus('Synthesizing speech...'));

    socket.on('transcription:complete', (data: { text: string }) => {
      addMessage({ type: 'user', text: data.text, status: 'complete' });
    });

    socket.on('response:text:delta', (data: { turnId: number; token: string }) => {
      appendDelta(data.turnId, data.token);
    });

    socket.on('response:audio:chunk', (data: AudioChunk) => {
      setProcessingSubstatus(null);
      setState('speaking', 'Audio chunk received');
      handlersRef.current.onAudioChunk(data);
    });

    socket.on(
      'response:done',
      (data: { turnId: number; text: string; metrics: TurnMetrics | null }) => {
        finaliseMessage(data.turnId, 'complete', data.text);
        if (data.metrics) setMetrics(data.metrics);
        handlersRef.current.onTurnComplete(data.turnId);
      }
    );

    socket.on('turn:cancelled', (data: { turnId: number }) => {
      console.log(`[SOCKET] Turn ${data.turnId} cancelled`);
      finaliseMessage(data.turnId, 'interrupted');
      setProcessingSubstatus(null);
      handlersRef.current.onCancelled();
    });

    socket.on('ready:listening', () => handlersRef.current.onReadyToListen());

    socket.on('call:end', (data: { message: string }) => {
      addMessage({ type: 'system', text: data.message, status: 'complete' });
      handlersRef.current.onCallEnd?.();
    });

    socket.on('error', (data: { message: string }) => {
      console.error(`[SOCKET] Error: ${data.message}`);
      setProcessingSubstatus(null);
      addMessage({ type: 'system', text: `Error: ${data.message}`, status: 'error' });
    });

    return () => {
      socket.disconnect();
    };
  }, [serverUrl, addMessage, appendDelta, finaliseMessage, setState, setProcessingSubstatus]);

  const sendAudio = useCallback(
    (audioBlob: Blob) => {
      if (!socketRef.current?.connected) return;
      setState('processing', 'Sending audio');
      setProcessingSubstatus('Uploading audio...');
      audioBlob.arrayBuffer().then((buf) => socketRef.current?.emit('audio:input', { audio: buf }));
    },
    [setState, setProcessingSubstatus]
  );

  const startCall = useCallback(() => {
    if (!socketRef.current?.connected) return;
    setMessages([]);
    setMetrics(null);
    socketRef.current.emit('call:start');
  }, []);

  /** Barge-in — tell the server to abandon the turn it is working on. */
  const interrupt = useCallback(() => {
    socketRef.current?.emit('interrupt');
  }, []);

  /** Report that all audio for a turn has finished playing. */
  const notifyPlaybackComplete = useCallback((turnId: number) => {
    socketRef.current?.emit('playback:complete', { turnId });
  }, []);

  return {
    connected,
    messages,
    metrics,
    sendAudio,
    startCall,
    interrupt,
    notifyPlaybackComplete,
  };
};
