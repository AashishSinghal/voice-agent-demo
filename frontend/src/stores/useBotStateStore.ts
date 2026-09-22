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

export interface TimelineMark {
  label: string;
  /** ms since the timeline started. */
  at: number;
  /** ms since the previous mark. */
  delta: number;
  source: 'client' | 'server';
}

export type TimelineKind = 'turn' | 'backchannel' | 'interruption';

/** Rolling reaction times, so a single lucky run is not mistaken for typical. */
export interface Benchmark {
  samples: number[];
  last: number | null;
}

interface BotStateStore {
  state: CallState;
  /** Set locally the moment VAD hears the caller, without waiting for the
   *  server to agree. Purely cosmetic, but it removes a round trip of
   *  apparent lag from the interface. */
  userSpeaking: boolean;
  substatus: string | null;
  events: DebugEvent[];

  timeline: TimelineMark[];
  timelineKind: TimelineKind | null;
  benchmarks: Record<TimelineKind, Benchmark>;

  setState: (next: CallState, reason?: string) => void;
  setUserSpeaking: (speaking: boolean) => void;
  setSubstatus: (substatus: string | null) => void;
  logEvent: (label: string, detail?: string) => void;

  startTimeline: (kind: TimelineKind) => void;
  markTimeline: (label: string) => void;
  attachServerMarks: (marks: { label: string; at: number; delta: number }[]) => void;
  finishTimeline: (label: string, actualKind?: TimelineKind) => void;

  reset: () => void;
}

const emptyBenchmarks = (): Record<TimelineKind, Benchmark> => ({
  turn: { samples: [], last: null },
  backchannel: { samples: [], last: null },
  interruption: { samples: [], last: null },
});

/** Wall-clock start of the timeline currently being recorded. */
let timelineStart = 0;
let timelineLast = 0;

export const useBotStateStore = create<BotStateStore>((set, get) => ({
  state: 'idle',
  userSpeaking: false,
  substatus: null,
  events: [],
  timeline: [],
  timelineKind: null,
  benchmarks: emptyBenchmarks(),

  setState: (next, reason) => {
    const current = get().state;
    if (current === next) return;
    console.log(`[STATE] ${current} -> ${next}${reason ? ` (${reason})` : ''}`);
    set({ state: next });
    get().logEvent(`${current} → ${next}`, reason);
  },

  setUserSpeaking: (userSpeaking) => set({ userSpeaking }),
  setSubstatus: (substatus) => set({ substatus }),

  logEvent: (label, detail) =>
    set((s) => ({
      events: [
        ...s.events.slice(-60),
        { id: `${Date.now()}-${Math.random()}`, at: Date.now(), label, detail },
      ],
    })),

  startTimeline: (kind) => {
    timelineStart = performance.now();
    timelineLast = timelineStart;
    set({ timeline: [], timelineKind: kind });
  },

  markTimeline: (label) => {
    if (!get().timelineKind) return;
    const now = performance.now();
    const mark: TimelineMark = {
      label,
      at: Math.round(now - timelineStart),
      delta: Math.round(now - timelineLast),
      source: 'client',
    };
    timelineLast = now;
    set((s) => ({ timeline: [...s.timeline, mark] }));
  },

  /** Splice the server's internal breakdown in as detail. */
  attachServerMarks: (marks) =>
    set((s) => ({
      timeline: [
        ...s.timeline,
        ...marks.map((m) => ({ ...m, source: 'server' as const })),
      ],
    })),

  finishTimeline: (label, actualKind) => {
    // The kind is provisional until the server classifies the utterance, so
    // the caller can correct it here before the sample is recorded.
    const kind = actualKind ?? get().timelineKind;
    if (!get().timelineKind || !kind) return;

    const total = Math.round(performance.now() - timelineStart);
    get().markTimeline(label);

    set((s) => {
      const bench = s.benchmarks[kind];
      return {
        timelineKind: null,
        benchmarks: {
          ...s.benchmarks,
          [kind]: { samples: [...bench.samples, total].slice(-20), last: total },
        },
      };
    });

    console.log(`[TIMELINE] ${kind} completed in ${total}ms`);
  },

  reset: () =>
    set({
      state: 'idle',
      userSpeaking: false,
      substatus: null,
      events: [],
      timeline: [],
      timelineKind: null,
      benchmarks: emptyBenchmarks(),
    }),
}));

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
};

// Dev affordance: drive call state from the console to check visuals without
// a live call, e.g. __botStore.getState().setState('speaking')
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__botStore = useBotStateStore;
}
