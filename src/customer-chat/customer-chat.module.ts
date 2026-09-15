import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CustomerChatController } from './customer-chat.controller';

@Module({
  imports: [WebhooksModule],
  controllers: [CustomerChatController],
})
export class CustomerChatModule {}
