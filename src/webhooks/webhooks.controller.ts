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
import { MessageHandler } from '../whatsapp/message.handler';
import { WhatsappSignatureGuard } from './signature.guard';

@Controller('webhooks/whatsapp')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly messageHandler: MessageHandler,
  ) {}

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
      }
    }
    return { ok: true };
  }

  private async handleInboundMessage(
    msg: any,
    contacts: Array<{ wa_id: string; profile?: { name?: string } }>,
  ): Promise<void> {
    const wamid: string = msg.id;
    const from: string = msg.from;
    const whatsappNumber = from.startsWith('+') ? from : `+${from}`;

    // Save the customer name from WhatsApp profile if provided
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;
    if (profileName) {
      await this.prisma.customer.upsert({
        where: { whatsappNumber },
        create: { whatsappNumber, name: profileName },
        update: { name: profileName },
      });
    }

    // Only handle text messages through the bot — ignore media for now
    if (msg.type !== 'text') {
      this.logger.log(`Ignoring non-text message type=${msg.type} from ${whatsappNumber}`);
      return;
    }

    const textBody: string = msg.text?.body ?? '';
    if (!textBody) return;

    this.logger.log(`Inbound from ${whatsappNumber}: ${textBody}`);

    // Hand off to MessageHandler — it handles idempotency, DB saves, 
    // conversation state, bot logic, and sending the reply
    await this.messageHandler.handle(whatsappNumber, textBody, wamid);
  }
}