import { create } from 'zustand';

/**
 * Call state, mirrored from the server so both sides agree.
 *
 *   idle      no call
 *   listening waiting for / capturing the caller
 *   thinking  transcribing or generating
 *   speaking  playing audio back
 *   paused    caller spoke over us; deciding if it was a real interruption
 *   ended     call finished
 */
export type CallState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'ended';

export interface DebugEvent {
  id: string;
  at: number;
  label: string;
  detail?: string;
}

interface BotStateStore {
  state: CallState;
  substatus: string | null;
  events: DebugEvent[];

  setState: (next: CallState, reason?: string) => void;
  setSubstatus: (substatus: string | null) => void;
  logEvent: (label: string, detail?: string) => void;
  reset: () => void;
}

export const useBotStateStore = create<BotStateStore>((set, get) => ({
  state: 'idle',
  substatus: null,
  events: [],

  setState: (next, reason) => {
    const current = get().state;
    if (current === next) return;
    console.log(`[STATE] ${current} -> ${next}${reason ? ` (${reason})` : ''}`);
    set({ state: next });
    get().logEvent(`${current} → ${next}`, reason);
  },

  setSubstatus: (substatus) => set({ substatus }),

  logEvent: (label, detail) =>
    set((s) => ({
      events: [
        ...s.events.slice(-40),
        { id: `${Date.now()}-${Math.random()}`, at: Date.now(), label, detail },
      ],
    })),

  reset: () => set({ state: 'idle', substatus: null, events: [] }),
}));

// Dev affordance: drive call state from the console to check visuals without
// a live call, e.g. __botStore.getState().setState('speaking')
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__botStore = useBotStateStore;
}
