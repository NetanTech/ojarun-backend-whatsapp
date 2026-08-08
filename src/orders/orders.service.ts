import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListOrdersQueryDto, UpdateOrderStatusDto } from './dto/order.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

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
      uiStatus: this.toUiStatus(order.status),
      createdAt: order.createdAt,
      customerName: order.customer.name,
      customerPhone: order.customer.whatsappNumber,
      deliveryAddress: order.customerNotes,
    };
  }

  private serializeDetail(order: {
    id: string;
    status: OrderStatus;
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
      uiStatus: this.toUiStatus(order.status),
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
  private toUiStatus(status: OrderStatus): 'Pending' | 'Active' | 'Cancelled' {
    if (status === OrderStatus.cancelled) return 'Cancelled';
    if (
      status === OrderStatus.pending ||
      status === OrderStatus.awaiting_payment ||
      status === OrderStatus.confirmed
    ) {
      return 'Pending';
    }
    return 'Active';
  }

  /** Timeline status for the details modal */
  private toDetailStatus(
    status: OrderStatus,
  ): 'received' | 'shopping' | 'ready' | 'delivered' {
    switch (status) {
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
