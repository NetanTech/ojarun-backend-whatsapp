import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { AdminRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const adminSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AdminsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(search?: string) {
    const where: Prisma.AdminWhereInput = search?.trim()
      ? {
          OR: [
            { name: { contains: search.trim(), mode: 'insensitive' } },
            { email: { contains: search.trim(), mode: 'insensitive' } },
            { phone: { contains: search.trim(), mode: 'insensitive' } },
          ],
        }
      : {};

    return this.prisma.admin.findMany({
      where,
      select: adminSelect,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id },
      select: adminSelect,
    });
    if (!admin) throw new NotFoundException('Admin not found');
    return admin;
  }

  async updateRole(id: string, role: AdminRole, actorId: string) {
    if (id === actorId && role !== AdminRole.superadmin) {
      throw new ForbiddenException('You cannot demote your own account');
    }

    const target = await this.prisma.admin.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

    if (target.role === AdminRole.superadmin && role !== AdminRole.superadmin) {
      const superCount = await this.prisma.admin.count({
        where: { role: AdminRole.superadmin },
      });
      if (superCount <= 1) {
        throw new ForbiddenException('Cannot remove the last superadmin');
      }
    }

    return this.prisma.admin.update({
      where: { id },
      data: { role },
      select: adminSelect,
    });
  }
}
