/**
 * The speech detector's decisions, with no browser in it.
 *
 * The hook (`hooks/useVoiceActivityDetection.ts`) reads a level off the Web Audio
 * analyser each frame and hands it here with the time; this decides whether that
 * is the start or end of an utterance. Keeping it a plain function of
 * (level, time) lets a recorded clip be played through the same code offline
 * (`lib/simulateCall.ts`).
 *
 * Thresholds are derived from the room rather than hardcoded. Microphone gain
 * varies by an order of magnitude across machines: a level that is obviously
 * speech on one laptop is below the noise floor on another, and a fixed
 * threshold either ignores normal speech or triggers on the fan. The floor is
 * estimated as a low percentile of recent frames: speech is the minority of
 * samples in a window, so percentiles survive someone talking through the
 * calibration.
 */

/** Absolute bounds, so a dead-silent room cannot drive thresholds to zero. */
const MIN_SPEECH_RMS = 0.010;
const MAX_SPEECH_RMS = 0.12;
const MIN_SILENCE_RMS = 0.006;

/** Frames kept for the floor estimate (~50ms apart, so about 3 seconds). */
const FLOOR_WINDOW = 60;
const FLOOR_SAMPLE_MS = 50;
const FLOOR_PERCENTILE = 0.25;

/**
 * A dip this short inside a word does not restart the onset timer. "Stop" has a
 * closed-mouth gap before the "p"; without this neither half lasted long enough
 * to count as speech and the word was never heard.
 */
const ONSET_GAP_MS = 120;

export interface VadCalibration {
  noiseFloor: number;
  speechThreshold: number;
  silenceThreshold: number;
}

export interface VadTuning {
  /** ms of sustained sound before `start`. */
  speechDuration: number;
  /** ms of continuous silence before `end`. */
  silenceDuration: number;
  /** Multiply the measured noise floor by this to get the speech threshold. */
  speechFactor: number;
  /** Multiply the measured noise floor by this to get the silence threshold. */
  silenceFactor: number;
}

export type VadEvent = 'start' | 'end';

export function createVad() {
  let floorSamples: number[] = [];
  let lastFloorSampleAt = 0;
  let speechSince: number | null = null;
  let belowSince: number | null = null;
  let silenceSince: number | null = null;
  let speaking = false;
  let lastVoiceAt = 0;
  let calibration: VadCalibration = {
    noiseFloor: 0,
    speechThreshold: MIN_SPEECH_RMS,
    silenceThreshold: MIN_SILENCE_RMS,
  };

  function updateNoiseFloor(rms: number, now: number, tuning: VadTuning) {
    if (now - lastFloorSampleAt < FLOOR_SAMPLE_MS) return;
    lastFloorSampleAt = now;

    floorSamples.push(rms);
    if (floorSamples.length > FLOOR_WINDOW) floorSamples.shift();
    if (floorSamples.length < 8) return;

    const sorted = [...floorSamples].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * FLOOR_PERCENTILE)];
    calibration = {
      noiseFloor: floor,
      speechThreshold: Math.min(MAX_SPEECH_RMS, Math.max(MIN_SPEECH_RMS, floor * tuning.speechFactor)),
      silenceThreshold: Math.max(MIN_SILENCE_RMS, floor * tuning.silenceFactor),
    };
  }

  return {
    /** Feed one frame's level; returns the event it triggers, if any. */
    push(rms: number, now: number, tuning: VadTuning): VadEvent[] {
      updateNoiseFloor(rms, now, tuning);
      const { speechThreshold, silenceThreshold } = calibration;
      const events: VadEvent[] = [];

      // Sustained speech -> start.
      if (rms >= speechThreshold) {
        lastVoiceAt = now;
        belowSince = null;
        speechSince ??= now;
        if (!speaking && now - speechSince >= tuning.speechDuration) {
          speaking = true;
          events.push('start');
        }
      } else {
        belowSince ??= now;
        if (now - belowSince > ONSET_GAP_MS) speechSince = null;
      }

      // Continuous silence -> end. Cleared on firing so the next quiet frame
      // arms a fresh window (it re-fires every window while the room stays quiet).
      if (rms < silenceThreshold) {
        silenceSince ??= now;
        if (now - silenceSince >= tuning.silenceDuration) {
          silenceSince = null;
          speaking = false;
          events.push('end');
        }
      } else {
        silenceSince = null;
      }
      return events;
    },
    get calibration() {
      return calibration;
    },
    /** Last moment the level was above the speech threshold. */
    get lastVoiceAt() {
      return lastVoiceAt;
    },
    reset() {
      floorSamples = [];
      lastFloorSampleAt = 0;
      speechSince = null;
      belowSince = null;
      silenceSince = null;
      speaking = false;
    },
  };
}
