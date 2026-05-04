import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageDirection, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { WhatsappSignatureGuard } from './signature.guard';

@Controller('webhooks/whatsapp')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Meta calls this once when you save the webhook URL.
   * Echo hub.challenge back as plain text if the verify token matches.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expected = this.config.get<string>('whatsapp.verifyToken');
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('Webhook verified');
      return challenge;
    }
    this.logger.warn('Webhook verification FAILED — token mismatch');
    return '';
  }

  /**
   * Inbound message / status update from Meta.
   *
   * For Phase 1 we process inline. Later — when volume grows or replies
   * involve real work (DB lookups, payment, dispatch) — move this to a
   * BullMQ queue. For now: simple wins.
   *
   * The 200 still goes back fast because everything below is small.
   * If you ever add slow work here, switch to a queue.
   */
  @Post()
  @HttpCode(200)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Body() body: any): Promise<{ ok: true }> {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;

        for (const msg of value.messages ?? []) {
          await this.handleInboundMessage(msg, value.contacts ?? []);
        }
        // Status updates (sent/delivered/read on our outbound messages) — we
        // currently ignore them. When you want delivery analytics, persist
        // these to a `message_status` table or extend `messages`.
      }
    }
    return { ok: true };
  }

  /** Resolve customer → idempotency check → persist → auto-reply. */
  private async handleInboundMessage(
    msg: any,
    contacts: Array<{ wa_id: string; profile?: { name?: string } }>,
  ): Promise<void> {
    const wamid: string = msg.id;
    const from: string = msg.from; // E.164 without leading "+"

    // 1. Idempotency — Meta retries on any non-2xx and sometimes even on 2xx.
    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: wamid },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate wamid=${wamid}`);
      return;
    }

    // 2. Find or create the customer.
    const whatsappNumber = from.startsWith('+') ? from : `+${from}`;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;
    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber },
      create: { whatsappNumber, name: profileName ?? null },
      update: profileName ? { name: profileName } : {},
    });

    // 3. Extract a text body if it's a text message; otherwise just log type.
    const body = msg.type === 'text' ? msg.text?.body ?? null : null;

    // 4. Persist the inbound message before doing anything else.
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: wamid,
        direction: MessageDirection.inbound,
        body,
        raw: msg as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Inbound from ${whatsappNumber} (${customer.name ?? 'unknown'}): ${body ?? `[${msg.type}]`}`,
    );

    // 5. Auto-reply so the customer knows we got their message.
    //    Phase 2: replace this with real bot logic / handoff to admin UI.
    const replyBody = customer.name
      ? `Hi ${customer.name}! 👋 Thanks for reaching out to Ojarun. We've received your message and will get back to you shortly.`
      : `Hi! 👋 Thanks for reaching out to Ojarun. We've received your message and will get back to you shortly.`;

    const sent = await this.whatsapp.sendText(whatsappNumber, replyBody);

    // 6. Log the outbound message too — useful for audit and debugging.
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: sent.wamid,
        direction: MessageDirection.outbound,
        body: replyBody,
        raw: { sent } as Prisma.InputJsonValue,
      },
    });
  }
}
