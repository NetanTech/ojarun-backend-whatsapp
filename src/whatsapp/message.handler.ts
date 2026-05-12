import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from './whatsapp.service';
import { ConversationService } from './conversation.service';
import { OrderService, ParsedItem } from '../orders/order.service';
import { ProductService } from '../products/product.service';

const MENU = `👋 Welcome to *Ojarun*!

We shop the market and deliver to you 🛍️

Reply with a number:
1️⃣ See today's prices
2️⃣ Place an order
3️⃣ Check order status
4️⃣ Talk to us`;

@Injectable()
export class MessageHandler {
  private readonly logger = new Logger(MessageHandler.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
    private conversation: ConversationService,
    private orders: OrderService,
    private products: ProductService,
  ) {}

  async handle(from: string, messageText: string, waMessageId: string) {
    const text = messageText.trim().toLowerCase();

    // 1. Idempotency — skip if already processed
    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: waMessageId },
    });
    if (existing) {
      this.logger.log(`Duplicate message ${waMessageId} — skipping`);
      return;
    }

    // 2. Get or create customer
    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber: from },
      update: {},
      create: { whatsappNumber: from },
    });

    // 3. Get conversation + state
    const convo = await this.conversation.getOrCreate(customer.id);
    const state = convo.state as any;

    // 4. Save inbound message
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: waMessageId,
        direction: 'inbound',
        body: messageText,
        raw: { from, text: messageText, waMessageId },
      },
    });

    // 5. If human mode, skip bot — let staff handle from admin panel
    if (convo.mode === 'human') {
      this.logger.log(`Conversation ${convo.id} is in human mode — skipping bot reply`);
      return;
    }

    // 6. Route based on conversation state
    let reply: string;

    if (state.step === 'awaiting_order_items') {
      reply = await this.handleOrderInput(text, customer.id, convo.id);
    } else if (state.step === 'awaiting_confirmation') {
      reply = await this.handleConfirmation(text, customer.id, convo.id, state);
    } else {
      reply = await this.handleMenu(text, convo.id);
    }

    // 7. Send reply
    const { wamid } = await this.whatsapp.sendText(from, reply);

    // 8. Save outbound message
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: wamid ?? `out_${Date.now()}`,
        direction: 'outbound',
        body: reply,
        raw: { to: from, body: reply },
      },
    });
  }

  // ─── Top-level menu ───────────────────────────────────────────────────────

  private async handleMenu(text: string, convoId: string): Promise<string> {
    if (['hi', 'hello', 'hey', 'start', 'hola', 'hy', 'yo'].includes(text)) {
      return MENU;
    }
    if (text === '1' || text.includes('price')) {
      return this.products.getPriceList();
    }
    if (text === '2' || text.includes('order')) {
      await this.conversation.setState(convoId, { step: 'awaiting_order_items' });
      return `🛒 What would you like to order?\n\nType each item like this:\n_Rice 1 bag, Tomatoes 2kg, Onions 1 paint_\n\nReply *0* to cancel.`;
    }
    if (text === '3' || text.includes('status')) {
      const convo = await this.prisma.conversation.findUnique({ where: { id: convoId } });
      return this.getOrderStatus(convo!.customerId);
    }
    if (text === '4' || text.includes('human') || text.includes('agent') || text.includes('talk')) {
      await this.conversation.setHumanMode(convoId);
      return `Got it! 👍 A team member will respond shortly.\n\nOur hours are *8am – 8pm* daily.`;
    }
    return `Sorry, I didn't get that 😅\n\n${MENU}`;
  }

  // ─── Order item collection ────────────────────────────────────────────────

  private async handleOrderInput(
    text: string,
    customerId: string,
    convoId: string,
  ): Promise<string> {
    if (text === '0' || text === 'cancel') {
      await this.conversation.setState(convoId, { step: 'idle' });
      return `No problem! Order cancelled.\n\n${MENU}`;
    }

    const parsed = this.parseOrderText(text);
    if (parsed.length === 0) {
      return `I couldn't read that order 😅\n\nPlease type like this:\n_Rice 1 bag, Tomatoes 2kg_\n\nOr reply *0* to cancel.`;
    }

    const priced: ParsedItem[] = [];
    const notFound: string[] = [];

    for (const item of parsed) {
      const product = await this.products.findByName(item.name);
      if (product) {
        priced.push({
          name: product.name,
          unit: product.unit,
          quantity: item.quantity,
          price: Number(product.currentPrice),
        });
      } else {
        notFound.push(item.name);
      }
    }

    if (notFound.length > 0) {
      return `Hmm, I couldn't find: *${notFound.join(', ')}*\n\nCheck the price list (reply *1*) for available items, or reply *0* to cancel.`;
    }

    const total = priced.reduce((sum, i) => sum + i.price * i.quantity, 0);

    let summary = `📋 *Your Order*\n\n`;
    for (const item of priced) {
      summary += `• ${item.name} x${item.quantity} ${item.unit} — ₦${(item.price * item.quantity).toLocaleString()}\n`;
    }
    summary += `\n*Total: ₦${total.toLocaleString()}*\n\n`;
    summary += `Reply *YES* to confirm or *CANCEL* to start over.`;

    await this.conversation.setState(convoId, {
      step: 'awaiting_confirmation',
      cart: priced,
    });

    return summary;
  }

  // ─── Order confirmation ───────────────────────────────────────────────────

  private async handleConfirmation(
    text: string,
    customerId: string,
    convoId: string,
    state: any,
  ): Promise<string> {
    if (text === 'cancel' || text === '0' || text === 'no') {
      await this.conversation.setState(convoId, { step: 'idle' });
      return `Order cancelled. No worries!\n\n${MENU}`;
    }

    if (text === 'yes' || text === 'y' || text === 'confirm') {
      const order = await this.orders.createFromWhatsapp(customerId, state.cart);
      await this.conversation.setState(convoId, { step: 'idle' });

      return (
        `✅ *Order Confirmed!*\n\n` +
        `Order ID: *${order.id.slice(0, 8).toUpperCase()}*\n` +
        `Total: ₦${Number(order.total).toLocaleString()}\n\n` +
        `We'll message you when your shopper is heading to the market 🛒\n\n` +
        `Questions? Reply *4* to talk to us.`
      );
    }

    return `Please reply *YES* to confirm or *CANCEL* to start over.`;
  }

  // ─── Order status ─────────────────────────────────────────────────────────

  private async getOrderStatus(customerId: string): Promise<string> {
    const recentOrders = await this.prisma.order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    if (recentOrders.length === 0) {
      return `You don't have any orders yet.\n\nReply *2* to place your first order! 🛒`;
    }

    const statusEmoji: Record<string, string> = {
      pending: '⏳',
      confirmed: '✅',
      shopping: '🛒',
      purchased: '📦',
      dispatched: '🚴',
      delivered: '🎉',
      cancelled: '❌',
    };

    let msg = `📦 *Your Recent Orders*\n\n`;
    for (const order of recentOrders) {
      const emoji = statusEmoji[order.status] ?? '📋';
      msg += `${emoji} *${order.id.slice(0, 8).toUpperCase()}* — ${order.status.toUpperCase()}\n`;
      msg += `   ₦${Number(order.total).toLocaleString()}\n\n`;
    }
    return msg.trim();
  }

  // ─── Parse "Rice 1 bag, Tomatoes 2kg" ────────────────────────────────────

  private parseOrderText(text: string): Array<{ name: string; quantity: number }> {
    const items: Array<{ name: string; quantity: number }> = [];
    const parts = text.split(/,|and/i);

    for (const part of parts) {
      const trimmed = part.trim();
      const match = trimmed.match(
        /^([a-zA-Z\s]+?)\s+(\d+(?:\.\d+)?)\s*\w*$|^(\d+(?:\.\d+)?)\s+\w*\s*([a-zA-Z\s]+)$/,
      );
      if (match) {
        const name = (match[1] || match[4] || '').trim();
        const quantity = parseFloat(match[2] || match[3]);
        if (name && quantity > 0) {
          items.push({ name, quantity });
        }
      }
    }
    return items;
  }
}