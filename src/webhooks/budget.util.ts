export type BudgetDraftItem = {
  name: string;
  quantity: number;
  unit: string;
};

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

/**
 * Nigerian market shorthand: "maggi 2k" / "fish 2k apple 4k" means ₦2000 / ₦4000,
 * NOT 2kg / 4kg. "2kg" / "2 kg" stay as weight.
 */
export function extractBudgetItemsFromMessage(message: string): BudgetDraftItem[] {
  const text = message.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const items: BudgetDraftItem[] = [];
  const seen = new Set<string>();

  // name + amount + k (not kg)  e.g. "maggi 2k", "apple 4k"
  const kRe =
    /([a-zA-Z][a-zA-Z]*(?:\s+[a-zA-Z][a-zA-Z]*){0,3}?)\s+(\d+(?:\.\d+)?)\s*k(?!g)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = kRe.exec(text)) !== null) {
    const name = cleanItemName(m[1]);
    const n = Number(m[2]);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    const amount = Math.round(n * 1000);
    if (amount < 100) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, quantity: 1, unit: `N${amount} worth` });
  }

  // name + N/₦ amount  e.g. "fish N2000", "potato ₦5,000"
  const nairaRe =
    /([a-zA-Z][a-zA-Z]*(?:\s+[a-zA-Z][a-zA-Z]*){0,3}?)\s+[n₦]\s*(\d[\d,]*(?:\.\d+)?)\s*k?\b/gi;
  while ((m = nairaRe.exec(text)) !== null) {
    const name = cleanItemName(m[1]);
    let amount = Number(String(m[2]).replace(/,/g, ''));
    if (!name || !Number.isFinite(amount) || amount <= 0) continue;
    if (/\d\s*k\b/i.test(m[0]) || /[n₦]\s*\d+\s*k\b/i.test(m[0])) amount *= 1000;
    amount = Math.round(amount);
    if (amount < 100) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, quantity: 1, unit: `N${amount} worth` });
  }

  // name + N thousand  e.g. "fish 2 thousand"
  const thousandRe =
    /([a-zA-Z][a-zA-Z]*(?:\s+[a-zA-Z][a-zA-Z]*){0,3}?)\s+(\d+(?:\.\d+)?)\s*thousand\b/gi;
  while ((m = thousandRe.exec(text)) !== null) {
    const name = cleanItemName(m[1]);
    const n = Number(m[2]);
    if (!name || !Number.isFinite(n) || n <= 0) continue;
    const amount = Math.round(n * 1000);
    if (amount < 100) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, quantity: 1, unit: `N${amount} worth` });
  }

  return items;
}

/**
 * When the model misreads "2k" as quantity=2 unit=kg, rewrite using
 * budget hints from the customer's actual message.
 */
export function applyBudgetHintsFromMessage(
  message: string,
  items: BudgetDraftItem[],
): BudgetDraftItem[] {
  const hints = extractBudgetItemsFromMessage(message);
  if (hints.length === 0) return items;

  const byName = new Map(hints.map((h) => [h.name.toLowerCase(), h]));

  return items.map((item) => {
    const hint =
      byName.get(item.name.toLowerCase()) ||
      [...byName.entries()].find(
        ([key]) =>
          item.name.toLowerCase().includes(key) ||
          key.includes(item.name.toLowerCase()),
      )?.[1];

    if (!hint) return item;

    // Only override when it looks like a misread weight/count for a money ask
    const unit = item.unit.toLowerCase();
    const looksLikeWeightOrCount =
      /^(kg|g|kilo|kilos|piece|pieces|pcs|pack|packs|bag|bags)?$/.test(unit) ||
      unit === 'kg' ||
      unit === 'g';
    const budget = parseBudgetNaira(item.unit, item.name);
    if (budget != null) return item; // already money-shaped
    if (!looksLikeWeightOrCount && !/^\d+(\.\d+)?$/.test(unit)) {
      // unusual unit — still prefer explicit message budget when present
    }
    return { name: item.name, quantity: 1, unit: hint.unit };
  });
}

function cleanItemName(raw: string): string {
  const stop = new Set([
    'add',
    'buy',
    'get',
    'want',
    'wanna',
    'need',
    'please',
    'abeg',
    'and',
    'with',
    'also',
    'plus',
    'of',
    'some',
    'the',
    'a',
    'an',
    'my',
    'order',
    'for',
    'thousand',
    'naira',
    'ngn',
    'worth',
  ]);
  const parts = raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p && !stop.has(p));
  if (parts.length === 0) return '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}
