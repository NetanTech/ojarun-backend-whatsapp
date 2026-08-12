export type CatalogProduct = {
  id: string;
  name: string;
  unit: string;
  currentPrice: { toString(): string } | number | string;
};

/**
 * Match a customer's item name to a catalog product (exact, contains, token overlap).
 */
export function matchCatalogProduct(
  itemName: string,
  products: CatalogProduct[],
): CatalogProduct | null {
  const needle = itemName.trim().toLowerCase();
  if (!needle || products.length === 0) return null;

  const normalized = products.map((p) => ({
    product: p,
    key: p.name.trim().toLowerCase(),
  }));

  const exact = normalized.find((p) => p.key === needle);
  if (exact) return exact.product;

  const contains = normalized.find(
    (p) => p.key.includes(needle) || needle.includes(p.key),
  );
  if (contains) return contains.product;

  const tokens = needle.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return null;

  let best: { product: CatalogProduct; score: number } | null = null;
  for (const { product, key } of normalized) {
    const score = tokens.filter((t) => key.includes(t)).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { product, score };
    }
  }
  return best?.product ?? null;
}
