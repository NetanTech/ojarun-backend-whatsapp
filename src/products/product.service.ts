import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductService {
  constructor(private prisma: PrismaService) {}

  async getPriceList(): Promise<string> {
    const products = await this.prisma.product.findMany({
      where: { isAvailable: true },
      orderBy: { name: 'asc' },
    });

    if (products.length === 0) {
      return 'Prices are being updated. Please check back shortly 🙏';
    }

    let msg = "🛒 *Today's Prices*\n\n";
    for (const p of products) {
      msg += `• ${p.name} — ₦${Number(p.currentPrice).toLocaleString()} per ${p.unit}\n`;
    }
    msg += '\nReply *2* to place an order.';
    return msg;
  }

  async findByName(name: string) {
    return this.prisma.product.findFirst({
      where: {
        name: { contains: name, mode: 'insensitive' },
        isAvailable: true,
      },
    });
  }
}