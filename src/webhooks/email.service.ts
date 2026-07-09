import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type NewOrderEmailPayload = {
  orderId: string;
  customerName: string | null;
  whatsappNumber: string;
  items: { name: string; quantity: number; unit: string }[];
  deliveryAddress: string | null;
  createdAt: Date;
};

// Deliberately using ZeptoMail's HTTP API instead of SMTP. Render's free
// tier blocks outbound traffic on SMTP ports (25/465/587) as of Sep 2025 —
// this sidesteps that entirely since it's a plain HTTPS call (port 443),
// which isn't restricted.
const ZEPTOMAIL_API_URL = 'https://api.zeptomail.com/v1.1/email';
const FETCH_TIMEOUT_MS = 15_000;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Fire-and-forget from the caller's perspective — all failures are caught
   * and logged here so a broken mail provider never blocks or delays the
   * customer-facing WhatsApp reply.
   */
  async sendNewOrderNotification(payload: NewOrderEmailPayload): Promise<void> {
    const adminEmail = this.config.get<string>('email.adminTo');
    const fromEmail = this.config.get<string>('email.from');
    const fromName = this.config.get<string>('email.fromName') || 'OjaRun';
    const apiToken = this.config.get<string>('email.zeptoApiToken');

    if (!adminEmail) {
      this.logger.warn('EMAIL_ADMIN_TO is not configured — skipping new order notification email');
      return;
    }
    if (!apiToken) {
      this.logger.warn('ZEPTOMAIL_API_TOKEN is not configured — skipping new order notification email');
      return;
    }

    const itemRows = payload.items
      .map(
        (item) => `
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #EDE8DD; font-size: 15px; color: #2F2A20;">${escapeHtml(item.name)}</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #EDE8DD; font-size: 15px; color: #2F2A20; text-align: right; white-space: nowrap;">${item.quantity} ${escapeHtml(item.unit)}</td>
          </tr>`,
      )
      .join('');

    const addressBlock = payload.deliveryAddress
      ? `<p style="margin: 0; font-size: 15px; color: #2F2A20;">${escapeHtml(payload.deliveryAddress)}</p>`
      : `<div style="background: #FFF6E9; border: 1px solid #F0C674; padding: 12px 16px; border-radius: 8px; margin: 0;">
           <p style="margin: 0; font-size: 14px; color: #8A5A00;">⚠️ Not provided yet — the customer will need to be asked for it.</p>
         </div>`;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background-color: #F4F1EA;">
          <div style="max-width: 560px; margin: 0 auto; padding: 24px 16px;">

            <!-- Header -->
            <div style="background: #E8F0DC; border-radius: 12px 12px 0 0; padding: 28px 30px;">
              <p style="margin: 0 0 6px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; color: #2F5233; text-transform: uppercase;">OjaRun</p>
              <h1 style="margin: 0 0 4px 0; font-size: 24px; color: #1F3820; font-weight: 700;">New order received 🛒</h1>
              <p style="margin: 0; font-size: 14px; color: #3F5A3F;">Order <strong>#${payload.orderId.slice(0, 8)}</strong> from ${escapeHtml(payload.customerName ?? payload.whatsappNumber)}</p>
            </div>

            <!-- Body -->
            <div style="background: #FFFFFF; padding: 30px;">

              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding-bottom: 6px; font-size: 12px; font-weight: 700; color: #8A8474; text-transform: uppercase; letter-spacing: 0.5px;">Customer</td>
                </tr>
                <tr>
                  <td style="font-size: 15px; color: #2F2A20;">${escapeHtml(payload.customerName ?? '(no name on file)')} — ${payload.whatsappNumber}</td>
                </tr>
              </table>

              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding-bottom: 6px; font-size: 12px; font-weight: 700; color: #8A8474; text-transform: uppercase; letter-spacing: 0.5px;">Delivery address</td>
                </tr>
                <tr>
                  <td>${addressBlock}</td>
                </tr>
              </table>

              <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="padding-bottom: 10px; font-size: 12px; font-weight: 700; color: #8A8474; text-transform: uppercase; letter-spacing: 0.5px;">Items</td>
                </tr>
                ${itemRows}
              </table>

              <p style="margin: 0; font-size: 13px; color: #A39D8C;">Placed ${payload.createdAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}</p>
            </div>

            <!-- Footer -->
            <div style="background: #1F3820; border-radius: 0 0 12px 12px; padding: 16px 30px; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #C7D6C1;">OjaRun order notifications — sent automatically</p>
            </div>

          </div>
        </body>
      </html>
    `;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // Tolerate the token being pasted either with or without the
    // "Zoho-enczapikey " prefix — the ZeptoMail dashboard displays both
    // together as one string, so it's an easy thing to copy either way.
    const trimmedToken = apiToken.trim();
    const authHeader = trimmedToken.toLowerCase().startsWith('zoho-enczapikey')
      ? trimmedToken
      : `Zoho-enczapikey ${trimmedToken}`;

    try {
      const res = await fetch(ZEPTOMAIL_API_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          from: { address: fromEmail, name: fromName },
          to: [{ email_address: { address: adminEmail, name: 'OjaRun Admin' } }],
          subject: `New order from ${payload.customerName ?? payload.whatsappNumber}`,
          htmlbody: html,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`ZeptoMail API error ${res.status}: ${errText}`);
      }

      this.logger.log(`New order notification email sent for order ${payload.orderId}`);
    } catch (err) {
      this.logger.error('Failed to send new order notification email', err as Error);
    } finally {
      clearTimeout(timeout);
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