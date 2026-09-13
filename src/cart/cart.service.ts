import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CartMergeItem = { productId: string; quantity: number };

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async findMine(customerId: string) {
    const items = await this.prisma.cartItem.findMany({
      where: { customerId },
      include: { product: true },
      orderBy: { createdAt: 'asc' },
    });
    return items.map((i) => this.serialize(i));
  }

  async setQuantity(customerId: string, productId: string, quantity: number) {
    if (quantity <= 0) {
      return this.remove(customerId, productId);
    }

    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    await this.prisma.cartItem.upsert({
      where: { customerId_productId: { customerId, productId } },
      create: { customerId, productId, quantity },
      update: { quantity },
    });
    return this.findMine(customerId);
  }

  async remove(customerId: string, productId: string) {
    await this.prisma.cartItem.deleteMany({ where: { customerId, productId } });
    return this.findMine(customerId);
  }

  async clear(customerId: string) {
    await this.prisma.cartItem.deleteMany({ where: { customerId } });
    return [];
  }

  /** Folds a guest's local cart into the customer's saved cart on login — existing quantities add up. */
  async merge(customerId: string, items: CartMergeItem[]) {
    const validItems = items.filter((i) => i.quantity > 0);
    if (validItems.length === 0) return this.findMine(customerId);

    const productIds = validItems.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const validIds = new Set(products.map((p) => p.id));

    const existing = await this.prisma.cartItem.findMany({
      where: { customerId, productId: { in: productIds } },
    });
    const existingByProduct = new Map(existing.map((e) => [e.productId, e]));

    await this.prisma.$transaction(
      validItems
        .filter((i) => validIds.has(i.productId))
        .map((i) => {
          const current = existingByProduct.get(i.productId);
          const quantity = (current?.quantity ?? 0) + i.quantity;
          return this.prisma.cartItem.upsert({
            where: { customerId_productId: { customerId, productId: i.productId } },
            create: { customerId, productId: i.productId, quantity },
            update: { quantity },
          });
        }),
    );

    return this.findMine(customerId);
  }

  private serialize(item: {
    productId: string;
    quantity: number;
    product: {
      name: string;
      unit: string;
      currentPrice: Prisma.Decimal;
      imageUrl: string | null;
    };
  }) {
    return {
      id: item.productId,
      name: item.product.name,
      more: item.product.unit,
      price: Number(item.product.currentPrice),
      imageURL: item.product.imageUrl || '/assets/Untitled design.png',
      quantity: item.quantity,
    };
  }
}
