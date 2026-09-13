import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RewardTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REFERRAL_REFERRER_BONUS,
  REFERRAL_SIGNUP_BONUS,
  pointsForAmount,
  tierForPoints,
} from './rewards.util';

const REFERRAL_SIGNUP_DESCRIPTION = 'Referral sign-up bonus';
const REFERRAL_REFERRER_DESCRIPTION = 'Referral bonus';

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSummary(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        points: true,
        referralCode: true,
        _count: { select: { referrals: true } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const [earnedAgg, redeemedAgg] = await Promise.all([
      this.prisma.rewardTransaction.aggregate({
        where: { customerId, type: RewardTransactionType.earned, status: 'successful' },
        _sum: { points: true },
      }),
      this.prisma.rewardTransaction.aggregate({
        where: { customerId, type: RewardTransactionType.redeemed, status: 'successful' },
        _sum: { points: true },
      }),
    ]);

    const tier = tierForPoints(customer.points);

    return {
      points: customer.points,
      tier: tier.name,
      tierIndex: tier.index,
      tierMin: tier.min,
      tierMax: tier.max,
      totalEarned: earnedAgg._sum.points ?? 0,
      totalRedeemed: redeemedAgg._sum.points ?? 0,
      referralCode: customer.referralCode,
      referralCount: customer._count.referrals,
    };
  }

  async getTransactions(customerId: string, page = 1, pageSize = 5) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.min(50, Math.max(1, pageSize));
    const skip = (safePage - 1) * safePageSize;

    const [items, total] = await Promise.all([
      this.prisma.rewardTransaction.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safePageSize,
      }),
      this.prisma.rewardTransaction.count({ where: { customerId } }),
    ]);

    return {
      items: items.map((t) => ({
        id: t.id,
        date: t.createdAt.toISOString().slice(0, 10),
        description: t.description,
        type: t.type,
        status: t.status,
        points: t.type === RewardTransactionType.redeemed ? -t.points : t.points,
      })),
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  /** Idempotent — safe to call more than once for the same order. */
  async awardForDeliveredOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const alreadyAwarded = await this.prisma.rewardTransaction.findFirst({
      where: { orderId, type: RewardTransactionType.earned },
      select: { id: true },
    });
    if (alreadyAwarded) return;

    const points = pointsForAmount(Number(order.total));
    if (points <= 0) return;

    try {
      await this.prisma.$transaction([
        this.prisma.rewardTransaction.create({
          data: {
            customerId: order.customerId,
            orderId: order.id,
            type: RewardTransactionType.earned,
            points,
            description: `Order #${order.id.slice(0, 8).toUpperCase()}`,
          },
        }),
        this.prisma.customer.update({
          where: { id: order.customerId },
          data: { points: { increment: points } },
        }),
      ]);
    } catch (err) {
      this.logger.error(`Failed to award points for order ${orderId}`, err as Error);
    }
  }

  /** Idempotent — safe to call more than once for the same referred customer. */
  async awardReferralBonuses(referredCustomerId: string, referrerId: string) {
    const already = await this.prisma.rewardTransaction.findFirst({
      where: { customerId: referredCustomerId, description: REFERRAL_SIGNUP_DESCRIPTION },
      select: { id: true },
    });
    if (already) return;

    try {
      await this.prisma.$transaction([
        this.prisma.rewardTransaction.create({
          data: {
            customerId: referredCustomerId,
            type: RewardTransactionType.earned,
            points: REFERRAL_SIGNUP_BONUS,
            description: REFERRAL_SIGNUP_DESCRIPTION,
          },
        }),
        this.prisma.customer.update({
          where: { id: referredCustomerId },
          data: { points: { increment: REFERRAL_SIGNUP_BONUS } },
        }),
        this.prisma.rewardTransaction.create({
          data: {
            customerId: referrerId,
            type: RewardTransactionType.earned,
            points: REFERRAL_REFERRER_BONUS,
            description: REFERRAL_REFERRER_DESCRIPTION,
          },
        }),
        this.prisma.customer.update({
          where: { id: referrerId },
          data: { points: { increment: REFERRAL_REFERRER_BONUS } },
        }),
      ]);
    } catch (err) {
      this.logger.error(
        `Failed to award referral bonuses for ${referredCustomerId} / ${referrerId}`,
        err as Error,
      );
    }
  }

  async redeemPoints(
    customerId: string,
    points: number,
    description = 'Redeemed towards an order',
  ) {
    if (!Number.isInteger(points) || points <= 0) {
      throw new BadRequestException('Points must be a positive whole number');
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { points: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.points < points) {
      throw new BadRequestException('You do not have enough points for this redemption');
    }

    await this.prisma.$transaction([
      this.prisma.rewardTransaction.create({
        data: { customerId, type: RewardTransactionType.redeemed, points, description },
      }),
      this.prisma.customer.update({
        where: { id: customerId },
        data: { points: { decrement: points } },
      }),
    ]);

    return this.getSummary(customerId);
  }
}
