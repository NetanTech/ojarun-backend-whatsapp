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
import { AiService, AiChatResult } from "./ai.service";
import { ConversationService } from "./conversation.service";
import { EmailService } from "./email.service";

// Deterministic safety net: tool-calling isn't 100% reliable across every
// model, and this is the single highest-stakes moment in the flow (it's what
// actually creates the order). Rather than trust the model to pick
// confirm_order every time, catch the common exact confirmation phrases
// here first — same pattern the MENU/ORDER/HELP keyword routing already uses.
const CONFIRM_PHRASES = new Set([
  "THATS ALL",
  "THAT'S ALL",
  "THAT IS ALL",
  "THATS IT",
  "THAT'S IT",
  "CONFIRM",
  "CONFIRM ORDER",
  "PLACE ORDER",
  "PLACE THE ORDER",
  "GO AHEAD",
  "DONE",
  "COMPLETE ORDER",
  "FINISH ORDER",
  "YES CONFIRM",
  "OK CONFIRM",
  "YES PLEASE CONFIRM",
  "THAT WILL BE ALL",
]);

function normalizeForConfirmCheck(text: string): string {
  return text.trim().toUpperCase().replace(/[.,!?'’]/g, "");
}

@Controller("webhooks/whatsapp")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly ai: AiService,
    private readonly conversations: ConversationService,
    private readonly email: EmailService,
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
      // Check for an exact, unambiguous confirmation phrase first — only
      // treated as a confirmation when there's actually a non-empty draft
      // to confirm, so "done" or "that's it" said in some other context
      // doesn't accidentally trigger this.
      const existingDraft = await this.conversations.getDraft(conversation.id);
      const isDeterministicConfirm =
        CONFIRM_PHRASES.has(normalizeForConfirmCheck(bodyText)) && existingDraft.items.length > 0;

      const aiResult: AiChatResult | null = isDeterministicConfirm
        ? { type: "confirm_order" }
        : await this.ai.chat(bodyText, formattedHistory, customer.contextSummary ?? null);

      if (aiResult?.type === "draft_update") {
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversation.id,
          aiResult.items,
          aiResult.deliveryAddress,
        );

        let draftSummary = `Noted! Here's your list so far:\n\n`;
        items.forEach((item) => {
          draftSummary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
        });
        draftSummary += deliveryAddress
          ? `\n📍 Delivery to: ${deliveryAddress}`
          : `\n⚠️ Still need your delivery address — just drop it whenever you're ready.`;
        draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;

        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, draftSummary);
        return;
      }

      if (aiResult?.type === "confirm_order") {
        // The draft (not anything the model just said) is the source of
        // truth here — it was built up incrementally across every
        // update_order_items call, so it can't be missing earlier items.
        const draft = await this.conversations.getDraft(conversation.id);

        if (draft.items.length === 0) {
          await this.sendAndLog(
            customer.id,
            conversation.id,
            whatsappNumber,
            `You never tell me wetin you wan buy yet 🙏 — just drop your list and we go start!`,
          );
          return;
        }

        const createdOrder = await this.prisma.$transaction(async (tx) => {
          await tx.pendingOrder.updateMany({
            where: { phone: whatsappNumber, completed: false },
            data: { completed: true },
          });

          const order = await tx.order.create({
            data: {
              customerId: customer.id,
              channel: Channel.whatsapp,
              status: OrderStatus.pending,
              total: new Prisma.Decimal(0.0),
              customerNotes: draft.deliveryAddress,
            },
          });

          for (const item of draft.items) {
            await tx.orderItem.create({
              data: {
                orderId: order.id,
                productId: null,
                productNameSnapshot: item.name,
                unitSnapshot: item.unit,
                unitPriceSnapshot: new Prisma.Decimal(0.0),
                quantity: new Prisma.Decimal(item.quantity),
              },
            });
          }

          return order;
        });

        await this.conversations.clearDraft(conversation.id);

        this.logger.log(`Order processed transactionally for ${whatsappNumber}`);

        // Fire-and-forget — EmailService catches its own errors, so a broken
        // mail provider can never delay or block the customer's confirmation.
        void this.email.sendNewOrderNotification({
          orderId: createdOrder.id,
          customerName: customer.name,
          whatsappNumber,
          items: draft.items,
          deliveryAddress: draft.deliveryAddress,
          createdAt: createdOrder.createdAt,
        });

        let customerInvoiceReceipt = `E don set! 🔥 I have compiled your OjaRun market order list:\n\n`;
        draft.items.forEach((item) => {
          customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
        });

        if (draft.deliveryAddress) {
          customerInvoiceReceipt += `\n📍 *Delivery to:* ${draft.deliveryAddress}`;
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