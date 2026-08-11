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
import {
  MessageDirection,
  Prisma,
  Channel,
  OrderStatus,
  PaymentStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WhatsappService } from "../whatsapp/whatsapp.service";
import { WhatsappSignatureGuard } from "./signature.guard";
import { getDeliveryWindow } from "./delivery.util";
import { AiService, AiChatResult } from "./ai.service";
import { ConversationService } from "./conversation.service";
import { EmailService } from "../email/email.service";
import { PaystackService } from "../paystack/paystack.service";
import { parseBudgetNaira, applyBudgetHintsFromMessage, extractBudgetItemsFromMessage } from "./budget.util";
import { randomBytes } from "crypto";

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

function looksLikeCartRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?.!]/g, "");
  if (/^(my\s+)?(cart|order|orders|list)$/.test(t)) return true;
  if (/^(show|see|view|wetin|what's|whats)\b/.test(t) && /\b(cart|order|orders|list)\b/.test(t)) {
    return true;
  }
  return (
    /\b(cart|list|orders?)\b/.test(t) &&
    /\b(see|show|view|wetin|what's|whats|my)\b/.test(t)
  );
}

/** First message already contains a shopping request — don't bury it under welcome. */
function looksLikeOrderIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    /\b(buy|wan\b|want|order|need|get me|add)\b/.test(t) ||
    /\b(\d+\s*k\b|\d+\s*thousand|naira|₦|\bkg\b|\bbag\b)\b/.test(t)
  );
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
    private readonly paystack: PaystackService,
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

    // Human handoff: if an admin has taken over this customer, still store
    // the inbound message but skip bot/AI auto-replies.
    const handoff = await this.prisma.conversations.findUnique({
      where: { customer_id: customer.id },
      select: { mode: true, assigned_admin_id: true },
    });
    if (handoff?.mode === "human") {
      this.logger.log(
        `Handoff active for ${whatsappNumber} (admin=${handoff.assigned_admin_id ?? "unassigned"}) — skipping bot reply`,
      );
      return;
    }

    // WhatsApp Cloud API delivers voice notes as type "audio" with only a
    // media id — no transcription, so there's no text for the AI to work
    // with. Without this, it silently fell through to the generic welcome
    // fallback, which looks like the bot ignored them. Catching audio
    // messages generally (not just flagged voice notes) since a plain
    // audio file attachment can't be processed either.
    if (msg.type === "audio") {
      await this.sendAndLog(
        customer.id,
        conversation.id,
        whatsappNumber,
        `Sorry oh, I can't listen to voice notes yet 🎙️ — just type your message and we go run am sharp-sharp! Reply *MENU* for options.`,
      );
      return;
    }

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

      // Cart/list questions must read the real draft — never let the model invent items
      if (!isDeterministicConfirm && looksLikeCartRequest(bodyText)) {
        if (existingDraft.items.length === 0) {
          await this.sendAndLog(
            customer.id,
            conversation.id,
            whatsappNumber,
            `Your cart empty for now 🛒 — just drop the items you want make we start packing am.`,
          );
          return;
        }
        let cartSummary = `Your current order:\n\n`;
        existingDraft.items.forEach((item) => {
          cartSummary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
        });
        cartSummary += existingDraft.deliveryAddress
          ? `\n📍 Delivery to: ${existingDraft.deliveryAddress}`
          : `\n⚠️ Still need your delivery address.`;
        cartSummary += `\n\nAdd/remove items anytime, or say *"that's all"* when you're ready.`;
        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, cartSummary);
        return;
      }

      const aiResult: AiChatResult | null = isDeterministicConfirm
        ? { type: "confirm_order" }
        : await this.ai.chat(bodyText, formattedHistory, customer.contextSummary ?? null);

      // If the model failed / leaked tools, still parse Nigerian "item 2k" budgets
      const resolved = this.resolveDraftFromAiOrMessage(bodyText, aiResult);

      if (resolved?.type === "draft_update") {
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversation.id,
          resolved.items,
          resolved.deliveryAddress,
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

      if (resolved?.type === "confirm_order") {
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

        if (!draft.deliveryAddress) {
          await this.sendAndLog(
            customer.id,
            conversation.id,
            whatsappNumber,
            `Almost there! 📍 I still need your delivery address before I fit place this order — just drop it and say *"that's all"* again to confirm.`,
          );
          return;
        }

        const pricedItems = await this.priceDraftItems(draft.items);
        const totalNaira = pricedItems.reduce(
          (sum, item) => sum + item.lineTotal,
          0,
        );
        const allPriced = pricedItems.every((item) => item.unitPrice > 0);
        const paystackRef = `oja_${randomBytes(8).toString("hex")}`;

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
              paymentStatus: PaymentStatus.unpaid,
              total: new Prisma.Decimal(totalNaira.toFixed(2)),
              customerNotes: draft.deliveryAddress,
              paystackReference: paystackRef,
            },
          });

          for (const item of pricedItems) {
            await tx.orderItem.create({
              data: {
                orderId: order.id,
                productId: item.productId,
                productNameSnapshot: item.name,
                unitSnapshot: item.unit,
                unitPriceSnapshot: new Prisma.Decimal(item.unitPrice.toFixed(2)),
                quantity: new Prisma.Decimal(item.quantity),
              },
            });
          }

          return order;
        });

        await this.conversations.clearDraft(conversation.id);
        await this.conversations.closeSession(conversation.id);

        // Fire-and-forget — don't make the customer wait on this. Without
        // it, there's a real memory gap of up to 15 minutes (until the
        // cron's next pass) where the bot has no idea this order was just
        // placed if the customer says anything else right away.
        this.conversations
          .summarizeSession(conversation.id)
          .catch((err) => this.logger.error(`Immediate summarization failed for session ${conversation.id}`, err));

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

        const { window, day } = getDeliveryWindow();
        let customerInvoiceReceipt = `E don set! 🔥 I have compiled your OjaRun market order list:\n\n`;
        pricedItems.forEach((item) => {
          const priceBit =
            item.unitPrice > 0
              ? ` — ₦${(item.lineTotal).toLocaleString("en-NG")}`
              : "";
          customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit}${priceBit}\n`;
        });
        customerInvoiceReceipt += `\n📍 *Delivery to:* ${draft.deliveryAddress}`;
        customerInvoiceReceipt += `\n🚴 *Delivery Schedule:* ${window} ${day}`;

        // Charge when every line has a price (catalog match OR customer budget
        // like "fish 2 thousand" → ₦2000). Otherwise keep the pricing-wait copy.
        if (allPriced && totalNaira >= 1) {
          customerInvoiceReceipt += `\n\n💰 *Subtotal:* ₦${totalNaira.toLocaleString("en-NG")}`;

          if (!this.paystack.isConfigured()) {
            this.logger.warn(
              `Order ${createdOrder.id} priced (₦${totalNaira}) but Paystack keys are missing`,
            );
            customerInvoiceReceipt += `\n\nOrder received — payment link go follow sharp-sharp. 🙏`;
          } else {
            const webAppUrl = this.config.get<string>("webAppUrl") || "";
            const callbackUrl = webAppUrl
              ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
              : undefined;
            const payEmail = `${whatsappNumber.replace(/\D/g, "")}@whatsapp.ojarun.ng`;

            const payment = await this.paystack.initializeTransaction({
              email: payEmail,
              amountNaira: totalNaira,
              reference: paystackRef,
              callbackUrl,
              metadata: {
                orderId: createdOrder.id,
                channel: "whatsapp",
                customerId: customer.id,
              },
            });

            if (payment.ok && payment.authorizationUrl) {
              await this.prisma.order.update({
                where: { id: createdOrder.id },
                data: {
                  status: OrderStatus.awaiting_payment,
                  paymentStatus: PaymentStatus.pending,
                  paymentUrl: payment.authorizationUrl,
                },
              });

              customerInvoiceReceipt += `\n\nTap *Pay now* to complete checkout. Once payment clears, our market shoppers start shopping. 🙏`;

              await this.sendPaymentAndLog(
                customer.id,
                conversation.id,
                whatsappNumber,
                customerInvoiceReceipt,
                payment.authorizationUrl,
              );
              return;
            }

            this.logger.error(
              `Paystack init failed for order ${createdOrder.id}: ${payment.error}`,
            );
            customerInvoiceReceipt += `\n\nPayment link no gree open just now — our team go send am sharp-sharp. 🙏`;
          }
        } else {
          customerInvoiceReceipt += `\n\nOur market shoppers are handling it. We will send over your subtotal breakdown once pricing finishes! 🙏`;
        }

        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, customerInvoiceReceipt);
        return;
      }

      if (resolved?.type === "text") {
        // Never forward hallucinated tool syntax to WhatsApp
        if (
          /<function[=/(]|update_order_items\s*\)?\s*\(?\s*\{|confirm_order\s*\(/i.test(
            resolved.content,
          )
        ) {
          this.logger.warn(
            `Suppressed outbound tool-syntax leak: ${resolved.content.slice(0, 160)}`,
          );
          return;
        }
        await this.sendAndLog(customer.id, conversation.id, whatsappNumber, resolved.content);
        return;
      }
      // resolved === null means the provider call failed — fall through to
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
   * Prefer structured AI draft updates, but always correct Nigerian "2k" money
   * shorthand and fall back to deterministic parsing when the model fails.
   */
  private resolveDraftFromAiOrMessage(
    bodyText: string,
    aiResult: AiChatResult | null,
  ): AiChatResult | null {
    const fromMessage = extractBudgetItemsFromMessage(bodyText);

    if (aiResult?.type === "draft_update") {
      const corrected = applyBudgetHintsFromMessage(bodyText, aiResult.items);
      const byName = new Map(
        corrected.map((item) => [item.name.toLowerCase(), item]),
      );
      for (const hint of fromMessage) {
        if (!byName.has(hint.name.toLowerCase())) {
          byName.set(hint.name.toLowerCase(), hint);
        }
      }
      return {
        type: "draft_update",
        items: [...byName.values()],
        deliveryAddress: aiResult.deliveryAddress,
      };
    }

    if (aiResult?.type === "confirm_order") {
      return aiResult;
    }

    // Model returned junk / sorry / null — still try money-shorthand parse
    if (fromMessage.length > 0) {
      this.logger.warn(
        `AI miss on "${bodyText.slice(0, 80)}" — recovered ${fromMessage.length} budget item(s) from message`,
      );
      return {
        type: "draft_update",
        items: fromMessage,
        deliveryAddress: null,
      };
    }

    return aiResult;
  }

  /**
   * Price draft lines from catalog OR customer budget wording
   * (e.g. unit "N2000 worth" / "fish 2 thousand").
   */
  private async priceDraftItems(
    items: { name: string; quantity: number; unit: string }[],
  ): Promise<
    {
      name: string;
      quantity: number;
      unit: string;
      productId: string | null;
      unitPrice: number;
      lineTotal: number;
    }[]
  > {
    const products = await this.prisma.product.findMany({
      where: { isAvailable: true },
      select: { id: true, name: true, unit: true, currentPrice: true },
    });
    const byName = new Map(
      products.map((p) => [p.name.trim().toLowerCase(), p]),
    );

    return items.map((item) => {
      const match = byName.get(item.name.trim().toLowerCase());
      const quantity = Number(item.quantity) || 0;
      const budget = parseBudgetNaira(item.unit, item.name);

      // Budget orders ("₦2k worth of fish") — the stated money IS the line total
      if (budget != null) {
        return {
          name: item.name,
          quantity: quantity > 0 ? quantity : 1,
          unit: item.unit,
          productId: match?.id ?? null,
          unitPrice: budget,
          lineTotal: budget,
        };
      }

      const unitPrice = match ? Number(match.currentPrice) : 0;
      return {
        name: item.name,
        quantity,
        unit: match?.unit || item.unit,
        productId: match?.id ?? null,
        unitPrice,
        lineTotal: unitPrice * quantity,
      };
    });
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

  private async sendPaymentAndLog(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    body: string,
    paymentUrl: string,
  ): Promise<void> {
    try {
      const sentPayload = await this.whatsapp.sendPaymentLink(
        whatsappNumber,
        body,
        paymentUrl,
        "Pay now",
      );
      await this.prisma.message.create({
        data: {
          customerId,
          sessionId: conversationId,
          whatsappMessageId: sentPayload.wamid!,
          direction: MessageDirection.outbound,
          body: `${body}\n\n${paymentUrl}`,
          raw: { sentPayload, paymentUrl } as Prisma.InputJsonValue,
        },
      });
      await this.conversations.touch(conversationId);
    } catch (error) {
      this.logger.error(
        `Failed to send/log payment link to ${whatsappNumber}`,
        error as Error,
      );
    }
  }

  private resolveReplyKey(body: string | null, isNewCustomer: boolean): string {
    // New customer who already dropped a shopping list → skip static welcome
    if (isNewCustomer) {
      if (body && looksLikeOrderIntent(body)) return "default";
      return "welcome";
    }
    const text = (body ?? "").trim().toUpperCase();

    if (text === "MENU" || text.includes("WETIN DEY")) return "menu";
    if (text === "ORDER" || text === "I WANT TO BUY" || text === "I WAN BUY") return "order_prompt";
    if (text === "HELP") return "help";
    if (text.includes("LOCATION") || text.includes("IBADAN")) return "location";
    if (text.includes("PRICE") || text.includes("HOW MUCH") || text.includes("₦")) return "pricing";

    return "default";
  }
}