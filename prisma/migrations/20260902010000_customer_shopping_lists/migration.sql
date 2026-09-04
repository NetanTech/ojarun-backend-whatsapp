-- CreateTable
CREATE TABLE "customer_shopping_lists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_shopping_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_shopping_list_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "list_id" UUID NOT NULL,
    "product_id" UUID,
    "product_name_snapshot" TEXT NOT NULL,
    "unit_snapshot" TEXT NOT NULL,
    "price_snapshot" DECIMAL(12,2) NOT NULL,
    "image_url_snapshot" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "customer_shopping_list_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_shopping_lists_customer_id_idx" ON "customer_shopping_lists"("customer_id");

-- CreateIndex
CREATE INDEX "customer_shopping_list_items_list_id_idx" ON "customer_shopping_list_items"("list_id");

-- AddForeignKey
ALTER TABLE "customer_shopping_lists" ADD CONSTRAINT "customer_shopping_lists_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_shopping_list_items" ADD CONSTRAINT "customer_shopping_list_items_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "customer_shopping_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_shopping_list_items" ADD CONSTRAINT "customer_shopping_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
