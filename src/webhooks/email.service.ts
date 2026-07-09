import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export type NewOrderEmailPayload = {
  orderId: string;
  customerName: string | null;
  whatsappNumber: string;
  items: { name: string; quantity: number; unit: string }[];
  deliveryAddress: string | null;
  createdAt: Date;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('email.host'),
      port: this.config.get<number>('email.port') ?? 587,
      secure: this.config.get<boolean>('email.secure') ?? false, // true for port 465, false for 587/STARTTLS
      auth: {
        user: this.config.get<string>('email.user'),
        pass: this.config.get<string>('email.pass'),
      },
    });
  }

  /**
   * Fire-and-forget from the caller's perspective — all failures are caught
   * and logged here so a broken mail provider never blocks or delays the
   * customer-facing WhatsApp reply.
   */
  async sendNewOrderNotification(payload: NewOrderEmailPayload): Promise<void> {
    const adminEmail = this.config.get<string>('email.adminTo');
    const fromEmail = this.config.get<string>('email.from') ?? this.config.get<string>('email.user');
    const fromName = this.config.get<string>('email.fromName');
    const fromHeader = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

    if (!adminEmail) {
      this.logger.warn('EMAIL_ADMIN_TO is not configured — skipping new order notification email');
      return;
    }

    const itemsHtml = payload.items
      .map((item) => `<li>${escapeHtml(item.name)} — ${item.quantity} ${escapeHtml(item.unit)}</li>`)
      .join('');

    const html = `
      <h2>New OjaRun order 🛒</h2>
      <p><strong>Order ID:</strong> ${payload.orderId}</p>
      <p><strong>Customer:</strong> ${escapeHtml(payload.customerName ?? '(no name on file)')} — ${payload.whatsappNumber}</p>
      <p><strong>Delivery address:</strong> ${payload.deliveryAddress ? escapeHtml(payload.deliveryAddress) : '⚠️ Not provided yet'}</p>
      <p><strong>Items:</strong></p>
      <ul>${itemsHtml}</ul>
      <p><strong>Placed at:</strong> ${payload.createdAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}</p>
    `;

    try {
      await this.transporter.sendMail({
        from: fromHeader,
        to: adminEmail,
        subject: `New order from ${payload.customerName ?? payload.whatsappNumber}`,
        html,
      });
      this.logger.log(`New order notification email sent for order ${payload.orderId}`);
    } catch (err) {
      this.logger.error('Failed to send new order notification email', err as Error);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}