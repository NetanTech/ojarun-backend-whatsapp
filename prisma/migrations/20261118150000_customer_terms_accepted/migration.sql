-- When the customer accepted the Terms & Conditions (null = not yet).
ALTER TABLE "customers" ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(6);
