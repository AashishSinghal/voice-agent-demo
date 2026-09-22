import { useCallback, useEffect, useRef, useState } from 'react';

interface QueuedChunk {
  turnId: number;
  index: number;
  audio: ArrayBuffer;
}

interface UseAudioPlaybackOptions {
  /** Fires when every chunk of a completed turn has finished playing. */
  onTurnPlayed?: (turnId: number) => void;
}

/**
 * Plays streamed audio chunks in order.
 *
 * The agent now sends one audio chunk per sentence while the LLM is still
 * generating, so playback has to behave like a queue: start as soon as the
 * first chunk lands, keep playing as later chunks arrive, and report
 * completion only once the turn is known to be finished AND the queue has
 * drained.
 *
 * `stop()` exists for barge-in — it drops everything pending and silences
 * whatever is mid-sentence.
 */
export const useAudioPlayback = ({ onTurnPlayed }: UseAudioPlaybackOptions = {}) => {
  const queueRef = useRef<QueuedChunk[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const completedTurnRef = useRef<number | null>(null);
  const activeTurnRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);

  const onTurnPlayedRef = useRef(onTurnPlayed);
  useEffect(() => {
    onTurnPlayedRef.current = onTurnPlayed;
  }, [onTurnPlayed]);

  const releaseCurrent = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const playNext = useCallback(() => {
    const next = queueRef.current.shift();

    if (!next) {
      playingRef.current = false;
      setIsPlaying(false);

      // The turn is only finished when the server said so and we have played
      // everything it sent.
      const turnId = activeTurnRef.current;
      if (turnId !== null && completedTurnRef.current === turnId) {
        activeTurnRef.current = null;
        completedTurnRef.current = null;
        onTurnPlayedRef.current?.(turnId);
      }
      return;
    }

    releaseCurrent();

    const blob = new Blob([next.audio], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    urlRef.current = url;
    audioRef.current = audio;
    activeTurnRef.current = next.turnId;

    audio.onended = () => playNext();
    audio.onerror = () => {
      console.error('[PLAYBACK] Chunk failed to play, skipping');
      playNext();
    };

    playingRef.current = true;
    setIsPlaying(true);

    audio.play().catch((err) => {
      console.error('[PLAYBACK] play() rejected:', err);
      playNext();
    });
  }, [releaseCurrent]);

  const enqueue = useCallback(
    (chunk: QueuedChunk) => {
      queueRef.current.push(chunk);
      if (!playingRef.current) playNext();
    },
    [playNext]
  );

  /** Tell playback that no further chunks are coming for this turn. */
  const markTurnComplete = useCallback((turnId: number) => {
    completedTurnRef.current = turnId;

    // The queue may already have drained before `response:done` arrived.
    if (!playingRef.current && queueRef.current.length === 0) {
      activeTurnRef.current = null;
      completedTurnRef.current = null;
      onTurnPlayedRef.current?.(turnId);
    }
  }, []);

  /** Barge-in: drop everything immediately. */
  const stop = useCallback(() => {
    queueRef.current = [];
    completedTurnRef.current = null;
    activeTurnRef.current = null;
    releaseCurrent();
    playingRef.current = false;
    setIsPlaying(false);
  }, [releaseCurrent]);

  useEffect(() => releaseCurrent, [releaseCurrent]);

  return { enqueue, markTurnComplete, stop, isPlaying };
};
