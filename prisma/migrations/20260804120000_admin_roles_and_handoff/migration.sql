-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('superadmin', 'admin', 'customer_care', 'customer_support');

-- AlterTable
ALTER TABLE "admins"
ADD COLUMN "role" "AdminRole" NOT NULL DEFAULT 'admin',
ADD COLUMN "avatar_url" TEXT;

-- Bootstrap: oldest admin becomes superadmin so role changes are possible
UPDATE "admins"
SET "role" = 'superadmin'
WHERE "id" = (
  SELECT "id" FROM "admins" ORDER BY "created_at" ASC LIMIT 1
);

-- AlterTable
ALTER TABLE "conversations"
ADD COLUMN "assigned_admin_id" UUID;

-- CreateIndex
CREATE INDEX "conversations_assigned_admin_id_idx" ON "conversations"("assigned_admin_id");

-- CreateIndex
CREATE INDEX "conversations_mode_idx" ON "conversations"("mode");

-- AddForeignKey
ALTER TABLE "conversations"
ADD CONSTRAINT "conversations_assigned_admin_id_fkey"
FOREIGN KEY ("assigned_admin_id") REFERENCES "admins"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
