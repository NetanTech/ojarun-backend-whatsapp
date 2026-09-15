import { Module } from '@nestjs/common';
import { CustomerChatController } from './customer-chat.controller';
import { AiService } from '../webhooks/ai.service';

@Module({
  controllers: [CustomerChatController],
  providers: [AiService],
})
export class CustomerChatModule {}
