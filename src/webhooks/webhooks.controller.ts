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
import { MessageDirection, Prisma, Channel, OrderStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { WhatsappSignatureGuard } from "./signature.guard";
import { getDeliveryWindow } from "./delivery.util";
import { AiService } from "./ai.service";
import { ConversationService } from "./conversation.service";

@Controller("webhooks/whatsapp")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly ai: AiService,
    private readonly conversations: ConversationService,
  ) {}

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
  ): string {
    const expected = this.config.get<string>("whatsapp.verifyToken");
    if (mode === "subscribe" && token === expected) {
      this.logger.log("Webhook verified successfully");
      return challenge;
    }
    this.logger.warn("Webhook verification failed: token mismatch");
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
          try {
            await this.handleInboundMessage(msg, value.contacts ?? []);
          } catch (error) {
            // One bad message shouldn't take the rest of this batch down —
            // log it and keep going instead of throwing to Meta (which just
            // triggers a retry that re-hits the same failure).
            this.logger.error(`Failed to process inbound message wamid=${msg?.id}`, error as Error);
          }
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

    // 1. Idempotency check
    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: wamid },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate message wamid=${wamid}`);
      return;
    }

    // 2. Resolve phone format + upsert Customer. New-vs-returning has to be
    // determined BEFORE the upsert — upsert always returns a row with
    // createdAt populated, so checking it afterward never detects "new".
    const whatsappNumber = from.startsWith("+") ? from : `+${from}`;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;

    const existingCustomer = await this.prisma.customer.findUnique({ where: { whatsappNumber } });
    const isNewCustomer = !existingCustomer;

    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber },
      create: { whatsappNumber, name: profileName ?? null },
      update: profileName ? { name: profileName } : {},
    });

    // 3. Resolve (or open) this customer's active conversation session.
    const conversation = await this.conversations.getOrCreateActive(customer.id);
    const bodyText = msg.type === "text" ? (msg.text?.body ?? null) : null;

    // 4. Fetch conversation-scoped history BEFORE saving the current
    // message — avoids the old skip-the-first-row guesswork, and scopes
    // context to this session rather than the customer's entire lifetime.
    const threadHistory = bodyText
      ? await this.prisma.message.findMany({
          where: { sessionId: conversation.id, body: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 12,
        })
      : [];

    const formattedHistory = threadHistory
      .reverse()
      .map((m) => ({
        role: (m.direction === MessageDirection.inbound ? "user" : "assistant") as "user" | "assistant",
        content: m.body!,
      }));

    // 5. Save incoming message to the timeline, scoped to this conversation.
    try {
      await this.prisma.message.create({
        data: {
          customerId: customer.id,
          sessionId: conversation.id,
          whatsappMessageId: wamid,
          direction: MessageDirection.inbound,
          body: bodyText,
          raw: msg as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        this.logger.debug(`Caught race-condition duplicate via unique constraint: wamid=${wamid}`);
        return;
      }
      throw error;
    }

    await this.conversations.touch(conversation.id);

    this.logger.log(`Inbound [${whatsappNumber}]: ${bodyText ?? `[${msg.type}]`}`);

    // 6. Fallback static keyword router
    const replyKey = this.resolveReplyKey(bodyText, isNewCustomer);

    if (replyKey === "order_prompt") {
      await this.prisma.pendingOrder.upsert({
        where: { phone: whatsappNumber },
        create: { phone: whatsappNumber, completed: false },
        update: { startedAt: new Date(), completed: false, remindedAt: null },
      });
    }

    // 7. Dynamic AI conversation routing, now with cross-conversation
    // customer context (contextSummary) baked into the system prompt.
    if (replyKey === "default" && bodyText) {
      const aiResult = await this.ai.chat(bodyText, formattedHistory, customer.contextSummary ?? null);

      if (aiResult?.type === "order") {
        await this.prisma.$transaction(async (tx) => {
          await tx.pendingOrder.updateMany({
            where: { phone: whatsappNumber, completed: false },
            data: { completed: true },
          });

          const createdOrder = await tx.order.create({
            data: {
              customerId: customer.id,
              channel: Channel.whatsapp,
              status: OrderStatus.pending,
              total: new Prisma.Decimal(0.0),
              customerNotes: aiResult.deliveryAddress,
            },
          });

          for (const item of aiResult.items) {
            await tx.orderItem.create({
              data: {
                orderId: createdOrder.id,
                productId: null,
                productNameSnapshot: item.name,
                unitSnapshot: item.unit,
                unitPriceSnapshot: new Prisma.Decimal(0.0),
                quantity: new Prisma.Decimal(item.quantity),
              },
            });
          }
        });

        this.logger.log(`Order processed transactionally for ${whatsappNumber}`);

        let customerInvoiceReceipt = `E don set! 🔥 I have compiled your OjaRun market order list:\n\n`;
        aiResult.items.forEach((item) => {
          customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
        });

        if (aiResult.deliveryAddress) {
          customerInvoiceReceipt += `\n📍 *Delivery to:* ${aiResult.deliveryAddress}`;
        } else {
          customerInvoiceReceipt += `\n⚠️ We no get your delivery address yet — abeg reply with your address so we fit deliver am!`;
        }

        const { window, day } = getDeliveryWindow();
        customerInvoiceReceipt += `\n🚴 *Delivery Schedule:* ${window} ${day}\n\nOur market shoppers are handling it. We will send over your subtotal breakdown once pricing finishes! 🙏`;

        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, customerInvoiceReceipt);
        return;
      }

      if (aiResult?.type === "text") {
        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, aiResult.content);
        return;
      }
      // aiResult === null means the provider call failed — fall through to
      // the static fallback below instead of leaving the customer with nothing.
    }

    // 8. Static keyed fallback route
    const botResponse = await this.prisma.botResponse.findUnique({
      where: { key: replyKey },
    });

    let staticMessageBody =
      botResponse?.body ??
      `Aba! 👋 Welcome to OjaRun market service. Drop your list here make we run your market errands for Ibadan sharp-sharp!`;

    staticMessageBody = customer.name
      ? staticMessageBody.replace(/\{\{name\}\}/g, customer.name)
      : staticMessageBody.replace(/,?\s*\{\{name\}\}/g, "");

    if (replyKey === "order_prompt") {
      const { window, day } = getDeliveryWindow();
      staticMessageBody += `\n\n📦 Delivery window for orders now is *${window} ${day}*.`;
    }

    await this.sendAndLog(customer.id, conversation.id, whatsappNumber, staticMessageBody);
  }

  /**
   * Sends an outbound WhatsApp message and logs it, isolated in its own
   * try/catch. Previously a failed send here (after an order was already
   * committed in the DB) would throw uncaught — the order would exist but
   * the customer would never be told, with no automatic recovery.
   */
  private async sendAndLog(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    body: string,
  ): Promise<void> {
    try {
      const sentPayload = await this.whatsapp.sendText(whatsappNumber, body);
      await this.prisma.message.create({
        data: {
          customerId,
          sessionId: conversationId,
          whatsappMessageId: sentPayload.wamid!,
          direction: MessageDirection.outbound,
          body,
          raw: { sentPayload } as Prisma.InputJsonValue,
        },
      });
      await this.conversations.touch(conversationId);
    } catch (error) {
      this.logger.error(`Failed to send/log outbound message to ${whatsappNumber}`, error as Error);
      // TODO: wire this into an alert/retry queue. DB state (e.g. an
      // already-created order) is still correct even if the customer wasn't
      // notified — this just needs a delivery retry, not a data fix.
    }
  }

  private resolveReplyKey(body: string | null, isNewCustomer: boolean): string {
    if (isNewCustomer) return "welcome";
    const text = (body ?? "").trim().toUpperCase();

    if (text === "MENU" || text.includes("WETIN DEY")) return "menu";
    if (text === "ORDER" || text.startsWith("I WANT TO BUY") || text.startsWith("I WAN BUY")) return "order_prompt";
    if (text === "HELP") return "help";
    if (text.includes("LOCATION") || text.includes("IBADAN")) return "location";
    if (text.includes("PRICE") || text.includes("HOW MUCH") || text.includes("₦")) return "pricing";

    return "default";
  }
}