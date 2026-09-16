-- Snapshot the fee breakdown on each order so historical orders are never
-- re-costed from today's rate constants.
ALTER TABLE "orders"
  ADD COLUMN "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "delivery_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "agent_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "delivery_distance_km" DECIMAL(6,2),
  ADD COLUMN "delivery_lat" DOUBLE PRECISION,
  ADD COLUMN "delivery_lng" DOUBLE PRECISION;

-- Backfill existing rows with the flat fees that were in force when they were
-- placed: web orders paid a 1200 agent fee + 700 delivery, WhatsApp orders
-- paid neither. Subtotal is derived so the breakdown still adds up to total.
UPDATE "orders"
SET "agent_fee" = 1200,
    "delivery_fee" = 700,
    "subtotal" = GREATEST("total" + "discount_amount" - 1900, 0)
WHERE "channel" = 'web';

UPDATE "orders"
SET "subtotal" = GREATEST("total" + "discount_amount", 0)
WHERE "channel" <> 'web';
