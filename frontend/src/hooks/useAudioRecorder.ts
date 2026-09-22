import { useState, useRef, useCallback } from 'react';
import { diag } from '../lib/diagnostics';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  startRecording: (stream: MediaStream) => void;
  stopRecording: () => void;
  /** Stop capturing and throw the buffered audio away. */
  discardRecording: () => void;
  error: string | null;
}

/**
 * Records from a caller-owned MediaStream.
 *
 * The stream is passed in rather than acquired here: the mic now stays open
 * for the whole call so VAD can listen during playback, and re-acquiring it
 * per turn would both close that window and re-prompt for permission.
 */
export const useAudioRecorder = (
  onAudioData: (audioBlob: Blob) => void
): UseAudioRecorderReturn => {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);

  const onAudioDataRef = useRef(onAudioData);
  onAudioDataRef.current = onAudioData;

  const startRecording = useCallback((stream: MediaStream) => {
    if (mediaRecorderRef.current?.state === 'recording') return;

    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const chunks = chunksRef.current;
        chunksRef.current = [];
        mediaRecorderRef.current = null;

        const size = chunks.reduce((total, chunk) => total + chunk.size, 0);

        if (discardRef.current) {
          diag.log('audio', 'recording discarded', { bytes: size });
          return;
        }

        const blob = new Blob(chunks, { type: mimeType });
        diag.log('audio', 'recording ready', { bytes: blob.size, parts: chunks.length });
        onAudioDataRef.current(blob);
      };

      recorder.start();
      diag.log('audio', 'recorder started', { mimeType });
      setIsRecording(true);
      setError(null);
    } catch (err) {
      console.error('[AUDIO_RECORDER] Failed to start:', err);
      setError('Failed to start recording');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      discardRef.current = false;
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const discardRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      discardRef.current = true;
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  return { isRecording, startRecording, stopRecording, discardRecording, error };
};
