import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useBotStateStore } from '../../stores/useBotStateStore';
import type { TurnMetrics } from '../../hooks/useSocketConnection';

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  metrics: TurnMetrics | null;
  levelRef: React.RefObject<number>;
  peakRef: React.RefObject<number>;
  speechThreshold: number;
  silenceThreshold: number;
  isRecording: boolean;
}

/**
 * Live microphone level against the two detection thresholds.
 *
 * This is the first thing to look at when the agent seems deaf: if the bar
 * never crosses the speech marker while you talk, the thresholds are wrong for
 * this microphone and nothing downstream will ever fire.
 */
const LevelMeter = ({
  levelRef,
  peakRef,
  speechThreshold,
  silenceThreshold,
}: Pick<DebugPanelProps, 'levelRef' | 'peakRef' | 'speechThreshold' | 'silenceThreshold'>) => {
  const barRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  // Full scale at 0.35 RMS — loud speech. Driven by rAF, not React state,
  // because this updates 60 times a second.
  const SCALE = 0.35;

  useEffect(() => {
    let frame: number;
    const tick = () => {
      const level = levelRef.current ?? 0;
      const pct = Math.min(100, (level / SCALE) * 100);

      if (barRef.current) {
        barRef.current.style.width = `${pct}%`;
        barRef.current.style.background =
          level >= speechThreshold ? '#34d399' : level >= silenceThreshold ? '#fbbf24' : '#52525b';
      }
      if (readoutRef.current) {
        readoutRef.current.textContent =
          `now ${level.toFixed(3)}  ·  peak ${(peakRef.current ?? 0).toFixed(3)}`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levelRef, peakRef, speechThreshold, silenceThreshold]);

  const markerAt = (value: number) => `${Math.min(100, (value / SCALE) * 100)}%`;

  return (
    <div>
      <div className="relative h-3 w-full overflow-hidden rounded bg-zinc-900">
        <div ref={barRef} className="h-full transition-[background-color] duration-150" style={{ width: '0%' }} />
        <div
          className="absolute top-0 h-full w-px bg-amber-400/70"
          style={{ left: markerAt(silenceThreshold) }}
          title={`silence < ${silenceThreshold}`}
        />
        <div
          className="absolute top-0 h-full w-px bg-emerald-400/80"
          style={{ left: markerAt(speechThreshold) }}
          title={`speech >= ${speechThreshold}`}
        />
      </div>
      <div className="mt-1.5 space-y-0.5">
        <div ref={readoutRef} className="font-mono text-[11px] text-zinc-400">0.000</div>
        <div className="font-mono text-[11px] text-zinc-600">
          silence &lt; {silenceThreshold} · speech ≥ {speechThreshold}
        </div>
      </div>
    </div>
  );
};

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-4 py-1.5">
    <span className="text-xs text-zinc-500">{label}</span>
    <span className="font-mono text-xs text-zinc-200">{value}</span>
  </div>
);

const ms = (value: number | null | undefined) => (value == null ? '—' : `${value} ms`);

/**
 * The hood, for when someone wants to see how the thing works: live call state,
 * per-stage latency, and the event log that shows interruptions being
 * classified.
 */
const DebugPanel = ({
  open,
  onClose,
  connected,
  metrics,
  levelRef,
  peakRef,
  speechThreshold,
  silenceThreshold,
  isRecording,
}: DebugPanelProps) => {
  const { state, events } = useBotStateStore();

  return (
    <aside
      className={[
        'fixed right-0 top-0 z-20 h-full w-80 border-l border-white/10 bg-zinc-950/95 backdrop-blur',
        'transition-transform duration-300 ease-out',
        open ? 'translate-x-0' : 'translate-x-full',
      ].join(' ')}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
        <h2 className="text-sm font-medium text-zinc-200">Under the hood</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          aria-label="Close debug panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-6 overflow-y-auto px-5 py-4" style={{ height: 'calc(100% - 57px)' }}>
        <section>
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">State</h3>
          <Row label="call state" value={state} />
          <Row label="socket" value={connected ? 'connected' : 'disconnected'} />
          <Row label="recording" value={isRecording ? 'yes' : 'no'} />
        </section>

        <section>
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-zinc-600">
            Microphone
          </h3>
          <LevelMeter
            levelRef={levelRef}
            peakRef={peakRef}
            speechThreshold={speechThreshold}
            silenceThreshold={silenceThreshold}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Talk normally. The bar must cross the green marker for speech to
            register, and fall below the amber one for the turn to end. If it
            never reaches green, the thresholds are wrong for this mic.
          </p>
        </section>

        <section>
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">
            Last turn latency
          </h3>
          <Row label="transcription" value={ms(metrics?.sttMs)} />
          <Row label="first token" value={ms(metrics?.firstTokenMs)} />
          <Row label="first audio" value={ms(metrics?.firstAudioMs)} />
          <Row label="full response" value={ms(metrics?.totalMs)} />
          <Row label="sentence chunks" value={metrics?.chunks ?? '—'} />
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            First audio is what the caller feels. It lands well before the full
            response because each sentence is synthesised as it is generated.
          </p>
        </section>

        <section>
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">Events</h3>
          <div className="space-y-1">
            {events.length === 0 && <p className="text-xs text-zinc-600">No events yet.</p>}
            {[...events].reverse().map((event) => (
              <div key={event.id} className="font-mono text-[11px] leading-snug">
                <span className="text-zinc-300">{event.label}</span>
                {event.detail && <span className="text-zinc-600"> · {event.detail}</span>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
};

export default DebugPanel;
