import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateShoppingListDto,
  ShoppingListItemInputDto,
  UpdateShoppingListDto,
} from './dto/shopping-list.dto';

const MAX_LISTS_PER_CUSTOMER = 10;

@Injectable()
export class ShoppingListsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMine(customerId: string) {
    const lists = await this.prisma.customerShoppingList.findMany({
      where: { customerId },
      include: { items: true },
      orderBy: { updatedAt: 'desc' },
    });
    return lists.map((l) => this.serialize(l));
  }

  async create(customerId: string, dto: CreateShoppingListDto) {
    const existingCount = await this.prisma.customerShoppingList.count({
      where: { customerId },
    });
    if (existingCount >= MAX_LISTS_PER_CUSTOMER) {
      throw new BadRequestException(
        `You can save up to ${MAX_LISTS_PER_CUSTOMER} shopping lists. Delete one before creating another.`,
      );
    }

    const itemsData = await this.buildItemsData(dto.items);

    const list = await this.prisma.customerShoppingList.create({
      data: {
        customerId,
        name: dto.name.trim(),
        items: { create: itemsData },
      },
      include: { items: true },
    });
    return this.serialize(list);
  }

  async update(customerId: string, id: string, dto: UpdateShoppingListDto) {
    await this.ensureOwned(customerId, id);

    if (dto.items) {
      const itemsData = await this.buildItemsData(dto.items);
      await this.prisma.$transaction([
        this.prisma.customerShoppingListItem.deleteMany({ where: { listId: id } }),
        this.prisma.customerShoppingList.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            items: { create: itemsData },
          },
        }),
      ]);
    } else if (dto.name !== undefined) {
      await this.prisma.customerShoppingList.update({
        where: { id },
        data: { name: dto.name.trim() },
      });
    }

    const updated = await this.prisma.customerShoppingList.findUnique({
      where: { id },
      include: { items: true },
    });
    return this.serialize(updated!);
  }

  async remove(customerId: string, id: string) {
    await this.ensureOwned(customerId, id);
    await this.prisma.customerShoppingList.delete({ where: { id } });
    return { message: 'Shopping list deleted' };
  }

  private async ensureOwned(customerId: string, id: string) {
    const list = await this.prisma.customerShoppingList.findFirst({
      where: { id, customerId },
      select: { id: true },
    });
    if (!list) throw new NotFoundException('Shopping list not found');
  }

  private async buildItemsData(
    items: ShoppingListItemInputDto[],
  ): Promise<Prisma.CustomerShoppingListItemCreateWithoutListInput[]> {
    if (items.length === 0) {
      throw new BadRequestException('A shopping list needs at least one item');
    }

    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    return items.map((item) => {
      const product = byId.get(item.productId);
      if (!product) {
        throw new BadRequestException(`Product ${item.productId} not found`);
      }
      return {
        productId: product.id,
        productNameSnapshot: product.name,
        unitSnapshot: product.unit,
        priceSnapshot: product.currentPrice,
        imageUrlSnapshot: product.imageUrl,
        quantity: item.quantity,
      };
    });
  }

  private serialize(list: {
    id: string;
    name: string;
    updatedAt: Date;
    items: Array<{
      id: string;
      productId: string | null;
      productNameSnapshot: string;
      unitSnapshot: string;
      priceSnapshot: Prisma.Decimal;
      imageUrlSnapshot: string | null;
      quantity: number;
    }>;
  }) {
    return {
      id: list.id,
      name: list.name,
      updatedAt: list.updatedAt.toLocaleDateString('en-NG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
      items: list.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        name: item.productNameSnapshot,
        unit: item.unitSnapshot,
        more: item.unitSnapshot,
        price: Number(item.priceSnapshot),
        imageURL: item.imageUrlSnapshot || '/assets/Untitled design.png',
        quantity: item.quantity,
      })),
    };
  }
}
