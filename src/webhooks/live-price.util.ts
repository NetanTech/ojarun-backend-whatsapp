import { matchCatalogProduct, CatalogProduct } from "./product-match.util";

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}

/** "Per kg" / "per derica" / "kg" → a short unit for customer copy. */
export function displayUnit(unit: string): string {
  return unit
    .trim()
    .replace(/^per\s+/i, "")
    .replace(/^\/\s*/, "")
    .trim() || "unit";
}

export function quantityExamples(unit?: string | null): string {
  const u = displayUnit(unit || "kg").toLowerCase();
  if (/derica|dirica/.test(u)) {
    return `"1 derica", "2 derica", "N5000 worth"`;
  }
  if (/kg|kilo/.test(u)) {
    return `"2 kg", "1 derica", "N5000 worth"`;
  }
  if (/bottle/.test(u)) return `"1 bottle", "2 bottles"`;
  if (/bag/.test(u)) return `"1 bag", "2 bags"`;
  if (/cup/.test(u)) return `"2 cups", "1 kg", "N5000 worth"`;
  return `"2 ${u}", "1 derica", "N5000 worth"`;
}

export function quoteQuantityPrompt(
  itemName: string,
  product: CatalogProduct | null,
): string {
  if (!product) {
    return `How much *${itemName}* do you want? (e.g. ${quantityExamples("kg")})`;
  }

  const price = Number(product.currentPrice);
  const unit = displayUnit(String(product.unit || "unit"));
  const examples = quantityExamples(unit);
  return (
    `*${product.name}* is *${formatNaira(price)}* per ${unit} today.\n\n` +
    `How many ${unit} do you want? (e.g. ${examples})`
  );
}

export function findLiveProduct(
  itemName: string,
  products: CatalogProduct[],
): CatalogProduct | null {
  return matchCatalogProduct(itemName, products);
}
