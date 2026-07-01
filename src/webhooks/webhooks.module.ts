import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WebhooksController } from './webhooks.controller';
import { WhatsappSignatureGuard } from './signature.guard';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ReminderService } from './reminder.service';
import { AiService } from './ai.service';
import { ConversationService } from './conversation.service';

@Module({
  imports: [WhatsappModule, ScheduleModule.forRoot()],
  controllers: [WebhooksController],
  providers: [WhatsappSignatureGuard, ReminderService, AiService, ConversationService],
})
export class WebhooksModule {}