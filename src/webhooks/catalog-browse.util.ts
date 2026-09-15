export type BrowseIntent =
  | { kind: "index" }
  | { kind: "category"; category: string }
  | { kind: "search"; query: string }
  | { kind: "product"; productId: string };

const INDEX_PHRASES = new Set([
  "browse",
  "catalog",
  "catalogue",
  "products",
  "product list",
  "price",
  "prices",
  "pricing",
  "price list",
  "wetin dey",
  "wetin you get",
  "wetin una get",
  "what's available",
  "whats available",
  "what is available",
  "what do you sell",
  "what can i buy",
  "show products",
  "show me products",
  "show me the products",
  "list products",
  "see products",
  "see prices",
  "show me prices",
  "market list",
  "today's market",
  "todays market",
  "what do you have",
  "wetin una dey sell",
]);

const SEARCH_PREFIX =
  /^(?:browse|catalog|catalogue|products?|prices?|pricing)\s+(?:of\s+|for\s+)?(.+)$/i;
const HOW_MUCH_PREFIX = /^(?:how\s+much(?:\s+is|\s+for)?)\s+(.+)$/i;
const PRICE_OF_PREFIX =
  /^(?:what(?:'s|s|\s+is)\s+the\s+price\s+(?:of|for)|wetin\s+be\s+(?:the\s+)?price\s+(?:of|for))\s+(.+)$/i;
const STOCK_PREFIX =
  /^(?:do\s+you\s+have|have\s+you\s+got|una\s+get|una\s+dey\s+sell|you\s+(?:sell|get|dey\s+sell))\s+(.+)$/i;

const PRODUCT_ID_RE =
  /^browse:product:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function normalizePhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[?.!]/g, "")
    .replace(/\s+/g, " ");
}

function stripLeadingQuantity(query: string): string {
  return query
    .replace(
      /^\d+(?:\.\d+)?\s*(?:kg|kilo|kilos|g|grams?|piece|pcs|cup|cups|bag|bags|bottle|bottles|can|cans|pack|packs|tuber|tubers|congo|tray|trays)\s+/i,
      "",
    )
    .trim();
}

/**
 * True when the customer is asking to see the live catalog / a price,
 * not placing an order. Quantity-led messages stay with the order flow.
 */
export function parseBrowseIntent(text: string): BrowseIntent | null {
  const raw = text.trim();
  if (!raw) return null;

  if (raw.startsWith("browse:cat:")) {
    const category = raw.slice("browse:cat:".length).trim();
    return category ? { kind: "category", category } : { kind: "index" };
  }

  const productMatch = PRODUCT_ID_RE.exec(raw);
  if (productMatch) {
    return { kind: "product", productId: productMatch[1] };
  }

  const phrase = normalizePhrase(raw);
  if (INDEX_PHRASES.has(phrase)) return { kind: "index" };

  const searchMatch =
    SEARCH_PREFIX.exec(raw) ||
    HOW_MUCH_PREFIX.exec(raw) ||
    PRICE_OF_PREFIX.exec(raw) ||
    STOCK_PREFIX.exec(raw);

  if (!searchMatch?.[1]) return null;

  const query = stripLeadingQuantity(searchMatch[1]);
  if (!query || INDEX_PHRASES.has(normalizePhrase(query))) {
    return { kind: "index" };
  }

  return { kind: "search", query };
}

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}

export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

export function chunkWhatsAppText(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < 80) cut = rest.lastIndexOf("\n", limit);
    if (cut < 80) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
