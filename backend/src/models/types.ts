export interface TranscriptionResult {
  text: string;
  confidence: number;
  language: string;
}

/** One side of the conversation, as the model will see it. */
export interface Turn {
  role: 'user' | 'assistant';
  /** What was actually said. For an interrupted assistant turn this is only
   *  the portion the caller heard, never the full generated text. */
  content: string;
  timestamp: Date;
  /** Assistant turns only: the caller cut in before this finished. */
  interrupted?: boolean;
  /** Assistant turns only: generated but never spoken. Used to resume. */
  unspoken?: string;
}

export type CallState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'paused'      // caller spoke over us; deciding whether it was a real interrupt
  | 'ended';

export interface TurnMetrics {
  sttMs: number | null;
  firstTokenMs: number | null;
  firstAudioMs: number | null;
  totalMs: number;
  chunks: number;
}

/** USD for one turn and for the call so far, with the inputs behind them. */
export interface CostReport {
  turn: {
    sttUsd: number;
    llmUsd: number;
    ttsUsd: number;
    totalUsd: number;
  };
  session: {
    sttUsd: number;
    llmUsd: number;
    ttsUsd: number;
    totalUsd: number;
    turns: number;
  };
  detail: {
    billedAudioSeconds: number;
    actualAudioSeconds: number;
    promptTokens: number;
    completionTokens: number;
    spokenCharacters: number;
  };
}
