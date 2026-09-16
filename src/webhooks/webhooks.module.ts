import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { DeliveryModule } from '../delivery/delivery.module';
import { AiService } from './ai.service';
import { ConversationService } from './conversation.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { PaystackModule } from '../paystack/paystack.module';
import { AdminNotificationService } from '../admins/admin-notification.service';
import { CatalogLookupService } from './catalog-lookup.service';

@Module({
  imports: [
    WhatsappModule,
    PrismaModule,
    EmailModule,
    PaystackModule,
    DeliveryModule,
  ],
  controllers: [WebhooksController],
  providers: [
    AiService,              // 👈 Register the service directly
    ConversationService,  
    AdminNotificationService,
    CatalogLookupService,
  ],
  // DeliveryModule is re-exported (not its individual providers) so importers
  // still resolve AddressValidationService, which now lives there rather than
  // in this module's own providers.
  exports: [DeliveryModule, AiService],
})
export class WebhooksModule {}
