import { X } from 'lucide-react';
import { useBotStateStore } from '../../stores/useBotStateStore';
import type { TurnMetrics } from '../../hooks/useSocketConnection';

interface DebugPanelProps {
  open: boolean;
  onClose: () => void;
  connected: boolean;
  metrics: TurnMetrics | null;
}

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
const DebugPanel = ({ open, onClose, connected, metrics }: DebugPanelProps) => {
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
