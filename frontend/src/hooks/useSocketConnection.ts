import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

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
  isProcessing: boolean;
  messages: ConversationMessage[];
  processingStatus: string | null;
}

export const useSocketConnection = (
  serverUrl: string,
  onAudioResponse: (audioBuffer: ArrayBuffer) => void
): UseSocketConnectionReturn => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);

  const addMessage = useCallback((message: Omit<ConversationMessage, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, {
      ...message,
      id: `msg-${Date.now()}-${Math.random()}`,
      timestamp: new Date(),
    }]);
  }, []);

  useEffect(() => {
    // Initialize socket connection
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
      console.log('Connected to server');
      setConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
    });

    // Processing status events
    socket.on('processing:start', () => {
      setIsProcessing(true);
      setProcessingStatus('Processing audio...');
    });

    socket.on('processing:stt', () => {
      setProcessingStatus('Transcribing speech...');
    });

    socket.on('processing:llm', () => {
      setProcessingStatus('Generating response...');
    });

    socket.on('processing:tts', () => {
      setProcessingStatus('Synthesizing speech...');
    });

    // Transcription complete
    socket.on('transcription:complete', (data: { text: string }) => {
      console.log('Transcription:', data.text);
      addMessage({
        type: 'user',
        text: data.text,
        status: 'complete',
      });
    });

    // Response text (create message without audio first)
    socket.on('response:text', (data: { text: string }) => {
      console.log('Response text:', data.text);
      addMessage({
        type: 'assistant',
        text: data.text,
        status: 'complete',
      });
    });

    // Audio response events (update the last assistant message with audio)
    socket.on('response:audio', (data: { audio: ArrayBuffer }) => {
      setIsProcessing(false);
      setProcessingStatus(null);

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

      // Don't auto-play here - the AudioPlayer component will handle it
    });

    // Error events
    socket.on('error', (data: { message: string }) => {
      console.error('Socket error:', data.message);
      setIsProcessing(false);
      setProcessingStatus(null);
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
  }, [serverUrl, addMessage]);

  const sendAudio = (audioBlob: Blob) => {
    if (!socketRef.current || !connected) {
      console.error('Socket not connected');
      return;
    }

    setIsProcessing(true);
    setProcessingStatus('Uploading audio...');

    // Convert Blob to ArrayBuffer and send
    audioBlob.arrayBuffer().then(arrayBuffer => {
      socketRef.current?.emit('audio:input', {
        audio: arrayBuffer,
      });
    });
  };

  return {
    connected,
    sendAudio,
    isProcessing,
    messages,
    processingStatus,
  };
};
