import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WhatsappSignatureGuard } from './signature.guard';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [WebhooksController],
  providers: [WhatsappSignatureGuard],
})
export class WebhooksModule {}
