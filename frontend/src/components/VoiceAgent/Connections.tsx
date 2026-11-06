import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionsView } from '../../hooks/useSocketConnection';

interface Api {
  list: () => Promise<ConnectionsView>;
  start: (service: string) => Promise<{ url: string }>;
  remove: (service: string) => Promise<unknown>;
}

const LABELS: Record<string, string> = { notion: 'Notion' };

/** Connect the caller's own accounts, so the agent can act on them. */
export default function Connections({ api, active }: { api: Api; active: boolean }) {
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const popup = useRef<Window | null>(null);

  const refresh = useCallback(() => {
    api
      .list()
      .then(setView)
      .catch(() => setView(null));
  }, [api]);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  // The window that finishes the sign-in tells this page, which then re-reads.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup.current || event.data?.type !== 'connection') return;
      setNote(event.data.ok ? null : 'That did not connect. Try again.');
      refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);

  if (!view || view.available.length === 0) return null;

  const connect = async (service: string) => {
    setNote(null);
    try {
      const { url } = await api.start(service);
      popup.current = window.open(url, 'connect-account', 'width=520,height=720');
      if (!popup.current) setNote('Allow pop-ups for this site to connect.');
    } catch {
      setNote('Could not start connecting. Try again.');
    }
  };

  return (
    <section>
      <h3 className="mb-1 text-[11px] uppercase tracking-wider text-zinc-600">Connected accounts</h3>
      {view.available.map((service) => {
        const found = view.connected.find((c) => c.service === service);
        return (
          <div key={service} className="mb-1 flex items-center justify-between gap-2 text-xs text-zinc-300">
            <span>
              {LABELS[service] ?? service}
              {found ? <span className="text-emerald-400"> · {found.workspace ?? 'connected'}</span> : null}
            </span>
            <button
              type="button"
              onClick={() => (found ? api.remove(service).then(refresh) : connect(service))}
              className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800"
            >
              {found ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        );
      })}
      {note ? <p className="text-[11px] text-amber-400">{note}</p> : null}
      <p className="mt-1 text-[11px] text-zinc-600">
        Once connected, ask the agent to search or add notes. Adding a note always asks for a yes first.
      </p>
    </section>
  );
}
