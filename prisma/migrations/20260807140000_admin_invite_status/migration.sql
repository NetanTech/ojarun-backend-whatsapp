-- AlterEnum
DO $$ BEGIN
  ALTER TYPE "AdminRole" ADD VALUE 'agent';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AdminStatus" AS ENUM ('active', 'inactive', 'invited');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable
ALTER TABLE "admins"
ADD COLUMN IF NOT EXISTS "status" "AdminStatus" NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS "last_active_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "invite_token_hash" TEXT,
ADD COLUMN IF NOT EXISTS "invite_message" TEXT,
ADD COLUMN IF NOT EXISTS "invited_by_id" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admins_status_idx" ON "admins"("status");
