import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { AddressValidationService } from './address-validation.service';
import { AiService } from './ai.service';
import { ConversationService } from './conversation.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { PaystackModule } from '../paystack/paystack.module';
import { ProductsModule } from '../products/products.module';
import { AdminNotificationService } from '../admins/admin-notification.service';
import { CatalogBrowseService } from './catalog-browse.service';

@Module({
  imports: [
    WhatsappModule,
    PrismaModule,
    EmailModule,
    PaystackModule,
    ProductsModule,
  ],
  controllers: [WebhooksController],
  providers: [
    AiService,              // 👈 Register the service directly
    ConversationService,  
    AdminNotificationService,
    AddressValidationService,
    CatalogBrowseService,
  ],
  exports: [AddressValidationService, AiService],
})
export class WebhooksModule {}