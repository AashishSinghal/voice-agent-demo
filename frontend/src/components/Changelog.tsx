import { X } from 'lucide-react';
import { CHANGELOG, type ChangeEntry, type EntryKind } from '../data/changelog';

interface ChangelogProps {
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL: Record<EntryKind, string> = {
  bug: 'fixed',
  capability: 'added',
  insight: 'learned',
};

const KIND_STYLE: Record<EntryKind, string> = {
  bug: 'border-amber-400/30 text-amber-300/90',
  capability: 'border-emerald-400/30 text-emerald-300/90',
  insight: 'border-sky-400/30 text-sky-300/90',
};

const Entry = ({ entry }: { entry: ChangeEntry }) => (
  <article className="border-b border-white/5 pb-7 last:border-0">
    <div className="mb-2 flex items-center gap-2">
      <span
        className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${KIND_STYLE[entry.kind]}`}
      >
        {KIND_LABEL[entry.kind]}
      </span>
      <time className="font-mono text-[11px] text-zinc-600">{entry.date}</time>
    </div>

    <h3 className="mb-2.5 text-sm font-medium leading-snug text-zinc-100">{entry.title}</h3>

    <dl className="space-y-2.5 text-xs leading-relaxed">
      <div>
        <dt className="text-[10px] uppercase tracking-wider text-zinc-600">Problem</dt>
        <dd className="text-zinc-400">{entry.problem}</dd>
      </div>

      {entry.cause && (
        <div>
          <dt className="text-[10px] uppercase tracking-wider text-zinc-600">Cause</dt>
          <dd className="text-zinc-400">{entry.cause}</dd>
        </div>
      )}

      <div>
        <dt className="text-[10px] uppercase tracking-wider text-zinc-600">Fix</dt>
        <dd className="text-zinc-300">{entry.fix}</dd>
      </div>
    </dl>

    {entry.metrics && (
      <div className="mt-3 space-y-1">
        {entry.metrics.map((metric) => (
          <div key={metric.label} className="flex items-baseline justify-between gap-4">
            <span className="text-[11px] text-zinc-500">{metric.label}</span>
            <span className="font-mono text-[11px] text-zinc-300">
              {metric.before && <span className="text-zinc-600">{metric.before} → </span>}
              {metric.after}
            </span>
          </div>
        ))}
      </div>
    )}

    {entry.log && (
      <pre className="mt-3 overflow-x-auto rounded bg-black/40 p-2.5 font-mono text-[10px] leading-relaxed text-zinc-500">
        {entry.log}
      </pre>
    )}
  </article>
);

/**
 * The build log, in public.
 *
 * Visible to anyone rather than hidden behind the debug panel: the engineering
 * is the interesting part of this project, and without somewhere to read it,
 * the demo just looks like a voice chatbot.
 */
const Changelog = ({ open, onClose }: ChangelogProps) => (
  <aside
    className={[
      'fixed right-0 top-0 z-20 h-full w-[26rem] max-w-full border-l border-white/10 bg-zinc-950/95 backdrop-blur',
      'transition-transform duration-300 ease-out',
      open ? 'translate-x-0' : 'translate-x-full',
    ].join(' ')}
    aria-hidden={!open}
  >
    <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
      <div>
        <h2 className="text-sm font-medium text-zinc-200">What broke, and why</h2>
        <p className="mt-0.5 text-[11px] text-zinc-600">
          {CHANGELOG.length} entries · newest first
        </p>
      </div>
      <button
        onClick={onClose}
        className="rounded p-1 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
        aria-label="Close changelog"
      >
        <X className="h-4 w-4" />
      </button>
    </div>

    <div className="space-y-7 overflow-y-auto px-5 py-5" style={{ height: 'calc(100% - 65px)' }}>
      {CHANGELOG.map((entry) => (
        <Entry key={`${entry.date}-${entry.title}`} entry={entry} />
      ))}
    </div>
  </aside>
);

export default Changelog;
