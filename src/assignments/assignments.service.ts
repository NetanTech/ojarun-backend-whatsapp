import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminRole,
  AssignmentStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthAdmin } from '../auth/current-admin.decorator';

/** Order is open for shopping + delivery work. */
const CLAIMABLE_STATUSES: OrderStatus[] = [
  OrderStatus.pending,
  OrderStatus.awaiting_payment,
  OrderStatus.confirmed,
  OrderStatus.shopping,
  OrderStatus.purchased,
  OrderStatus.dispatched,
];

const ACTIVE_CLAIM: AssignmentStatus[] = [
  AssignmentStatus.accepted,
  AssignmentStatus.in_progress,
];

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open queue: orders that need shopping/delivery and are not claimed yet.
   * Money stays with Ojarun — this is ownership of the job only.
   */
  async listQueue() {
    const claimedOrderIds = await this.activeClaimOrderIds();

    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: CLAIMABLE_STATUSES },
        ...(claimedOrderIds.length
          ? { id: { notIn: claimedOrderIds } }
          : {}),
      },
      include: {
        customer: { select: { name: true, whatsappNumber: true } },
        items: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return orders.map((order) => this.serializeQueueItem(order));
  }

  /** Jobs this agent currently owns (or completed for them). */
  async listMine(adminId: string, status?: AssignmentStatus) {
    const assignments = await this.prisma.orderAssignment.findMany({
      where: {
        adminId,
        ...(status
          ? { status }
          : {
              status: {
                in: [
                  AssignmentStatus.accepted,
                  AssignmentStatus.in_progress,
                  AssignmentStatus.completed,
                ],
              },
            }),
      },
      include: {
        order: {
          include: {
            customer: { select: { name: true, whatsappNumber: true } },
            items: true,
          },
        },
      },
      orderBy: { assignedAt: 'desc' },
    });

    return assignments.map((a) => ({
      assignmentId: a.id,
      status: a.status,
      assignedAt: a.assignedAt,
      completedAt: a.completedAt,
      notes: a.notes,
      order: this.serializeQueueItem(a.order),
    }));
  }

  /**
   * Exclusive claim: one agent owns shopping + delivery for the order.
   * Concurrent claims lose via unique partial index + transaction check.
   */
  async claim(orderId: string, admin: AuthAdmin) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (
      order.status === OrderStatus.delivered ||
      order.status === OrderStatus.cancelled
    ) {
      throw new BadRequestException(
        'This order is already finished and cannot be claimed.',
      );
    }
    if (!CLAIMABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException('This order cannot be claimed right now.');
    }

    try {
      const assignment = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.orderAssignment.findFirst({
          where: {
            orderId,
            status: { in: ACTIVE_CLAIM },
          },
          include: {
            admin: { select: { id: true, name: true } },
          },
        });

        if (existing) {
          if (existing.adminId === admin.id) {
            return existing;
          }
          throw new ConflictException(
            `Already claimed by ${existing.admin.name || 'another agent'}.`,
          );
        }

        // Drop leftover pending rows from the old notify-creates-assignment path.
        await tx.orderAssignment.updateMany({
          where: {
            orderId,
            status: AssignmentStatus.pending,
          },
          data: { status: AssignmentStatus.rejected },
        });

        return tx.orderAssignment.create({
          data: {
            orderId,
            adminId: admin.id,
            status: AssignmentStatus.accepted,
            notes: 'Claimed for shopping + delivery',
          },
        });
      });

      return this.getAssignmentDetail(assignment.id);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Another agent just claimed this order. Refresh the queue.',
        );
      }
      throw err;
    }
  }

  /** Put the job back in the open queue so another agent can claim it. */
  async release(orderId: string, admin: AuthAdmin, reason?: string) {
    const active = await this.prisma.orderAssignment.findFirst({
      where: {
        orderId,
        status: { in: ACTIVE_CLAIM },
      },
    });
    if (!active) {
      throw new NotFoundException('No active claim on this order');
    }

    const canRelease =
      active.adminId === admin.id ||
      admin.role === AdminRole.admin ||
      admin.role === AdminRole.superadmin;
    if (!canRelease) {
      throw new ForbiddenException('Only the claiming agent can release this order');
    }

    const updated = await this.prisma.orderAssignment.update({
      where: { id: active.id },
      data: {
        status: AssignmentStatus.rejected,
        completedAt: new Date(),
        notes: reason?.trim()
          ? `Released: ${reason.trim()}`
          : 'Released back to queue',
      },
    });

    return {
      orderId,
      assignmentId: updated.id,
      status: updated.status,
      message: 'Order is back in the open queue',
    };
  }

  /** Active claim for an order, if any (for admin order detail). */
  async getActiveClaim(orderId: string) {
    const active = await this.prisma.orderAssignment.findFirst({
      where: {
        orderId,
        status: { in: ACTIVE_CLAIM },
      },
      include: {
        admin: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
    if (!active) return null;
    return {
      assignmentId: active.id,
      status: active.status,
      assignedAt: active.assignedAt,
      agent: active.admin,
    };
  }

  /**
   * Agents may only advance orders they claimed.
   * Admins / superadmins can always override.
   */
  async assertCanUpdateOrder(orderId: string, admin: AuthAdmin) {
    if (
      admin.role === AdminRole.admin ||
      admin.role === AdminRole.superadmin
    ) {
      return;
    }

    const active = await this.prisma.orderAssignment.findFirst({
      where: {
        orderId,
        adminId: admin.id,
        status: { in: ACTIVE_CLAIM },
      },
      select: { id: true },
    });
    if (!active) {
      throw new ForbiddenException(
        'Claim this order first before updating its status.',
      );
    }
  }

  /** Mark the claimer's job done when the order is delivered. */
  async markCompletedForOrder(orderId: string) {
    await this.prisma.orderAssignment.updateMany({
      where: {
        orderId,
        status: { in: ACTIVE_CLAIM },
      },
      data: {
        status: AssignmentStatus.completed,
        completedAt: new Date(),
      },
    });
  }

  /** Free the claim when an order is cancelled mid-job. */
  async markReleasedForOrder(orderId: string) {
    await this.prisma.orderAssignment.updateMany({
      where: {
        orderId,
        status: { in: ACTIVE_CLAIM },
      },
      data: {
        status: AssignmentStatus.rejected,
        completedAt: new Date(),
        notes: 'Order cancelled',
      },
    });
  }

  /** Move accepted → in_progress once shopping starts. */
  async markInProgressForOrder(orderId: string) {
    await this.prisma.orderAssignment.updateMany({
      where: {
        orderId,
        status: AssignmentStatus.accepted,
      },
      data: { status: AssignmentStatus.in_progress },
    });
  }

  private async activeClaimOrderIds(): Promise<string[]> {
    const rows = await this.prisma.orderAssignment.findMany({
      where: { status: { in: ACTIVE_CLAIM } },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    return rows.map((r) => r.orderId);
  }

  private async getAssignmentDetail(assignmentId: string) {
    const a = await this.prisma.orderAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        admin: { select: { id: true, name: true, email: true } },
        order: {
          include: {
            customer: { select: { name: true, whatsappNumber: true } },
            items: true,
          },
        },
      },
    });
    if (!a) throw new NotFoundException('Assignment not found');
    return {
      assignmentId: a.id,
      status: a.status,
      assignedAt: a.assignedAt,
      agent: a.admin,
      order: this.serializeQueueItem(a.order),
    };
  }

  private serializeQueueItem(order: {
    id: string;
    status: OrderStatus;
    total: Prisma.Decimal;
    deliveryFee: Prisma.Decimal;
    agentFee: Prisma.Decimal;
    customerNotes: string | null;
    deliveryLat: number | null;
    deliveryLng: number | null;
    createdAt: Date;
    customer: { name: string | null; whatsappNumber: string };
    items: unknown[];
  }) {
    return {
      id: order.id,
      shortId: order.id.slice(0, 8).toUpperCase(),
      status: order.status,
      itemsCount: order.items.length,
      total: Number(order.total),
      deliveryFee: Number(order.deliveryFee),
      agentFee: Number(order.agentFee),
      deliveryAddress: order.customerNotes || 'Not provided',
      deliveryLat: order.deliveryLat,
      deliveryLng: order.deliveryLng,
      customerName: order.customer.name,
      customerPhone: order.customer.whatsappNumber,
      createdAt: order.createdAt,
      /** Settlement is Ojarun → agent offline; fees here are order totals only. */
      settlementNote: 'Customer pays Ojarun; Ojarun settles agents separately',
    };
  }
}
