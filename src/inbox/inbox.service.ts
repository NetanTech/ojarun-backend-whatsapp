import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConversationMode,
  MessageDirection,
  Prisma,
  ChatSessionStatus,
  AdminRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

type ListRow = {
  customer_id: string;
  name: string | null;
  whatsapp_number: string;
  mode: ConversationMode | null;
  assigned_admin_id: string | null;
  message_id: string | null;
  body: string | null;
  direction: MessageDirection | null;
  created_at: Date | null;
  admin_id: string | null;
  admin_name: string | null;
  admin_email: string | null;
  admin_role: AdminRole | null;
};

@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async list(search?: string) {
    const q = search?.trim();
    const rows = q
      ? await this.prisma.$queryRaw<ListRow[]>`
          SELECT * FROM (
            SELECT DISTINCT ON (m.customer_id)
              m.customer_id,
              c.name,
              c.whatsapp_number,
              conv.mode,
              conv.assigned_admin_id,
              m.id AS message_id,
              m.body,
              m.direction,
              m.created_at,
              a.id AS admin_id,
              a.name AS admin_name,
              a.email AS admin_email,
              a.role AS admin_role
            FROM messages m
            INNER JOIN customers c ON c.id = m.customer_id
            LEFT JOIN conversations conv ON conv.customer_id = c.id
            LEFT JOIN admins a ON a.id = conv.assigned_admin_id
            WHERE c.name ILIKE ${'%' + q + '%'}
               OR c.whatsapp_number ILIKE ${'%' + q + '%'}
            ORDER BY m.customer_id, m.created_at DESC
          ) t
          ORDER BY t.created_at DESC NULLS LAST
          LIMIT 50
        `
      : await this.prisma.$queryRaw<ListRow[]>`
          SELECT * FROM (
            SELECT DISTINCT ON (m.customer_id)
              m.customer_id,
              c.name,
              c.whatsapp_number,
              conv.mode,
              conv.assigned_admin_id,
              m.id AS message_id,
              m.body,
              m.direction,
              m.created_at,
              a.id AS admin_id,
              a.name AS admin_name,
              a.email AS admin_email,
              a.role AS admin_role
            FROM messages m
            INNER JOIN customers c ON c.id = m.customer_id
            LEFT JOIN conversations conv ON conv.customer_id = c.id
            LEFT JOIN admins a ON a.id = conv.assigned_admin_id
            ORDER BY m.customer_id, m.created_at DESC
          ) t
          ORDER BY t.created_at DESC NULLS LAST
          LIMIT 50
        `;

    return rows.map((row) => ({
      customerId: row.customer_id,
      name: row.name,
      whatsappNumber: row.whatsapp_number,
      mode: row.mode ?? ConversationMode.bot,
      assignedAdmin: row.admin_id
        ? {
            id: row.admin_id,
            name: row.admin_name,
            email: row.admin_email!,
            role: row.admin_role!,
          }
        : null,
      lastMessage: row.message_id
        ? {
            id: row.message_id,
            body: row.body,
            direction: row.direction!,
            createdAt: row.created_at!,
          }
        : null,
      updatedAt: row.created_at ?? new Date(0),
    }));
  }

  async getMessages(customerId: string, limit = 200) {
    const take = Math.min(Math.max(limit, 1), 500);

    const [customer, handoff, messages] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, whatsappNumber: true },
      }),
      this.prisma.conversations.findUnique({
        where: { customer_id: customerId },
        select: {
          mode: true,
          assigned_admin: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
      }),
      this.prisma.message.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          body: true,
          direction: true,
          createdAt: true,
          whatsappMessageId: true,
        },
      }),
    ]);

    if (!customer) throw new NotFoundException('Customer not found');

    return {
      customer,
      mode: handoff?.mode ?? ConversationMode.bot,
      assignedAdmin: handoff?.assigned_admin ?? null,
      // Return chronological for the UI
      messages: messages.reverse(),
    };
  }

  async takeover(customerId: string, adminId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const handoff = await this.prisma.conversations.upsert({
      where: { customer_id: customerId },
      create: {
        customer_id: customerId,
        mode: ConversationMode.human,
        assigned_admin_id: adminId,
      },
      update: {
        mode: ConversationMode.human,
        assigned_admin_id: adminId,
        updated_at: new Date(),
      },
      include: {
        assigned_admin: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    return {
      customerId,
      mode: handoff.mode,
      assignedAdmin: handoff.assigned_admin,
      message: 'Conversation taken over. Bot replies are paused.',
    };
  }

  async release(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    await this.prisma.conversations.upsert({
      where: { customer_id: customerId },
      create: {
        customer_id: customerId,
        mode: ConversationMode.bot,
        assigned_admin_id: null,
      },
      update: {
        mode: ConversationMode.bot,
        assigned_admin_id: null,
        updated_at: new Date(),
      },
    });

    return {
      customerId,
      mode: ConversationMode.bot,
      assignedAdmin: null,
      message: 'Conversation released. Bot replies resumed.',
    };
  }

  async reply(customerId: string, adminId: string, body: string) {
    const text = body.trim();
    if (!text) throw new BadRequestException('Message body is required');

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, whatsappNumber: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    // Ensure human mode before sending (auto-takeover if still on bot)
    let handoff = await this.prisma.conversations.findUnique({
      where: { customer_id: customerId },
      select: { mode: true, assigned_admin_id: true },
    });
    if (handoff?.mode !== ConversationMode.human) {
      handoff = await this.prisma.conversations.upsert({
        where: { customer_id: customerId },
        create: {
          customer_id: customerId,
          mode: ConversationMode.human,
          assigned_admin_id: adminId,
        },
        update: {
          mode: ConversationMode.human,
          assigned_admin_id: adminId,
          updated_at: new Date(),
        },
        select: { mode: true, assigned_admin_id: true },
      });
    }

    const activeSession = await this.prisma.chatSession.findFirst({
      where: { customerId, status: ChatSessionStatus.active },
      orderBy: { lastActivityAt: 'desc' },
      select: { id: true },
    });

    const sent = await this.whatsapp.sendText(customer.whatsappNumber, text);
    if (!sent.ok) {
      throw new BadRequestException(
        sent.error || 'Failed to send WhatsApp message',
      );
    }

    const message = await this.prisma.message.create({
      data: {
        customerId,
        sessionId: activeSession?.id ?? null,
        whatsappMessageId: sent.wamid,
        direction: MessageDirection.outbound,
        body: text,
        raw: {
          source: 'admin_inbox',
          adminId,
          sentPayload: sent,
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        body: true,
        direction: true,
        createdAt: true,
        whatsappMessageId: true,
      },
    });

    // Best-effort side updates — never undo a successful WhatsApp send
    try {
      await Promise.all([
        activeSession
          ? this.prisma.chatSession.update({
              where: { id: activeSession.id },
              data: { lastActivityAt: new Date() },
            })
          : Promise.resolve(null),
        this.prisma.conversations.update({
          where: { customer_id: customerId },
          data: {
            mode: ConversationMode.human,
            assigned_admin_id: handoff.assigned_admin_id ?? adminId,
            updated_at: new Date(),
          },
        }),
      ]);
    } catch {
      // ignore
    }

    return message;
  }
}
