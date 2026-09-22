import { useEffect, useRef } from 'react';
import type { CallState } from '../../stores/useBotStateStore';

interface OrbProps {
  state: CallState;
  /** Live mic level, 0..1. Read every frame; deliberately not React state. */
  levelRef: React.RefObject<number>;
}

/** Per-state palette. Two stops so the orb has depth rather than a flat fill. */
const PALETTE: Record<CallState, { from: string; to: string; glow: string }> = {
  idle: { from: '#3f3f46', to: '#18181b', glow: 'rgba(113,113,122,0.25)' },
  listening: { from: '#34d399', to: '#059669', glow: 'rgba(52,211,153,0.45)' },
  thinking: { from: '#a78bfa', to: '#6d28d9', glow: 'rgba(167,139,250,0.45)' },
  speaking: { from: '#60a5fa', to: '#1d4ed8', glow: 'rgba(96,165,250,0.5)' },
  paused: { from: '#fbbf24', to: '#b45309', glow: 'rgba(251,191,36,0.45)' },
  ended: { from: '#52525b', to: '#27272a', glow: 'rgba(82,82,91,0.2)' },
};

/**
 * The single visual anchor of the interface.
 *
 * Scale and glow are driven from an animation frame writing CSS custom
 * properties, rather than from React state — mic level updates ~60 times a
 * second and re-rendering at that rate would be wasteful and janky.
 */
const Orb = ({ state, levelRef }: OrbProps) => {
  const orbRef = useRef<HTMLDivElement>(null);
  const smoothed = useRef(0);

  useEffect(() => {
    let frame: number;

    const tick = () => {
      // Only the caller's voice should push the orb around; while the agent
      // speaks, a gentle idle pulse reads better than reacting to its own audio.
      const target = state === 'listening' || state === 'paused' ? (levelRef.current ?? 0) : 0;
      smoothed.current += (target - smoothed.current) * 0.18;

      const breath =
        state === 'speaking' ? 0.04 * Math.sin(Date.now() / 260) :
        state === 'thinking' ? 0.03 * Math.sin(Date.now() / 420) : 0;

      const scale = 1 + smoothed.current * 0.28 + breath;

      if (orbRef.current) {
        orbRef.current.style.setProperty('--orb-scale', scale.toFixed(3));
        orbRef.current.style.setProperty(
          '--orb-glow-size',
          `${(38 + smoothed.current * 70 + Math.abs(breath) * 180).toFixed(0)}px`
        );
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [state, levelRef]);

  const palette = PALETTE[state];

  return (
    <div className="relative flex items-center justify-center" style={{ width: 260, height: 260 }}>
      {/* halo */}
      <div
        className="absolute rounded-full blur-3xl transition-colors duration-700"
        style={{ width: 240, height: 240, background: palette.glow }}
      />

      {/* rotating ring, only while the agent is working */}
      <div
        className="absolute rounded-full transition-opacity duration-500"
        style={{
          width: 210,
          height: 210,
          // Per-side longhand only. `border` and `borderColor` are both
          // shorthands, and mixing either with borderTopColor makes React warn
          // about conflicting style updates on re-render.
          borderWidth: 1,
          borderStyle: 'solid',
          borderTopColor: 'transparent',
          borderRightColor: palette.from,
          borderBottomColor: palette.from,
          borderLeftColor: palette.from,
          opacity: state === 'thinking' ? 0.55 : 0.15,
          animation: state === 'thinking' ? 'orb-spin 2.4s linear infinite' : 'none',
        }}
      />

      <div
        ref={orbRef}
        className="relative rounded-full transition-colors duration-700"
        style={{
          width: 168,
          height: 168,
          background: `radial-gradient(circle at 34% 30%, ${palette.from}, ${palette.to} 72%)`,
          boxShadow: `0 0 var(--orb-glow-size, 40px) ${palette.glow}, inset 0 -18px 40px rgba(0,0,0,0.45)`,
          transform: 'scale(var(--orb-scale, 1))',
          willChange: 'transform',
        }}
      >
        {/* highlight */}
        <div
          className="absolute rounded-full"
          style={{
            top: '16%',
            left: '22%',
            width: '32%',
            height: '24%',
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0.4), rgba(255,255,255,0) 70%)',
            filter: 'blur(3px)',
          }}
        />
      </div>
    </div>
  );
};

export default Orb;
