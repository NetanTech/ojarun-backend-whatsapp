import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(search?: string) {
    const where: Prisma.CustomerWhereInput = search?.trim()
      ? {
          OR: [
            { name: { contains: search.trim(), mode: 'insensitive' } },
            { whatsappNumber: { contains: search.trim(), mode: 'insensitive' } },
          ],
        }
      : {};

    const customers = await this.prisma.customer.findMany({
      where,
      include: {
        _count: { select: { orders: true, messages: true } },
        orders: {
          select: { createdAt: true, total: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return customers.map((c) => ({
      id: c.id,
      name: c.name,
      whatsappNumber: c.whatsappNumber,
      ordersCount: c._count.orders,
      messagesCount: c._count.messages,
      lastOrderAt: c.orders[0]?.createdAt ?? null,
      lastOrderTotal: c.orders[0] ? Number(c.orders[0].total) : null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  async findOne(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        _count: { select: { orders: true, messages: true } },
        orders: {
          select: {
            id: true,
            status: true,
            total: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!customer) throw new NotFoundException('Customer not found');

    return {
      id: customer.id,
      name: customer.name,
      whatsappNumber: customer.whatsappNumber,
      ordersCount: customer._count.orders,
      messagesCount: customer._count.messages,
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
      recentOrders: customer.orders.map((o) => ({
        id: o.id,
        shortId: o.id.slice(0, 8).toUpperCase(),
        status: o.status,
        total: Number(o.total),
        createdAt: o.createdAt,
      })),
    };
  }
}
