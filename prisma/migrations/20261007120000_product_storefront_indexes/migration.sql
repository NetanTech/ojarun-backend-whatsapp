-- Speed up storefront catalog queries (available + newest first, category filter).
CREATE INDEX IF NOT EXISTS "products_is_available_created_at_idx"
  ON "products" ("is_available", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "products_category_idx"
  ON "products" ("category");

CREATE INDEX IF NOT EXISTS "products_name_idx"
  ON "products" ("name");
