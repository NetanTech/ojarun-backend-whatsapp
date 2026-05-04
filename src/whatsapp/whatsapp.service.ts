import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';

/**
 * Thin wrapper around Meta's Graph API for sending WhatsApp messages.
 *
 * 24-hour window: after a customer messages you, you have 24h of free-form
 * replies. After that, only pre-approved templates work. For Phase 1 we only
 * reply to inbound messages, so we're always inside the window.
 *
 * Phone-number format: Meta's docs use no leading "+". We strip it before
 * sending.
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly http: AxiosInstance;
  private readonly phoneNumberId: string;

  constructor(private readonly config: ConfigService) {
    const apiVersion = this.config.get<string>('whatsapp.apiVersion');
    const accessToken = this.config.get<string>('whatsapp.accessToken');
    this.phoneNumberId = this.config.get<string>('whatsapp.phoneNumberId') ?? '';

    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${apiVersion}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
  }

  async sendText(to: string, body: string): Promise<{ ok: boolean; wamid: string | null; error?: string }> {
    try {
      const { data } = await this.http.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: this.normaliseNumber(to),
        type: 'text',
        text: { preview_url: false, body },
      });
      return { ok: true, wamid: data?.messages?.[0]?.id ?? null };
    } catch (err) {
      const ax = err as AxiosError<any>;
      const reason = ax.response?.data?.error?.message ?? ax.message;
      this.logger.error(`WhatsApp send failed: ${reason}`);
      return { ok: false, wamid: null, error: reason };
    }
  }

  private normaliseNumber(n: string): string {
    return n.startsWith('+') ? n.slice(1) : n;
  }
}
