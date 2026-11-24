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
  sms: {
    termiiApiKey: process.env.TERMII_API_KEY ?? '',
    senderId: process.env.SMS_SENDER_ID ?? 'Ojarun',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    resetExpiresIn: process.env.JWT_RESET_EXPIRES_IN ?? '15m',
  },
  cors: {
    // Render's dashboard has this saved as CORS_ORIGINS (plural) — accept
    // either name so a mismatched env var name in any given deployment
    // doesn't silently fall back to the localhost default.
    origin:
      process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? 'http://localhost:3001',
  },
  adminAppUrl:
    process.env.ADMIN_APP_URL ??
    (process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN)?.split(',')[0]?.trim() ??
    'http://localhost:3001',
  // Public URL of this Nest API (used for Paystack webhook / redirects)
  publicApiUrl:
    process.env.PUBLIC_API_URL ??
    process.env.BACKEND_PUBLIC_URL ??
    `http://localhost:${parseInt(process.env.PORT ?? '4000', 10)}`,
  webAppUrl: process.env.WEB_APP_URL ?? 'http://localhost:3000',
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY ?? '',
    publicKey: process.env.PAYSTACK_PUBLIC_KEY ?? '',
    // Optional override; defaults to Paystack HMAC with secretKey
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET ?? '',
  },
  fees: {
    // Shopper/service fee. Charged on every order regardless of the channel it
    // came through, so WhatsApp and web quote the same price for the same cart.
    // Tiered by cart value: perBand naira for every bandSize naira of items,
    // bands starting at bandSize + edge (15,100, 30,100…). See
    // src/common/service-fee.util.ts. Replaces the old flat SERVICE_FEE_NAIRA.
    serviceFeePerBandNaira: parseInt(process.env.SERVICE_FEE_PER_BAND ?? '1500', 10),
    serviceFeeBandNaira: parseInt(process.env.SERVICE_FEE_BAND ?? '15000', 10),
    serviceFeeBandEdgeNaira: parseInt(process.env.SERVICE_FEE_BAND_EDGE ?? '100', 10),
    // Smallest amount one line of a website order may come to (price ×
    // quantity), so nobody orders e.g. a single ₦250 egg. 0 switches it off.
    minLineTotalNaira: parseInt(process.env.MIN_LINE_TOTAL_NAIRA ?? '500', 10),
  },
  google: {
    mapsApiKey:
      process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_API_KEY ?? '',
  },
  ors: {
    apiKey: process.env.ORS_API_KEY ?? '',
    // api.openrouteservice.org is being deprecated in favour of api.heigit.org;
    // both are tried in order so the switchover can't break pricing.
    baseUrls: (
      process.env.ORS_BASE_URLS ??
      'https://api.openrouteservice.org,https://api.heigit.org'
    )
      .split(',')
      .map((u) => u.trim().replace(/\/$/, ''))
      .filter(Boolean),
    tlsInsecure:
      process.env.ORS_TLS_INSECURE === 'true' ||
      (process.env.NODE_ENV ?? 'development') !== 'production',
  },
  // Distance-based delivery pricing. Origin is UI Second Gate, Ibadan — every
  // fee is measured from there. Rates are env-tunable so pricing can change
  // without a code deploy.
  delivery: {
    // UI Second Gate (Agbowo side), Ibadan, from the owner's Google Maps pin.
    originLat: parseFloat(process.env.DELIVERY_ORIGIN_LAT ?? '7.4503374'),
    originLng: parseFloat(process.env.DELIVERY_ORIGIN_LNG ?? '3.907946'),
    originName: process.env.DELIVERY_ORIGIN_NAME ?? 'UI Second Gate, Ibadan',
    // Straight-line km get multiplied by this to approximate road distance.
    roadFactor: parseFloat(process.env.DELIVERY_ROAD_FACTOR ?? '1.3'),
    // Owner's formula (Nov 2026): up to flatKm costs a flat flatFee; above
    // that F = baseFee + perKm × distance (the whole distance), rounded to
    // the nearest roundTo. E.g. 8.1 km: 700 + 190 × 8.1 = 2,239 → ₦2,250.
    flatFeeNaira: parseInt(process.env.DELIVERY_FLAT_FEE ?? '1300', 10),
    flatKm: parseFloat(process.env.DELIVERY_FLAT_KM ?? '4'),
    baseFeeNaira: parseInt(process.env.DELIVERY_BASE_FEE ?? '700', 10),
    perKmNaira: parseInt(process.env.DELIVERY_PER_KM ?? '190', 10),
    // 0 = no maximum (the owner removed the old ₦3,000 cap).
    maxFeeNaira: parseInt(process.env.DELIVERY_MAX_FEE ?? '0', 10),
    // Fees are rounded to the nearest clean note so riders aren't handling change.
    roundToNaira: parseInt(process.env.DELIVERY_ROUND_TO ?? '50', 10),
    // Charged when we can't place the address at all (vague landmark, map
    // service down). Same as the flat short-trip fee.
    fallbackFeeNaira: parseInt(process.env.DELIVERY_FALLBACK_FEE ?? '1300', 10),
    // Pins farther than this from the origin are rejected (out of service area).
    maxKm: parseFloat(process.env.DELIVERY_MAX_KM ?? '35'),
    // Launch offer: percent off the delivery fee on each customer's first
    // maxOrders non-cancelled orders placed between start and end (end is
    // exclusive). Defaults: 30% on the first 3 orders, 23 Nov – 22 Dec 2026,
    // Nigeria time. Set DELIVERY_PROMO_PERCENT=0 to switch it off.
    launchPromo: {
      percent: parseFloat(process.env.DELIVERY_PROMO_PERCENT ?? '30'),
      maxOrders: parseInt(process.env.DELIVERY_PROMO_MAX_ORDERS ?? '3', 10),
      start: process.env.DELIVERY_PROMO_START ?? '2026-11-23T00:00:00+01:00',
      end: process.env.DELIVERY_PROMO_END ?? '2026-12-23T00:00:00+01:00',
    },
  },
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