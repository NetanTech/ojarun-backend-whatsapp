import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly config: ConfigService) {}

  async chat(userMessage: string, history: ChatMessage[] = []): Promise<string | null> {
    const provider = this.config.get<string>('ai.provider');

    try {
      switch (provider) {
        case 'anthropic': return await this.callAnthropic(userMessage, history);
        case 'groq':      return await this.callGroq(userMessage, history);
        case 'openai':    return await this.callOpenAI(userMessage, history);
        case 'gemini':    return await this.callGemini(userMessage, history);
        default:
          this.logger.error(`Unknown AI provider: ${provider}`);
          return null;
      }
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
        max_tokens: 1000, // Safe buffer for tool calling payloads
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
    
    // Process history to align strictly with Gemini alternation requirements
    const rawContents = [
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || ' ' }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    // Filter logic ensuring strict alternation and a user-first structure
    const contents: any[] = [];
    for (const msg of rawContents) {
      if (contents.length === 0 && msg.role !== 'user') {
        continue; // Skip any prepended model responses if they hit first
      }
      const lastMsg = contents[contents.length - 1];
      if (lastMsg && lastMsg.role === msg.role) {
        // Append text together if identical roles happen consecutively
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