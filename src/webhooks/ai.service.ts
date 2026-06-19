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
    return this.config.get<string>('ai.systemPrompt')!;
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
        max_tokens: 500,
        system: this.systemPrompt(),
        messages: [...history, { role: 'user', content: userMessage }],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || null;
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
        max_tokens: 500,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          ...history,
          { role: 'user', content: userMessage },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
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
        max_tokens: 500,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          ...history,
          { role: 'user', content: userMessage },
        ],
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  }

  private async callGemini(userMessage: string, history: ChatMessage[]): Promise<string | null> {
    const apiKey = this.config.get<string>('ai.apiKey');
    const model = this.config.get<string>('ai.model');
    const contents = [
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: this.systemPrompt() }] },
          contents,
        }),
      },
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }
}