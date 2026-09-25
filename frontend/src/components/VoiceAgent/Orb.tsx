import { useEffect, useRef } from 'react';
import type { CallState } from '../../stores/useBotStateStore';

interface OrbProps {
  state: CallState;
  /** Spectrum of the caller's microphone. */
  inputAnalyserRef: React.RefObject<AnalyserNode | null>;
  /** Spectrum of the agent's voice as it plays. */
  outputAnalyserRef: React.RefObject<AnalyserNode | null>;
}

interface Palette {
  core: string;
  edge: string;
  glow: string;
}

const PALETTE: Record<CallState, Palette> = {
  idle: { core: '#52525b', edge: '#18181b', glow: 'rgba(113,113,122,0.20)' },
  listening: { core: '#34d399', edge: '#065f46', glow: 'rgba(52,211,153,0.40)' },
  thinking: { core: '#a78bfa', edge: '#4c1d95', glow: 'rgba(167,139,250,0.40)' },
  speaking: { core: '#60a5fa', edge: '#1e3a8a', glow: 'rgba(96,165,250,0.45)' },
  paused: { core: '#fbbf24', edge: '#92400e', glow: 'rgba(251,191,36,0.40)' },
  ended: { core: '#3f3f46', edge: '#18181b', glow: 'rgba(63,63,70,0.15)' },
};

const SIZE = 260;
const BASE_RADIUS = 74;
/** Points around the ring. Enough to read as a curve, few enough to stay smooth. */
const POINTS = 128;
/** Speech energy lives low in the spectrum; the top bins are mostly empty. */
const USED_BIN_FRACTION = 0.45;

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/**
 * Audio-reactive orb.
 *
 * Deforms against the live spectrum of whichever side is talking, read from a
 * real AnalyserNode rather than approximated — so the movement lines up with
 * what is actually being heard.
 *
 * The shape is built by mapping frequency bins around half the circle and
 * mirroring them, which keeps it symmetric and organic instead of noisy. Radii
 * are eased toward their targets each frame so loud transients bloom rather
 * than snap, and everything is drawn on a canvas because this runs at 60fps
 * and has no business touching React state.
 */
const Orb = ({ state, inputAnalyserRef, outputAnalyserRef }: OrbProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radiiRef = useRef<number[]>(new Array(POINTS).fill(BASE_RADIUS));
  const paletteRef = useRef<Palette>(PALETTE.idle);
  const stateRef = useRef<CallState>(state);

  stateRef.current = state;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    context.scale(dpr, dpr);

    const centre = SIZE / 2;
    let frame = 0;

    const draw = () => {
      const current = stateRef.current;
      const target = PALETTE[current];

      // Ease the palette so a state change is a wash rather than a jump.
      paletteRef.current = target;

      // Only one side talks at a time; read whichever that is.
      const analyser =
        current === 'speaking'
          ? outputAnalyserRef.current
          : current === 'listening' || current === 'paused'
            ? inputAnalyserRef.current
            : null;

      let spectrum: Uint8Array<ArrayBuffer> | null = null;
      if (analyser) {
        spectrum = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        analyser.getByteFrequencyData(spectrum);
      }

      const usable = spectrum ? Math.floor(spectrum.length * USED_BIN_FRACTION) : 0;
      const now = performance.now();
      const radii = radiiRef.current;

      for (let i = 0; i < POINTS; i++) {
        // Mirror the first half across the second so the blob stays symmetric.
        const mirrored = i < POINTS / 2 ? i : POINTS - i - 1;
        const binIndex = usable ? Math.floor((mirrored / (POINTS / 2)) * usable) : 0;
        const energy = spectrum && usable ? spectrum[binIndex] / 255 : 0;

        // A slow drift keeps the shape alive when nothing is playing.
        const idleWave =
          Math.sin(now / 900 + (i / POINTS) * Math.PI * 4) * (current === 'idle' ? 1.4 : 2.4);

        const wanted = BASE_RADIUS + energy * 46 + idleWave;
        radii[i] = lerp(radii[i], wanted, 0.22);
      }

      context.clearRect(0, 0, SIZE, SIZE);

      // --- halo ---
      const haloRadius = Math.max(...radii) + 34;
      const halo = context.createRadialGradient(centre, centre, BASE_RADIUS * 0.4, centre, centre, haloRadius);
      halo.addColorStop(0, target.glow);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = halo;
      context.beginPath();
      context.arc(centre, centre, haloRadius, 0, Math.PI * 2);
      context.fill();

      // --- body, as a closed curve through the deformed radii ---
      context.beginPath();
      for (let i = 0; i <= POINTS; i++) {
        const index = i % POINTS;
        const nextIndex = (i + 1) % POINTS;
        const angle = (index / POINTS) * Math.PI * 2 - Math.PI / 2;
        const nextAngle = (nextIndex / POINTS) * Math.PI * 2 - Math.PI / 2;

        const x = centre + Math.cos(angle) * radii[index];
        const y = centre + Math.sin(angle) * radii[index];
        const nx = centre + Math.cos(nextAngle) * radii[nextIndex];
        const ny = centre + Math.sin(nextAngle) * radii[nextIndex];

        if (i === 0) context.moveTo(x, y);
        // Midpoint quadratics round off the joins between samples.
        context.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
      }
      context.closePath();

      const body = context.createRadialGradient(
        centre - 18,
        centre - 22,
        6,
        centre,
        centre,
        BASE_RADIUS + 48
      );
      body.addColorStop(0, target.core);
      body.addColorStop(1, target.edge);
      context.fillStyle = body;
      context.fill();

      // --- specular highlight ---
      const highlight = context.createRadialGradient(
        centre - 24,
        centre - 30,
        2,
        centre - 24,
        centre - 30,
        40
      );
      highlight.addColorStop(0, 'rgba(255,255,255,0.32)');
      highlight.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = highlight;
      context.fill();

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [inputAnalyserRef, outputAnalyserRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: SIZE, height: SIZE }}
      aria-hidden
    />
  );
};

export default Orb;
