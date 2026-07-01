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
      `Just drop your shopping list right here (e.g. "2kg tomatoes, 1 bag rice") and we go sort you out sharp-sharp! 🛍️\n\n` +
      `Reply *MENU* to see wetin we fit help you with, or *HELP* if you need guidance.`,
  },
  {
    key: 'menu',
    body:
      `Wetin dey do 🛒\n\n` +
      `🛍️ *ORDER* — start a new market order\n` +
      `📦 Just type your shopping list directly, e.g. "1kg beef, 2 tubers yam"\n` +
      `📍 *LOCATION* — see where we dey deliver\n` +
      `💰 *PRICE* — ask about pricing\n` +
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
      `1️⃣ Send us your market list (items + quantities)\n` +
      `2️⃣ We confirm your delivery address and time\n` +
      `3️⃣ Our shoppers go buy the items for you for Ibadan market\n` +
      `4️⃣ We deliver to you and send your pricing breakdown\n\n` +
      `Reply *MENU* anytime to see your options, or just start typing your list.`,
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
      `Pricing dey depend on wetin dey market that day 💰\n\n` +
      `Send us your list and we go get the current prices for you once our shoppers dey buy — no fixed price list since market price dey change daily. No hidden charges, we go show you everything before delivery.`,
  },
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
}

main()
  .catch((err) => {
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });