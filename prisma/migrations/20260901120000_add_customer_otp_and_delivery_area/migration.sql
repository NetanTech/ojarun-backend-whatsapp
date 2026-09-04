-- AlterTable
ALTER TABLE "customers" ADD COLUMN "delivery_area" TEXT;

-- CreateTable
CREATE TABLE "customer_otps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_otps_phone_idx" ON "customer_otps"("phone");
