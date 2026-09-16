const { PrismaClient, OrderStatus, Channel, PaymentStatus } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signToken(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSeconds };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(body));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64url(signature)}`;
}

async function main() {
  const whatsappNumber = `234TESTREVIEW${Date.now()}`;
  const customer = await prisma.customer.create({
    data: {
      whatsappNumber,
      name: 'Review Test Customer',
      referralCode: `TEST${Date.now()}`.slice(0, 12),
    },
  });

  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      channel: Channel.web,
      status: OrderStatus.delivered,
      paymentStatus: PaymentStatus.paid,
      total: 5000,
      items: {
        create: [
          {
            productNameSnapshot: 'Tomatoes',
            unitSnapshot: 'per congo',
            unitPriceSnapshot: 2500,
            quantity: 2,
          },
        ],
      },
    },
  });

  const token = signToken(
    { sub: customer.id, type: 'access', kind: 'customer', name: customer.name, phone: customer.whatsappNumber },
    process.env.JWT_SECRET || 'dev-only-change-me',
    7 * 24 * 60 * 60,
  );

  console.log(JSON.stringify({ customerId: customer.id, orderId: order.id, token, customerJson: { id: customer.id, phone: customer.whatsappNumber, name: customer.name } }));
}

main().finally(() => prisma.$disconnect());
