import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, X } from 'lucide-react';
import { useBotStateStore, median, type TimelineKind } from '../../stores/useBotStateStore';
import type { VadCalibration } from '../../hooks/useVoiceActivityDetection';
import { diag } from '../../lib/diagnostics';
import type { TurnMetrics } from '../../hooks/useSocketConnection';

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  metrics: TurnMetrics | null;
  levelRef: React.RefObject<number>;
  peakRef: React.RefObject<number>;
  calibrationRef: React.RefObject<VadCalibration>;
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
  calibrationRef,
}: Pick<DebugPanelProps, 'levelRef' | 'peakRef' | 'calibrationRef'>) => {
  const barRef = useRef<HTMLDivElement>(null);
  const speechMarkRef = useRef<HTMLDivElement>(null);
  const silenceMarkRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const thresholdRef = useRef<HTMLDivElement>(null);

  // Full scale at 0.35 RMS — loud speech. Driven by rAF, not React state,
  // because this updates 60 times a second.
  const SCALE = 0.35;

  useEffect(() => {
    let frame: number;
    const tick = () => {
      const level = levelRef.current ?? 0;
      const cal = calibrationRef.current;
      if (!cal) {
        frame = requestAnimationFrame(tick);
        return;
      }

      const pct = Math.min(100, (level / SCALE) * 100);

      if (barRef.current) {
        barRef.current.style.width = `${pct}%`;
        barRef.current.style.background =
          level >= cal.speechThreshold
            ? '#34d399'
            : level >= cal.silenceThreshold
              ? '#fbbf24'
              : '#52525b';
      }
      // Markers move as the room is re-measured.
      if (speechMarkRef.current) {
        speechMarkRef.current.style.left = `${Math.min(100, (cal.speechThreshold / SCALE) * 100)}%`;
      }
      if (silenceMarkRef.current) {
        silenceMarkRef.current.style.left = `${Math.min(100, (cal.silenceThreshold / SCALE) * 100)}%`;
      }
      if (readoutRef.current) {
        readoutRef.current.textContent =
          `now ${level.toFixed(4)}  ·  peak ${(peakRef.current ?? 0).toFixed(4)}`;
      }
      if (thresholdRef.current) {
        thresholdRef.current.textContent =
          `floor ${cal.noiseFloor.toFixed(4)} · speech \u2265 ${cal.speechThreshold.toFixed(4)}`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levelRef, peakRef, calibrationRef]);

  return (
    <div>
      <div className="relative h-3 w-full overflow-hidden rounded bg-zinc-900">
        <div ref={barRef} className="h-full transition-[background-color] duration-150" style={{ width: '0%' }} />
        <div ref={silenceMarkRef} className="absolute top-0 h-full w-px bg-amber-400/70" style={{ left: '0%' }} />
        <div ref={speechMarkRef} className="absolute top-0 h-full w-px bg-emerald-400/80" style={{ left: '0%' }} />
      </div>
      <div className="mt-1.5 space-y-0.5">
        <div ref={readoutRef} className="font-mono text-[11px] text-zinc-400">0.0000</div>
        <div ref={thresholdRef} className="font-mono text-[11px] text-zinc-600">calibrating…</div>
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

const DebugPanel = ({
  open,
  onClose,
  connected,
  metrics,
  levelRef,
  peakRef,
  calibrationRef,
  isRecording,
}: DebugPanelProps) => {
  const { state, events, timeline, benchmarks } = useBotStateStore();
  const [copied, setCopied] = useState(false);
  const [entryCount, setEntryCount] = useState(0);

  // The recorder is not React state; subscribe so the count stays current.
  useEffect(() => diag.subscribe(() => setEntryCount(diag.count)), []);

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
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-zinc-600">
            Diagnostics
          </h3>
          <div className="flex gap-2">
            <button
              onClick={async () => {
                const ok = await diag.copy();
                setCopied(ok);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-white/10 px-2 py-1.5 text-xs text-zinc-300 transition hover:bg-white/5"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy log'}
            </button>
            <button
              onClick={() => diag.download()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded border border-white/10 px-2 py-1.5 text-xs text-zinc-300 transition hover:bg-white/5"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
            <button
              onClick={() => {
                diag.reset();
                setEntryCount(0);
              }}
              className="rounded border border-white/10 px-2 py-1.5 text-xs text-zinc-500 transition hover:bg-white/5 hover:text-zinc-300"
            >
              Clear
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            {entryCount} events captured — client, server, socket traffic and
            microphone level, in one timeline. Audio is recorded by size only.
          </p>
        </section>
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
          <LevelMeter levelRef={levelRef} peakRef={peakRef} calibrationRef={calibrationRef} />
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Thresholds are measured from your room, not hardcoded, so the
            markers drift as the noise floor is re-estimated. Talk normally: the
            bar should clear the green marker comfortably without shouting.
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
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">
            Last turn timeline
          </h3>
          {timeline.length === 0 ? (
            <p className="text-xs text-zinc-600">Nothing recorded yet.</p>
          ) : (
            <div className="space-y-0.5">
              {timeline.map((mark, i) => (
                <div key={`${mark.label}-${i}`} className="flex justify-between font-mono text-[11px]">
                  <span className={mark.source === 'server' ? 'text-zinc-500' : 'text-zinc-300'}>
                    {mark.source === 'server' ? '  ↳ ' : ''}
                    {mark.label}
                  </span>
                  <span className="text-zinc-400">+{mark.delta}ms</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Indented rows are the server's internal stages. The gap between
            "audio sent" and the decision is the network round trip plus
            transcription.
          </p>
        </section>

        <section>
          <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">
            Reaction benchmark
          </h3>
          {(['interruption', 'backchannel'] as TimelineKind[]).map((kind) => {
            const bench = benchmarks[kind];
            return (
              <Row
                key={kind}
                label={kind === 'interruption' ? 'stop on interrupt' : 'resume after "mhm"'}
                value={
                  bench.last === null
                    ? '—'
                    : `${bench.last} ms · med ${median(bench.samples)} (n=${bench.samples.length})`
                }
              />
            );
          })}
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
            Measured from the moment the caller's voice is detected to the
            moment the agent acts on it. Under ~300 ms feels immediate; over a
            second feels broken.
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
