import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WebhooksController } from './webhooks.controller';
import { WhatsappSignatureGuard } from './signature.guard';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ReminderService } from './reminder.service';
import { AiService } from './ai.service';

@Module({
  imports: [WhatsappModule, ScheduleModule.forRoot()],
  controllers: [WebhooksController],
  providers: [WhatsappSignatureGuard, ReminderService, AiService],
})
export class WebhooksModule {}