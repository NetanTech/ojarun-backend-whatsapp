-- The delivery run the customer chose (or the earliest allowed one).
ALTER TABLE "orders" ADD COLUMN "delivery_at" TIMESTAMPTZ(6);
CREATE INDEX "orders_delivery_at_idx" ON "orders"("delivery_at");

-- Runs offered by the WhatsApp bot's "when should we deliver?" question.
ALTER TABLE "chat_sessions" ADD COLUMN "delivery_prompt" JSONB;
