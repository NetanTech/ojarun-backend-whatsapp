import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const ORDER_STATUS_COPY: Partial<Record<OrderStatus, { title: string; message: (shortId: string) => string }>> = {
  pending: {
    title: 'Order Placed',
    message: (id) => `Your order ${id} has been placed and is awaiting confirmation.`,
  },
  confirmed: {
    title: 'Order Confirmed',
    message: (id) => `Your order ${id} has been confirmed and is being processed.`,
  },
  shopping: {
    title: 'Shopping In Progress',
    message: (id) => `Our agent is sourcing the items for order ${id} from the market.`,
  },
  purchased: {
    title: 'Items Purchased',
    message: (id) => `The items for order ${id} have been purchased and are being packed.`,
  },
  dispatched: {
    title: 'Order Dispatched',
    message: (id) => `Order ${id} is on its way to you.`,
  },
  delivered: {
    title: 'Order Delivered',
    message: (id) => `Order ${id} has been delivered successfully.`,
  },
  cancelled: {
    title: 'Order Cancelled',
    message: (id) => `Order ${id} has been cancelled.`,
  },
};

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  findMine(customerId: string) {
    return this.prisma.customerNotification.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markRead(customerId: string, id: string) {
    const notification = await this.prisma.customerNotification.findFirst({
      where: { id, customerId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.customerNotification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(customerId: string) {
    await this.prisma.customerNotification.updateMany({
      where: { customerId, isRead: false },
      data: { isRead: true },
    });
    return { message: 'All notifications marked as read' };
  }

  create(customerId: string, type: NotificationType, title: string, message: string) {
    return this.prisma.customerNotification.create({
      data: { customerId, type, title, message },
    });
  }

  /**
   * Fires an order-lifecycle notification for a customer, skipping any
   * transition that isn't customer-meaningful (e.g. the transient
   * awaiting_payment state). Never throws — a notification failure should
   * never block the order action that triggered it.
   */
  async notifyOrderStatus(
    customerId: string,
    shortId: string,
    status: OrderStatus,
    extra?: string,
  ) {
    const copy = ORDER_STATUS_COPY[status];
    if (!copy) return;
    try {
      const message = extra ? `${copy.message(shortId)} ${extra}` : copy.message(shortId);
      await this.create(customerId, NotificationType.order, copy.title, message);
    } catch {
      // Notifications are best-effort — swallow failures here.
    }
  }
}
