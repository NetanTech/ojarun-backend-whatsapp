import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

/**
 * Validates Meta's X-Hub-Signature-256 header.
 *
 * Algorithm: HMAC-SHA256 of the raw request body, keyed with the App Secret.
 * Meta sends "sha256=<hex>" — we re-compute and compare in constant time.
 *
 * Without this, the webhook is an open door — anyone on the internet could
 * POST fake messages and we'd process them. Don't skip this.
 */
@Injectable()
export class WhatsappSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WhatsappSignatureGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();

    const header = req.header('x-hub-signature-256');
    if (!header || !header.startsWith('sha256=')) {
      this.logger.warn('Missing or malformed X-Hub-Signature-256');
      return false;
    }

    const appSecret = this.config.get<string>('whatsapp.appSecret');
    if (!appSecret) {
      this.logger.error('WHATSAPP_APP_SECRET not configured — rejecting webhook');
      return false;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.error('rawBody missing — check JSON parser config in main.ts');
      return false;
    }

    const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const provided = header.slice('sha256='.length);

    if (expected.length !== provided.length) return false;

    const ok = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
    if (!ok) this.logger.warn('Signature mismatch — possible spoof or wrong app secret');
    return ok;
  }
}
