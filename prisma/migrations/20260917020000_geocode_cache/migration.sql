-- Cache resolved addresses so repeat checkouts cost no external lookups.
CREATE TABLE "geocode_cache" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "normalized"  TEXT NOT NULL,
  "raw_address" TEXT NOT NULL,
  "lat"         DOUBLE PRECISION NOT NULL,
  "lng"         DOUBLE PRECISION NOT NULL,
  "label"       TEXT,
  "distance_km" DECIMAL(6,2) NOT NULL,
  "source"      TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "geocode_cache_normalized_key" ON "geocode_cache" ("normalized");
