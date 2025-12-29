import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import type { Message, GeneratedResponse, FAQEntry } from '../models/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load FAQs directly from JSON
const faqsPath = new URL('../data/faqs.json', import.meta.url);
const faqsData = fs.readFileSync(faqsPath, 'utf-8');
const allFAQs: FAQEntry[] = JSON.parse(faqsData);

console.log(`📚 Loaded ${allFAQs.length} FAQ entries`);

export class OllamaService {
  private apiUrl: string;
  private model: string;
  private allFAQs: FAQEntry[];

  constructor() {
    this.apiUrl = process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'phi3';
    this.allFAQs = allFAQs;
    console.log(`🤖 Ollama Service initialized (${this.model}) with ${this.allFAQs.length} FAQs`);
  }

  async generateResponse(
    query: string,
    conversationHistory: Message[] = []
  ): Promise<GeneratedResponse> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(query, conversationHistory);

    try {
      console.log(`🤖 Generating response with ${this.model}...`);

      const response = await axios.post(
        `${this.apiUrl}/api/generate`,
        {
          model: this.model,
          prompt: `${systemPrompt}\n\n${userPrompt}`,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            num_predict: 150,
            stop: ['\n\n', 'User:', 'Assistant:'],
          },
        },
        {
          timeout: 30000,
        }
      );

      const text = response.data.response.trim();

      console.log(`✅ Generated response: "${text.substring(0, 100)}..."`);

      // Check if response is a deflection
      const isDeflection = text.toLowerCase().includes('human agent') ||
                          text.toLowerCase().includes('outside my area');

      return {
        text,
        shouldDeflect: isDeflection,
        confidence: 0.9,
      };
    } catch (error) {
      console.error('❌ Ollama API error:', error);
      throw new Error('Failed to generate response');
    }
  }

  private buildSystemPrompt(): string {
    // Build FAQ context from all FAQs
    const faqContext = this.allFAQs
      .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
      .join('\n\n');

    return `You are a friendly customer support agent for Wise, helping customers track their money transfers.

You can ONLY answer questions about the topics covered in the FAQ below. For ANY other questions, you must politely deflect to a human agent.

FAQ Knowledge Base:
${faqContext}

Guidelines:
- Keep responses concise (2-3 sentences max)
- Be conversational and friendly
- Answer based on the FAQ information above
- Natural for voice conversation
- Do not use phrases like "according to the FAQ" or "based on the information provided"

If the question is NOT covered in the FAQ above, respond EXACTLY with:
"I understand this is outside my area of expertise. Let me connect you with a human agent who can better assist you with this matter."`;
  }

  private buildUserPrompt(
    query: string,
    conversationHistory: Message[]
  ): string {
    const historyText = conversationHistory
      .slice(-4)
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');

    let prompt = `User Question: ${query}`;

    if (historyText) {
      prompt += `\n\nConversation History:\n${historyText}`;
    }

    prompt += `\n\nProvide a natural, conversational response:`;

    return prompt;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.apiUrl}/api/tags`, {
        timeout: 5000,
      });
      console.log(`✅ Ollama connection successful`);
      console.log(`📦 Available models:`, response.data.models?.map((m: any) => m.name).join(', '));
      return true;
    } catch (error) {
      console.error('❌ Ollama connection failed:', error);
      return false;
    }
  }
}
