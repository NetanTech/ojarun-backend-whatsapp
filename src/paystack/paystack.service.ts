import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import axios, { AxiosInstance } from 'axios';

export type InitializePaymentInput = {
  email: string;
  amountNaira: number;
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
};

export type InitializePaymentResult = {
  ok: boolean;
  authorizationUrl?: string;
  accessCode?: string;
  reference?: string;
  error?: string;
};

@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly http: AxiosInstance;
  private readonly secretKey: string;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('paystack.secretKey') || '';
    this.http = axios.create({
      baseURL: 'https://api.paystack.co',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.secretKey?.trim());
  }

  async initializeTransaction(
    input: InitializePaymentInput,
  ): Promise<InitializePaymentResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        error:
          'Paystack is not configured. Set PAYSTACK_SECRET_KEY in the backend .env',
      };
    }

    const amountKobo = Math.round(input.amountNaira * 100);
    if (!Number.isFinite(amountKobo) || amountKobo < 100) {
      return {
        ok: false,
        error: 'Payment amount must be at least ₦1.00',
      };
    }

    try {
      const { data } = await this.http.post('/transaction/initialize', {
        email: input.email,
        amount: amountKobo,
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata ?? {},
      });

      if (!data?.status || !data?.data?.authorization_url) {
        return {
          ok: false,
          error: data?.message || 'Paystack initialize failed',
        };
      }

      return {
        ok: true,
        authorizationUrl: data.data.authorization_url as string,
        accessCode: data.data.access_code as string | undefined,
        reference: data.data.reference as string,
      };
    } catch (err: any) {
      const message =
        err?.response?.data?.message ||
        err?.message ||
        'Failed to initialize Paystack payment';
      this.logger.error(`Paystack initialize failed: ${message}`);
      return { ok: false, error: message };
    }
  }

  async verifyTransaction(reference: string): Promise<{
    ok: boolean;
    paid: boolean;
    amountNaira?: number;
    status?: string;
    metadata?: Record<string, unknown>;
    error?: string;
  }> {
    if (!this.isConfigured()) {
      return { ok: false, paid: false, error: 'Paystack not configured' };
    }

    try {
      const { data } = await this.http.get(
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
      const trx = data?.data;
      const status = String(trx?.status || '');
      const amountNaira =
        typeof trx?.amount === 'number' ? trx.amount / 100 : undefined;
      return {
        ok: Boolean(data?.status),
        paid: status === 'success',
        amountNaira,
        status,
        metadata: (trx?.metadata as Record<string, unknown>) || {},
      };
    } catch (err: any) {
      const message =
        err?.response?.data?.message ||
        err?.message ||
        'Failed to verify Paystack payment';
      return { ok: false, paid: false, error: message };
    }
  }

  /** Paystack signs the raw request body with HMAC SHA512 using the secret key. */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    if (!this.isConfigured() || !signature) return false;
    const payload = typeof rawBody === 'string' ? rawBody : rawBody;
    const hash = createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');

    try {
      const a = Buffer.from(hash);
      const b = Buffer.from(signature);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
