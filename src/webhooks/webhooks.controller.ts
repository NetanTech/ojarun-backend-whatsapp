import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MessageDirection, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { WhatsappSignatureGuard } from "./signature.guard";
import { getDeliveryWindow } from "./delivery.util";
import { AiService } from "./ai.service";

@Controller("webhooks/whatsapp")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly ai: AiService,
  ) {}

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    const expected = this.config.get<string>("whatsapp.verifyToken");
    if (mode === "subscribe" && token === expected) {
      this.logger.log("Webhook verified");
      return challenge;
    }
    this.logger.warn("Webhook verification FAILED — token mismatch");
    return "";
  }

  @Post()
  @HttpCode(200)
  @UseGuards(WhatsappSignatureGuard)
  async receive(@Body() body: any): Promise<{ ok: true }> {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;
        for (const msg of value.messages ?? []) {
          await this.handleInboundMessage(msg, value.contacts ?? []);
        }
      }
    }
    return { ok: true };
  }

  private async handleInboundMessage(
    msg: any,
    contacts: Array<{ wa_id: string; profile?: { name?: string } }>,
  ): Promise<void> {
    const wamid: string = msg.id;
    const from: string = msg.from;

    // 1. Idempotency
    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: wamid },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate wamid=${wamid}`);
      return;
    }

    // 2. Find or create customer
    const whatsappNumber = from.startsWith("+") ? from : `+${from}`;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;

    const existingCustomer = await this.prisma.customer.findUnique({
      where: { whatsappNumber },
    });
    const isNewCustomer = !existingCustomer;

    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber },
      create: { whatsappNumber, name: profileName ?? null },
      update: profileName ? { name: profileName } : {},
    });

    // 3. Extract text body
    const body = msg.type === "text" ? (msg.text?.body ?? null) : null;

    // 4. Persist inbound message
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: wamid,
        direction: MessageDirection.inbound,
        body,
        raw: msg as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Inbound from ${whatsappNumber} (${customer.name ?? "unknown"}): ${body ?? `[${msg.type}]`}`,
    );

    // 5. Resolve reply key
    const replyKey = this.resolveReplyKey(body, isNewCustomer);

    // 6. Track pending orders
    if (replyKey === "order_prompt") {
      await this.prisma.pendingOrder.upsert({
        where: { phone: whatsappNumber },
        create: { phone: whatsappNumber, completed: false },
        update: { startedAt: new Date(), completed: false, remindedAt: null },
      });
    }

    // 7. Detect order details sent by customer (e.g. "2kg tomatoes, Bodija")
    const looksLikeOrderDetails =
      replyKey === "default" &&
      body !== null &&
      (/\d/.test(body) ||
        /kg|carton|piece|pack|litre|dozen|deliver|address/i.test(body));

    if (looksLikeOrderDetails) {
      await this.prisma.pendingOrder.updateMany({
        where: { phone: whatsappNumber, completed: false },
        data: { completed: true },
      });

      const { window, day } = getDeliveryWindow();
      const confirmMsg =
        `✅ Got your order! We're on it.\n\n` +
        `🚴 Delivery window: *${window} ${day}*\n\n` +
        `We'll confirm your total and availability in a few minutes. 🙏`;

      const sent = await this.whatsapp.sendText(whatsappNumber, confirmMsg);
      await this.prisma.message.create({
        data: {
          customerId: customer.id,
          whatsappMessageId: sent.wamid,
          direction: MessageDirection.outbound,
          body: confirmMsg,
          raw: { sent } as Prisma.InputJsonValue,
        },
      });
      return;
    }

    // 7b. AI handles all default messages with conversation history
    if (replyKey === "default" && body) {
      // Fetch last 10 messages for context
      const recentMessages = await this.prisma.message.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      // Build history oldest-first, excluding the message we just saved
      const history = recentMessages
        .reverse()
        .slice(0, -1)
        .filter((m) => m.body)
        .map((m) => ({
          role: (m.direction === MessageDirection.inbound
            ? "user"
            : "assistant") as "user" | "assistant",
          content: m.body!,
        }));

      const aiReply = await this.ai.chat(body, history);
      if (aiReply) {
        this.logger.log(`AI reply for: "${body.slice(0, 40)}"`);
        const sent = await this.whatsapp.sendText(whatsappNumber, aiReply);
        await this.prisma.message.create({
          data: {
            customerId: customer.id,
            whatsappMessageId: sent.wamid,
            direction: MessageDirection.outbound,
            body: aiReply,
            raw: { sent } as Prisma.InputJsonValue,
          },
        });
        return;
      }
    }

    // 8. Fetch and send bot response
    const botResponse = await this.prisma.botResponse.findUnique({
      where: { key: replyKey },
    });

    let replyBody =
      botResponse?.body ??
      `Hi! 👋 Thanks for reaching out to OjaRun. We've received your message and will get back to you shortly.`;

    if (customer.name) {
      replyBody = replyBody.replace(/\{\{name\}\}/g, customer.name);
    } else {
      replyBody = replyBody.replace(/,?\s*\{\{name\}\}/g, "");
    }

    if (replyKey === "order_prompt") {
      const { window, day } = getDeliveryWindow();
      replyBody += `\n\n📦 Based on the time now, your delivery will arrive *${window} ${day}*.`;
    }

    this.logger.log(`Bot reply key="${replyKey}" → ${replyBody.slice(0, 60)}…`);

    const sent = await this.whatsapp.sendText(whatsappNumber, replyBody);

    // 9. Log outbound message
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: sent.wamid,
        direction: MessageDirection.outbound,
        body: replyBody,
        raw: { sent } as Prisma.InputJsonValue,
      },
    });
  }

private resolveReplyKey(body: string | null, isNewCustomer: boolean): string {
  if (isNewCustomer) return 'welcome';

  const text = (body ?? '').trim().toUpperCase();

  // MENU
  if (
    text === 'MENU' ||
    text === 'SEE MENU' ||
    text === 'VIEW MENU' ||
    text === 'SHOW MENU' ||
    text.includes('WHAT DO YOU HAVE') ||
    text.includes('WHAT DO YOU SELL') ||
    text.includes('WHAT CAN I BUY') ||
    text.includes('WHAT DO YOU CARRY') ||
    text.includes('SHOW ME YOUR ITEMS') ||
    text.includes('AVAILABLE ITEMS') ||
    text.includes('LIST OF ITEMS') ||
    text.includes('WHAT IS AVAILABLE') ||
    text.includes('WETIN YOU GET') ||
    text.includes('WETIN DEY') ||
    text.includes('WETIN YOU SELL') ||
    text.includes('SHOW ME WETIN') ||
    text.includes('WHAT YOU GOT')
  ) return 'menu';

  // ORDER
  if (
    text === 'ORDER' ||
    text === 'PLACE ORDER' ||
    text === 'NEW ORDER' ||
    text === 'BUY' ||
    text.startsWith('I WANT TO ORDER') ||
    text.startsWith('I WANT TO BUY') ||
    text.startsWith('I NEED TO ORDER') ||
    text.startsWith('I NEED TO BUY') ||
    text.startsWith('LET ME ORDER') ||
    text.startsWith('I WOULD LIKE TO ORDER') ||
    text.startsWith('I WOULD LIKE TO BUY') ||
    text.startsWith('I WAN BUY') ||
    text.startsWith('I WAN ORDER') ||
    text.startsWith('ABEG I WAN') ||
    text.startsWith('MAKE I ORDER') ||
    text.includes('PLACE AN ORDER') ||
    text.includes('MAKE AN ORDER') ||
    text.includes('I WAN MAKE ORDER') ||
    text.includes('HELP ME ORDER')
  ) return 'order_prompt';

  // HELP
  if (
    text === 'HELP' ||
    text === 'SUPPORT' ||
    text === 'ASSIST' ||
    text === 'ASSISTANCE' ||
    text.includes('NEED HELP') ||
    text.includes('NEED SUPPORT') ||
    text.includes('WHAT CAN YOU DO') ||
    text.includes('HOW DOES THIS WORK') ||
    text.includes('HOW DO I USE') ||
    text.includes('WHAT ARE MY OPTIONS') ||
    text.includes('HOW THIS WORK') ||
    text.includes('EXPLAIN HOW')
  ) return 'help';

  // HOURS
  if (
    text.includes('HOUR') ||
    text.includes('OPEN') ||
    text.includes('CLOSE') ||
    text.includes('CLOSING') ||
    text.includes('WORKING HOURS') ||
    text.includes('BUSINESS HOURS') ||
    text.includes('WHAT TIME') ||
    text.includes('WHEN DO YOU') ||
    text.includes('ARE YOU OPEN') ||
    text.includes('STILL OPEN') ||
    text.includes('YOU DEY WORK') ||
    text.includes('YOU STILL DEY') ||
    text.includes('WHEN YOU DEY OPEN')
  ) return 'hours';

  // LOCATION
  if (
    text.includes('LOCATION') ||
    text.includes('ADDRESS') ||
    text.includes('WHERE ARE YOU') ||
    text.includes('WHERE DO YOU') ||
    text.includes('WHERE IS') ||
    text.includes('DO YOU DELIVER TO') ||
    text.includes('DELIVERY AREA') ||
    text.includes('DO YOU COVER') ||
    text.includes('IBADAN') ||
    text.includes('WHICH AREA') ||
    text.includes('WHERE YOU DEY') ||
    text.includes('YOU DEY DELIVER') ||
    text.includes('YOU REACH') ||
    text.includes('YOU COVER')
  ) return 'location';

  // PRICING
  if (
    text.includes('PRICE') ||
    text.includes('COST') ||
    text.includes('HOW MUCH') ||
    text.includes('PRICING') ||
    text.includes('EXPENSIVE') ||
    text.includes('CHEAP') ||
    text.includes('RATE') ||
    text.includes('FEE') ||
    text.includes('CHARGE') ||
    text.includes('NAIRA') ||
    text.includes('NGN') ||
    text.includes('₦') ||
    text.includes('E COST HOW MUCH') ||
    text.includes('HOW E DEY GO') ||
    text.includes('WETIN BE THE PRICE') ||
    text.includes('HOW MUCH E BE')
  ) return 'pricing';

  // TRACK ORDER
  if (
    text === 'TRACK' ||
    text.includes('TRACK MY ORDER') ||
    text.includes('MY ORDER') ||
    text.includes('DELIVERY STATUS') ||
    text.includes('WHERE IS MY') ||
    text.includes('HAS MY ORDER') ||
    text.includes('ORDER STATUS') ||
    text.includes('WHEN WILL MY') ||
    text.includes('UPDATE ON MY ORDER') ||
    text.includes('WHERE MY ORDER') ||
    text.includes('MY ORDER DON REACH') ||
    text.includes('WHEN MY ORDER') ||
    text.includes('HOW FAR MY ORDER')
  ) return 'track_order';

  // GREETING
  if (
    text === 'HI' ||
    text === 'HELLO' ||
    text === 'HEY' ||
    text === 'HI THERE' ||
    text === 'HELLO THERE' ||
    text === 'GOOD MORNING' ||
    text === 'GOOD AFTERNOON' ||
    text === 'GOOD EVENING' ||
    text === 'GOOD DAY' ||
    text === 'HOWDY' ||
    text === 'WASSUP' ||
    text === 'WHATS UP' ||
    text === "WHAT'S UP" ||
    text === 'SUP' ||
    text === 'YO' ||
    text === 'HOW FAR' ||
    text === 'HOW BODY' ||
    text === 'HOW NA' ||
    text === 'OGA' ||
    text === 'BOSS' ||
    text === 'E KAARO' ||
    text === 'E KAASAN' ||
    text === 'E KAALE' ||
    text === 'BAWO NI' ||
    text === 'SANNU' ||
    text === 'NNOO'
  ) return 'greeting';

  return 'default';
}
}
