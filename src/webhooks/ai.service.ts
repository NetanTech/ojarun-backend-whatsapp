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

  constructor(private readonly config: ConfigService) {
    const provider = this.config.get<string>('ai.provider');
    const model = this.config.get<string>('ai.model');
    const apiKey = this.config.get<string>('ai.apiKey');
    const baseUrl = this.config.get<string>('ai.baseUrl');
    
    this.logger.log(`🔍 AI Config: provider=${provider}, model=${model}, baseUrl=${baseUrl || 'default'}`);
    this.logger.log(`🔑 API Key present: ${apiKey ? 'YES' : 'NO'}`);
  }

  async chat(
    userMessage: string,
    history: ChatMessage[] = [],
    customerContext: string | null = null,
  ): Promise<AiChatResult | null> {
    const provider = this.config.get<string>('ai.provider');
    const text = userMessage.trim().toUpperCase();

    this.logger.log(`🔍 AI Config: provider=${provider}, model=${this.config.get<string>('ai.model')}`);

    const dynamicGreetings = [
      `Aba! 👋 Welcome to OjaRun! I dey here sharp-sharp to run your market errands for Ibadan. Drop your shopping list or tell me wetin you wan buy today! 🛍️`,
      `How far! 👋 OjaRun dey here for you. Tell me wetin you wan buy from market today make we go help you buy am sharp-sharp! 🍅`,
      `Oya let's go! 🚀 Welcome to OjaRun. Wetin we dey buy from Ibadan market today? Just drop the list make I arrange am for you.`,
      `Aba, how body? 👋 OjaRun service active! Drop your market list here make we run the errand for you sharp-sharp! 🛒`,
    ];

    const greetingWords = ['HEYY', 'HEY', 'HELLO', 'HI', 'HOW FAR', 'YO', 'AFA', 'AOFA', 'YO YO YO'];
    if (history.length === 0 && (greetingWords.includes(text) || greetingWords.some((g) => text.startsWith(g + ' ')))) {
      const randomIndex = Math.floor(Math.random() * dynamicGreetings.length);
      return { type: 'text', content: dynamicGreetings[randomIndex] };
    }

    try {
      let result: AiChatResult | null = null;
      
      // For OpenRouter, use the OpenAI-compatible endpoint
      if (provider === 'openai' || provider === 'openrouter') {
        const baseUrl = this.config.get<string>('ai.baseUrl') || 'https://api.openai.com/v1';
        result = await this.callOpenAICompatible(
          `${baseUrl}/chat/completions`,
          userMessage,
          history,
          customerContext,
        );
      } else {
        switch (provider) {
          case 'anthropic':
            result = await this.callAnthropic(userMessage, history, customerContext);
            break;
          case 'groq':
            result = await this.callGroq(userMessage, history, customerContext);
            break;
          case 'gemini':
            result = await this.callGemini(userMessage, history, customerContext);
            break;
          default:
            this.logger.error(`Unknown AI provider: ${provider}`);
            return null;
        }
      }

      if (!result) return null;
      if (result.type !== 'text') return result;

      const recovered = this.tryRecoverToolCallFromText(result.content);
      if (recovered) {
        this.logger.warn(`Recovered a tool call the model emitted as text: ${result.content.slice(0, 200)}`);
        return recovered;
      }

      if (/<function[=/(]|update_order_items\s*\)?\s*\(?\s*\{|confirm_order\s*\(/i.test(result.content)) {
        this.logger.warn(
          `Dropping unrecoverable tool-syntax text: ${result.content.slice(0, 200)}`,
        );
        return {
          type: 'text',
          content:
            `Sorry, I no catch that clear 🙏 — abeg send the items again (e.g. "add 3kg tomatoes") or say *"that's all"* to confirm.`,
        };
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
   * Summarize conversation
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
        case 'openai':
        case 'openrouter': {
          const baseUrl = this.config.get<string>('ai.baseUrl') || 
            (provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1');
          const url = `${baseUrl}/chat/completions`;
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

  // ============== SYSTEM PROMPT ==============
  private systemPrompt(customerContext: string | null): string {
    const base = this.config.get<string>('ai.systemPrompt') ?? 'You are a helpful assistant.';

    const orderingProtocol =
      `\n\nOrdering protocol — follow this exactly:\n` +
      `- When the customer mentions items they want, DO NOT automatically assign quantities or prices. Instead, ask for quantities one at a time.\n` +
      `- If the customer lists multiple items without quantities, respond with a friendly question asking for the quantity of the FIRST item only. Example: "How much beans do you want? (e.g., '2 cups', '1 kg', 'N500 worth')"\n` +
      `- After the customer gives the quantity for one item, store it and ask for the next item's quantity. Continue this pattern until all items have quantities.\n` +
      `- Only call update_order_items when the customer has provided BOTH the item name AND its quantity/amount.\n` +
      `- Nigerian money shorthand: "2k", "5k", "10k" means ₦2000 / ₦5000 / ₦10000. NEVER interpret "2k" as 2kg unless they explicitly wrote "2kg" or "2 kg" or "2 kilos". For money, quantity=1 and unit="N2000 worth" (etc).\n` +
      `- If the customer gives a delivery address/location at any point, include it as deliveryAddress in that same call.\n` +
      `- Never call confirm_order until the customer has explicitly confirmed they're done and ready (e.g. "yes", "that's all", "go ahead", "confirm"). Keep using update_order_items as the list grows before that.\n` +
      `- confirm_order takes no item arguments — the system already has the full list from your update_order_items calls.`;

    const withProtocol = `${base}${orderingProtocol}`;
    if (!customerContext) return withProtocol;
    return `${withProtocol}\n\nWhat you remember about this returning customer from past conversations:\n${customerContext}\n\nUse this only where it's actually relevant — don't force it into every reply.`;
  }

  // ============== TOOLS ==============
  private getMarketTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'update_order_items',
          description:
            'Call this whenever the customer mentions an item with a quantity/amount. Only include what was specified this turn; the system merges it into the running list for you.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'Items with quantities mentioned this turn — not the full running list.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Specific product name' },
                    quantity: {
                      type: 'number',
                      description: 'Physical amount only (kg, bags, pieces). For money, set to 1.',
                    },
                    unit: {
                      type: 'string',
                      description: 'Physical unit OR money phrase like "N2000 worth"',
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
          description: 'Call this ONLY when the customer has explicitly confirmed they are done.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
  }

  private getAnthropicTools() {
    return [
      {
        name: 'update_order_items',
        description: 'Call this whenever the customer mentions an item with a quantity/amount.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  quantity: { type: 'number' },
                  unit: { type: 'string' },
                },
                required: ['name', 'quantity', 'unit'],
              },
            },
            deliveryAddress: {
              type: 'string',
              description: 'The customer\'s delivery address, only if newly mentioned.',
            },
          },
          required: ['items'],
        },
      },
      {
        name: 'confirm_order',
        description: 'Call this ONLY when the customer has explicitly confirmed they are done.',
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
            description: 'Call this whenever the customer mentions an item with a quantity/amount.',
            parameters: {
              type: 'OBJECT',
              properties: {
                items: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      name: { type: 'STRING' },
                      quantity: { type: 'NUMBER' },
                      unit: { type: 'STRING' },
                    },
                    required: ['name', 'quantity', 'unit'],
                  },
                },
                deliveryAddress: {
                  type: 'STRING',
                  description: 'The customer\'s delivery address, only if newly mentioned.',
                },
              },
              required: ['items'],
            },
          },
          {
            name: 'confirm_order',
            description: 'Call this ONLY when the customer has explicitly confirmed they are done.',
            parameters: { type: 'OBJECT', properties: {} },
          },
        ],
      },
    ];
  }

  // ============== HELPERS ==============
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private tryRecoverToolCallFromText(content: string): AiChatResult | null {
    const confirmMatch = /confirm_order/i.test(content);
    const updateMatch = content.match(
      /update_order_items\s*\)?\s*\(?\s*(\{[\s\S]*\})/i,
    );

    if (updateMatch) {
      let jsonText = updateMatch[1];
      const lastBrace = jsonText.lastIndexOf('}');
      if (lastBrace !== -1) jsonText = jsonText.slice(0, lastBrace + 1);
      const args = this.parseLooseJson(jsonText);
      if (args) return this.toDraftUpdateResult(args);
      return null;
    }

    if (confirmMatch) {
      return { type: 'confirm_order' };
    }

    return null;
  }

  private parseLooseJson(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      // fall through
    }
    try {
      const softened = text
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/'/g, '"');
      return JSON.parse(softened);
    } catch {
      return null;
    }
  }

  private toDraftUpdateResult(args: any): AiChatResult {
    const items = args?.items ?? [];
    return {
      type: 'draft_update',
      items: items
        .map((item: any) => {
          const rawQty = Number(item?.quantity);
          const quantity = Number.isFinite(rawQty) ? rawQty : 1;
          return {
            name: String(item?.name ?? '').trim(),
            quantity,
            unit: item?.unit?.toString().trim() || 'pieces',
          };
        })
        .filter((item: OrderDraftItem) => item.name.length > 0),
      deliveryAddress: args?.deliveryAddress?.toString().trim() || null,
    };
  }

  // ============== GROQ ==============
  private async callGroq(
    userMessage: string,
    history: ChatMessage[],
    customerContext: string | null,
  ): Promise<AiChatResult | null> {
    const baseUrl = 'https://api.groq.com/openai/v1';
    return this.callOpenAICompatible(
      `${baseUrl}/chat/completions`,
      userMessage,
      history,
      customerContext,
    );
  }

  // ============== ANTHROPIC ==============
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

  // ============== OPENAI COMPATIBLE (Works with OpenRouter, OpenAI, Groq) ==============
 private async callOpenAICompatible(
  url: string,
  userMessage: string,
  history: ChatMessage[],
  customerContext: string | null,
): Promise<AiChatResult | null> {
  const apiKey = this.config.get<string>('ai.apiKey');
  const model = this.config.get<string>('ai.model') || 'meta-llama/llama-3.2-3b-instruct:free';

  if (!apiKey) {
    this.logger.error('❌ API key is missing');
    return null;
  }

  this.logger.log(`📡 Calling OpenAI-compatible API: ${url}`);
  this.logger.log(`📡 Model: ${model}`);

  try {
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1000,
        temperature: 0.7,
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
      this.logger.error(`❌ API error ${res.status}: ${rawBody}`);
      
      try {
        const errorJson = JSON.parse(rawBody);
        this.logger.error(`❌ Error details: ${JSON.stringify(errorJson)}`);
      } catch {
        // not JSON
      }
      
      throw new Error(`Provider error: ${res.statusText} (${rawBody})`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message;
    
    if (!message) {
      this.logger.warn('No message in response');
      return null;
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'update_order_items') {
        try {
          const args = JSON.parse(toolCall.function.arguments);
          return this.toDraftUpdateResult(args);
        } catch (e) {
          this.logger.error('Failed to parse tool call arguments:', e);
        }
      }
      if (toolCall.function.name === 'confirm_order') {
        return { type: 'confirm_order' };
      }
    }

    if (message.content) {
      return { type: 'text', content: message.content };
    }

    return null;
  } catch (error) {
    this.logger.error('❌ OpenAI-compatible API call failed:', error);
    throw error;
  }
}


  // ============== GEMINI ==============
private async callGemini(
  userMessage: string,
  history: ChatMessage[],
  customerContext: string | null,
): Promise<AiChatResult | null> {
  const apiKey = this.config.get<string>('ai.apiKey');
  const model = this.config.get<string>('ai.model') || 'gemini-1.0-pro'; // 👈 FIX: Provide default

  if (!apiKey) {
    this.logger.error('❌ Gemini API key is missing');
    return null;
  }

  // Map model names to correct format
  const modelMap: Record<string, string> = {
    'gemini-pro': 'gemini-1.0-pro',
    'gemini-1.0-pro': 'gemini-1.0-pro',
    'gemini-1.5-pro': 'gemini-1.5-pro',
    'gemini-1.5-flash': 'gemini-1.5-flash',
    'gemini-1.5-pro-latest': 'gemini-1.5-pro',
    'gemini-1.5-flash-latest': 'gemini-1.5-flash',
  };

  // 👇 FIX: Ensure model is a string before using as index
  const actualModel = modelMap[model] || model;
  this.logger.log(`📡 Calling Gemini with model: ${actualModel}`);

  const rawContents = [
    ...history.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || ' ' }],
    })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const contents: any[] = [];
  for (const msg of rawContents) {
    if (contents.length === 0 || contents[contents.length - 1].role !== msg.role) {
      contents.push(msg);
    } else {
      contents[contents.length - 1].parts[0].text += `\n${msg.parts[0].text}`;
    }
  }

  const requestBody: any = {
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1000,
    },
  };

  const systemInstruction = this.systemPrompt(customerContext);
  if (systemInstruction) {
    requestBody.system_instruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:generateContent?key=${apiKey}`;

  try {
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errorText = await res.text();
      this.logger.error(`❌ Gemini API error ${res.status}: ${errorText}`);
      throw new Error(`Gemini error: ${res.statusText} (${errorText})`);
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts;
    
    if (!parts || parts.length === 0) {
      this.logger.warn('No parts in Gemini response');
      return null;
    }

    const functionCallPart = parts.find((p: any) => p.functionCall);
    if (functionCallPart?.functionCall?.name === 'update_order_items') {
      return this.toDraftUpdateResult(functionCallPart.functionCall.args);
    }
    if (functionCallPart?.functionCall?.name === 'confirm_order') {
      return { type: 'confirm_order' };
    }

    const text = parts.map((p: any) => p.text).join(' ');
    if (text) {
      return { type: 'text', content: text };
    }

    return null;
  } catch (error) {
    this.logger.error('❌ Gemini API call failed:', error);
    throw error;
  }
}
}