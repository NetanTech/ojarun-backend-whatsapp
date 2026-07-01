import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type OrderDraftItem = {
  name: string;
  quantity: number;
  unit: string;
};

export type AiChatResult =
  | { type: 'text'; content: string }
  | { type: 'order'; items: OrderDraftItem[]; deliveryAddress: string | null };

const FETCH_TIMEOUT_MS = 20_000;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  async chat(
    userMessage: string,
    history: ChatMessage[] = [],
    customerContext: string | null = null,
  ): Promise<AiChatResult | null> {
    const provider = this.config.get<string>('ai.provider');
    const text = userMessage.trim().toUpperCase();

    const dynamicGreetings = [
      `Aba! 👋 Welcome to OjaRun! I dey here sharp-sharp to run your market errands for Ibadan. Drop your shopping list or let me know wetin you wan buy today! 🛍️`,
      `How far! 👋 OjaRun dey here for you. Tell me wetin you wan buy from market today make we go help you buy am sharp-sharp! 🍅`,
      `Oya let's go! 🚀 Welcome to OjaRun. Wetin we dey buy from Ibadan market today? Just drop the list make I arrange am for you.`,
      `Aba, how body? 👋 OjaRun service active! Drop your market list here make we run the errand for you sharp-sharp! 🛒`,
    ];

    // Only intercept greetings if there's no active conversation history — if
    // they're already mid-conversation, let the LLM handle it with context.
    const greetingWords = ['HEYY', 'HEY', 'HELLO', 'HI', 'HOW FAR', 'YO', 'AFA', 'AOFA', 'YO YO YO'];
    if (history.length === 0 && (greetingWords.includes(text) || greetingWords.some((g) => text.startsWith(g + ' ')))) {
      const randomIndex = Math.floor(Math.random() * dynamicGreetings.length);
      return { type: 'text', content: dynamicGreetings[randomIndex] };
    }

    try {
      let result: AiChatResult | null = null;
      switch (provider) {
        case 'anthropic':
          result = await this.callAnthropic(userMessage, history, customerContext);
          break;
        case 'groq':
          result = await this.callOpenAICompatible(
            'https://api.groq.com/openai/v1/chat/completions',
            userMessage,
            history,
            customerContext,
          );
          break;
        case 'openai':
          result = await this.callOpenAICompatible(
            'https://api.openai.com/v1/chat/completions',
            userMessage,
            history,
            customerContext,
          );
          break;
        case 'gemini':
          result = await this.callGemini(userMessage, history, customerContext);
          break;
        default:
          this.logger.error(`Unknown AI provider: ${provider}`);
          return null;
      }

      if (!result) return null;
      if (result.type === 'order') return result;

      const trimmed = result.content.trim();
      if (trimmed === 'Not_food' || trimmed === 'NOT_FOOD') {
        return {
          type: 'text',
          content: `No p, I dey for you! 🤝 Just list the things or ingredients you need from market, or tell me wetin you wan cook make I help you arrange the shopping list sharp-sharp!`,
        };
      }

      return result;
    } catch (err) {
      this.logger.error('AI chat failed', err as Error);
      return null;
    }
  }

  /**
   * Used by ConversationService when a conversation goes idle. Folds the
   * transcript into the customer's existing rolling profile and returns an
   * updated short summary — durable facts only (delivery area, usual items,
   * preferences), not a growing transcript log. Non-fatal on failure: the
   * caller should just skip updating the profile this round.
   */
  async summarizeConversation(transcript: string, existingContext: string | null): Promise<string | null> {
    const provider = this.config.get<string>('ai.provider');
    const prompt =
      `Existing customer profile notes (may be empty):\n${existingContext ?? '(none yet)'}\n\n` +
      `New conversation transcript:\n${transcript}\n\n` +
      `Rewrite the customer profile notes in 2-4 short plain-text lines. Keep only durable, ` +
      `reusable facts for future orders — delivery area, preferred brands/items, recurring ` +
      `quantities, payment habits, notable preferences. Drop anything one-off or stale. ` +
      `No markdown, no preamble — output only the updated notes.`;

    try {
      switch (provider) {
        case 'anthropic': {
          const res = await this.fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.config.get<string>('ai.apiKey')!,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: this.config.get<string>('ai.model'),
              max_tokens: 200,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`Anthropic summarize error: ${res.statusText}`);
          const data = await res.json();
          const textBlock = data.content?.find((b: any) => b.type === 'text');
          return textBlock?.text?.trim() || null;
        }
        case 'groq':
        case 'openai': {
          const url =
            provider === 'groq'
              ? 'https://api.groq.com/openai/v1/chat/completions'
              : 'https://api.openai.com/v1/chat/completions';
          const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.get<string>('ai.apiKey')}`,
            },
            body: JSON.stringify({
              model: this.config.get<string>('ai.model'),
              max_tokens: 200,
              messages: [{ role: 'user', content: prompt }],
            }),
          });
          if (!res.ok) throw new Error(`${provider} summarize error: ${res.statusText}`);
          const data = await res.json();
          return data.choices?.[0]?.message?.content?.trim() || null;
        }
        case 'gemini': {
          const apiKey = this.config.get<string>('ai.apiKey');
          const model = this.config.get<string>('ai.model');
          const res = await this.fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
            },
          );
          if (!res.ok) throw new Error(`Gemini summarize error: ${res.statusText}`);
          const data = await res.json();
          return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        }
        default:
          return null;
      }
    } catch (err) {
      this.logger.warn(`Conversation summarization failed (non-fatal): ${(err as Error).message}`);
      return null;
    }
  }

  private systemPrompt(customerContext: string | null): string {
    const base = this.config.get<string>('ai.systemPrompt') ?? 'You are a helpful assistant.';
    if (!customerContext) return base;
    return `${base}\n\nWhat you remember about this returning customer from past conversations:\n${customerContext}\n\nUse this only where it's actually relevant — don't force it into every reply.`;
  }

  private getMarketTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'create_market_order',
          description:
            'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'Clean list of foodstuff and market items with resolved names, numeric quantities, and units.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Specific product name, e.g., Local Rice, Ofada Rice, Scotch Bonnet Pepper, Beef' },
                    quantity: {
                      type: 'number',
                      description:
                        'Numeric amount. Convert fractions to decimals (e.g. "1/2 bag" -> 0.5). If the customer only gave a money amount with no physical unit (e.g. "N5000 worth"), use 1.',
                    },
                    unit: {
                      type: 'string',
                      description:
                        'Unit exactly as implied by the customer: kg, bag, congo, piece, tuber, etc. For money-based amounts, use the exact phrase, e.g. "N5000 worth".',
                    },
                  },
                  required: ['name', 'quantity', 'unit'],
                },
              },
              deliveryAddress: {
                type: 'string',
                description:
                  'The customer\'s delivery address or location exactly as they described it, e.g. "Soka, Ibadan" or "Bodija, near UI second gate". Omit this field if no location was mentioned anywhere in the conversation.',
              },
            },
            required: ['items'],
          },
        },
      },
    ];
  }

  private getAnthropicTools() {
    return [
      {
        name: 'create_market_order',
        description:
          'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Specific product name, e.g., Local Rice, Ofada Rice' },
                  quantity: {
                    type: 'number',
                    description: 'Numeric amount. Convert fractions to decimals (e.g. "1/2 bag" -> 0.5). Use 1 if only a money amount was given.',
                  },
                  unit: {
                    type: 'string',
                    description: 'Unit exactly as implied by customer: kg, bag, congo, piece. For money amounts, use the exact phrase, e.g. "N5000 worth".',
                  },
                },
                required: ['name', 'quantity', 'unit'],
              },
            },
            deliveryAddress: {
              type: 'string',
              description:
                'The customer\'s delivery address or location exactly as they described it, e.g. "Soka, Ibadan" or "Bodija, near UI second gate". Omit if no location was mentioned anywhere in the conversation.',
            },
          },
          required: ['items'],
        },
      },
    ];
  }

  private getGeminiTools() {
    return [
      {
        function_declarations: [
          {
            name: 'create_market_order',
            description:
              'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
            parameters: {
              type: 'OBJECT',
              properties: {
                items: {
                  type: 'ARRAY',
                  description: 'Clean list of market items with resolved names, numeric quantities, and units.',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      name: { type: 'STRING', description: 'Specific product name' },
                      quantity: { type: 'NUMBER', description: 'Numeric amount, fractions converted to decimals. Use 1 if only a money amount was given.' },
                      unit: { type: 'STRING', description: 'Unit as implied by customer, or the money phrase if that was all that was given.' },
                    },
                    required: ['name', 'quantity', 'unit'],
                  },
                },
                deliveryAddress: {
                  type: 'STRING',
                  description:
                    'The customer\'s delivery address or location exactly as they described it, e.g. "Soka, Ibadan" or "Bodija, near UI second gate". Omit if no location was mentioned anywhere in the conversation.',
                },
              },
              required: ['items'],
            },
          },
        ],
      },
    ];
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private toOrderResult(args: any): AiChatResult {
    const items = args?.items ?? [];
    return {
      type: 'order',
      items: items.map((item: any) => ({
        name: String(item?.name ?? '').trim(),
        quantity: typeof item?.quantity === 'number' && !Number.isNaN(item.quantity) && item.quantity > 0 ? item.quantity : 1,
        unit: item?.unit?.toString().trim() || 'pieces',
      })),
      deliveryAddress: args?.deliveryAddress?.toString().trim() || null,
    };
  }

  private async callAnthropic(
    userMessage: string,
    history: ChatMessage[],
    customerContext: string | null,
  ): Promise<AiChatResult | null> {
    const res = await this.fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.get<string>('ai.apiKey')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.get<string>('ai.model'),
        max_tokens: 1000,
        system: this.systemPrompt(customerContext),
        messages: [...history, { role: 'user', content: userMessage }],
        tools: this.getAnthropicTools(),
      }),
    });

    if (!res.ok) throw new Error(`Anthropic error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();

    const toolUseBlock = data.content?.find((block: any) => block.type === 'tool_use');
    if (toolUseBlock && toolUseBlock.name === 'create_market_order') {
      return this.toOrderResult(toolUseBlock.input);
    }

    const textBlock = data.content?.find((block: any) => block.type === 'text');
    return textBlock?.text ? { type: 'text', content: textBlock.text } : null;
  }

  /** Groq and OpenAI both speak the OpenAI chat-completions format — one implementation, base URL swapped in. */
  private async callOpenAICompatible(
    url: string,
    userMessage: string,
    history: ChatMessage[],
    customerContext: string | null,
  ): Promise<AiChatResult | null> {
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.get<string>('ai.apiKey')}`,
      },
      body: JSON.stringify({
        model: this.config.get<string>('ai.model'),
        max_tokens: 1000,
        messages: [
          { role: 'system', content: this.systemPrompt(customerContext) },
          ...history,
          { role: 'user', content: userMessage },
        ],
        tools: this.getMarketTools(),
        tool_choice: 'auto',
      }),
    });

    if (!res.ok) throw new Error(`Provider error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) return null;

    if (message.tool_calls?.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'create_market_order') {
        const args = JSON.parse(toolCall.function.arguments);
        return this.toOrderResult(args);
      }
    }

    return message.content ? { type: 'text', content: message.content } : null;
  }

  private async callGemini(
    userMessage: string,
    history: ChatMessage[],
    customerContext: string | null,
  ): Promise<AiChatResult | null> {
    const apiKey = this.config.get<string>('ai.apiKey');
    const model = this.config.get<string>('ai.model');

    const rawContents = [
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || ' ' }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    const contents: any[] = [];
    for (const msg of rawContents) {
      if (contents.length === 0 && msg.role !== 'user') continue;
      const lastMsg = contents[contents.length - 1];
      if (lastMsg && lastMsg.role === msg.role) {
        lastMsg.parts[0].text += `\n${msg.parts[0].text}`;
      } else {
        contents.push(msg);
      }
    }

    const res = await this.fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: this.systemPrompt(customerContext) }] },
          contents,
          tools: this.getGeminiTools(),
        }),
      },
    );

    if (!res.ok) throw new Error(`Gemini error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();

    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    const functionCallPart = parts.find((p: any) => p.functionCall);
    if (functionCallPart && functionCallPart.functionCall.name === 'create_market_order') {
      return this.toOrderResult(functionCallPart.functionCall.args);
    }

    return parts[0]?.text ? { type: 'text', content: parts[0].text } : null;
  }
}