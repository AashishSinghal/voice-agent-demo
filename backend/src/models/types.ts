export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  language: string;
}

export enum IntentCategory {
  TRANSFER_STATUS = 'transfer_status',
  DELIVERY_TIMING = 'delivery_timing',
  COMPLETION_VS_ARRIVAL = 'completion_vs_arrival',
  TRANSFER_DELAYS = 'transfer_delays',
  PROOF_OF_PAYMENT = 'proof_of_payment',
  REFERENCE_NUMBER = 'reference_number',
  OUT_OF_SCOPE = 'out_of_scope',
}

export interface ClassificationResult {
  category: IntentCategory;
  confidence: number;
  matchedFAQ?: FAQEntry;
}

export interface FAQEntry {
  id: string;
  category: string;
  question: string;
  answer: string;
  keywords: string[];
  relatedQuestions?: string[];
  embedding?: number[];
}

export interface GeneratedResponse {
  text: string;
  shouldDeflect: boolean;
  confidence: number;
}
