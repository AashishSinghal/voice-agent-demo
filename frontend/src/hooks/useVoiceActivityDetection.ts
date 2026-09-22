import { useEffect, useRef, useCallback } from 'react';

interface UseVADOptions {
  /** Silence long enough to treat the caller's turn as finished. */
  onSpeechEnd?: () => void;
  /** Sustained speech — drives barge-in. */
  onSpeechStart?: () => void;
  /** ms of continuous silence before onSpeechEnd. */
  silenceDuration?: number;
  /** ms of sustained sound before onSpeechStart. */
  speechDuration?: number;
  /** Multiply the measured noise floor by this to get the speech threshold. */
  speechFactor?: number;
  /** Multiply the measured noise floor by this to get the silence threshold. */
  silenceFactor?: number;
}

/**
 * Microphone activity detection with an adaptive noise gate.
 *
 * Level is time-domain RMS, not a mean over frequency bins — the bin average
 * is dominated by near-silent high bins and reads roughly the same whether you
 * are talking or not.
 *
 * Thresholds are derived from the room rather than hardcoded. Microphone gain
 * varies by an order of magnitude across machines: a level that is obviously
 * speech on one laptop is below the noise floor on another, and a fixed
 * threshold either ignores normal speech or triggers on the fan. The floor is
 * estimated as a low percentile of recent frames — speech is the minority of
 * samples in a window, so percentiles survive someone talking through the
 * calibration.
 */

/** Absolute bounds, so a dead-silent room cannot drive thresholds to zero. */
const MIN_SPEECH_RMS = 0.010;
const MAX_SPEECH_RMS = 0.12;
const MIN_SILENCE_RMS = 0.006;

/** Frames kept for the floor estimate (~50ms apart → about 3 seconds). */
const FLOOR_WINDOW = 60;
const FLOOR_SAMPLE_MS = 50;
const FLOOR_PERCENTILE = 0.25;

export interface VadCalibration {
  noiseFloor: number;
  speechThreshold: number;
  silenceThreshold: number;
}

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

  const floorSamplesRef = useRef<number[]>([]);
  const lastFloorSampleRef = useRef(0);
  const calibrationRef = useRef<VadCalibration>({
    noiseFloor: 0,
    speechThreshold: MIN_SPEECH_RMS,
    silenceThreshold: MIN_SILENCE_RMS,
  });

  const {
    onSpeechEnd,
    onSpeechStart,
    silenceDuration = 900,
    speechDuration = 250,
    speechFactor = 3.0,
    silenceFactor = 1.8,
  } = options;

  const endRef = useRef(onSpeechEnd);
  const startRef = useRef(onSpeechStart);
  const tuningRef = useRef({ silenceDuration, speechDuration, speechFactor, silenceFactor });
  useEffect(() => {
    endRef.current = onSpeechEnd;
    startRef.current = onSpeechStart;
    tuningRef.current = { silenceDuration, speechDuration, speechFactor, silenceFactor };
  }, [onSpeechEnd, onSpeechStart, silenceDuration, speechDuration, speechFactor, silenceFactor]);

  /** Low percentile of recent frames — a robust stand-in for "the room". */
  const updateNoiseFloor = useCallback((rms: number) => {
    const now = Date.now();
    if (now - lastFloorSampleRef.current < FLOOR_SAMPLE_MS) return;
    lastFloorSampleRef.current = now;

    const samples = floorSamplesRef.current;
    samples.push(rms);
    if (samples.length > FLOOR_WINDOW) samples.shift();
    if (samples.length < 8) return;

    const sorted = [...samples].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * FLOOR_PERCENTILE)];

    const { speechFactor: sf, silenceFactor: qf } = tuningRef.current;
    calibrationRef.current = {
      noiseFloor: floor,
      speechThreshold: Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, floor * sf)),
      silenceThreshold: Math.max(MIN_SILENCE_RMS, floor * qf),
    };
  }, []);

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
    updateNoiseFloor(rms);

    const { speechThreshold, silenceThreshold } = calibrationRef.current;
    const tuning = tuningRef.current;

    // --- sustained speech -> onSpeechStart ---
    if (rms >= speechThreshold) {
      if (speechSinceRef.current === null) speechSinceRef.current = Date.now();

      if (!speakingRef.current && Date.now() - speechSinceRef.current >= tuning.speechDuration) {
        speakingRef.current = true;
        console.log(
          `[VAD] speech start — rms ${rms.toFixed(4)} over ${speechThreshold.toFixed(4)} ` +
            `(floor ${calibrationRef.current.noiseFloor.toFixed(4)})`
        );
        startRef.current?.();
      }
    } else {
      speechSinceRef.current = null;
    }

    // --- continuous silence -> onSpeechEnd ---
    if (rms < silenceThreshold) {
      if (silenceTimerRef.current === null) {
        const windowMs = tuning.silenceDuration;
        silenceTimerRef.current = window.setTimeout(() => {
          // Clear first: leaving this set means no later silence period can
          // ever arm a new timer.
          silenceTimerRef.current = null;
          speakingRef.current = false;
          console.log(`[VAD] speech end (${windowMs}ms silence)`);
          endRef.current?.();
        }, windowMs);
      }
    } else if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    frameRef.current = requestAnimationFrame(check);
  }, [updateNoiseFloor]);

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
    floorSamplesRef.current = [];
    lastFloorSampleRef.current = 0;

    console.log('[VAD] started — calibrating noise floor from the room');
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
  }, [audioStream, enabled, check]);

  return { levelRef, peakRef, calibrationRef };
};
