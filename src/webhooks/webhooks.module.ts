import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { AddressValidationService } from './address-validation.service';
import { AiService } from './ai.service';
import { ConversationService } from './conversation.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { PaystackModule } from '../paystack/paystack.module';

@Module({
  imports: [
    WhatsappModule,
    PrismaModule,
    EmailModule,
    PaystackModule,
  ],
  controllers: [WebhooksController],
  providers: [
    AiService,              // 👈 Register the service directly
    ConversationService,    // 👈 Register the service directly
    AddressValidationService,
  ],
  exports: [AddressValidationService],
})
export class WebhooksModule {}