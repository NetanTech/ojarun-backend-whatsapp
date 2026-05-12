import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { MessageHandler } from './message.handler';
import { ConversationService } from './conversation.service';
import { OrderService } from '../orders/order.service';
import { ProductService } from '../products/product.service';

@Module({
  providers: [
    WhatsappService,
    MessageHandler,
    ConversationService,
    OrderService,
    ProductService,
  ],
  exports: [WhatsappService, MessageHandler],
})
export class WhatsappModule {}