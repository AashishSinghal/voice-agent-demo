import { useEffect, useRef, useCallback } from 'react';

interface UseVADOptions {
  /** Silence long enough to treat the caller's turn as finished. */
  onSpeechEnd?: () => void;
  /** Sustained speech — used to detect barge-in while the agent is talking. */
  onSpeechStart?: () => void;
  silenceThreshold?: number; // 0-255
  silenceDuration?: number; // ms of silence before onSpeechEnd
  speechThreshold?: number; // 0-255, deliberately higher than silenceThreshold
  speechDuration?: number; // ms of sustained sound before onSpeechStart
}

/**
 * Monitors microphone level and reports turn boundaries.
 *
 * Two independent detectors run over the same analyser:
 *   - end-of-speech: level below `silenceThreshold` for `silenceDuration`
 *   - start-of-speech: level above `speechThreshold` for `speechDuration`
 *
 * The start threshold is higher and requires sustained sound because it drives
 * barge-in. Echo cancellation removes most of the agent's own voice, but a
 * single loud frame still shouldn't cancel a response — only real speech should.
 */
export const useVoiceActivityDetection = (
  audioStream: MediaStream | null,
  enabled: boolean,
  options: UseVADOptions
) => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const speechSinceRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const speechFiredRef = useRef(false);

  const {
    onSpeechEnd,
    onSpeechStart,
    silenceThreshold = 30,
    silenceDuration = 2000,
    speechThreshold = 45,
    speechDuration = 300,
  } = options;

  // Keep callbacks in refs so changing them doesn't tear down the audio graph.
  const endRef = useRef(onSpeechEnd);
  const startRef = useRef(onSpeechStart);
  useEffect(() => {
    endRef.current = onSpeechEnd;
    startRef.current = onSpeechStart;
  }, [onSpeechEnd, onSpeechStart]);

  const check = useCallback(() => {
    if (!analyserRef.current) return;

    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    const average = data.reduce((sum, v) => sum + v, 0) / data.length;

    // --- sustained speech (barge-in) ---
    if (average >= speechThreshold) {
      if (speechSinceRef.current === null) speechSinceRef.current = Date.now();

      if (!speechFiredRef.current && Date.now() - speechSinceRef.current >= speechDuration) {
        speechFiredRef.current = true;
        console.log(`[VAD] Speech started (level ${average.toFixed(0)})`);
        startRef.current?.();
      }
    } else {
      speechSinceRef.current = null;
      if (average < silenceThreshold) speechFiredRef.current = false;
    }

    // --- silence (end of caller's turn) ---
    if (average < silenceThreshold) {
      if (!silenceTimerRef.current && endRef.current) {
        silenceTimerRef.current = window.setTimeout(() => {
          console.log(`[VAD] Speech ended (${silenceDuration}ms silence)`);
          endRef.current?.();
        }, silenceDuration);
      }
    } else if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    animationFrameRef.current = requestAnimationFrame(check);
  }, [silenceThreshold, silenceDuration, speechThreshold, speechDuration]);

  useEffect(() => {
    if (!audioStream || !enabled) return;

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    audioContext.createMediaStreamSource(audioStream).connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    speechFiredRef.current = false;
    speechSinceRef.current = null;

    check();

    return () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      silenceTimerRef.current = null;
      animationFrameRef.current = null;
      analyserRef.current = null;
      if (audioContext.state !== 'closed') audioContext.close();
    };
  }, [audioStream, enabled, check]);
};
