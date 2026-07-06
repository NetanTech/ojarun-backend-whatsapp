-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN     "draft_delivery_address" TEXT,
ADD COLUMN     "draft_items" JSONB;
