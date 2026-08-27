export type BudgetDraftItem = {
  name: string;
  quantity: number;
  unit: string;
};

// Common market items (used for merging multi-word items)
const COMMON_ITEMS = new Set([
  'beans', 'garri', 'pepper', 'titus', 'yam', 'plantain', 'corn',
  'rice', 'flour', 'sugar', 'salt', 'maggi', 'tomato', 'onion',
  'potato', 'kote', 'kot', 'irish potato', 'sweet potato',
  'fish', 'chicken', 'beef', 'goat', 'egg', 'milk', 'butter',
  'oil', 'groundnut', 'palm oil', 'vegetable oil', 'spaghetti',
  'noodles', 'indomie', 'crayfish', 'dry fish', 'stock fish',
  'okra', 'spinach', 'ugwu', 'waterleaf', 'cabbage', 'carrot',
  'garlic', 'ginger', 'thyme', 'curry', 'pepper soup', 'pomo',
  'shaki', 'roundabout', 'beef tripe', 'cow foot', 'goat head',
  'cocoyam', 'watermelon', 'pawpaw', 'pineapple', 'banana',
  'orange', 'apple', 'grape', 'mango', 'avocado', 'coconut',
  'live chicken', 'ofada rice', 'irish potato', 'sweet potato',
  'palm oil', 'vegetable oil', 'pepper soup', 'beef tripe',
  'cow foot', 'goat head', 'dry fish', 'stock fish',
  'coconut oil', 'groundnut oil', 'brown beans', 'white beans',
  'honey beans', 'oloyin beans', 'plantain chips'
]);

/**
 * Extract plain item names from a message (no money amounts)
 * e.g. "beans Fish Corn Live chicken Yam Ofada rice" → ["beans", "fish", "corn", "live chicken", "yam", "ofada rice"]
 */
export function extractPlainItemNames(message: string): string[] {
  if (!message || message.trim().length < 2) return [];
  
  // Remove common filler words and punctuation
  const cleaned = message
    .replace(/\b(i want|i need|buy|get|order|please|abeg|and|with|also|plus|from|market|pls|can i get|i would like)\b/gi, ' ')
    .replace(/[.,!?'"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  if (!cleaned) return [];

  // Split by commas, "and", newlines, or multiple spaces
  let parts = cleaned.split(/[,;]|\band\b|\n+/).flatMap(p => p.trim().split(/\s{2,}/)).filter(p => p.length > 0);
  
  // If only one part with spaces, split by spaces
  if (parts.length === 1 && parts[0].includes(' ')) {
    parts = parts[0].split(/\s+/).filter(p => p.length > 1);
  }

  // Remove stop words
  const stopWords = new Set(['of', 'the', 'a', 'an', 'for', 'to', 'with', 'and', 'or', 'but', 'so']);
  let tokens = parts
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 1 && !stopWords.has(p));

  if (tokens.length === 0) return [];

  // Merge tokens into known multi-word items
  const merged: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let found = false;
    // Try to combine with next token(s) to form a known item (up to 3 words)
    for (let j = Math.min(tokens.length - i, 3); j >= 2; j--) {
      const candidate = tokens.slice(i, i + j).join(' ');
      if (COMMON_ITEMS.has(candidate)) {
        merged.push(candidate);
        i += j;
        found = true;
        break;
      }
    }
    if (!found) {
      // Check if this token is a known item by itself
      if (COMMON_ITEMS.has(tokens[i])) {
        merged.push(tokens[i]);
      } else {
        // Try to clean the token (remove common suffixes)
        const cleanToken = tokens[i].replace(/s$/, ''); // remove plural 's'
        if (COMMON_ITEMS.has(cleanToken)) {
          merged.push(cleanToken);
        } else {
          merged.push(tokens[i]);
        }
      }
      i++;
    }
  }

  // Remove duplicates
  const seen = new Set<string>();
  return merged.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
    'add', 'buy', 'get', 'want', 'wanna', 'need', 'please', 'abeg',
    'and', 'with', 'also', 'plus', 'of', 'some', 'the', 'a', 'an',
    'my', 'order', 'for', 'thousand', 'naira', 'ngn', 'worth',
    'i', 'you', 'me', 'can', 'will', 'would', 'like', 'am', 'is',
    'are', 'was', 'were', 'have', 'has', 'had', 'do', 'does', 'did'
  ]);
  const parts = raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p && !stop.has(p));
  if (parts.length === 0) return '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}