-- AlterTable
ALTER TABLE "customers"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "password_hash" TEXT,
  ADD COLUMN "phone_verified_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateTable
CREATE TABLE "customer_password_reset_otps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_password_reset_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_password_reset_otps_email_idx" ON "customer_password_reset_otps"("email");
