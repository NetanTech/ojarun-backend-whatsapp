import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminNotificationService {
  private readonly logger = new Logger(AdminNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Notify admins about a new order.
   * Sends WhatsApp messages to all active, on-duty admins with WhatsApp numbers.
   * If no admins are available, logs a warning.
   * (Email notifications are already sent separately via EmailService.)
   */
  async notifyAdminsOfNewOrder(order: any, items: any[]): Promise<void> {
    try {
      // Fetch active, on-duty admins with WhatsApp numbers
      // Note: email is non‑nullable, so we don't need to filter it.
      const admins = await this.prisma.admin.findMany({
        where: {
          isActive: true,
          isOnDuty: true,
          whatsappNumber: { not: null }, // filter admins with a WhatsApp number
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
          'No active, on-duty admins with WhatsApp numbers found. Order notification skipped.',
        );
        return;
      }

      // Build the notification message
      const message = this.buildNotificationMessage(order, items);

      // Send to each admin
      for (const admin of admins) {
        await this.sendToAdmin(admin, order.id, message);
      }

      this.logger.log(`Order ${order.id} notified to ${admins.length} admin(s) via WhatsApp`);
    } catch (error) {
      this.logger.error(`Failed to notify admins for order ${order.id}`, error);
    }
  }

  private buildNotificationMessage(order: any, items: any[]): string {
    const orderId = order.id.slice(0, 8).toUpperCase();
    const customerName = order.customer?.name || 'Customer';
    const total = Number(order.total);

    let message = `📦 *NEW ORDER #${orderId}*\n\n`;
    message += `👤 *Customer:* ${customerName}\n`;
    message += `📱 *Phone:* ${order.customer?.whatsappNumber || 'Unknown'}\n\n`;

    message += `🛒 *Items:*\n`;
    items.forEach((item) => {
      const name = item.productNameSnapshot || item.name || 'Item';
      const qty = Number(item.quantity);
      const unit = item.unitSnapshot || item.unit || 'piece';
      message += `  🔸 ${name} — ${qty} ${unit}\n`;
    });

    message += `\n📍 *Delivery:* ${order.customerNotes || 'Not provided'}`;
    message += `\n💰 *Total:* ₦${total.toLocaleString()}`;

    // Check if attention is needed
    const needsAttention = this.checkIfNeedsAttention(order, items);
    if (needsAttention) {
      message += `\n\n⚠️ *ATTENTION NEEDED!* Please check the admin panel.`;
    }

    const adminUrl = this.config.get<string>('ADMIN_APP_URL');
    if (adminUrl) {
      message += `\n\n🔗 *Admin Panel:* ${adminUrl}/orders/${order.id}`;
    }
    message += `\n💬 *Reply to customer:* Use the inbox in the admin panel.`;

    return message;
  }

  private checkIfNeedsAttention(order: any, items: any[]): boolean {
    const hasUnpriced = items.some(
      (i) => Number(i.unitPriceSnapshot || i.unitPrice) <= 0,
    );
    if (hasUnpriced) return true;
    const totalQty = items.reduce((sum, i) => sum + Number(i.quantity), 0);
    if (totalQty > 50) return true;
    if (Number(order.total) > 100000) return true;
    return false;
  }

  private async sendToAdmin(
    admin: any,
    orderId: string,
    message: string,
  ): Promise<void> {
    try {
      // Send WhatsApp
      await this.whatsapp.sendText(admin.whatsappNumber, message);

      // Create assignment record (optional but useful)
      await this.prisma.orderAssignment.create({
        data: {
          orderId: orderId,
          adminId: admin.id,
          status: 'pending',
          notes: 'Auto-assigned from new order notification',
        },
      });

      this.logger.log(
        `WhatsApp notification sent to admin ${admin.name} (${admin.whatsappNumber})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send WhatsApp to admin ${admin.whatsappNumber}`,
        error,
      );
    }
  }
}