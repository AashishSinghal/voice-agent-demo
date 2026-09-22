import { useCallback, useEffect, useRef, useState } from 'react';

interface QueuedChunk {
  turnId: number;
  index: number;
  audio: ArrayBuffer;
}

interface UseAudioPlaybackOptions {
  /** Every chunk of a finished turn has played out. */
  onTurnPlayed?: (turnId: number) => void;
}

/**
 * Ordered playback queue for streamed sentence audio.
 *
 * Three behaviours matter here:
 *  - chunks arrive while earlier ones are still playing, so this is a queue;
 *  - `pause`/`resume` exist because speaking over the agent might only be a
 *    backchannel, in which case playback has to carry on from exactly where it
 *    stopped rather than restarting or dropping the rest;
 *  - `chunksPlayed` is reported upward so the server can truncate history to
 *    what the caller actually heard.
 */
export const useAudioPlayback = ({ onTurnPlayed }: UseAudioPlaybackOptions = {}) => {
  const queueRef = useRef<QueuedChunk[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const pausedRef = useRef(false);
  const completedTurnRef = useRef<number | null>(null);
  const activeTurnRef = useRef<number | null>(null);
  const chunksPlayedRef = useRef(0);

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
    if (pausedRef.current) return;

    const next = queueRef.current.shift();

    if (!next) {
      playingRef.current = false;
      setIsPlaying(false);

      const turnId = activeTurnRef.current;
      if (turnId !== null && completedTurnRef.current === turnId) {
        activeTurnRef.current = null;
        completedTurnRef.current = null;
        onTurnPlayedRef.current?.(turnId);
      }
      return;
    }

    releaseCurrent();

    const url = URL.createObjectURL(new Blob([next.audio], { type: 'audio/wav' }));
    const audio = new Audio(url);

    urlRef.current = url;
    audioRef.current = audio;
    activeTurnRef.current = next.turnId;

    audio.onended = () => {
      chunksPlayedRef.current += 1;
      playNext();
    };
    audio.onerror = () => {
      console.error('[PLAYBACK] chunk failed, skipping');
      chunksPlayedRef.current += 1;
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
      // A new turn resets the spoken counter.
      if (activeTurnRef.current !== null && chunk.turnId !== activeTurnRef.current) {
        chunksPlayedRef.current = 0;
      }
      queueRef.current.push(chunk);
      if (!playingRef.current && !pausedRef.current) playNext();
    },
    [playNext]
  );

  const markTurnComplete = useCallback((turnId: number) => {
    completedTurnRef.current = turnId;
    if (!playingRef.current && !pausedRef.current && queueRef.current.length === 0) {
      activeTurnRef.current = null;
      completedTurnRef.current = null;
      onTurnPlayedRef.current?.(turnId);
    }
  }, []);

  /** Hold playback mid-turn without losing queued audio. */
  const pause = useCallback(() => {
    pausedRef.current = true;
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  /** Carry on from exactly where `pause` stopped. */
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;

    if (audioRef.current && !audioRef.current.ended) {
      setIsPlaying(true);
      audioRef.current.play().catch(() => playNext());
      return;
    }
    playNext();
  }, [playNext]);

  /** Drop everything — a confirmed interruption. */
  const stop = useCallback(() => {
    queueRef.current = [];
    completedTurnRef.current = null;
    activeTurnRef.current = null;
    pausedRef.current = false;
    chunksPlayedRef.current = 0;
    releaseCurrent();
    playingRef.current = false;
    setIsPlaying(false);
  }, [releaseCurrent]);

  /** Sentence chunks fully played for the current turn. */
  const chunksPlayed = useCallback(() => chunksPlayedRef.current, []);

  /** The turn currently being played, if any. Needed to report a barge-in
   *  against the right turn — the server ignores an unknown one. */
  const currentTurn = useCallback(() => activeTurnRef.current, []);

  /** Start counting again for a new turn. */
  const resetCounter = useCallback(() => {
    chunksPlayedRef.current = 0;
  }, []);

  useEffect(() => releaseCurrent, [releaseCurrent]);

  return {
    enqueue,
    markTurnComplete,
    pause,
    resume,
    stop,
    chunksPlayed,
    currentTurn,
    resetCounter,
    isPlaying,
  };
};
