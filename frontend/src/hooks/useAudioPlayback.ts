import { useCallback, useEffect, useRef, useState } from 'react';
import { diag } from '../lib/diagnostics';

interface QueuedChunk {
  turnId: number;
  index: number;
  audio: ArrayBuffer;
}

interface UseAudioPlaybackOptions {
  /** Every chunk of a finished turn has played out. */
  onTurnPlayed?: (turnId: number) => void;
  /** The browser refused to play audio — usually an autoplay restriction. */
  onBlocked?: (error: DOMException) => void;
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
export const useAudioPlayback = ({
  onTurnPlayed,
  onBlocked,
}: UseAudioPlaybackOptions = {}) => {
  const queueRef = useRef<QueuedChunk[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const pausedRef = useRef(false);
  const completedTurnRef = useRef<number | null>(null);
  const activeTurnRef = useRef<number | null>(null);
  const chunksPlayedRef = useRef(0);
  /** Most recent turn we have been sent audio for, played or not. */
  const latestTurnRef = useRef<number | null>(null);

  /**
   * Web Audio graph for the agent's own voice.
   *
   * Every chunk is routed element -> analyser -> speakers, so the visualiser
   * can read the waveform actually coming out rather than animating a guess.
   * The context is created lazily on first playback, which is always after a
   * user gesture, so it is never blocked from starting.
   */
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  /**
   * A second tap on the same graph, exposed as a MediaStream so the agent's
   * voice can be recorded separately from the caller's.
   */
  const outputTapRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  const ensureGraph = useCallback(() => {
    if (!audioContextRef.current) {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      analyser.connect(context.destination);

      // Recording tap. Connected in parallel with the speakers, so capturing
      // never changes what the caller hears.
      const tap = context.createMediaStreamDestination();
      analyser.connect(tap);

      audioContextRef.current = context;
      analyserRef.current = analyser;
      outputTapRef.current = tap;
    }

    // Autoplay policy can leave the context suspended; without this the audio
    // is routed into a graph that is not running and nothing is heard.
    if (audioContextRef.current.state === 'suspended') {
      void audioContextRef.current.resume();
    }

    return analyserRef.current;
  }, []);

  const [isPlaying, setIsPlaying] = useState(false);

  const onTurnPlayedRef = useRef(onTurnPlayed);
  const onBlockedRef = useRef(onBlocked);
  useEffect(() => {
    onTurnPlayedRef.current = onTurnPlayed;
    onBlockedRef.current = onBlocked;
  }, [onTurnPlayed, onBlocked]);

  const releaseCurrent = useCallback(() => {
    // A MediaElementSource can only be created once per element, so each one
    // is disconnected before its element is dropped.
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
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
    if (pausedRef.current) {
      diag.log('audio', 'play skipped', {
        reason: 'paused',
        queued: queueRef.current.length,
      });
      return;
    }

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

    try {
      const analyser = ensureGraph();
      if (analyser && audioContextRef.current) {
        const source = audioContextRef.current.createMediaElementSource(audio);
        source.connect(analyser);
        sourceRef.current = source;
      }
    } catch (err) {
      // If the graph cannot be built the element still plays on its own; the
      // visualiser just has nothing to read. Never lose audio over decoration.
      diag.log('audio', 'analyser unavailable', { message: String(err) });
    }

    const startedAt = performance.now();

    audio.onloadedmetadata = () => {
      // A duration of 0 or NaN means the browser could not decode the WAV at
      // all — a very different failure from "it played but you heard nothing".
      diag.log('audio', 'chunk decoded', {
        turnId: next.turnId,
        index: next.index,
        durationSec: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(2)) : null,
        readyState: audio.readyState,
      });
    };

    audio.onended = () => {
      diag.log('audio', 'chunk ended', {
        turnId: next.turnId,
        index: next.index,
        playedMs: Math.round(performance.now() - startedAt),
      });
      chunksPlayedRef.current += 1;
      playNext();
    };

    audio.onerror = () => {
      diag.log('audio', 'chunk error', {
        turnId: next.turnId,
        index: next.index,
        code: audio.error?.code ?? null,
        message: audio.error?.message ?? null,
      });
      chunksPlayedRef.current += 1;
      playNext();
    };

    playingRef.current = true;
    setIsPlaying(true);

    diag.log('audio', 'chunk play start', {
      turnId: next.turnId,
      index: next.index,
      bytes: next.audio.byteLength,
      volume: audio.volume,
      muted: audio.muted,
    });

    audio.play().catch((err: DOMException) => {
      // NotAllowedError here means the browser blocked playback for want of a
      // user gesture — the single most common reason for "I can see the text
      // but hear nothing".
      diag.log('audio', 'play() rejected', {
        turnId: next.turnId,
        index: next.index,
        name: err?.name,
        message: err?.message,
      });
      onBlockedRef.current?.(err);
      playNext();
    });
  }, [releaseCurrent]);

  const enqueue = useCallback(
    (chunk: QueuedChunk) => {
      diag.log('audio', 'chunk queued', {
        turnId: chunk.turnId,
        index: chunk.index,
        bytes: chunk.audio.byteLength,
        queued: queueRef.current.length,
        playing: playingRef.current,
        paused: pausedRef.current,
      });

      const isNewTurn = latestTurnRef.current !== null && chunk.turnId !== latestTurnRef.current;
      latestTurnRef.current = chunk.turnId;

      if (isNewTurn) {
        // A new turn supersedes whatever came before. If the queue was paused
        // for an interruption that was then answered as a fresh turn, nothing
        // will ever un-pause it, and every chunk from here on would queue up
        // silently behind the pause — audible as the agent going mute while
        // its text keeps streaming.
        const stale = queueRef.current.length;
        queueRef.current = queueRef.current.filter((q) => q.turnId === chunk.turnId);

        if (pausedRef.current || stale > queueRef.current.length) {
          diag.log('audio', 'superseded by new turn', {
            turnId: chunk.turnId,
            droppedChunks: stale - queueRef.current.length,
            wasPaused: pausedRef.current,
          });
          releaseCurrent();
          pausedRef.current = false;
          playingRef.current = false;
          completedTurnRef.current = null;
          activeTurnRef.current = null;
        }
        chunksPlayedRef.current = 0;
      }

      queueRef.current.push(chunk);
      if (!playingRef.current && !pausedRef.current) playNext();
    },
    [playNext, releaseCurrent]
  );

  const markTurnComplete = useCallback((turnId: number) => {
    diag.log('audio', 'turn marked complete', {
      turnId,
      queued: queueRef.current.length,
      playing: playingRef.current,
      paused: pausedRef.current,
    });
    completedTurnRef.current = turnId;
    if (!playingRef.current && !pausedRef.current && queueRef.current.length === 0) {
      activeTurnRef.current = null;
      completedTurnRef.current = null;
      onTurnPlayedRef.current?.(turnId);
    }
  }, []);

  /** Hold playback mid-turn without losing queued audio. */
  const pause = useCallback(() => {
    diag.log('audio', 'playback paused', { queued: queueRef.current.length });
    pausedRef.current = true;
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  /** Carry on from exactly where `pause` stopped. */
  const resume = useCallback(() => {
    diag.log('audio', 'playback resume requested', {
      wasPaused: pausedRef.current,
      queued: queueRef.current.length,
    });
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
    diag.log('audio', 'playback stopped', {
      dropped: queueRef.current.length,
      wasPaused: pausedRef.current,
    });
    latestTurnRef.current = null;
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

  /**
   * The most recent turn audio has arrived for.
   *
   * Reported when the caller barges in. The turn *currently playing* is the
   * wrong answer while paused — it stays pinned to whatever was mid-sentence
   * when the pause began, and the server ignores a barge against a turn it has
   * already moved past.
   */
  const latestTurn = useCallback(() => latestTurnRef.current, []);

  /** Start counting again for a new turn. */
  const resetCounter = useCallback(() => {
    chunksPlayedRef.current = 0;
  }, []);

  useEffect(
    () => () => {
      releaseCurrent();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
      analyserRef.current = null;
    },
    [releaseCurrent]
  );

  return {
    /** Live spectrum of the agent's voice, for the visualiser. */
    outputAnalyserRef: analyserRef,
    /** The agent's voice as a MediaStream, for recording. */
    outputTapRef,
    /** Build the audio graph now rather than on first playback. */
    ensureGraph,
    enqueue,
    markTurnComplete,
    pause,
    resume,
    stop,
    chunksPlayed,
    latestTurn,
    resetCounter,
    isPlaying,
  };
};
