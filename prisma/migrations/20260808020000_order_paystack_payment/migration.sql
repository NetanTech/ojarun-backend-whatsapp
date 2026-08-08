-- AlterEnum
DO $$ BEGIN
  ALTER TYPE "OrderStatus" ADD VALUE 'awaiting_payment';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'pending', 'paid', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "payment_status" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
ADD COLUMN IF NOT EXISTS "paystack_reference" TEXT,
ADD COLUMN IF NOT EXISTS "payment_url" TEXT,
ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "orders_paystack_reference_key" ON "orders"("paystack_reference");
CREATE INDEX IF NOT EXISTS "orders_payment_status_idx" ON "orders"("payment_status");
