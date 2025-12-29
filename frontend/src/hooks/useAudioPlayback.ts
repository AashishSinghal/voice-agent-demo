import { useCallback } from 'react';

export const useAudioPlayback = () => {
  const playAudio = useCallback((audioBuffer: ArrayBuffer) => {
    const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);

    audio.play();

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
    };
  }, []);

  return { playAudio };
};