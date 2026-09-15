import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AiService, AiChatResult } from '../webhooks/ai.service';
import { SendChatMessageDto } from './dto/customer-chat.dto';

const MAX_HISTORY_MESSAGES = 20;

@Controller('customer-chat')
export class CustomerChatController {
  constructor(private readonly ai: AiService) {}

  @Post('message')
  @HttpCode(200)
  async sendMessage(@Body() dto: SendChatMessageDto): Promise<AiChatResult> {
    const history = (dto.history ?? []).slice(-MAX_HISTORY_MESSAGES);

    const result = await this.ai.chat(dto.message, history, null);
    if (result) return result;

    return {
      type: 'text',
      content:
        "Sorry, I'm having trouble replying right now. Please try again in a moment.",
    };
  }
}
