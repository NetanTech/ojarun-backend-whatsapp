import { Injectable, Logger } from '@nestjs/common';
import { AdminRole, AdminStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ConfigService } from '@nestjs/config';

/** Roles that receive new-order WhatsApp alerts when on duty */
const NOTIFY_ROLES: AdminRole[] = [
  AdminRole.agent,
  AdminRole.admin,
  AdminRole.superadmin,
];

export type OrderNotifyPayload = {
  id: string;
  total: { toString(): string } | number | string;
  customerNotes?: string | null;
  customer?: {
    name?: string | null;
    whatsappNumber?: string;
  } | null;
};

export type OrderNotifyItem = {
  name?: string;
  productNameSnapshot?: string;
  quantity: number | { toString(): string };
  unit?: string;
  unitSnapshot?: string;
  unitPrice?: number;
  unitPriceSnapshot?: number | { toString(): string };
};

@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /**
   * WhatsApp alert to on-duty agents/admins with a whatsappNumber saved.
   * Email to EMAIL_ADMIN_TO is sent separately from confirmOrder().
   */
  async notifyAdminsOfNewOrder(
    order: OrderNotifyPayload,
    items: OrderNotifyItem[],
    customerPhone?: string,
  ): Promise<void> {
    try {
      const admins = await this.prisma.admin.findMany({
        where: {
          status: AdminStatus.active,
          isActive: true,
          isOnDuty: true,
          whatsappNumber: { not: null },
          role: { in: NOTIFY_ROLES },
        },
        select: {
          id: true,
          name: true,
          whatsappNumber: true,
          role: true,
        },
      });

      if (admins.length === 0) {
        this.logger.warn(
          `No on-duty agents with WhatsApp numbers — order ${order.id} alert skipped. ` +
            `Agents: add WhatsApp number in Settings and keep "On duty" on.`,
        );
        return;
      }

      const message = this.buildNotificationMessage(
        order,
        items,
        customerPhone,
      );

      let sent = 0;
      for (const admin of admins) {
        const ok = await this.sendToAdmin(admin, order.id, message);
        if (ok) sent++;
      }

      this.logger.log(
        `Order ${order.id} WhatsApp alert: ${sent}/${admins.length} agent(s) notified`,
      );
    } catch (error) {
      this.logger.error(`Failed to notify admins for order ${order.id}`, error);
    }
  }

  private buildNotificationMessage(
    order: OrderNotifyPayload,
    items: OrderNotifyItem[],
    customerPhone?: string,
  ): string {
    const orderId = order.id.slice(0, 8).toUpperCase();
    const customerName = order.customer?.name || 'Customer';
    const phone =
      customerPhone ||
      order.customer?.whatsappNumber ||
      'Unknown';
    const total = Number(order.total);

    let message = `📦 *NEW ORDER #${orderId}*\n\n`;
    message += `👤 *Customer:* ${customerName}\n`;
    message += `📱 *Phone:* ${phone}\n\n`;

    message += `🛒 *Items:*\n`;
    items.forEach((item) => {
      const name = item.productNameSnapshot || item.name || 'Item';
      const qty = Number(item.quantity);
      const unit = item.unitSnapshot || item.unit || 'piece';
      message += `  🔸 ${name} — ${qty} ${unit}\n`;
    });

    message += `\n📍 *Delivery:* ${order.customerNotes || 'Not provided'}`;
    message += `\n💰 *Total:* ₦${total.toLocaleString('en-NG')}`;

    if (this.checkIfNeedsAttention(order, items)) {
      message += `\n\n⚠️ *Needs pricing* — some items have no catalog price yet.`;
    }

    const adminUrl = this.config.get<string>('adminAppUrl');
    if (adminUrl) {
      message += `\n\n🔗 ${adminUrl.replace(/\/$/, '')}/orders`;
    }

    return message;
  }

  private checkIfNeedsAttention(
    order: OrderNotifyPayload,
    items: OrderNotifyItem[],
  ): boolean {
    const hasUnpriced = items.some(
      (i) => Number(i.unitPriceSnapshot ?? i.unitPrice ?? 0) <= 0,
    );
    if (hasUnpriced) return true;
    if (Number(order.total) <= 0) return true;
    return false;
  }

  private async sendToAdmin(
    admin: { id: string; name: string | null; whatsappNumber: string | null },
    orderId: string,
    message: string,
  ): Promise<boolean> {
    if (!admin.whatsappNumber) return false;

    try {
      const sent = await this.whatsapp.sendText(admin.whatsappNumber, message);
      if (!sent.ok) {
        this.logger.warn(
          `WhatsApp to agent ${admin.name} failed: ${sent.error}. ` +
            `They may need to message the business number first (24h window).`,
        );
        return false;
      }

      await this.prisma.orderAssignment.create({
        data: {
          orderId,
          adminId: admin.id,
          status: 'pending',
          notes: 'Auto-assigned from new order WhatsApp alert',
        },
      });

      this.logger.log(
        `Order alert sent to ${admin.name} (${admin.whatsappNumber})`,
      );
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp to agent ${admin.whatsappNumber}`,
        error,
      );
      return false;
    }
  }
}
