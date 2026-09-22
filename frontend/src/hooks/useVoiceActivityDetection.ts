import { useEffect, useRef, useCallback } from 'react';

interface UseVADOptions {
  /** Silence long enough to treat the caller's turn as finished. */
  onSpeechEnd?: () => void;
  /** Sustained speech — drives barge-in. */
  onSpeechStart?: () => void;
  /** RMS below this counts as silence. 0..1 */
  silenceThreshold?: number;
  /** ms of continuous silence before onSpeechEnd. */
  silenceDuration?: number;
  /** RMS above this counts as speech. 0..1, above silenceThreshold. */
  speechThreshold?: number;
  /** ms of sustained sound before onSpeechStart. */
  speechDuration?: number;
  /** Called every frame with the current level. Keep it cheap. */
  onLevel?: (rms: number) => void;
}

/**
 * Microphone activity detection.
 *
 * Level is measured as time-domain RMS, not an average over frequency bins.
 * The frequency-bin average is dominated by the many near-silent high bins, so
 * it reads ~5-20 even for loud speech — thresholds set against it are either
 * never reached or fire constantly. RMS maps to something meaningful:
 * roughly 0.001-0.01 for a quiet room, 0.05-0.3 for normal speech.
 *
 * Two detectors run over the same signal, with separate thresholds so the
 * boundary does not chatter: speech has to clear a higher bar than silence.
 */
export const useVoiceActivityDetection = (
  audioStream: MediaStream | null,
  enabled: boolean,
  options: UseVADOptions
) => {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const speechSinceRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const levelRef = useRef(0);
  const peakRef = useRef(0);

  const {
    onSpeechEnd,
    onSpeechStart,
    silenceThreshold = 0.02,
    silenceDuration = 1200,
    speechThreshold = 0.045,
    speechDuration = 250,
    onLevel,
  } = options;

  // Callbacks live in refs so swapping them never rebuilds the audio graph.
  const endRef = useRef(onSpeechEnd);
  const startRef = useRef(onSpeechStart);
  const levelCbRef = useRef(onLevel);
  useEffect(() => {
    endRef.current = onSpeechEnd;
    startRef.current = onSpeechStart;
    levelCbRef.current = onLevel;
  }, [onSpeechEnd, onSpeechStart, onLevel]);

  const check = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);

    // 128 is the zero line for 8-bit time-domain samples.
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = (data[i] - 128) / 128;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / data.length);

    levelRef.current = rms;
    if (rms > peakRef.current) peakRef.current = rms;
    levelCbRef.current?.(rms);

    // --- sustained speech -> onSpeechStart ---
    if (rms >= speechThreshold) {
      if (speechSinceRef.current === null) speechSinceRef.current = Date.now();

      if (!speakingRef.current && Date.now() - speechSinceRef.current >= speechDuration) {
        speakingRef.current = true;
        console.log(`[VAD] speech start (rms ${rms.toFixed(3)})`);
        startRef.current?.();
      }
    } else {
      speechSinceRef.current = null;
    }

    // --- continuous silence -> onSpeechEnd ---
    if (rms < silenceThreshold) {
      if (silenceTimerRef.current === null) {
        silenceTimerRef.current = window.setTimeout(() => {
          // Clear first: without this the ref stays set and no further
          // silence period can ever arm a new timer.
          silenceTimerRef.current = null;
          speakingRef.current = false;
          console.log(`[VAD] speech end (${silenceDuration}ms silence)`);
          endRef.current?.();
        }, silenceDuration);
      }
    } else if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    frameRef.current = requestAnimationFrame(check);
  }, [silenceThreshold, silenceDuration, speechThreshold, speechDuration]);

  useEffect(() => {
    if (!audioStream || !enabled) return;

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    audioContext.createMediaStreamSource(audioStream).connect(analyser);

    analyserRef.current = analyser;
    speakingRef.current = false;
    speechSinceRef.current = null;
    peakRef.current = 0;

    console.log(
      `[VAD] started — speech >= ${speechThreshold}, silence < ${silenceThreshold} ` +
        `for ${silenceDuration}ms`
    );

    check();

    return () => {
      if (silenceTimerRef.current !== null) clearTimeout(silenceTimerRef.current);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      silenceTimerRef.current = null;
      frameRef.current = null;
      analyserRef.current = null;
      levelRef.current = 0;
      if (audioContext.state !== 'closed') audioContext.close();
      console.log('[VAD] stopped');
    };
  }, [audioStream, enabled, check, speechThreshold, silenceThreshold, silenceDuration]);

  return { levelRef, peakRef };
};
