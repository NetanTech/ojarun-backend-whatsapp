-- CreateEnum
CREATE TYPE "RewardTransactionType" AS ENUM ('earned', 'redeemed');

-- CreateEnum
CREATE TYPE "RewardTransactionStatus" AS ENUM ('successful', 'failed');

-- AlterTable
ALTER TABLE "customers"
  ADD COLUMN "points" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "referral_code" TEXT,
  ADD COLUMN "referred_by_id" UUID;

-- Backfill referral codes for existing customers before enforcing NOT NULL/UNIQUE
UPDATE "customers"
SET "referral_code" = upper(substr(md5(random()::text || "id"::text || clock_timestamp()::text), 1, 10))
WHERE "referral_code" IS NULL;

ALTER TABLE "customers" ALTER COLUMN "referral_code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "customers_referral_code_key" ON "customers"("referral_code");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_referred_by_id_fkey"
  FOREIGN KEY ("referred_by_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "reward_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "type" "RewardTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "status" "RewardTransactionStatus" NOT NULL DEFAULT 'successful',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "reward_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reward_transactions_customer_id_created_at_idx" ON "reward_transactions"("customer_id", "created_at");

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_transactions" ADD CONSTRAINT "reward_transactions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
