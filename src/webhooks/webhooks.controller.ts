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

    // 1. Idempotency Check
    const existing = await this.prisma.message.findUnique({
      where: { whatsappMessageId: wamid },
    });
    if (existing) {
      this.logger.debug(`Skipping duplicate message wamid=${wamid}`);
      return;
    }

    // 2. Resolve Phone Number format and upsert Customer
    const whatsappNumber = from.startsWith("+") ? from : `+${from}`;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name;

    const customer = await this.prisma.customer.upsert({
      where: { whatsappNumber },
      create: { whatsappNumber, name: profileName ?? null },
      update: profileName ? { name: profileName } : {},
    });

    const isNewCustomer = !customer.createdAt;
    const bodyText = msg.type === "text" ? (msg.text?.body ?? null) : null;

    // 3. Save incoming message to log timeline safely
    try {
      await this.prisma.message.create({
        data: {
          customerId: customer.id,
          whatsappMessageId: wamid,
          direction: MessageDirection.inbound,
          body: bodyText,
          raw: msg as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // Catch fast-retry race condition requests hitting before the first write finishes
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.debug(`Caught race-condition duplicate via unique constraint: wamid=${wamid}`);
        return; // Gracefully drop execution thread to give Meta a 200 OK success acknowledgement
      }
      throw error; // Propagate any non-idempotency structural errors transparently
    }

    this.logger.log(`Inbound [${whatsappNumber}]: ${bodyText ?? `[${msg.type}]`}`);

    // 4. Fallback Static Keywords Router
    const replyKey = this.resolveReplyKey(bodyText, isNewCustomer);

    if (replyKey === "order_prompt") {
      await this.prisma.pendingOrder.upsert({
        where: { phone: whatsappNumber },
        create: { phone: whatsappNumber, completed: false },
        update: { startedAt: new Date(), completed: false, remindedAt: null },
      });
    }

    // 5. Dynamic AI Conversation Routing Engine
    if (replyKey === "default" && bodyText) {
      // Fetch conversation thread history context to provide persistent memory arrays to LLM
      const threadHistory = await this.prisma.message.findMany({
        where: { 
          customerId: customer.id,
          body: { not: null }
        },
        orderBy: { createdAt: "desc" },
        skip: 1, // Ignore current message row just committed above
        take: 12,
      });

      const formattedHistory = threadHistory
        .reverse()
        .map((m) => ({
          role: (m.direction === MessageDirection.inbound ? "user" : "assistant") as "user" | "assistant",
          content: m.body!,
        }));

      let aiResponseText = await this.ai.chat(bodyText, formattedHistory);
      
      if (aiResponseText) {
        // Intercept Order Confirmation Interlock Instruction Directive Trigger Match
        if (aiResponseText.startsWith("__CREATE_ORDER__:") || aiResponseText.includes("__CREATE_ORDER__:")) {
          const jsonSubstring = aiResponseText.substring(aiResponseText.indexOf("["));
          const parsedItems = JSON.parse(jsonSubstring); 

          // Execute atomic state transitions inside an isolated database Transaction pipeline
          await this.prisma.$transaction(async (tx) => {
            await tx.pendingOrder.updateMany({
              where: { phone: whatsappNumber, completed: false },
              data: { completed: true },
            });

            // Creates parent order tracking metadata instance matching schema fields explicitly
            const createdOrder = await tx.order.create({
              data: {
                customerId: customer.id,
                channel: Channel.whatsapp,
                status: OrderStatus.pending,
                total: new Prisma.Decimal(0.00),
              },
            });

            // Inserts snapshots safely without mapping directly to schema-bypassing fields
            for (const item of parsedItems) {
              const numericValue = parseFloat(item.quantity);
              const isolatedQuantity = isNaN(numericValue) ? 1.000 : numericValue;
              const isolatedUnit = item.unit || "pieces";

              await tx.orderItem.create({
                data: {
                  orderId: createdOrder.id,
                  productId: null, 
                  productNameSnapshot: item.name,
                  unitSnapshot: isolatedUnit,
                  unitPriceSnapshot: new Prisma.Decimal(0.00), 
                  quantity: new Prisma.Decimal(isolatedQuantity),
                },
              });
            }
          });

          this.logger.log(`Order processed transactionally for ${whatsappNumber}`);

          // Assemble local friendly WhatsApp summary confirmation manifest text out to user
          let customerInvoiceReceipt = `E don set! 🔥 I have compiled your OjaRun market order list:\n\n`;
          parsedItems.forEach((item: any) => {
            customerInvoiceReceipt += `🔸 *${item.name}* — ${item.quantity} ${item.unit || ''}\n`;
          });

          const { window, day } = getDeliveryWindow();
          customerInvoiceReceipt += `\n🚴 *Delivery Schedule:* ${window} ${day}\n\nOur market shoppers are handling it. We will send over your subtotal breakdown once pricing finishes! 🙏`;

          const sentPayload = await this.whatsapp.sendText(whatsappNumber, customerInvoiceReceipt);
          await this.prisma.message.create({
            data: {
              customerId: customer.id,
              whatsappMessageId: sentPayload.wamid!,
              direction: MessageDirection.outbound,
              body: customerInvoiceReceipt,
              raw: { sentPayload } as Prisma.InputJsonValue,
            },
          });
          return;
        }

        // Send normal interactive feedback responses back to user
        const sentPayload = await this.whatsapp.sendText(whatsappNumber, aiResponseText);
        await this.prisma.message.create({
          data: {
            customerId: customer.id,
            whatsappMessageId: sentPayload.wamid!,
            direction: MessageDirection.outbound,
            body: aiResponseText,
            raw: { sentPayload } as Prisma.InputJsonValue,
          },
        });
        return; 
      }
    }

    // 6. Handle Outbound Keyed Static Route fallbacks safely
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

    const sentPayload = await this.whatsapp.sendText(whatsappNumber, staticMessageBody);
    await this.prisma.message.create({
      data: {
        customerId: customer.id,
        whatsappMessageId: sentPayload.wamid!,
        direction: MessageDirection.outbound,
        body: staticMessageBody,
        raw: { sentPayload } as Prisma.InputJsonValue,
      },
    });
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