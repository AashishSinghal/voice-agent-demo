import { useEffect, useRef, useCallback } from 'react';

interface UseVADOptions {
  onSpeechEnd: () => void;
  silenceThreshold?: number; // Volume threshold (0-255)
  silenceDuration?: number; // MS of silence before triggering
}

export const useVoiceActivityDetection = (
  audioStream: MediaStream | null,
  enabled: boolean,
  options: UseVADOptions
) => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<number| null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const {
    onSpeechEnd,
    silenceThreshold = 30, // Default: quiet threshold
    silenceDuration = 2000, // Default: 2 seconds of silence
  } = options;

  const checkAudioLevel = useCallback(() => {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;

    // If volume is below threshold (silence detected)
    if (average < silenceThreshold) {
      // Start silence timer if not already started
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          console.log('Speech ended - silence detected');
          onSpeechEnd();
        }, silenceDuration);
      }
    } else {
      // Clear silence timer if sound detected
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
    }

    // Continue checking
    if (enabled) {
      animationFrameRef.current = requestAnimationFrame(checkAudioLevel);
    }
  }, [enabled, onSpeechEnd, silenceThreshold, silenceDuration]);

  useEffect(() => {
    if (!audioStream || !enabled) {
      // Cleanup
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      return;
    }

    // Setup audio analysis
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(audioStream);

    source.connect(analyser);
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    // Start checking audio levels
    checkAudioLevel();

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      audioContext.close();
    };
  }, [audioStream, enabled, checkAudioLevel]);
};