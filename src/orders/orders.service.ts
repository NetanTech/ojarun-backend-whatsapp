import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { Channel, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { PaystackService } from '../paystack/paystack.service';
import { AdminNotificationService } from '../admins/admin-notification.service';
import { PromoCodesService } from '../promo-codes/promo-codes.service';
import {
  CreateOrderDto,
  ListOrdersQueryDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';

// Flat fees added to every web order — must match the constants the
// checkout UI displays (src/app/(Marketplace)/checkout/components/OrderSummary.tsx)
// so the amount charged always matches what the customer was shown.
const WEB_AGENT_FEE_NAIRA = 1200;
const WEB_DELIVERY_FEE_NAIRA = 700;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly paystack: PaystackService,
    private readonly adminNotification: AdminNotificationService,
    private readonly promoCodes: PromoCodesService,
  ) {}

  /** Creates a real order from the web checkout for a logged-in customer. */
  async createFromWeb(customerId: string, dto: CreateOrderDto) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const subtotal = dto.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    let promoCodeId: string | null = null;
    let discountAmount = 0;
    if (dto.promoCode) {
      const result = await this.promoCodes.validate(
        dto.promoCode,
        customerId,
        subtotal,
      );
      promoCodeId = result.promoCode.id;
      discountAmount = result.discountAmount;
    }

    const total = Math.max(
      subtotal + WEB_AGENT_FEE_NAIRA + WEB_DELIVERY_FEE_NAIRA - discountAmount,
      0,
    );
    const paystackRef = `oja_${randomBytes(8).toString('hex')}`;
    const deliveryNote = dto.note
      ? `${dto.deliveryAddress}\n\nNote: ${dto.note}`
      : dto.deliveryAddress;

    const created = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          customerId,
          channel: Channel.web,
          status: OrderStatus.pending,
          paymentStatus: PaymentStatus.unpaid,
          total: new Prisma.Decimal(total.toFixed(2)),
          customerNotes: deliveryNote,
          paystackReference: paystackRef,
          promoCodeId,
          discountAmount: new Prisma.Decimal(discountAmount.toFixed(2)),
        },
      });

      for (const item of dto.items) {
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId: item.productId,
            productNameSnapshot: item.name,
            unitSnapshot: item.unit,
            unitPriceSnapshot: new Prisma.Decimal(item.price.toFixed(2)),
            quantity: new Prisma.Decimal(item.quantity),
          },
        });
      }

      return order;
    });

    const fullOrder = await this.prisma.order.findUniqueOrThrow({
      where: { id: created.id },
      include: { customer: true, items: true },
    });

    let paymentUrl: string | null = null;
    let paymentError: string | null = null;

    if (dto.paymentMethod === 'card') {
      const payEmail =
        customer.email ||
        `${customer.whatsappNumber.replace(/\D/g, '')}@web.ojarun.ng`;
      const webAppUrl = this.config.get<string>('webAppUrl') || '';

      const payment = await this.paystack.initializeTransaction({
        email: payEmail,
        amountNaira: total,
        reference: paystackRef,
        callbackUrl: webAppUrl
          ? `${webAppUrl}/order-history/${created.id}`
          : undefined,
        metadata: { orderId: created.id, customerId, source: 'web' },
      });

      if (payment.ok && payment.authorizationUrl) {
        await this.prisma.order.update({
          where: { id: created.id },
          data: {
            status: OrderStatus.awaiting_payment,
            paymentStatus: PaymentStatus.pending,
            paymentUrl: payment.authorizationUrl,
          },
        });
        paymentUrl = payment.authorizationUrl;
      } else {
        paymentError =
          payment.error ||
          'Could not start card payment. You can retry payment from your order.';
        this.logger.warn(
          `Paystack init failed for web order ${created.id}: ${paymentError}`,
        );
      }
    }

    try {
      await this.adminNotification.notifyAdminsOfNewOrder(
        fullOrder,
        fullOrder.items,
      );
    } catch (err) {
      this.logger.error(
        `Admin WhatsApp notification failed for order ${created.id}`,
        err as Error,
      );
    }

    try {
      await this.email.sendNewOrderNotification({
        orderId: fullOrder.id,
        customerName: fullOrder.customer.name,
        whatsappNumber: fullOrder.customer.whatsappNumber,
        items: dto.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        })),
        deliveryAddress: dto.deliveryAddress,
        createdAt: fullOrder.createdAt,
      });
    } catch (err) {
      this.logger.error(
        `Order notification email failed for order ${created.id}`,
        err as Error,
      );
    }

    return {
      id: created.id,
      shortId: created.id.slice(0, 8).toUpperCase(),
      total,
      discountAmount,
      status: paymentUrl ? OrderStatus.awaiting_payment : OrderStatus.pending,
      paymentMethod: dto.paymentMethod,
      paymentUrl,
      paymentError,
    };
  }

  /** Order history list for the logged-in customer (web app). */
  async findMineList(customerId: string) {
    const orders = await this.prisma.order.findMany({
      where: { customerId },
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((order) => this.serializeForCustomer(order));
  }

  /** Single order detail for the logged-in customer — 404s if it's not theirs. */
  async findMineOne(customerId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, customerId },
      include: { items: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.serializeForCustomer(order);
  }

  /** Customer cancels their own order — blocked once it's already delivered or cancelled. */
  async cancelMine(customerId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, customerId } });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.status === OrderStatus.delivered ||
      order.status === OrderStatus.cancelled
    ) {
      throw new BadRequestException('This order can no longer be cancelled.');
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.cancelled },
      include: { items: { include: { product: true } } },
    });
    return this.serializeForCustomer(updated);
  }

  /** Customer confirms they've received their order. */
  async confirmMine(customerId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, customerId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.cancelled) {
      throw new BadRequestException(
        'This order was cancelled and cannot be marked as delivered.',
      );
    }

    const updated = await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.delivered },
      include: { items: { include: { product: true } } },
    });
    return this.serializeForCustomer(updated);
  }

  private serializeForCustomer(order: {
    id: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    channel: string;
    total: Prisma.Decimal;
    discountAmount: Prisma.Decimal;
    customerNotes: string | null;
    paymentUrl: string | null;
    createdAt: Date;
    items: Array<{
      id: string;
      productNameSnapshot: string;
      unitSnapshot: string;
      unitPriceSnapshot: Prisma.Decimal;
      quantity: Prisma.Decimal;
      product: { imageUrl: string | null } | null;
    }>;
  }) {
    const items = order.items.map((item) => ({
      id: item.id,
      name: item.productNameSnapshot,
      quantity: Number(item.quantity),
      unit: item.unitSnapshot,
      price: Number(item.unitPriceSnapshot),
      image: item.product?.imageUrl || undefined,
    }));

    const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const isWeb = order.channel === 'web';

    let status: 'in progress' | 'successful' | 'failed' = 'in progress';
    if (order.status === OrderStatus.cancelled) status = 'failed';
    else if (order.status === OrderStatus.delivered) status = 'successful';

    const progressedPastConfirm = ([
      OrderStatus.confirmed,
      OrderStatus.shopping,
      OrderStatus.purchased,
      OrderStatus.dispatched,
      OrderStatus.delivered,
    ] as OrderStatus[]).includes(order.status);
    const readyForPickup = ([
      OrderStatus.purchased,
      OrderStatus.dispatched,
      OrderStatus.delivered,
    ] as OrderStatus[]).includes(order.status);

    return {
      orderId: order.id,
      date: order.createdAt.toISOString().slice(0, 10),
      status,
      items,
      subtotal,
      agentFee: isWeb ? WEB_AGENT_FEE_NAIRA : 0,
      deliveryFee: isWeb ? WEB_DELIVERY_FEE_NAIRA : 0,
      discount: Number(order.discountAmount),
      total: Number(order.total),
      payment: {
        method: order.paymentUrl ? 'Card (Paystack)' : 'Pay on Delivery',
      },
      delivery: {
        method: 'Ojarun delivery',
        address: order.customerNotes || 'Not provided',
        estimatedTime: 'To be confirmed',
      },
      timeline: {
        orderReceived: true,
        shoppingInProgress: progressedPastConfirm,
        readyForPickup,
        delivered: order.status === OrderStatus.delivered,
      },
      market: 'Ojarun Market',
    };
  }

  async findAll(query: ListOrdersQueryDto) {
    const where: Prisma.OrderWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { customer: { whatsappNumber: { contains: q, mode: 'insensitive' } } },
        { customerNotes: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        customer: true,
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return orders.map((order) => this.serializeListItem(order));
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.serializeDetail(order);
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto) {
    await this.ensureExists(id);
    const order = await this.prisma.order.update({
      where: { id },
      data: { status: dto.status },
      include: {
        customer: true,
        items: {
          include: { product: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return this.serializeDetail(order);
  }

  async cancel(id: string) {
    return this.updateStatus(id, { status: OrderStatus.cancelled });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Order not found');
  }

  private serializeListItem(order: {
    id: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    paidAt: Date | null;
    total: Prisma.Decimal;
    createdAt: Date;
    customerNotes: string | null;
    customer: { name: string | null; whatsappNumber: string };
    items: unknown[];
  }) {
    return {
      id: order.id,
      shortId: order.id.slice(0, 8).toUpperCase(),
      itemsCount: order.items.length,
      total: Number(order.total),
      status: order.status,
      paymentStatus: order.paymentStatus,
      paidAt: order.paidAt,
      uiStatus: this.toUiStatus(order.status, order.paymentStatus),
      createdAt: order.createdAt,
      customerName: order.customer.name,
      customerPhone: order.customer.whatsappNumber,
      deliveryAddress: order.customerNotes,
    };
  }

  private serializeDetail(order: {
    id: string;
    status: OrderStatus;
    paymentStatus: PaymentStatus;
    paidAt: Date | null;
    total: Prisma.Decimal;
    createdAt: Date;
    updatedAt: Date;
    channel: string;
    customerNotes: string | null;
    customer: { name: string | null; whatsappNumber: string };
    items: Array<{
      id: string;
      productNameSnapshot: string;
      unitSnapshot: string;
      unitPriceSnapshot: Prisma.Decimal;
      quantity: Prisma.Decimal;
      product: { imageUrl: string | null } | null;
    }>;
  }) {
    const orderItems = order.items.map((item) => {
      const qty = Number(item.quantity);
      const unitPrice = Number(item.unitPriceSnapshot);
      const lineTotal = qty * unitPrice;
      return {
        id: item.id,
        name: item.productNameSnapshot,
        quantity: qty,
        unit: item.unitSnapshot,
        unitPrice,
        lineTotal,
        image: item.product?.imageUrl || '/assets/tomato-paste.png',
      };
    });

    const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const total = Number(order.total) || subtotal;

    return {
      id: order.id,
      shortId: order.id.slice(0, 8).toUpperCase(),
      status: order.status,
      paymentStatus: order.paymentStatus,
      paidAt: order.paidAt,
      uiStatus: this.toUiStatus(order.status, order.paymentStatus),
      detailStatus: this.toDetailStatus(order.status),
      channel: order.channel,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      customerName: order.customer.name || 'Customer',
      customerPhone: order.customer.whatsappNumber,
      deliveryMethod: 'Ojarun delivery',
      deliveryAddress: order.customerNotes || 'Not provided',
      itemsCount: orderItems.length,
      orderItems,
      subtotal,
      agentFee: 0,
      deliveryFee: 0,
      total,
    };
  }

  /** Compact badge for the orders table */
  private toUiStatus(
    status: OrderStatus,
    paymentStatus: PaymentStatus,
  ): 'Pending' | 'Confirmed' | 'Active' | 'Delivered' | 'Cancelled' {
    if (status === OrderStatus.cancelled) return 'Cancelled';
    if (status === OrderStatus.delivered) return 'Delivered';
    if (
      status === OrderStatus.shopping ||
      status === OrderStatus.purchased ||
      status === OrderStatus.dispatched
    ) {
      return 'Active';
    }
    if (status === OrderStatus.confirmed || paymentStatus === PaymentStatus.paid) {
      return 'Confirmed';
    }
    // pending, awaiting_payment — not paid yet
    return 'Pending';
  }

  /** Timeline status for the details modal */
  private toDetailStatus(
    status: OrderStatus,
  ): 'received' | 'confirmed' | 'shopping' | 'ready' | 'delivered' {
    switch (status) {
      case OrderStatus.confirmed:
        return 'confirmed';
      case OrderStatus.shopping:
      case OrderStatus.purchased:
        return 'shopping';
      case OrderStatus.dispatched:
        return 'ready';
      case OrderStatus.delivered:
        return 'delivered';
      default:
        return 'received';
    }
  }
}
