/**
 * Parse customer budget amounts from draft unit/name text.
 * Examples: "N2000 worth", "₦5k", "5000 naira", "2 thousand"
 */
export function parseBudgetNaira(unit: string, name = ''): number | null {
  const text = `${unit} ${name}`.toLowerCase().replace(/,/g, ' ').trim();
  if (!text) return null;

  // Prefer explicit naira markers so we don't treat "2 kg" as money
  const patterns: RegExp[] = [
    /[n₦]\s*(\d+(?:\.\d+)?)\s*k\b/, // N5k / ₦5k
    /[n₦]\s*(\d+(?:\.\d+)?)\b/, // N2000 / ₦2000
    /(\d+(?:\.\d+)?)\s*k\s*(?:naira|ngn|worth)\b/, // 5k worth
    /(\d+(?:\.\d+)?)\s*(?:naira|ngn)\b/, // 2000 naira
    /(\d+(?:\.\d+)?)\s*thousand(?:\s*(?:naira|ngn|worth))?/, // 2 thousand
    /(\d+(?:\.\d+)?)\s*worth\b/, // 5000 worth (AI unit style)
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    let amount = Number(m[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const matched = m[0];
    if (/\bthousand\b/.test(matched)) {
      amount *= 1000;
    } else if (/\d\s*k\b/.test(matched) || /[n₦]\s*\d+(?:\.\d+)?\s*k\b/.test(matched)) {
      amount *= 1000;
    }
    // Sanity: market line budgets are usually >= 100 naira
    if (amount < 100) continue;
    return Math.round(amount);
  }

  return null;
}
