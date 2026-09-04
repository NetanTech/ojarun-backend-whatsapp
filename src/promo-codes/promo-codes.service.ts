import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PromoCode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type PromoValidationResult = {
  promoCode: PromoCode;
  discountAmount: number;
};

@Injectable()
export class PromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Re-validates a code from scratch and computes the discount for the given
   * subtotal. Called both by the checkout "preview" endpoint and again,
   * server-side, at order creation — never trust a client-supplied discount.
   */
  async validate(
    rawCode: string,
    customerId: string,
    subtotal: number,
  ): Promise<PromoValidationResult> {
    const code = rawCode.trim().toUpperCase();
    const promo = await this.prisma.promoCode.findUnique({ where: { code } });

    if (!promo || !promo.isActive) {
      throw new BadRequestException('This promo code is not valid.');
    }
    if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This promo code has expired.');
    }
    if (promo.minOrderValue && subtotal < Number(promo.minOrderValue)) {
      throw new BadRequestException(
        `This code needs a minimum order of ₦${Number(promo.minOrderValue).toLocaleString()}.`,
      );
    }

    const redeemedFilter = {
      promoCodeId: promo.id,
      status: { not: OrderStatus.cancelled },
    };

    if (promo.maxRedemptions !== null) {
      const totalRedemptions = await this.prisma.order.count({
        where: redeemedFilter,
      });
      if (totalRedemptions >= promo.maxRedemptions) {
        throw new BadRequestException(
          'This promo code has reached its usage limit.',
        );
      }
    }

    const customerRedemptions = await this.prisma.order.count({
      where: { ...redeemedFilter, customerId },
    });
    if (customerRedemptions >= promo.perCustomerLimit) {
      throw new BadRequestException(
        'You have already used this promo code.',
      );
    }

    const discountAmount = this.computeDiscount(promo, subtotal);
    return { promoCode: promo, discountAmount };
  }

  private computeDiscount(promo: PromoCode, subtotal: number): number {
    const raw =
      promo.discountType === 'percent'
        ? subtotal * (Number(promo.discountValue) / 100)
        : Number(promo.discountValue);
    return Math.min(Math.max(raw, 0), subtotal);
  }
}
