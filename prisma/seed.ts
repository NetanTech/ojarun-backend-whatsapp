import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Every key referenced by WebhooksController#resolveReplyKey. If a key is
// missing here, that route silently falls back to the generic hardcoded
// welcome text in webhooks.controller.ts — so keep this list in sync with
// that function.
const botResponses = [
  {
    key: 'welcome',
    body:
      `Aba {{name}}! 👋 Welcome to OjaRun — we run your market errands for you here in Ibadan.\n\n` +
      `Just drop your shopping list right here (e.g. "rice", "2kg tomatoes, 1 bag beans") and I'll quote today's prices as we go. 🛍️\n\n` +
      `Reply *MENU* for options, *CANCEL* to start over, or *HELP* if you need guidance.`,
  },
  {
    key: 'menu',
    body:
      `Wetin dey do 🛒\n\n` +
      `🛍️ *ORDER* — start a new market order\n` +
      `❌ *CANCEL* — clear your list / unpaid order and start fresh\n` +
      `📦 Just type your shopping list, e.g. "rice" or "1kg beef, 2 tubers yam" — I'll quote today's price\n` +
      `📍 *LOCATION* — see where we dey deliver\n` +
      `❓ *HELP* — how OjaRun works\n\n` +
      `Wetin you wan do today?`,
  },
  {
    key: 'order_prompt',
    body:
      `Oya let's start your order! 🛒\n\n` +
      `Just type out everything you need, with quantities where you fit — e.g:\n` +
      `"2kg tomatoes, 1 congo rice, N5000 worth of meat, Soka Ibadan"\n\n` +
      `Add your delivery address and preferred time too so we no go dey ask twice.`,
  },
  {
    key: 'help',
    body:
      `No wahala, here's how OjaRun works 🙏\n\n` +
      `1️⃣ Send us what you want (e.g. "rice") — we'll quote today's live price and ask how much\n` +
      `2️⃣ Add quantities (kg, derica, bottles, or Naira worth)\n` +
      `3️⃣ We confirm your delivery address\n` +
      `4️⃣ Our shoppers buy the items for you in Ibadan market\n` +
      `5️⃣ We deliver and send your breakdown\n\n` +
      `Reply *CANCEL* anytime to start over, or *MENU* to see options.`,
  },
  {
    key: 'location',
    body:
      `We dey deliver within Ibadan for now 📍\n\n` +
      `Just add your area/landmark when you drop your order (e.g. "Soka, Ibadan" or "Bodija, near UI gate") so our shoppers fit find you quick quick.`,
  },
  {
    key: 'pricing',
    body:
      `Pricing follows today's market 💰\n\n` +
      `Just send the item (e.g. "rice") and I'll tell you today's price per kg or derica, then ask how much you want.\n\n` +
      `We update prices as we restock. No hidden charges — you'll see the amount before you confirm.`,
  },
];

// Same catalog the web app's demo storefront used before it was wired to
// real data (ojarun-web/constants/data.ts DEMO_PRODUCTS) — seeded here so
// the storefront isn't nearly empty once it reads from this table instead.
const products = [
  { name: 'Egusi (Melon Seeds)', category: 'Meals', currentPrice: 3500, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Garri (White)', category: 'Meals', currentPrice: 2500, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Garri (Yellow)', category: 'Meals', currentPrice: 2700, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Ogbono (Dried)', category: 'Meals', currentPrice: 4000, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Palm Oil', category: 'Sauces', currentPrice: 3200, unit: 'Per bottle', imageUrl: '/assets/Untitled design.png' },
  { name: 'Groundnut Oil', category: 'Sauces', currentPrice: 3800, unit: 'Per bottle', imageUrl: '/assets/Untitled design.png' },
  { name: 'Long Grain Rice', category: 'Meals', currentPrice: 5200, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Ofada Rice', category: 'Meals', currentPrice: 5800, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Honey Beans (Oloyin)', category: 'Meals', currentPrice: 4500, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Dried Stockfish', category: 'Meals', currentPrice: 8500, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
  { name: 'Smoked Catfish', category: 'Fresh Food', currentPrice: 6000, unit: 'Per kg', imageUrl: '/assets/Untitled design.png' },
];

async function main() {
  for (const response of botResponses) {
    await prisma.botResponse.upsert({
      where: { key: response.key },
      create: response,
      update: { body: response.body },
    });
    console.log(`Seeded bot_response: ${response.key}`);
  }

  for (const product of products) {
    const existing = await prisma.product.findFirst({ where: { name: product.name } });
    if (existing) {
      console.log(`Product already exists, skipping: ${product.name}`);
      continue;
    }
    await prisma.product.create({ data: product });
    console.log(`Seeded product: ${product.name}`);
  }

  // Launch promo — free delivery for every customer's first order.
  await prisma.promoCode.upsert({
    where: { code: 'WELCOME700' },
    create: {
      code: 'WELCOME700',
      discountType: 'fixed',
      discountValue: 700,
      perCustomerLimit: 1,
      isActive: true,
    },
    update: {},
  });
  console.log('Seeded promo_code: WELCOME700');
}

main()
  .catch((err) => {
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });