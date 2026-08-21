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
import { AiService, AiChatResult, OrderDraftItem } from "./ai.service";
import { ConversationService } from "./conversation.service";
import { EmailService } from "../email/email.service";
import { PaystackService } from "../paystack/paystack.service";
import { AddressValidationService } from "./address-validation.service";
import { parseBudgetNaira, applyBudgetHintsFromMessage, extractBudgetItemsFromMessage } from "./budget.util";
import { matchCatalogProduct } from "./product-match.util";
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

// ===== Expanded market items list =====
const MARKET_ITEMS = [
  'beans', 'garri', 'pepper', 'titus', 'yam', 'plantain', 'corn',
  'rice', 'flour', 'sugar', 'salt', 'maggi', 'tomato', 'onion',
  'potato', 'kote', 'kot', 'irish potato', 'sweet potato',
  'fish', 'chicken', 'beef', 'goat', 'egg', 'milk', 'butter',
  'oil', 'groundnut', 'palm oil', 'vegetable oil', 'spaghetti',
  'noodles', 'indomie', 'crayfish', 'dry fish', 'stock fish',
  'okra', 'spinach', 'ugwu', 'waterleaf', 'cabbage', 'carrot',
  'garlic', 'ginger', 'thyme', 'curry', 'pepper soup', 'pomo',
  'shaki', 'roundabout', 'beef tripe', 'cow foot', 'goat head',
  'cocoyam', 'watermelon', 'pawpaw', 'pineapple', 'banana',
  'orange', 'apple', 'grape', 'mango', 'avocado', 'coconut'
];

/** First message already contains a shopping request — don't bury it under welcome. */
function looksLikeOrderIntent(text: string): boolean {
  if (!text) return false;
  
  // ===== FIX: Combine multi-line text with proper typing =====
  const t: string = text.trim().toLowerCase().replace(/\n/g, ' ');
  
  // Check if any market item is mentioned
  const hasMarketItem = MARKET_ITEMS.some((item: string) => t.includes(item));
  if (hasMarketItem) return true;
  
  // Check for numbers with items (e.g., "2kg rice", "3 tubers yam")
  const hasNumberWithItem: boolean = /\b(\d+)\s*(?:kg|kilo|bag|bottle|pack|cups?|pieces?|tuber|tubers|congo|tray|trays)\s+\w+/i.test(t);
  if (hasNumberWithItem) return true;
  
  // Check for money amounts with items (e.g., "rice 2000", "fish 5k")
  const hasMoneyWithItem: boolean = /\b(\w+)\s+\d+[k]?\b/.test(t) || /\b\d+[k]?\s+\w+\b/.test(t);
  if (hasMoneyWithItem) return true;
  
  // Check for "I want" patterns without specific items
  if (/\b(wan|want|buy|get|order|need|i want|i wan|i need|get me|add|bring|send)\b/.test(t)) {
    if (t.length > 5) return true;
  }
  
  // Original checks
  return (
    /\b(buy|wan\b|want|order|need|get me|add|bring|send)\b/.test(t) ||
    /\b(\d+\s*k\b|\d+\s*thousand|naira|₦|\bkg\b|\bbag\b|\bkilo\b|\bkilos\b)\b/.test(t)
  );
}

function looksLikePayNowRequest(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[?.!]/g, "");
  return (
    /^pay\s*now$/.test(t) ||
    /^make\s*payment$/.test(t) ||
    /^payment\s*link$/.test(t) ||
    /^send\s*(me\s*)?(the\s*)?pay(ment)?\s*link$/.test(t) ||
    /^how\s*(do\s*i\s*)?pay$/.test(t)
  );
}

function looksLikeSameAddressRequest(text: string): boolean {
  return /\bsame\s+(address|location|place|delivery)\b/i.test(text);
}

// ===== Check if message looks like an address =====
function looksLikeAddress(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 5) return false;
  
  const addressIndicators = [
    'ibadan', 'ui', 'gate', 'road', 'street', 'avenue', 
    'close', 'crescent', 'drive', 'lane', 'way', 'boulevard',
    'estate', 'village', 'town', 'area', 'junction', 'roundabout',
    'behind', 'beside', 'near', 'opposite', 'along',
    'house', 'flat', 'apartment', 'block', 'plot'
  ];
  
  const hasIndicator = addressIndicators.some(indicator => t.includes(indicator));
  if (hasIndicator) return true;
  
  if (/\d+\s+(road|street|avenue|close|drive|lane)/i.test(t)) return true;
  
  const ibadanAreas = [
    'bodija', 'soka', 'agodi', 'alaafin', 'apata', 'challenge',
    'eleyele', 'gbagi', 'jericho', 'mokola', 'monatan', 'ojo',
    'sabo', 'tanki', 'uch', 'ui', 'university of ibadan',
    'oyoroad', 'ringroad', 'dugbe', 'oke ado', 'oke aro'
  ];
  
  return ibadanAreas.some(area => t.includes(area));
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
    private readonly addressValidation: AddressValidationService,
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

  const existing = await this.prisma.message.findUnique({
    where: { whatsappMessageId: wamid },
  });
  if (existing) {
    this.logger.debug(`Skipping duplicate message wamid=${wamid}`);
    return;
  }

  const whatsappNumber = from.startsWith("+") ? from : `+${from}`;
  const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;

  const existingCustomer = await this.prisma.customer.findUnique({ where: { whatsappNumber } });
  const isNewCustomer = !existingCustomer;

  const customer = await this.prisma.customer.upsert({
    where: { whatsappNumber },
    create: { whatsappNumber, name: profileName ?? null },
    update: profileName ? { name: profileName } : {},
  });

  const conversation = await this.conversations.getOrCreateActive(customer.id);
  const bodyText = msg.type === "text" ? (msg.text?.body ?? null) : null;

  // ===== FIX: Handle multi-line messages with proper TypeScript typing =====
  let processedText = bodyText;
  if (bodyText && bodyText.includes('\n')) {
    const lines = bodyText.split('\n').filter((line: string) => line.trim());
    processedText = lines.join(' ');
    this.logger.log(`📝 Multi-line message detected (${lines.length} lines): ${processedText}`);
  }

  const threadHistory = processedText
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

  try {
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        sessionId: conversation.id,
        whatsappMessageId: wamid,
        direction: MessageDirection.inbound,
        body: processedText,
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
  this.logger.log(`Inbound [${whatsappNumber}]: ${processedText ?? `[${msg.type}]`}`);

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

  if (msg.type === "audio") {
    await this.sendAndLog(
      customer.id,
      conversation.id,
      whatsappNumber,
      `Sorry oh, I can't listen to voice notes yet 🎙️ — just type your message and we go run am sharp-sharp! Reply *MENU* for options.`,
    );
    return;
  }

  const pendingItems = await this.conversations.getPendingItems(conversation.id);
  if (pendingItems.length > 0 && processedText) {
    const handled = await this.handleQuantityResponse(
      customer.id,
      conversation.id,
      whatsappNumber,
      processedText,
      pendingItems,
    );
    if (handled) {
      await this.conversations.touch(conversation.id);
      return;
    }
  }

  if (processedText && looksLikeAddress(processedText)) {
    const addressHandled = await this.handleAddressInput(
      customer.id,
      conversation.id,
      whatsappNumber,
      processedText,
    );
    if (addressHandled) {
      await this.conversations.touch(conversation.id);
      return;
    }
  }

  if (processedText && looksLikeOrderIntent(processedText)) {
    await this.processOrderMessage(
      customer.id,
      conversation.id,
      whatsappNumber,
      processedText,
      formattedHistory,
      customer.contextSummary,
    );
    return;
  }

  const replyKey = this.resolveReplyKey(processedText, isNewCustomer);

  if (replyKey === "order_prompt") {
    await this.prisma.pendingOrder.upsert({
      where: { phone: whatsappNumber },
      create: { phone: whatsappNumber, completed: false },
      update: { startedAt: new Date(), completed: false, remindedAt: null },
    });
  }

  if (replyKey === "default" && processedText) {
    await this.processOrderMessage(
      customer.id,
      conversation.id,
      whatsappNumber,
      processedText,
      formattedHistory,
      customer.contextSummary,
    );
    return;
  }

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

  // ===== Process order messages =====
  private async processOrderMessage(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    customerContext: string | null,
  ): Promise<void> {
    const existingDraft = await this.conversations.getDraft(conversationId);
    const isDeterministicConfirm =
      CONFIRM_PHRASES.has(normalizeForConfirmCheck(bodyText)) && existingDraft.items.length > 0;

    if (!isDeterministicConfirm && looksLikePayNowRequest(bodyText)) {
      const handled = await this.handlePayNowRequest(
        customerId,
        conversationId,
        whatsappNumber,
      );
      if (handled) return;
    }

    if (!isDeterministicConfirm && looksLikeSameAddressRequest(bodyText)) {
      const lastAddress = await this.getLastDeliveryAddress(customerId);
      if (lastAddress) {
        const validated = await this.addressValidation.validateAddress(lastAddress);
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversationId,
          [],
          lastAddress,
        );
        
        let draftSummary = `Noted! Here's your list so far:\n\n`;
        if (items.length === 0) {
          draftSummary += `(No items yet — drop wetin you wan buy.)\n`;
        } else {
          items.forEach((item) => {
            draftSummary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
          });
        }
        
        if (validated) {
          draftSummary += `\n📍 *Delivery to:* ${validated.formatted}`;
          if (validated.neighborhood) {
            draftSummary += `\n📍 *Area:* ${validated.neighborhood}`;
          }
        } else {
          draftSummary += `\n📍 *Delivery to:* ${deliveryAddress}`;
        }
        
        draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;
        await this.sendAndLog(customerId, conversationId, whatsappNumber, draftSummary);
        return;
      }
    }

    if (!isDeterministicConfirm && looksLikeCartRequest(bodyText)) {
      if (existingDraft.items.length === 0) {
        await this.sendAndLog(
          customerId,
          conversationId,
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
      await this.sendAndLog(customerId, conversationId, whatsappNumber, cartSummary);
      return;
    }

    const aiResult: AiChatResult | null = isDeterministicConfirm
      ? { type: "confirm_order" }
      : await this.ai.chat(bodyText, history, customerContext);

    const resolved = this.resolveDraftFromAiOrMessage(bodyText, aiResult);

    if (resolved?.type === "draft_update") {
      const itemsWithoutQuantities = resolved.items.filter(
        item => item.quantity <= 0 || (item.unit === 'pieces' && item.quantity === 1)
      );

      if (itemsWithoutQuantities.length > 0 && !resolved.deliveryAddress) {
        const itemNames = itemsWithoutQuantities.map(item => item.name);
        await this.conversations.setPendingItems(conversationId, itemNames);
        
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          `Got it! Let me get the quantities:\n\nHow much *${itemNames[0]}* do you want? (e.g., "2 cups", "1 kg", "N500 worth")`
        );
        return;
      }

      if (resolved.items.length > 0) {
        const { items, deliveryAddress } = await this.conversations.mergeDraft(
          conversationId,
          resolved.items,
          resolved.deliveryAddress,
        );

        let draftSummary = `Noted! Here's your list so far:\n\n`;
        if (items.length === 0) {
          draftSummary += `(No items yet — drop wetin you wan buy.)\n`;
        } else {
          items.forEach((item) => {
            draftSummary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
          });
        }
        
        const addressInfo = await this.conversations.getDeliveryAddress(conversationId);
        if (addressInfo.address) {
          if (addressInfo.formatted) {
            draftSummary += `\n📍 *Delivery to:* ${addressInfo.formatted}`;
          } else {
            draftSummary += `\n📍 *Delivery to:* ${addressInfo.address}`;
          }
          if (addressInfo.neighborhood) {
            draftSummary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
          }
        } else if (deliveryAddress) {
          draftSummary += `\n📍 *Delivery to:* ${deliveryAddress}`;
        } else {
          draftSummary += `\n⚠️ Still need your delivery address — just drop it whenever you're ready.`;
        }
        
        draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;

        await this.sendAndLog(customerId, conversationId, whatsappNumber, draftSummary);
        return;
      }
    }

    if (resolved?.type === "confirm_order") {
      await this.confirmOrder(
        customerId,
        conversationId,
        whatsappNumber,
      );
      return;
    }

    if (resolved?.type === "text") {
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
      await this.sendAndLog(customerId, conversationId, whatsappNumber, resolved.content);
      return;
    }
  }

  // ===== Confirm order method =====
  private async confirmOrder(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
  ): Promise<void> {
    const draft = await this.conversations.getDraft(conversationId);
    const addressInfo = await this.conversations.getDeliveryAddress(conversationId);

    if (draft.items.length === 0) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `You never tell me wetin you wan buy yet 🙏 — just drop your list and we go start!`,
      );
      return;
    }

    if (!draft.deliveryAddress && !addressInfo.address) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `Almost there! 📍 I still need your delivery address before I fit place this order — just drop it and say *"that's all"* again to confirm.`,
      );
      return;
    }

    const finalAddress = addressInfo.formatted || addressInfo.address || draft.deliveryAddress;

    const pricedItems = await this.priceDraftItems(draft.items);
    const totalNaira = pricedItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0,
    );
    const allPriced = pricedItems.every((item) => item.unitPrice > 0);
    const paystackRef = `oja_${randomBytes(8).toString("hex")}`;

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true },
    });

    const createdOrder = await this.prisma.$transaction(async (tx) => {
      await tx.pendingOrder.updateMany({
        where: { phone: whatsappNumber, completed: false },
        data: { completed: true },
      });

      const order = await tx.order.create({
        data: {
          customerId: customerId,
          channel: Channel.whatsapp,
          status: OrderStatus.pending,
          paymentStatus: PaymentStatus.unpaid,
          total: new Prisma.Decimal(totalNaira.toFixed(2)),
          customerNotes: finalAddress,
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

    await this.conversations.clearDraft(conversationId);
    await this.conversations.clearPendingItems(conversationId);
    await this.conversations.closeSession(conversationId);

    this.conversations
      .summarizeSession(conversationId)
      .catch((err) => this.logger.error(`Immediate summarization failed for session ${conversationId}`, err));

    this.logger.log(`Order processed transactionally for ${whatsappNumber}`);

    try {
      await this.email.sendNewOrderNotification({
        orderId: createdOrder.id,
        customerName: customer?.name ?? null,
        whatsappNumber: whatsappNumber,
        items: draft.items.map(item => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        })),
        deliveryAddress: finalAddress ?? null,
        createdAt: createdOrder.createdAt,
      });
    } catch (emailError) {
      this.logger.error(`Failed to send order notification email for order ${createdOrder.id}`, emailError);
    }

    const { window, day } = getDeliveryWindow();
    let customerInvoiceReceipt = `E don set! 🔥 I have compiled your OjaRun market order list:\n\n`;
    pricedItems.forEach((item) => {
      const priceBit =
        item.unitPrice > 0
          ? ` — ₦${(item.lineTotal).toLocaleString("en-NG")}`
          : "";
      customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit}${priceBit}\n`;
    });
    customerInvoiceReceipt += `\n📍 *Delivery to:* ${finalAddress}`;
    if (addressInfo.neighborhood) {
      customerInvoiceReceipt += `\n📍 *Area:* ${addressInfo.neighborhood}`;
    }
    customerInvoiceReceipt += `\n🚴 *Delivery Schedule:* ${window} ${day}`;

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
            customerId: customerId,
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
            customerId,
            conversationId,
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
      const unpriced = pricedItems.filter((i) => i.unitPrice <= 0).map((i) => i.name);
      this.logger.warn(
        `Order ${createdOrder.id}: no payment link — allPriced=${allPriced} total=₦${totalNaira} paystack=${this.paystack.isConfigured()} unpriced=[${unpriced.join(", ")}]`,
      );
      customerInvoiceReceipt += `\n\nOur market shoppers are handling it. We will send over your subtotal breakdown once pricing finishes! 🙏`;
    }

    await this.sendAndLog(customerId, conversationId, whatsappNumber, customerInvoiceReceipt);
  }

  // ===== Handle address input =====
  private async handleAddressInput(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
  ): Promise<boolean> {
    const result = await this.addressValidation.validateAndFormatResponse(bodyText);

    if (!result.valid) {
      await this.sendAndLog(customerId, conversationId, whatsappNumber, result.message);
      return true;
    }

    if (result.validatedAddress) {
      await this.conversations.setDeliveryAddress(
        conversationId,
        result.validatedAddress.fullAddress,
        {
          formatted: result.validatedAddress.formatted,
          neighborhood: result.validatedAddress.neighborhood,
          landmark: result.validatedAddress.landmark,
        }
      );

      const draft = await this.conversations.getDraft(conversationId);
      const addressInfo = await this.conversations.getDeliveryAddress(conversationId);
      
      let draftSummary = `Noted! Here's your list so far:\n\n`;
      
      if (draft.items.length === 0) {
        draftSummary += `(No items yet — drop wetin you wan buy.)\n`;
      } else {
        draft.items.forEach((item) => {
          draftSummary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
        });
      }
      
      draftSummary += `\n📍 *Delivery to:* ${addressInfo.formatted || addressInfo.address}`;
      
      if (addressInfo.neighborhood) {
        draftSummary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
      }
      
      draftSummary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;

      await this.sendAndLog(customerId, conversationId, whatsappNumber, draftSummary);
      return true;
    }

    return false;
  }

  // ===== Handle quantity responses =====
  private async handleQuantityResponse(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
    bodyText: string,
    pendingItems: string[],
  ): Promise<boolean> {
    const quantity = this.conversations.parseQuantity(bodyText);
    
    if (!quantity) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `Sorry, I no catch that 🙏 — please tell me how much *${pendingItems[0]}* you want (e.g., "2 cups", "1 kg", "N500 worth")`
      );
      return true;
    }

    const currentItem = pendingItems[0];
    await this.conversations.mergeDraft(
      conversationId,
      [{ name: currentItem, quantity: quantity.value, unit: quantity.unit }],
      null
    );

    pendingItems.shift();
    await this.conversations.setPendingItems(conversationId, pendingItems);

    if (pendingItems.length > 0) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `Great! ✅ ${quantity.value} ${quantity.unit} of ${currentItem} added.\n\nHow much *${pendingItems[0]}* do you want? (e.g., "2 cups", "1 kg", "N500 worth")`
      );
    } else {
      const draft = await this.conversations.getDraft(conversationId);
      const addressInfo = await this.conversations.getDeliveryAddress(conversationId);
      
      let summary = `Noted! Here's your list so far:\n\n`;
      draft.items.forEach((item) => {
        summary += `🔸 *${item.name}* — ${item.quantity} ${item.unit}\n`;
      });
      
      if (addressInfo.address) {
        summary += `\n📍 *Delivery to:* ${addressInfo.formatted || addressInfo.address}`;
        if (addressInfo.neighborhood) {
          summary += `\n📍 *Area:* ${addressInfo.neighborhood}`;
        }
      } else {
        summary += `\n📍 Still need your delivery address — just drop it whenever you're ready.`;
      }
      
      summary += `\n\nAdd more items anytime, or say *"that's all"* when you're ready to confirm.`;
      
      await this.sendAndLog(customerId, conversationId, whatsappNumber, summary);
    }

    return true;
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

    return items.map((item) => {
      const match = matchCatalogProduct(item.name, products);
      const quantity = Number(item.quantity) || 0;
      const budget = parseBudgetNaira(item.unit, item.name);

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
        name: match?.name ?? item.name,
        quantity,
        unit: match?.unit || item.unit,
        productId: match?.id ?? null,
        unitPrice,
        lineTotal: unitPrice * quantity,
      };
    });
  }

  private async getLastDeliveryAddress(customerId: string): Promise<string | null> {
    const last = await this.prisma.order.findFirst({
      where: { customerId, customerNotes: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { customerNotes: true },
    });
    const addr = last?.customerNotes?.trim();
    return addr || null;
  }

  /** Resend Paystack link for the customer's latest unpaid order. */
  private async handlePayNowRequest(
    customerId: string,
    conversationId: string,
    whatsappNumber: string,
  ): Promise<boolean> {
    const order = await this.prisma.order.findFirst({
      where: {
        customerId,
        paymentStatus: { in: [PaymentStatus.unpaid, PaymentStatus.pending] },
        status: { in: [OrderStatus.pending, OrderStatus.awaiting_payment] },
      },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });

    if (!order) {
      await this.sendAndLog(
        customerId,
        conversationId,
        whatsappNumber,
        `I no see any open order waiting for payment 🙏 — drop a fresh list, or check if you already paid.`,
      );
      return true;
    }

    const totalNaira = Number(order.total);
    let paymentUrl = order.paymentUrl;
    let displayTotal = totalNaira;

    if (totalNaira < 1 || !paymentUrl) {
      const repriced = await this.repriceOrderItems(order.id, order.items);
      displayTotal = repriced.total;
      if (displayTotal >= 1 && this.paystack.isConfigured() && order.paystackReference) {
        const payEmail = `${whatsappNumber.replace(/\D/g, "")}@whatsapp.ojarun.ng`;
        const webAppUrl = this.config.get<string>("webAppUrl") || "";
        let reference = order.paystackReference;
        let payment = await this.paystack.initializeTransaction({
          email: payEmail,
          amountNaira: displayTotal,
          reference,
          callbackUrl: webAppUrl
            ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
            : undefined,
          metadata: { orderId: order.id, channel: "whatsapp", customerId },
        });
        if (!payment.ok && /reference/i.test(payment.error || "")) {
          reference = `oja_${randomBytes(8).toString("hex")}`;
          payment = await this.paystack.initializeTransaction({
            email: payEmail,
            amountNaira: displayTotal,
            reference,
            callbackUrl: webAppUrl
              ? `${webAppUrl.replace(/\/$/, "")}/payment/callback`
              : undefined,
            metadata: { orderId: order.id, channel: "whatsapp", customerId },
          });
        }
        if (payment.ok && payment.authorizationUrl) {
          paymentUrl = payment.authorizationUrl;
          await this.prisma.order.update({
            where: { id: order.id },
            data: {
              total: new Prisma.Decimal(displayTotal.toFixed(2)),
              status: OrderStatus.awaiting_payment,
              paymentStatus: PaymentStatus.pending,
              paymentUrl,
              paystackReference: reference,
            },
          });
        }
      }

      if (!paymentUrl) {
        await this.sendAndLog(
          customerId,
          conversationId,
          whatsappNumber,
          `Your order *${order.id.slice(0, 8).toUpperCase()}* dey wait for pricing still 🙏\n\nAdd *Titus* (and other items) with prices in admin, or customer can send budget amounts like "titus 5k".`,
        );
        return true;
      }
    }

    let body = `Here's your payment link again 💳\n\n`;
    order.items.forEach((item) => {
      body += `🔸 *${item.productNameSnapshot}* — ${item.quantity} ${item.unitSnapshot}\n`;
    });
    if (order.customerNotes) {
      body += `\n📍 *Delivery to:* ${order.customerNotes}`;
    }
    body += `\n\n💰 *Total:* ₦${displayTotal.toLocaleString("en-NG")}`;
    body += `\n\nTap *Pay now* below to complete checkout. 🙏`;

    await this.sendPaymentAndLog(
      customerId,
      conversationId,
      whatsappNumber,
      body,
      paymentUrl!,
    );
    return true;
  }

  /** Re-price order line items from catalog */
  private async repriceOrderItems(
    orderId: string,
    items: Array<{
      id: string;
      productNameSnapshot: string;
      unitSnapshot: string;
      quantity: { toString(): string };
      unitPriceSnapshot: { toString(): string };
    }>,
  ): Promise<{ total: number; allPriced: boolean }> {
    const priced = await this.priceDraftItems(
      items.map((i) => ({
        name: i.productNameSnapshot,
        quantity: Number(i.quantity),
        unit: i.unitSnapshot,
      })),
    );

    let total = 0;
    let allPriced = true;
    for (let i = 0; i < items.length; i++) {
      const line = priced[i];
      if (line.unitPrice <= 0) allPriced = false;
      total += line.lineTotal;
      if (line.unitPrice > 0) {
        await this.prisma.orderItem.update({
          where: { id: items[i].id },
          data: {
            unitPriceSnapshot: new Prisma.Decimal(line.unitPrice.toFixed(2)),
            productId: line.productId,
          },
        });
      }
    }

    if (allPriced && total >= 1) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { total: new Prisma.Decimal(total.toFixed(2)) },
      });
    }

    return { total, allPriced };
  }

  /**
   * Sends an outbound WhatsApp message and logs it
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

  // ===== resolveReplyKey checks order intent first =====
  private resolveReplyKey(body: string | null, isNewCustomer: boolean): string {
    if (!body) {
      if (isNewCustomer) return "welcome";
      return "default";
    }
    
    const text = body.trim().toUpperCase();
    
    // Check for order intent FIRST - this is the key fix
    if (looksLikeOrderIntent(body)) {
      return "default";
    }
    
    // Then check for new customer welcome
    if (isNewCustomer) {
      return "welcome";
    }
    
    // Existing customer keywords
    if (text === "MENU" || text.includes("WETIN DEY")) return "menu";
    if (text === "ORDER" || text === "I WANT TO BUY" || text === "I WAN BUY") return "order_prompt";
    if (text === "HELP") return "help";
    if (text.includes("LOCATION") || text.includes("IBADAN")) return "location";
    if (text.includes("PRICE") || text.includes("HOW MUCH") || text.includes("₦")) return "pricing";

    return "default";
  }
}