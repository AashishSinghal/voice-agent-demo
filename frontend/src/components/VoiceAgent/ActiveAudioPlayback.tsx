import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2 } from 'lucide-react';
import { Button } from '../ui/button';
import { useBotStateStore } from '../../stores/useBotStateStore';

interface ActiveAudioPlaybackProps {
  audioBuffer: ArrayBuffer | null;
  transcriptText: string;
  onPlaybackEnd?: () => void;
}

const ActiveAudioPlayback = ({ audioBuffer, transcriptText, onPlaybackEnd }: ActiveAudioPlaybackProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const waveformDataRef = useRef<number[]>([]);

  const { setState } = useBotStateStore();

  const generateWaveform = useCallback(async (buffer: ArrayBuffer) => {
    try {
      const audioContext = new AudioContext();
      const decodedBuffer = await audioContext.decodeAudioData(buffer.slice(0));
      const rawData = decodedBuffer.getChannelData(0);
      const samples = 100;
      const blockSize = Math.floor(rawData.length / samples);
      const filteredData: number[] = [];

      for (let i = 0; i < samples; i++) {
        const blockStart = blockSize * i;
        let sum = 0;
        for (let j = 0; j < blockSize; j++) {
          sum += Math.abs(rawData[blockStart + j]);
        }
        filteredData.push(sum / blockSize);
      }

      const max = Math.max(...filteredData);
      waveformDataRef.current = filteredData.map(v => v / max);
      audioContext.close();
    } catch (error) {
      console.error('[ACTIVE_AUDIO] Waveform error:', error);
    }
  }, []);

  useEffect(() => {
    if (!audioBuffer) return;

    let isCleaningUp = false;

    const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    generateWaveform(audioBuffer);

    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration);
    });

    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime);
    });

    audio.addEventListener('play', () => {
      setIsPlaying(true);
    });

    audio.addEventListener('pause', () => {
      if (isCleaningUp) return;
      setIsPlaying(false);

      if (!audio.ended) {
        setState('listening', 'Audio paused');
      }
    });

    audio.addEventListener('ended', () => {
      setIsPlaying(false);
      setCurrentTime(0);
      setState('listening', 'Audio ended');

      if (onPlaybackEnd) {
        onPlaybackEnd();
      }
    });

    audio.play().catch(err => {
      console.error('[ACTIVE_AUDIO] Auto-play failed:', err);
    });

    return () => {
      isCleaningUp = true;
      audio.pause();
      URL.revokeObjectURL(audioUrl);
    };
  }, [audioBuffer, onPlaybackEnd, setState, generateWaveform]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const data = waveformDataRef.current;

    ctx.clearRect(0, 0, width, height);

    const barWidth = width / data.length;
    const progress = duration > 0 ? currentTime / duration : 0;

    data.forEach((value, index) => {
      const barHeight = value * height * 0.8;
      const x = index * barWidth;
      const y = (height - barHeight) / 2;

      const isPlayed = index / data.length < progress;
      ctx.fillStyle = isPlayed ? '#3b82f6' : '#d1d5db';
      ctx.fillRect(x, y, barWidth - 1, barHeight);
    });
  }, [currentTime, duration]);

  const togglePlayPause = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!audioBuffer) return null;

  return (
    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg border-2 border-blue-200 shadow-lg">
      <div className="flex items-start gap-3 mb-3">
        <div className="shrink-0 h-10 w-10 rounded-full bg-blue-500 flex items-center justify-center shadow-md">
          <Volume2 className="h-6 w-6 text-white" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-blue-900 mb-1">Bot is speaking:</p>
          <p className="text-sm text-blue-800 italic">{transcriptText}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 bg-white p-3 rounded-lg shadow-sm">
        <Button
          size="sm"
          variant="ghost"
          onClick={togglePlayPause}
          className="h-10 w-10 p-0 rounded-full hover:bg-blue-100"
        >
          {isPlaying ? (
            <Pause className="h-5 w-5 text-blue-600" />
          ) : (
            <Play className="h-5 w-5 text-blue-600" />
          )}
        </Button>

        <div className="flex-1">
          <canvas
            ref={canvasRef}
            width={300}
            height={40}
            className="w-full h-10 cursor-pointer"
            onClick={togglePlayPause}
          />
        </div>

        <span className="text-xs text-gray-600 font-mono min-w-[55px] text-right">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
};

export default ActiveAudioPlayback;
