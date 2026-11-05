import { useEffect, useRef, useCallback } from 'react';
import { diag } from '../lib/diagnostics';
import { createVad, type VadCalibration } from '../lib/vad';

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
 * Microphone activity detection: reads the level off a Web Audio analyser each
 * frame and hands it to the pure detector in `lib/vad.ts`, which holds the
 * thresholds and the start/end decisions.
 *
 * Level is time-domain RMS, not a mean over frequency bins: the bin average
 * is dominated by near-silent high bins and reads roughly the same whether you
 * are talking or not.
 */

export type { VadCalibration };

export const useVoiceActivityDetection = (
  audioStream: MediaStream | null,
  enabled: boolean,
  options: UseVADOptions
) => {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const vadRef = useRef(createVad());
  const levelRef = useRef(0);
  const peakRef = useRef(0);
  /** Last moment the level was above the speech threshold. Combined with the
   *  onset this gives how long the caller was actually audible, which is what
   *  separates a real utterance from a clip of room tone. */
  const lastVoiceAtRef = useRef(0);
  const calibrationRef = useRef<VadCalibration>(vadRef.current.calibration);

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

  const check = useCallback(function check() {
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

    const vad = vadRef.current;
    const events = vad.push(rms, Date.now(), tuningRef.current);
    calibrationRef.current = vad.calibration;
    lastVoiceAtRef.current = vad.lastVoiceAt;
    diag.logLevel(rms, vad.calibration);

    for (const event of events) {
      if (event === 'start') {
        diag.log('vad', 'speech start', {
          rms: Number(rms.toFixed(4)),
          threshold: Number(vad.calibration.speechThreshold.toFixed(4)),
          floor: Number(vad.calibration.noiseFloor.toFixed(4)),
        });
        startRef.current?.();
      } else {
        diag.log('vad', 'speech end', { silenceWindowMs: tuningRef.current.silenceDuration });
        endRef.current?.();
      }
    }

    frameRef.current = requestAnimationFrame(check);
  }, []);

  useEffect(() => {
    if (!audioStream || !enabled) return;

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    audioContext.createMediaStreamSource(audioStream).connect(analyser);

    analyserRef.current = analyser;
    peakRef.current = 0;
    vadRef.current.reset();

    diag.log('vad', 'started', { fftSize: analyser.fftSize });
    check();

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      analyserRef.current = null;
      levelRef.current = 0;
      if (audioContext.state !== 'closed') audioContext.close();
      diag.log('vad', 'stopped');
    };
  }, [audioStream, enabled, check]);

  return {
    levelRef,
    peakRef,
    calibrationRef,
    lastVoiceAtRef,
    /** Live spectrum of the caller's voice, for the visualiser. */
    inputAnalyserRef: analyserRef,
  };
};
