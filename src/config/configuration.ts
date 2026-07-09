export default () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
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
  },
  ai: {
    provider: process.env.AI_PROVIDER ?? 'groq',
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'llama3-8b-8192',
    systemPrompt: process.env.AI_SYSTEM_PROMPT ?? `You are a helpful assistant for OjaRun, a grocery delivery service in Ibadan, Nigeria. When a customer mentions a dish they want to cook, list the ingredients they'll need in a friendly WhatsApp message format. Keep it concise. End with "Reply ORDER to get these delivered to you! 🛒". Only respond to cooking/food related messages. For anything else, return exactly: NOT_FOOD`,
  },
  email: {
    host: process.env.ZEPTOMAIL_HOST ?? '',
    port: parseInt(process.env.ZEPTOMAIL_PORT ?? '465', 10),
    secure: true, // ZeptoMail's port 465 requires implicit TLS
    user: process.env.ZEPTOMAIL_USER ?? '',
    pass: process.env.ZEPTOMAIL_PASS ?? '',
    from: process.env.EMAIL_FROM ?? '',
    fromName: process.env.EMAIL_FROM_NAME ?? '',
    adminTo: process.env.EMAIL_ADMIN_TO ?? '',
  },
});