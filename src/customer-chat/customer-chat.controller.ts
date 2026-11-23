import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { MessageDirection } from '@prisma/client';
import { AiService, AiChatResult } from '../webhooks/ai.service';
import { SendChatMessageDto, SubmitChatListDto } from './dto/customer-chat.dto';
import { ProductsService } from '../products/products.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerJwtAuthGuard } from '../customer-auth/customer-jwt-auth.guard';
import {
  CurrentCustomer,
  AuthCustomer,
} from '../customer-auth/current-customer.decorator';

const MAX_HISTORY_MESSAGES = 20;
const NEWLINE = String.fromCharCode(10);

@Controller('customer-chat')
@UseGuards(ThrottlerGuard)
export class CustomerChatController {
  constructor(
    private readonly ai: AiService,
    private readonly products: ProductsService,
    private readonly prisma: PrismaService,
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

  /**
   * Order-only website chat: the customer's typed list goes straight into the
   * admin Messages inbox under their name and WhatsApp number, where an admin
   * picks it up. No AI involved, so the reply is always the same.
   */
  @Post('list')
  @HttpCode(201)
  @UseGuards(CustomerJwtAuthGuard)
  async submitList(
    @Body() dto: SubmitChatListDto,
    @CurrentCustomer() customer: AuthCustomer,
  ) {
    const entries = dto.entries.map((e) => e.trim()).filter(Boolean);
    if (entries.length === 0) {
      throw new BadRequestException('Type what you want to buy first.');
    }
    const body = [
      '🛒 Shopping list from the website chat:',
      ...entries.map((e) => e.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(NEWLINE)),
    ].join(NEWLINE);

    const message = await this.prisma.message.create({
      data: {
        customerId: customer.id,
        direction: MessageDirection.inbound,
        body,
        raw: { source: 'web-chat', entries },
      },
      select: { id: true, createdAt: true },
    });

    return {
      id: message.id,
      receivedAt: message.createdAt,
      message:
        'Order received! An Ojarun admin will take up your order shortly on WhatsApp.',
    };
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
