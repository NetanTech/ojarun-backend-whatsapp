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
  | { type: 'draft_update'; items: OrderDraftItem[]; deliveryAddress: string | null }
  | { type: 'confirm_order' };

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
      if (result.type !== 'text') return result;

      // Some models (observed with Groq/Llama) occasionally hallucinate a
      // pseudo-XML representation of the tool call as plain text instead of
      // actually invoking it, e.g. `<function/update_order_items {...} />`.
      // Left unhandled, that garbled text goes straight to the customer AND
      // gets saved into history, confusing every subsequent turn. Recover
      // it here instead of trusting every model to always call tools cleanly.
      const recovered = this.tryRecoverToolCallFromText(result.content);
      if (recovered) {
        this.logger.warn(`Recovered a tool call the model emitted as text: ${result.content.slice(0, 200)}`);
        return recovered;
      }

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

    const orderingProtocol =
      `\n\nOrdering protocol — follow this exactly:\n` +
      `- Whenever the customer mentions an item they want (new, or a change to an existing item's quantity/unit), call update_order_items with just that item or items. You do NOT need to repeat items from earlier in the conversation — the system keeps the running list for you.\n` +
      `- If the customer gives a delivery address/location at any point, include it as deliveryAddress in that same call.\n` +
      `- Never call confirm_order until the customer has explicitly confirmed they're done and ready (e.g. "yes", "that's all", "go ahead", "confirm"). Keep using update_order_items as the list grows before that.\n` +
      `- confirm_order takes no item arguments — the system already has the full list from your update_order_items calls.`;

    const withProtocol = `${base}${orderingProtocol}`;
    if (!customerContext) return withProtocol;
    return `${withProtocol}\n\nWhat you remember about this returning customer from past conversations:\n${customerContext}\n\nUse this only where it's actually relevant — don't force it into every reply.`;
  }

  private getMarketTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'update_order_items',
          description:
            'Call this whenever the customer mentions an item to buy — new items, or a change to an existing one. Only include what changed this turn; the system merges it into the running list for you.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'Items mentioned or changed this turn — not the full running list.',
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
                description: 'The customer\'s delivery address, only if newly mentioned this turn. Omit otherwise.',
              },
            },
            required: ['items'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'confirm_order',
          description:
            'Call this ONLY when the customer has explicitly confirmed they are done adding items and ready to place the order. Takes no arguments — the system already has the full list.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
  }

  private getAnthropicTools() {
    return [
      {
        name: 'update_order_items',
        description:
          'Call this whenever the customer mentions an item to buy — new items, or a change to an existing one. Only include what changed this turn; the system merges it into the running list for you.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: 'Items mentioned or changed this turn — not the full running list.',
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
              description: 'The customer\'s delivery address, only if newly mentioned this turn. Omit otherwise.',
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'confirm_order',
        description:
          'Call this ONLY when the customer has explicitly confirmed they are done adding items and ready to place the order. Takes no arguments — the system already has the full list.',
        input_schema: { type: 'object', properties: {} },
      },
    ];
  }

  private getGeminiTools() {
    return [
      {
        function_declarations: [
          {
            name: 'update_order_items',
            description:
              'Call this whenever the customer mentions an item to buy — new items, or a change to an existing one. Only include what changed this turn; the system merges it into the running list for you.',
            parameters: {
              type: 'OBJECT',
              properties: {
                items: {
                  type: 'ARRAY',
                  description: 'Items mentioned or changed this turn — not the full running list.',
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
                  description: 'The customer\'s delivery address, only if newly mentioned this turn. Omit otherwise.',
                },
              },
              required: ['items'],
            },
          },
          {
            name: 'confirm_order',
            description:
              'Call this ONLY when the customer has explicitly confirmed they are done adding items and ready to place the order. Takes no arguments — the system already has the full list.',
            parameters: { type: 'OBJECT', properties: {} },
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

  /**
   * Attempts to recover a tool call from text the model emitted instead of
   * a real structured tool call — e.g. `<function/update_order_items {...} />`.
   * Returns null if the text doesn't look like a hallucinated tool call at
   * all, in which case it's genuinely just a normal reply.
   */
  private tryRecoverToolCallFromText(content: string): AiChatResult | null {
    const confirmMatch = content.match(/confirm_order/i);
    const updateMatch = content.match(/update_order_items\s*(\{[\s\S]*\})/i);

    if (updateMatch) {
      // Trim any trailing XML-ish closing tag like `/>` or `}` fragments
      // after the JSON object before parsing.
      let jsonText = updateMatch[1];
      const lastBrace = jsonText.lastIndexOf('}');
      if (lastBrace !== -1) jsonText = jsonText.slice(0, lastBrace + 1);
      try {
        const args = JSON.parse(jsonText);
        return this.toDraftUpdateResult(args);
      } catch {
        return null; // genuinely unparseable — let it through as plain text rather than guess
      }
    }

    if (confirmMatch) {
      return { type: 'confirm_order' };
    }

    return null;
  }

  private toDraftUpdateResult(args: any): AiChatResult {
    const items = args?.items ?? [];
    return {
      type: 'draft_update',
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
    if (toolUseBlock?.name === 'update_order_items') {
      return this.toDraftUpdateResult(toolUseBlock.input);
    }
    if (toolUseBlock?.name === 'confirm_order') {
      return { type: 'confirm_order' };
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

    if (!res.ok) {
      const rawBody = await res.text();
      // Groq specifically can reject a tool call outright (tool_use_failed)
      // rather than returning a garbled successful reply — but it conveniently
      // includes what it tried to generate in error.failed_generation, in the
      // same malformed shape as the text-hallucination case. Route it through
      // the same recovery path instead of just failing.
      let parsedError: any = null;
      try {
        parsedError = JSON.parse(rawBody);
      } catch {
        // not JSON — fall through to the generic throw below
      }
      const failedGeneration = parsedError?.error?.failed_generation;
      if (failedGeneration) {
        this.logger.warn('Provider rejected a tool call (tool_use_failed) — attempting recovery from failed_generation');
        return { type: 'text', content: failedGeneration };
      }
      throw new Error(`Provider error: ${res.statusText} (${rawBody})`);
    }
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    if (!message) return null;

    if (message.tool_calls?.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'update_order_items') {
        const args = JSON.parse(toolCall.function.arguments);
        return this.toDraftUpdateResult(args);
      }
      if (toolCall.function.name === 'confirm_order') {
        return { type: 'confirm_order' };
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
    if (functionCallPart?.functionCall.name === 'update_order_items') {
      return this.toDraftUpdateResult(functionCallPart.functionCall.args);
    }
    if (functionCallPart?.functionCall.name === 'confirm_order') {
      return { type: 'confirm_order' };
    }

    return parts[0]?.text ? { type: 'text', content: parts[0].text } : null;
  }
}