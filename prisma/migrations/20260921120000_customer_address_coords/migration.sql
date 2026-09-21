-- Persist map pins on saved addresses so checkout can re-quote without
-- forcing the customer to drop a pin again every time.
ALTER TABLE "customer_addresses"
  ADD COLUMN IF NOT EXISTS "lat" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lng" DOUBLE PRECISION;
