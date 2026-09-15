-- CreateTable
CREATE TABLE "meal_favorites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "meal_id" TEXT NOT NULL,
    "name_snapshot" TEXT NOT NULL,
    "image_url_snapshot" TEXT,
    "servings_snapshot" TEXT NOT NULL,
    "total_price_snapshot" DECIMAL(12,2) NOT NULL,
    "ingredient_count_snapshot" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meal_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_favorites_customer_id_idx" ON "meal_favorites"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "meal_favorites_customer_id_meal_id_key" ON "meal_favorites"("customer_id", "meal_id");

-- AddForeignKey
ALTER TABLE "meal_favorites" ADD CONSTRAINT "meal_favorites_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
