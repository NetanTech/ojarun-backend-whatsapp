import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import * as https from 'https';

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

    // Corporate SSL inspection / local MITM often breaks Meta Graph TLS.
    // Opt out of cert verification in non-production, or when explicitly set.
    const tlsInsecure =
      this.config.get<boolean>('whatsapp.tlsInsecure') === true ||
      (this.config.get<string>('env') ?? 'development') !== 'production';

    this.http = axios.create({
      baseURL: `https://graph.facebook.com/${apiVersion}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      ...(tlsInsecure
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
        : {}),
    });
  }

  async sendText(to: string, body: string): Promise<{ ok: boolean; wamid: string | null; error?: string }> {
    if (!this.phoneNumberId || !this.config.get<string>('whatsapp.accessToken')) {
      return {
        ok: false,
        wamid: null,
        error:
          'WhatsApp is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in the backend .env',
      };
    }

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
      const apiError = ax.response?.data?.error;
      const reason =
        apiError?.error_user_msg ||
        apiError?.message ||
        ax.message ||
        'Failed to send WhatsApp message';
      const code = apiError?.code ? ` (code ${apiError.code})` : '';
      this.logger.error(`WhatsApp send failed: ${reason}${code}`);

      const authFailed =
        /auth/i.test(String(reason)) ||
        ax.response?.status === 401 ||
        apiError?.code === 190;

      return {
        ok: false,
        wamid: null,
        error: authFailed
          ? `WhatsApp Authentication Error${code}. Your WHATSAPP_ACCESS_TOKEN is invalid or expired — generate a new token in Meta Developer Console and update the backend .env, then restart Nest.`
          : `${reason}${code}`,
      };
    }
  }

  private normaliseNumber(n: string): string {
    return n.startsWith('+') ? n.slice(1) : n;
  }
}
