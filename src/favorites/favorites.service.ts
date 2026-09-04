import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async findMine(customerId: string) {
    const favorites = await this.prisma.customerFavorite.findMany({
      where: { customerId },
      include: { product: true },
      orderBy: { createdAt: 'desc' },
    });
    return favorites.map((f) => this.serializeProduct(f.product));
  }

  async add(customerId: string, productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');

    // Idempotent — adding an already-favorited product just returns the list, no error.
    await this.prisma.customerFavorite.upsert({
      where: { customerId_productId: { customerId, productId } },
      create: { customerId, productId },
      update: {},
    });
    return this.findMine(customerId);
  }

  async remove(customerId: string, productId: string) {
    await this.prisma.customerFavorite.deleteMany({
      where: { customerId, productId },
    });
    return this.findMine(customerId);
  }

  private serializeProduct(product: {
    id: string;
    name: string;
    unit: string;
    currentPrice: Prisma.Decimal;
    isAvailable: boolean;
    category: string | null;
    description: string | null;
    imageUrl: string | null;
  }) {
    return {
      id: product.id,
      name: product.name,
      unit: product.unit,
      currentPrice: Number(product.currentPrice),
      isAvailable: product.isAvailable,
      category: product.category,
      description: product.description,
      imageUrl: product.imageUrl,
    };
  }
}
