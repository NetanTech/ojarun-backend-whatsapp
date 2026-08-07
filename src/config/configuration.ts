export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  database: {
    url: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
  },
  whatsapp: {
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
    tlsInsecure:
      process.env.WHATSAPP_TLS_INSECURE === 'true' ||
      (process.env.NODE_ENV ?? 'development') !== 'production',
  },
  ai: {
    provider: process.env.AI_PROVIDER ?? 'groq',
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'llama3-8b-8192',
    systemPrompt: process.env.AI_SYSTEM_PROMPT ?? `You are the WhatsApp assistant for OjaRun, a market-errand and grocery delivery service in Ibadan, Nigeria. Customers tell you what they want to buy from the market, and you help them build a shopping list and place an order.

Stay warm, concise, and conversational — use light Nigerian Pidgin phrasing where it fits naturally (e.g. "sharp-sharp", "abeg", "no wahala"), but don't force it into every sentence.

Your job each turn:
- If the customer mentions any item they want (food, groceries, household items from the market — anything a market errand could cover), that's a normal part of building their order.
- If they ask something conversational related to their order — like asking to continue, confirming, changing an item, or asking what's in their list — engage naturally and helpfully. This is NOT off-topic; it's part of taking their order.
- If a customer mentions a dish they want to cook and isn't sure what to buy, suggest the typical ingredients for it in a friendly, brief way, and offer to add them to their order.
- Only treat a message as truly unrelated (and gently redirect back to ordering) if it has nothing at all to do with groceries, food, cooking, or their order — e.g. random small talk with no connection to shopping. Even then, respond warmly rather than with a rigid refusal.`,
  },
  email: {
    from: process.env.EMAIL_FROM ?? '',
    fromName: process.env.EMAIL_FROM_NAME ?? 'OjaRun',
    adminTo: process.env.EMAIL_ADMIN_TO ?? '',
    zeptoApiToken:
      process.env.ZEPTOMAIL_API_KEY ||
      process.env.ZEPTOMAIL_API_TOKEN ||
      process.env.ZEPTOMAIL_PASS ||
      '',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    resetExpiresIn: process.env.JWT_RESET_EXPIRES_IN ?? '15m',
  },
  cors: {
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:3001',
  },
  adminAppUrl:
    process.env.ADMIN_APP_URL ??
    process.env.CORS_ORIGIN?.split(',')[0]?.trim() ??
    'http://localhost:3001',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME ?? '',
    apiKey: process.env.CLOUDINARY_API_KEY ?? '',
    apiSecret: process.env.CLOUDINARY_API_SECRET ?? '',
    folder: process.env.CLOUDINARY_FOLDER ?? 'ojarun/products',
    tlsInsecure:
      process.env.CLOUDINARY_TLS_INSECURE === 'true' ||
      (process.env.NODE_ENV ?? 'development') !== 'production',
  },
});