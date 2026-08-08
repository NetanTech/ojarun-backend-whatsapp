import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  MessageDirection,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PaystackService } from './paystack.service';

@Controller('webhooks/paystack')
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(
    private readonly paystack: PaystackService,
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody || !this.paystack.verifyWebhookSignature(rawBody, signature || '')) {
      this.logger.warn('Rejected Paystack webhook — invalid signature');
      throw new UnauthorizedException('Invalid Paystack signature');
    }

    const event = req.body as {
      event?: string;
      data?: {
        reference?: string;
        status?: string;
        amount?: number;
        metadata?: Record<string, unknown>;
      };
    };

    if (event.event !== 'charge.success') {
      return { received: true };
    }

    const reference = event.data?.reference;
    if (!reference) {
      this.logger.warn('charge.success without reference');
      return { received: true };
    }

    // Double-check with Paystack verify API (don't trust webhook body alone)
    const verified = await this.paystack.verifyTransaction(reference);
    if (!verified.ok || !verified.paid) {
      this.logger.warn(
        `Webhook reference ${reference} failed verify: ${verified.error || verified.status}`,
      );
      return { received: true };
    }

    const order = await this.prisma.order.findUnique({
      where: { paystackReference: reference },
      include: { customer: true, items: true },
    });

    if (!order) {
      this.logger.warn(`No order for Paystack reference ${reference}`);
      return { received: true };
    }

    if (order.paymentStatus === PaymentStatus.paid) {
      return { received: true };
    }

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: PaymentStatus.paid,
        status: OrderStatus.confirmed,
        paidAt: new Date(),
        total:
          verified.amountNaira != null
            ? new Prisma.Decimal(verified.amountNaira)
            : order.total,
      },
      include: { customer: true },
    });

    this.logger.log(`Order ${order.id} marked paid via Paystack ${reference}`);

    const phone = updated.customer.whatsappNumber;
    const confirmText =
      `Payment received — thank you! ✅\n\n` +
      `Your OjaRun order is *confirmed*. Our market shoppers are on it.\n` +
      `Order ref: *${order.id.slice(0, 8).toUpperCase()}*\n\n` +
      `We'll update you as we shop and deliver. 🙏`;

    try {
      const sent = await this.whatsapp.sendText(phone, confirmText);
      await this.prisma.message.create({
        data: {
          customerId: updated.customerId,
          whatsappMessageId: sent.wamid,
          direction: MessageDirection.outbound,
          body: confirmText,
          raw: { sentPayload: sent, source: 'paystack_webhook' } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify customer after payment for order ${order.id}`,
        err as Error,
      );
    }

    return { received: true };
  }
}
