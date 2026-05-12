import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ParsedItem {
  name: string;
  unit: string;
  quantity: number;
  price: number;
}

@Injectable()
export class OrderService {
  constructor(private prisma: PrismaService) {}

  async createFromWhatsapp(customerId: string, items: ParsedItem[]) {
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    const order = await this.prisma.order.create({
      data: {
        customerId,
        channel: 'whatsapp',
        status: 'pending',
        total,
        items: {
          create: items.map((item) => ({
            productNameSnapshot: item.name,
            unitSnapshot: item.unit,
            unitPriceSnapshot: item.price,
            quantity: item.quantity,
          })),
        },
      },
      include: { items: true },
    });

    return order;
  }
}