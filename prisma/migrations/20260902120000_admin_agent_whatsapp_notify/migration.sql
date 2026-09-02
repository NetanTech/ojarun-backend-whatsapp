-- Agent WhatsApp alerts + order assignment tracking

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "Specialty" AS ENUM ('shopping', 'delivery', 'customer_support', 'management');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "AssignmentStatus" AS ENUM ('pending', 'accepted', 'in_progress', 'completed', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Admin: fields for agent order alerts
ALTER TABLE "admins"
ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "isOnDuty" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT,
ADD COLUMN IF NOT EXISTS "specialty" "Specialty";

-- order_assignments (links notified agents to orders)
CREATE TABLE IF NOT EXISTS "order_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "order_id" UUID NOT NULL,
  "admin_id" UUID NOT NULL,
  "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "notes" TEXT,
  "status" "AssignmentStatus" NOT NULL DEFAULT 'pending',
  CONSTRAINT "order_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "order_assignments_order_id_idx" ON "order_assignments"("order_id");
CREATE INDEX IF NOT EXISTS "order_assignments_admin_id_idx" ON "order_assignments"("admin_id");

DO $$ BEGIN
  ALTER TABLE "order_assignments"
  ADD CONSTRAINT "order_assignments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "order_assignments"
  ADD CONSTRAINT "order_assignments_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
