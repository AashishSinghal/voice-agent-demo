import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { Button } from '../ui/button';

interface AudioPlayerProps {
  audioBuffer: ArrayBuffer;
  autoPlay?: boolean;
}

const AudioPlayer = ({ audioBuffer, autoPlay = true }: AudioPlayerProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const waveformDataRef = useRef<number[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    // Create audio element from buffer
    const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Generate waveform data
    generateWaveform(audioBuffer);

    // Setup audio event listeners
    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration);
    });

    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime);
    });

    audio.addEventListener('play', () => setIsPlaying(true));
    audio.addEventListener('pause', () => setIsPlaying(false));
    audio.addEventListener('ended', () => {
      setIsPlaying(false);
      setCurrentTime(0);
    });

    // Auto-play if enabled
    if (autoPlay) {
      audio.play();
    }

    return () => {
      audio.pause();
      URL.revokeObjectURL(audioUrl);
    };
  }, [audioBuffer, autoPlay]);

  const generateWaveform = async (buffer: ArrayBuffer) => {
    try {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
      const rawData = audioBuffer.getChannelData(0);
      const samples = 100; // Number of bars in waveform
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

      // Normalize
      const max = Math.max(...filteredData);
      waveformDataRef.current = filteredData.map(v => v / max);

      drawWaveform();
    } catch (error) {
      console.error('Error generating waveform:', error);
    }
  };

  const drawWaveform = () => {
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

      // Color based on progress
      const isPlayed = index / data.length < progress;
      ctx.fillStyle = isPlayed ? '#3b82f6' : '#d1d5db';
      ctx.fillRect(x, y, barWidth - 1, barHeight);
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    drawWaveform();
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

  return (
    <div className="flex items-center gap-3 mt-2 p-2 bg-gray-50 rounded-lg">
      <Button
        size="sm"
        variant="ghost"
        onClick={togglePlayPause}
        className="h-8 w-8 p-0"
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" />
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

      <span className="text-xs text-gray-500 min-w-[45px] text-right">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
};

export default AudioPlayer;