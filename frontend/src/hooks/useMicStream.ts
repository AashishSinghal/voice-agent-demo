import { useCallback, useRef, useState } from 'react';

/**
 * Owns a single microphone stream for the lifetime of a call.
 *
 * Previously the recorder acquired and released the mic on every turn, which
 * meant nothing was listening while the agent spoke — so barge-in was
 * impossible. Holding one stream for the whole call lets VAD run continuously,
 * including during playback.
 *
 * `echoCancellation` matters here: without it the agent's own voice comes back
 * through the mic and trips the interrupt detector.
 */
export const useMicStream = () => {
  const streamRef = useRef<MediaStream | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const acquire = useCallback(async (): Promise<MediaStream | null> => {
    if (streamRef.current) return streamRef.current;

    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = next;
      setStream(next);
      setError(null);
      return next;
    } catch (err) {
      console.error('[MIC] Failed to acquire stream:', err);
      setError('Failed to access microphone');
      return null;
    }
  }, []);

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  return { stream, acquire, release, error };
};
