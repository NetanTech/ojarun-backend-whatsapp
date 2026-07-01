-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('bot', 'human');

-- CreateEnum
CREATE TYPE "ChatSessionStatus" AS ENUM ('active', 'closed');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "context_summary" TEXT,
ADD COLUMN     "context_summary_updated_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "session_id" UUID;

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "mode" "ConversationMode" NOT NULL DEFAULT 'bot',
    "state" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "ChatSessionStatus" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "summary" TEXT,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_orders" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "phone" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminded_at" TIMESTAMPTZ(6),
    "completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pending_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_customer_id_key" ON "conversations"("customer_id");

-- CreateIndex
CREATE INDEX "conversations_customer_id_idx" ON "conversations"("customer_id");

-- CreateIndex
CREATE INDEX "chat_sessions_customer_id_status_idx" ON "chat_sessions"("customer_id", "status");

-- CreateIndex
CREATE INDEX "chat_sessions_last_activity_at_idx" ON "chat_sessions"("last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "bot_responses_key_key" ON "bot_responses"("key");

-- CreateIndex
CREATE UNIQUE INDEX "pending_orders_phone_key" ON "pending_orders"("phone");

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_idx" ON "messages"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
