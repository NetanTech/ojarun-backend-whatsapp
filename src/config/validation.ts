/**
 * Fail fast at boot if required env vars are missing.
 * Warn in dev; throw in production. The webhook is unforgiving — if any
 * of these are wrong the bot is dead, and you want to know immediately.
 */
export function validateConfig(config: Record<string, any>): Record<string, any> {
  const required = [
    'DATABASE_URL',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
  ];

  const missing = required.filter((k) => !config[k]);
  if (missing.length === 0) return config;

  const msg = `Missing required env vars: ${missing.join(', ')}`;
  if (config.NODE_ENV === 'production') {
    throw new Error(msg);
  }
  // eslint-disable-next-line no-console
  console.warn(`⚠️  ${msg} — OK in dev, will throw in production.`);
  return config;
}
