import { create } from 'zustand';

/**
 * Bot State Machine:
 *
 * idle -> call_starting -> greeting -> listening -> recording -> processing -> speaking -> listening
 *
 * State Transitions:
 * - idle: Initial state, no call active
 * - call_starting: User clicked start call, waiting for greeting
 * - greeting: Bot is playing the initial greeting message
 * - listening: Bot is ready to listen, waiting for user to speak (auto-starts recording)
 * - recording: User is speaking, audio is being recorded
 * - processing: Audio sent to server, being transcribed and processed (STT -> LLM -> TTS)
 * - speaking: Bot response audio is playing
 * - call_ended: Call has ended (deflection or user hang up)
 */
export type BotState =
  | 'idle'
  | 'call_starting'
  | 'greeting'
  | 'listening'
  | 'recording'
  | 'processing'
  | 'speaking'
  | 'call_ended';

interface BotStateStore {
  state: BotState;

  // For UI Feedback
  processingSubstatus: string | null;

  setState: (newState: BotState, reason?: string) => void;
  setProcessingSubstatus: (substatus: string | null) => void;

  canRecord: () => boolean;
  canProcessAudio: () => boolean;
  isPlayingAudio: () => boolean;

  reset: () => void;
}

const logStateChange = (from: BotState, to: BotState, reason?: string) => {
  const timestamp = new Date().toISOString();
  const reasonStr = reason ? ` (Reason: ${reason})` : '';
  console.log(`[BOT_STATE ${timestamp}] ${from} -> ${to}${reasonStr}`);
};

export const useBotStateStore = create<BotStateStore>((set, get) => ({
  state: 'idle',
  processingSubstatus: null,

  setState: (newState: BotState, reason?: string) => {
    const currentState = get().state;
    if (currentState !== newState) {
      logStateChange(currentState, newState, reason);
      set({ state: newState });
    }
  },

  setProcessingSubstatus: (substatus: string | null) => {
    const timestamp = new Date().toISOString();
    if (substatus) {
      console.log(`[BOT_PROCESSING ${timestamp}] ${substatus}`);
    }
    set({ processingSubstatus: substatus });
  },

  // Can only record when bot is in listening state
  canRecord: () => {
    const state = get().state;
    return state === 'listening';
  },

  // Can only process audio when in recording state (user just finished speaking)
  canProcessAudio: () => {
    const state = get().state;
    return state === 'recording';
  },

  // Check if bot is currently playing audio (greeting or speaking)
  isPlayingAudio: () => {
    const state = get().state;
    return state === 'greeting' || state === 'speaking';
  },

  reset: () => {
    console.log('[BOT_STATE] Resetting to idle state');
    set({
      state: 'idle',
      processingSubstatus: null,
    });
  },
}));
