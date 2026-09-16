import { matchCatalogProduct, CatalogProduct } from "./product-match.util";

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}

/** "Per kg" / "per derica" / "kg" → a short unit for customer copy. */
export function displayUnit(unit: string): string {
  return (
    unit
      .trim()
      .replace(/^per\s+/i, "")
      .replace(/^\/\s*/, "")
      .trim() || "unit"
  );
}

/**
 * Items Nigerians usually buy by budget ("N2000 worth"), not by kg —
 * pepper, spices, paste, seasoning, etc.
 */
const WORTH_ITEM_RE =
  /\b(pepper|dry pepper|ata|ata rodo|shombo|crayfish|maggi|seasoning|thyme|curry|salt|tomato paste|tin tomato|groundnut|egusi|ogbono|locust bean|iru|ogiri)\b/i;

export function prefersWorth(itemName: string, _catalogUnit?: string | null): boolean {
  return WORTH_ITEM_RE.test(itemName);
}

export function quantityExamples(
  unit?: string | null,
  opts?: { worth?: boolean },
): string {
  if (opts?.worth) {
    return `"N2000 worth", "N5k", "pepper 3000"`;
  }
  const u = displayUnit(unit || "kg").toLowerCase();
  if (/derica|dirica/.test(u)) {
    return `"1 derica", "2 derica", "N5000 worth"`;
  }
  if (/kg|kilo/.test(u)) {
    return `"2 kg", "1 derica", "N5000 worth"`;
  }
  if (/bottle/.test(u)) return `"1 bottle", "2 bottles"`;
  if (/bag/.test(u)) return `"1 bag", "2 bags"`;
  if (/cup/.test(u)) return `"2 cups", "N5000 worth"`;
  if (/congo/.test(u)) return `"1 congo", "2 congo", "N5000 worth"`;
  return `"2 ${u}", "1 derica", "N5000 worth"`;
}

/** One short line for a compact multi-item price board. */
export function priceBoardLine(
  itemName: string,
  product: CatalogProduct | null,
): string {
  if (!product) {
    const worth = prefersWorth(itemName);
    return worth
      ? `• *${itemName}* — tell me Naira worth (e.g. "N2000")`
      : `• *${itemName}* — tell me how much (e.g. "2 kg" or "N2000")`;
  }

  const price = Number(product.currentPrice);
  const unit = displayUnit(String(product.unit || "unit"));
  const worth = prefersWorth(product.name, unit);
  if (worth) {
    return `• *${product.name}* — *${formatNaira(price)}* / ${unit} today → reply with *Naira worth* (e.g. "N2000")`;
  }
  return `• *${product.name}* — *${formatNaira(price)}* / ${unit} today`;
}

export function quoteQuantityPrompt(
  itemName: string,
  product: CatalogProduct | null,
): string {
  if (!product) {
    const worth = prefersWorth(itemName);
    if (worth) {
      return `How much *${itemName}* do you want in Naira? (e.g. ${quantityExamples(null, { worth: true })})`;
    }
    return `How much *${itemName}* do you want? (e.g. ${quantityExamples("kg")})`;
  }

  const price = Number(product.currentPrice);
  const unit = displayUnit(String(product.unit || "unit"));
  const worth = prefersWorth(product.name, unit);

  if (worth) {
    return (
      `*${product.name}* is *${formatNaira(price)}* per ${unit} today.\n\n` +
      `How much do you want in *Naira worth*? (e.g. ${quantityExamples(unit, { worth: true })})`
    );
  }

  return (
    `*${product.name}* is *${formatNaira(price)}* per ${unit} today.\n\n` +
    `How many ${unit} do you want? (e.g. ${quantityExamples(unit)})`
  );
}

export function findLiveProduct(
  itemName: string,
  products: CatalogProduct[],
): CatalogProduct | null {
  return matchCatalogProduct(itemName, products);
}
