-- Switch signup verification from phone/SMS to email.

-- AlterTable
ALTER TABLE "customer_otps" RENAME COLUMN "phone" TO "email";

-- RenameIndex
ALTER INDEX "customer_otps_phone_idx" RENAME TO "customer_otps_email_idx";

-- AlterTable
ALTER TABLE "customers" RENAME COLUMN "phone_verified_at" TO "email_verified_at";
