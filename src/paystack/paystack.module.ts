import { Module } from '@nestjs/common';
import { PaystackService } from './paystack.service';
import { PaystackWebhookController } from './paystack.webhook.controller';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [PaystackWebhookController],
  providers: [PaystackService],
  exports: [PaystackService],
})
export class PaystackModule {}
