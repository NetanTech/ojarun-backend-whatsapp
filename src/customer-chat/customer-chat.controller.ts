import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AiService, AiChatResult } from '../webhooks/ai.service';
import { SendChatMessageDto } from './dto/customer-chat.dto';
import { ProductsService } from '../products/products.service';

const MAX_HISTORY_MESSAGES = 20;
const NEWLINE = String.fromCharCode(10);

@Controller('customer-chat')
@UseGuards(ThrottlerGuard)
export class CustomerChatController {
  constructor(
    private readonly ai: AiService,
    private readonly products: ProductsService,
  ) {}

  /** One line per available product, grouped by category, for the AI prompt. */
  private async catalogText(): Promise<string | null> {
    try {
      // Uses the storefront cache, so this is usually free.
      const list = await this.products.findAllPublic();
      const byCategory = new Map<string, string[]>();
      for (const p of list) {
        const cat = p.category || 'Other';
        const line = `- ${p.name} | ${p.unit} | ₦${p.currentPrice.toLocaleString('en-NG')}`;
        byCategory.set(cat, [...(byCategory.get(cat) ?? []), line]);
      }
      return [...byCategory.entries()]
        .map(([cat, lines]) => [`${cat}:`, ...lines].join(NEWLINE))
        .join(NEWLINE);
    } catch {
      return null; // chat still works, just without the product list
    }
  }

  @Post('message')
  @HttpCode(200)
  async sendMessage(@Body() dto: SendChatMessageDto): Promise<AiChatResult> {
    const history = (dto.history ?? []).slice(-MAX_HISTORY_MESSAGES);

    const catalog = await this.catalogText();
    const result = await this.ai.chat(dto.message, history, null, catalog);
    if (result) return result;

    return {
      type: 'text',
      content:
        "Sorry, I'm having trouble replying right now. Please try again in a moment.",
    };
  }
}
