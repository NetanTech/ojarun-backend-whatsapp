import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  async chat(userMessage: string, history: ChatMessage[] = []): Promise<string | null> {
    const provider = this.config.get<string>('ai.provider');
    const text = userMessage.trim().toUpperCase();

    // 1. Array of mixed, highly localized dynamic greetings
    const dynamicGreetings = [
      `Aba! 👋 Welcome to OjaRun! I dey here sharp-sharp to run your market errands for Ibadan. Drop your shopping list or let me know wetin you wan buy today! 🛍️`,
      `How far! 👋 OjaRun dey here for you. Tell me wetin you wan buy from market today make we go help you buy am sharp-sharp! 🍅`,
      `Oya let's go! 🚀 Welcome to OjaRun. Wetin we dey buy from Ibadan market today? Just drop the list make I arrange am for you.`,
      `Aba, how body? 👋 OjaRun service active! Drop your market list here make we run the errand for you sharp-sharp! 🛒`
    ];

    // 2. Only intercept greetings if there's no active conversation history
    // If they are already talking about ingredients, let the LLM handle it using context!
    const greetingWords = ['HEYY', 'HEY', 'HELLO', 'HI', 'HOW FAR', 'YO', 'AFA', 'AOFA', 'YO YO YO'];
    if (history.length === 0 && (greetingWords.includes(text) || greetingWords.some(g => text.startsWith(g + ' ')))) {
      const randomIndex = Math.floor(Math.random() * dynamicGreetings.length);
      return dynamicGreetings[randomIndex];
    }

    if (text.includes('HOW TO COOK') || text.includes('RECIPE') || text.includes('PREPARE') || text.includes('PEPPER SOUP')) {
      this.logger.log(`Food-related intent recognized. Processing with chat history context...`);
    }

    try {
      let response: string | null = null;
      switch (provider) {
        case 'anthropic': response = await this.callAnthropic(userMessage, history); break;
        case 'groq':      response = await this.callGroq(userMessage, history); break;
        case 'openai':    response = await this.callOpenAI(userMessage, history); break;
        case 'gemini':    response = await this.callGemini(userMessage, history); break;
        default:
          this.logger.error(`Unknown AI provider: ${provider}`);
          return null;
      }

      // Localized fallback safeguard if the model gets strict or confused
      if (response && (response.trim() === 'Not_food' || response.trim() === 'NOT_FOOD')) {
        return `No p, I dey for you! 🤝 Just list the things or ingredients you need from market, or tell me wetin you wan cook make I help you arrange the shopping list sharp-sharp!`;
      }

      return response;
    } catch (err) {
      this.logger.error('AI chat failed', err);
      return null;
    }
  }

  private systemPrompt(): string {
    return this.config.get<string>('ai.systemPrompt') ?? 'You are a helpful assistant.';
  }

  private getMarketTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'create_market_order',
          description: 'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'Clean list of foodstuff and market items containing fully resolved specific names and requested quantities.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Specific name of the product, e.g., Local Rice, Foreign Rice, Ofada Rice, Scotch Bonnet Pepper, Beef' },
                    quantity: { type: 'string', description: 'Quantities or size values mentioned, e.g., 2kg, 1 congo, 1/2 bag, N5000 worth' }
                  },
                  required: ['name', 'quantity']
                }
              }
            },
            required: ['items']
          }
        }
      }
    ];
  }

  private getAnthropicTools() {
    return [
      {
        name: 'create_market_order',
        description: 'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
        input_schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Specific name of the product, e.g., Local Rice, Foreign Rice' },
                  quantity: { type: 'string', description: 'Quantities or sizes, e.g., 2kg, 1 congo, N5000 worth' }
                },
                required: ['name', 'quantity']
              }
            }
          },
          required: ['items']
        }
      }
    ];
  }

  private getGeminiTools() {
    return [
      {
        function_declarations: [
          {
            name: 'create_market_order',
            description: 'Call this function ONLY when the customer explicitly agrees, gives confirmation, or says yes to completing their market order list.',
            parameters: {
              type: 'OBJECT',
              properties: {
                items: {
                  type: 'ARRAY',
                  description: 'Clean list of market items containing fully resolved specific names and requested quantities.',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      name: { type: 'STRING', description: 'Specific name of product' },
                      quantity: { type: 'STRING', description: 'Quantities or sizing units' }
                    },
                    required: ['name', 'quantity']
                  }
                }
              },
              required: ['items']
            }
          }
        ]
      }
    ];
  }

  private async callAnthropic(userMessage: string, history: ChatMessage[]): Promise<string | null> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.get<string>('ai.apiKey')!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.get<string>('ai.model'),
        max_tokens: 1000,
        system: this.systemPrompt(),
        messages: [...history, { role: 'user', content: userMessage }],
        tools: this.getAnthropicTools(),
      }),
    });
    
    if (!res.ok) throw new Error(`Anthropic error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();
    
    const toolUseBlock = data.content?.find((block: any) => block.type === 'tool_use');
    if (toolUseBlock && toolUseBlock.name === 'create_market_order') {
      return `__CREATE_ORDER__:${JSON.stringify(toolUseBlock.input.items)}`;
    }

    const textBlock = data.content?.find((block: any) => block.type === 'text');
    return textBlock?.text || null;
  }

  private async callGroq(userMessage: string, history: ChatMessage[]): Promise<string | null> {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.get<string>('ai.apiKey')}`,
      },
      body: JSON.stringify({
        model: this.config.get<string>('ai.model'),
        max_tokens: 1000,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          ...history,
          { role: 'user', content: userMessage },
        ],
        tools: this.getMarketTools(),
        tool_choice: 'auto'
      }),
    });
    
    if (!res.ok) throw new Error(`Groq error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();
    const message = data.choices?.[0]?.message;

    if (!message) return null;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'create_market_order') {
        const args = JSON.parse(toolCall.function.arguments);
        return `__CREATE_ORDER__:${JSON.stringify(args.items)}`;
      }
    }

    return message.content || null;
  }

  private async callOpenAI(userMessage: string, history: ChatMessage[]): Promise<string | null> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.get<string>('ai.apiKey')}`,
      },
      body: JSON.stringify({
        model: this.config.get<string>('ai.model'),
        max_tokens: 1000,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          ...history,
          { role: 'user', content: userMessage },
        ],
        tools: this.getMarketTools(),
        tool_choice: 'auto'
      }),
    });
    
    if (!res.ok) throw new Error(`OpenAI error: ${res.statusText} (${await res.text()})`);
    const data = await res.json();
    const message = data.choices?.[0]?.message;

    if (!message) return null;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'create_market_order') {
        const args = JSON.parse(toolCall.function.arguments);
        return `__CREATE_ORDER__:${JSON.stringify(args.items)}`;
      }
    }

    return message.content || null;
  }

  private async callGemini(userMessage: string, history: ChatMessage[]): Promise<string | null> {
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
      if (contents.length === 0 && msg.role !== 'user') {
        continue;
      }
      const lastMsg = contents[contents.length - 1];
      if (lastMsg && lastMsg.role === msg.role) {
        lastMsg.parts[0].text += `\n${msg.parts[0].text}`;
      } else {
        contents.push(msg);
      }
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: this.systemPrompt() }] },
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
      const args = functionCallPart.functionCall.args;
      return `__CREATE_ORDER__:${JSON.stringify(args.items)}`;
    }

    return parts[0]?.text || null;
  }
}