import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { AiService } from '../webhooks/ai.service';
import { SendCustomerChatDto } from './dto/customer-chat.dto';

@Controller('customer-chat')
export class CustomerChatController {
  constructor(private readonly ai: AiService) {}

  @Post('message')
  @HttpCode(200)
  async message(@Body() dto: SendCustomerChatDto) {
    const result = await this.ai.chat(
      dto.message,
      dto.history ?? [],
      null,
    );

    if (!result) {
      return {
        type: 'text' as const,
        content:
          'Sorry, I no catch that just now. Abeg try again in a moment.',
      };
    }

    return result;
  }
}
