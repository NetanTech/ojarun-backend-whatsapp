import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddMealFavoriteDto } from './dto/meal-favorite.dto';

@Injectable()
export class MealFavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async findMine(customerId: string) {
    const favorites = await this.prisma.mealFavorite.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return favorites.map((f) => this.serialize(f));
  }

  async add(customerId: string, mealId: string, dto: AddMealFavoriteDto) {
    await this.prisma.mealFavorite.upsert({
      where: { customerId_mealId: { customerId, mealId } },
      create: {
        customerId,
        mealId,
        nameSnapshot: dto.name,
        imageUrlSnapshot: dto.imageURL,
        servingsSnapshot: dto.servings,
        totalPriceSnapshot: dto.totalPrice,
        ingredientCountSnapshot: dto.ingredientCount,
      },
      update: {},
    });
    return this.findMine(customerId);
  }

  async remove(customerId: string, mealId: string) {
    await this.prisma.mealFavorite.deleteMany({ where: { customerId, mealId } });
    return this.findMine(customerId);
  }

  private serialize(favorite: {
    mealId: string;
    nameSnapshot: string;
    imageUrlSnapshot: string | null;
    servingsSnapshot: string;
    totalPriceSnapshot: Prisma.Decimal;
    ingredientCountSnapshot: number;
  }) {
    return {
      id: favorite.mealId,
      name: favorite.nameSnapshot,
      imageURL: favorite.imageUrlSnapshot || '/assets/Untitled design.png',
      servings: favorite.servingsSnapshot,
      totalPrice: Number(favorite.totalPriceSnapshot),
      ingredientCount: favorite.ingredientCountSnapshot,
    };
  }
}
