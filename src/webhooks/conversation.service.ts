import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ChatSessionStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, OrderDraftItem } from './ai.service';

const DEFAULT_IDLE_MINUTES = 360; // 6 hours of no messages = new conversation next time

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly config: ConfigService,
  ) {}

  private get idleMinutes(): number {
    return this.config.get<number>('conversation.idleMinutes') ?? DEFAULT_IDLE_MINUTES;
  }

  /**
   * Returns the customer's active conversation, or opens a new one if none
   * exists or the previous one has gone idle past the session window. This
   * is what keeps conversation-scoped history (and the AI's context window)
   * from mixing an order from three weeks ago into today's chat.
   */
  async getOrCreateActive(customerId: string) {
    const cutoff = new Date(Date.now() - this.idleMinutes * 60 * 1000);

    const active = await this.prisma.chatSession.findFirst({
      where: { customerId, status: ChatSessionStatus.active },
      orderBy: { lastActivityAt: 'desc' },
    });

    if (active && active.lastActivityAt >= cutoff) {
      return active;
    }

    if (active) {
      // Stale — close it now so the cron picks it up for summarization shortly after.
      await this.prisma.chatSession.update({
        where: { id: active.id },
        data: { status: ChatSessionStatus.closed, closedAt: new Date() },
      });
    }

    return this.prisma.chatSession.create({ data: { customerId } });
  }

  async touch(conversationId: string): Promise<void> {
    await this.prisma.chatSession.update({
      where: { id: conversationId },
      data: { lastActivityAt: new Date() },
    });
  }

  /**
   * Merges newly-mentioned items into the session's running draft — matched
   * by case-insensitive name, so a repeated mention of an item updates its
   * quantity/unit rather than duplicating it. This is what lets the AI just
   * report what changed each turn instead of restating the whole list.
   */
  async mergeDraft(
    sessionId: string,
    incomingItems: OrderDraftItem[],
    deliveryAddress: string | null,
  ): Promise<{ items: OrderDraftItem[]; deliveryAddress: string | null }> {
    const session = await this.prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    const existingItems = (session.draftItems as unknown as OrderDraftItem[] | null) ?? [];

    const merged = [...existingItems];
    for (const incoming of incomingItems) {
      const idx = merged.findIndex((m) => m.name.toLowerCase() === incoming.name.toLowerCase());
      if (idx >= 0) {
        merged[idx] = incoming;
      } else {
        merged.push(incoming);
      }
    }

    const updatedAddress = deliveryAddress ?? session.draftDeliveryAddress ?? null;

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: {
        draftItems: merged as unknown as Prisma.InputJsonValue,
        draftDeliveryAddress: updatedAddress,
      },
    });

    return { items: merged, deliveryAddress: updatedAddress };
  }

  async getDraft(sessionId: string): Promise<{ items: OrderDraftItem[]; deliveryAddress: string | null }> {
    const session = await this.prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    return {
      items: (session.draftItems as unknown as OrderDraftItem[] | null) ?? [],
      deliveryAddress: session.draftDeliveryAddress ?? null,
    };
  }

  async clearDraft(sessionId: string): Promise<void> {
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { draftItems: Prisma.JsonNull, draftDeliveryAddress: null },
    });
  }

  /**
   * Closes a session immediately rather than waiting for the idle timeout.
   * Called right after an order is confirmed — a confirmed order is a
   * natural end to that conversation, so the next message should start
   * completely fresh (clean history, empty draft) instead of continuing in
   * a session that still has the just-finished order's context in it.
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { status: ChatSessionStatus.closed, closedAt: new Date() },
    });
  }

  /**
   * Cron target: closes conversations that have gone idle, then generates a
   * short rolling profile for any closed-but-unsummarized conversation and
   * folds it into Customer.contextSummary — so even a brand new conversation
   * benefits from what was learned before (delivery area, usual items, etc.).
   */
  @Cron('0 */15 * * * *') // every 15 minutes
  async summarizeStaleConversations(): Promise<void> {
    const cutoff = new Date(Date.now() - this.idleMinutes * 60 * 1000);

    const toClose = await this.prisma.chatSession.findMany({
      where: { status: ChatSessionStatus.active, lastActivityAt: { lt: cutoff } },
    });

    for (const convo of toClose) {
      await this.prisma.chatSession.update({
        where: { id: convo.id },
        data: { status: ChatSessionStatus.closed, closedAt: new Date() },
      });
    }

    if (toClose.length > 0) {
      this.logger.log(`Closed ${toClose.length} idle conversation(s)`);
    }

    // Batch, don't hammer the AI provider in one pass if there's a backlog.
    const unsummarized = await this.prisma.chatSession.findMany({
      where: { status: ChatSessionStatus.closed, summary: null },
      take: 20,
    });

    for (const convo of unsummarized) {
      await this.summarizeSession(convo.id);
    }
  }

  /**
   * Summarizes one session and folds it into the customer's rolling
   * profile. Public so it can be triggered immediately when a session
   * closes (e.g. right after an order is confirmed), not just picked up
   * by the cron up to 15 minutes later — that lag was creating a real
   * memory gap right when customers were most likely to say something
   * else ("when's it arriving?").  Idempotent: the cron only picks up
   * sessions where summary is still null, so calling this immediately
   * and letting the cron also pass over it later is harmless.
   */
  async summarizeSession(conversationId: string): Promise<void> {
    const messages = await this.prisma.message.findMany({
      where: { sessionId: conversationId, body: { not: null } },
      orderBy: { createdAt: 'asc' },
    });

    // Nothing worth summarizing (e.g. a lone greeting) — mark it done so we
    // don't keep retrying it every 15 minutes forever.
    if (messages.length < 2) {
      await this.prisma.chatSession.update({ where: { id: conversationId }, data: { summary: '' } });
      return;
    }

    const transcript = messages.map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Bot'}: ${m.body}`).join('\n');

    const conversation = await this.prisma.chatSession.findUniqueOrThrow({
      where: { id: conversationId },
      include: { customer: true },
    });

    const updatedSummary = await this.ai.summarizeConversation(transcript, conversation.customer.contextSummary ?? null);
    if (!updatedSummary) return; // non-fatal — cron will retry next pass since summary stays null

    await this.prisma.$transaction([
      this.prisma.chatSession.update({ where: { id: conversationId }, data: { summary: updatedSummary } }),
      this.prisma.customer.update({
        where: { id: conversation.customerId },
        data: { contextSummary: updatedSummary, contextSummaryUpdatedAt: new Date() },
      }),
    ]);

    this.logger.log(`Summarized conversation ${conversationId} for customer ${conversation.customerId}`);
  }
}