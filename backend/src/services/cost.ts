/**
 * What a turn costs.
 *
 * The project runs on Groq's free tier, so nothing is actually billed. The
 * point is to know the shape of the bill before it exists: which stage
 * dominates, and therefore which one is worth optimising. Measuring first
 * matters here because the answer is not the obvious one — see the note below
 * the price table.
 *
 * Prices are on-demand USD, checked September 2026. They move; treat this
 * table as the single place to update.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface TurnCost {
  sttUsd: number;
  llmUsd: number;
  ttsUsd: number;
  totalUsd: number;
  /** What drove each figure, so a number can always be explained. */
  detail: {
    billedAudioSeconds: number;
    actualAudioSeconds: number;
    promptTokens: number;
    completionTokens: number;
    spokenCharacters: number;
  };
}

interface LlmPrice {
  /** USD per million tokens. */
  inputPerMillion: number;
  outputPerMillion: number;
}

interface SttPrice {
  usdPerHour: number;
}

interface TtsPrice {
  usdPerMillionCharacters: number;
}

const LLM_PRICES: Record<string, LlmPrice> = {
  'openai/gpt-oss-20b': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  'openai/gpt-oss-120b': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

const STT_PRICES: Record<string, SttPrice> = {
  'whisper-large-v3': { usdPerHour: 0.111 },
  'whisper-large-v3-turbo': { usdPerHour: 0.04 },
};

const TTS_PRICES: Record<string, TtsPrice> = {
  'canopylabs/orpheus-v1-english': { usdPerMillionCharacters: 22 },
  'canopylabs/orpheus-arabic-saudi': { usdPerMillionCharacters: 40 },
};

/**
 * Transcription is billed at a ten-second minimum per request, whatever the
 * clip actually contains. A voice agent sends many short clips, so most
 * requests are billed at several times their real length — and trimming a clip
 * tighter, which helps accuracy, saves nothing at all on cost.
 */
const STT_MINIMUM_BILLED_SECONDS = 10;

const DEFAULT_LLM = 'openai/gpt-oss-20b';
const DEFAULT_STT = 'whisper-large-v3';
const DEFAULT_TTS = 'canopylabs/orpheus-v1-english';

export function sttCost(audioSeconds: number, model = DEFAULT_STT): number {
  const price = STT_PRICES[model] ?? STT_PRICES[DEFAULT_STT];
  const billed = Math.max(audioSeconds, STT_MINIMUM_BILLED_SECONDS);
  return (billed / 3600) * price.usdPerHour;
}

export function billedAudioSeconds(audioSeconds: number): number {
  return Math.max(audioSeconds, STT_MINIMUM_BILLED_SECONDS);
}

export function llmCost(usage: TokenUsage, model = DEFAULT_LLM): number {
  const price = LLM_PRICES[model] ?? LLM_PRICES[DEFAULT_LLM];
  return (
    (usage.promptTokens / 1_000_000) * price.inputPerMillion +
    (usage.completionTokens / 1_000_000) * price.outputPerMillion
  );
}

export function ttsCost(characters: number, model = DEFAULT_TTS): number {
  const price = TTS_PRICES[model] ?? TTS_PRICES[DEFAULT_TTS];
  return (characters / 1_000_000) * price.usdPerMillionCharacters;
}

export function turnCost(input: {
  audioSeconds: number;
  usage: TokenUsage;
  spokenCharacters: number;
  sttModel?: string;
  llmModel?: string;
  ttsModel?: string;
}): TurnCost {
  const stt = sttCost(input.audioSeconds, input.sttModel);
  const llm = llmCost(input.usage, input.llmModel);
  const tts = ttsCost(input.spokenCharacters, input.ttsModel);

  return {
    sttUsd: stt,
    llmUsd: llm,
    ttsUsd: tts,
    totalUsd: stt + llm + tts,
    detail: {
      billedAudioSeconds: billedAudioSeconds(input.audioSeconds),
      actualAudioSeconds: Number(input.audioSeconds.toFixed(2)),
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      spokenCharacters: input.spokenCharacters,
    },
  };
}

export const addCost = (a: TurnCost | null, b: TurnCost): TurnCost => {
  if (!a) return b;
  return {
    sttUsd: a.sttUsd + b.sttUsd,
    llmUsd: a.llmUsd + b.llmUsd,
    ttsUsd: a.ttsUsd + b.ttsUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    detail: {
      billedAudioSeconds: a.detail.billedAudioSeconds + b.detail.billedAudioSeconds,
      actualAudioSeconds: Number(
        (a.detail.actualAudioSeconds + b.detail.actualAudioSeconds).toFixed(2)
      ),
      promptTokens: a.detail.promptTokens + b.detail.promptTokens,
      completionTokens: a.detail.completionTokens + b.detail.completionTokens,
      spokenCharacters: a.detail.spokenCharacters + b.detail.spokenCharacters,
    },
  };
};
