import { useEffect, useRef, useState, useCallback } from 'react';
import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { useBotStateStore } from '../stores/useBotStateStore';

export interface ConversationMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  text?: string;
  timestamp: Date;
  status?: 'transcribing' | 'processing' | 'complete' | 'error';
  audioBuffer?: ArrayBuffer;
}

interface UseSocketConnectionReturn {
  connected: boolean;
  sendAudio: (audioBlob: Blob) => void;
  messages: ConversationMessage[];
  startCall: () => void;
}

export const useSocketConnection = (
  serverUrl: string,
  onCallEnd?: () => void,
  onBotReady?: () => void
): UseSocketConnectionReturn => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);

  const { setState, setProcessingSubstatus } = useBotStateStore();

  const addMessage = useCallback((message: Omit<ConversationMessage, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, {
      ...message,
      id: `msg-${Date.now()}-${Math.random()}`,
      timestamp: new Date(),
    }]);
  }, []);

  useEffect(() => {
    const socket = io(serverUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    // Connection events
    socket.on('connect', () => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Connected`);
      setConnected(true);
    });

    socket.on('disconnect', () => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Disconnected`);
      setConnected(false);
    });

    socket.on('processing:start', () => {
      setState('processing', 'Server started processing');
      setProcessingSubstatus('Processing audio...');
    });

    socket.on('processing:stt', () => {
      setProcessingSubstatus('Transcribing speech...');
    });

    socket.on('processing:llm', () => {
      setProcessingSubstatus('Generating response...');
    });

    socket.on('processing:tts', () => {
      setProcessingSubstatus('Synthesizing speech...');
    });

    socket.on('transcription:complete', (data: { text: string }) => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Transcription: "${data.text}"`);

      addMessage({
        type: 'user',
        text: data.text,
        status: 'complete',
      });
    });

    socket.on('response:text', (data: { text: string }) => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Response: "${data.text}"`);

      addMessage({
        type: 'assistant',
        text: data.text,
        status: 'complete',
      });
    });

    socket.on('response:audio', (data: { audio: ArrayBuffer; shouldDeflect?: boolean }) => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Audio received (deflect: ${!!data.shouldDeflect})`);

      setProcessingSubstatus(null);

      // Update the last assistant message with audio buffer
      setMessages(prev => {
        const updated = [...prev];
        // Find last assistant message (iterate backwards)
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].type === 'assistant') {
            updated[i] = {
              ...updated[i],
              audioBuffer: data.audio,
            };
            break;
          }
        }
        return updated;
      });

      setState('speaking', 'Audio received');
    });

    socket.on('ready:listening', () => {
      if (onBotReady) {
        onBotReady();
      }
    });

    socket.on('call:end', (data: { reason: string; message: string }) => {
      const ts = new Date().toISOString();
      console.log(`[SOCKET ${ts}] Call ending: ${data.reason}`);

      addMessage({
        type: 'system',
        text: data.message,
        status: 'complete',
      });

      if (onCallEnd) {
        onCallEnd();
      }
    });

    // Error events
    socket.on('error', (data: { message: string }) => {
      const ts = new Date().toISOString();
      console.error(`[SOCKET ${ts}] Error: ${data.message}`);

      setProcessingSubstatus(null);

      addMessage({
        type: 'system',
        text: `Error: ${data.message}`,
        status: 'error',
      });
    });

    // Cleanup
    return () => {
      socket.disconnect();
    };
  }, [serverUrl, addMessage, onCallEnd, onBotReady, setState, setProcessingSubstatus]);

  const sendAudio = useCallback((audioBlob: Blob) => {
    if (!socketRef.current || !connected) {
      console.error('[SOCKET] Cannot send audio: Not connected');
      return;
    }

    const ts = new Date().toISOString();
    console.log(`[SOCKET ${ts}] Sending audio (${audioBlob.size} bytes)`);

    setState('processing', 'Sending audio');
    setProcessingSubstatus('Uploading audio...');

    audioBlob.arrayBuffer().then(arrayBuffer => {
      socketRef.current?.emit('audio:input', { audio: arrayBuffer });
    });
  }, [connected, setState, setProcessingSubstatus]);

  const startCall = useCallback(() => {
    if (!socketRef.current || !connected) {
      console.error('[SOCKET] Cannot start call: Not connected');
      return;
    }

    const ts = new Date().toISOString();
    console.log(`[SOCKET ${ts}] Starting call`);

    setState('call_starting', 'Call started');
    socketRef.current.emit('call:start');
  }, [connected, setState]);

  return {
    connected,
    sendAudio,
    messages,
    startCall,
  };
};
