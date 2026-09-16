import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CustomerChatController } from './customer-chat.controller';

@Module({
  imports: [
    WebhooksModule,
    // Public, unauthenticated endpoint that calls a paid LLM API per request —
    // throttle per-IP here so it can't be used to run up the AI bill.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 12 }]),
  ],
  controllers: [CustomerChatController],
})
export class CustomerChatModule {}
