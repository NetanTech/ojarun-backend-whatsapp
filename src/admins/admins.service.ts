import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminRole, AdminStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { InviteAdminDto, UpdateAdminDto } from '../auth/dto/auth.dto';
import {
  createInviteToken,
  hashInviteToken,
  hashPassword,
} from '../auth/crypto.util';

const adminSelectLegacy = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
} as const;

const adminSelect = {
  ...adminSelectLegacy,
  status: true,
  lastActiveAt: true,
  inviteMessage: true,
} as const;

type AdminListRow = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: AdminRole;
  avatarUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  status?: AdminStatus;
  lastActiveAt?: Date | null;
  inviteMessage?: string | null;
};

function normalizeAdmin(row: AdminListRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status ?? AdminStatus.active,
    lastActiveAt: row.lastActiveAt ?? null,
    inviteMessage: row.inviteMessage ?? null,
  };
}

const ROLE_LABELS: Record<AdminRole, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  agent: 'Agent',
  customer_care: 'Customer care',
  customer_support: 'Customer support',
};

@Injectable()
export class AdminsService {
  private readonly logger = new Logger(AdminsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

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

    // Prefer extended fields; fall back if migration not applied yet.
    try {
      const rows = await this.prisma.admin.findMany({
        where,
        select: adminSelect,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => normalizeAdmin(row));
    } catch {
      const rows = await this.prisma.admin.findMany({
        where,
        select: adminSelectLegacy,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => normalizeAdmin(row));
    }
  }

  async findOne(id: string) {
    try {
      const admin = await this.prisma.admin.findUnique({
        where: { id },
        select: adminSelect,
      });
      if (!admin) throw new NotFoundException('Admin not found');
      return normalizeAdmin(admin);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      const admin = await this.prisma.admin.findUnique({
        where: { id },
        select: adminSelectLegacy,
      });
      if (!admin) throw new NotFoundException('Admin not found');
      return normalizeAdmin(admin);
    }
  }

  async invite(dto: InviteAdminDto, actorId: string, actorRole: AdminRole) {
    if (
      actorRole !== AdminRole.superadmin &&
      actorRole !== AdminRole.admin
    ) {
      throw new ForbiddenException('You cannot invite users');
    }

    if (
      dto.role === AdminRole.superadmin &&
      actorRole !== AdminRole.superadmin
    ) {
      throw new ForbiddenException('Only superadmins can invite superadmins');
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.admin.findUnique({ where: { email } });
    if (existing && existing.status !== AdminStatus.invited) {
      throw new ConflictException('An account with this email already exists');
    }

    const token = createInviteToken();
    const inviteTokenHash = hashInviteToken(token);
    const passwordHash = await hashPassword(createInviteToken());
    const name = dto.name.trim();
    const message = dto.message?.trim() || null;

    const admin = existing
      ? await this.prisma.admin.update({
          where: { id: existing.id },
          data: {
            name,
            role: dto.role,
            status: AdminStatus.invited,
            inviteTokenHash,
            inviteMessage: message,
            invitedById: actorId,
            passwordHash,
          },
          select: adminSelect,
        })
      : await this.prisma.admin.create({
          data: {
            email,
            name,
            role: dto.role,
            status: AdminStatus.invited,
            inviteTokenHash,
            inviteMessage: message,
            invitedById: actorId,
            passwordHash,
          },
          select: adminSelect,
        });

    const appUrl = (
      this.config.get<string>('adminAppUrl') || 'http://localhost:3001'
    ).replace(/\/$/, '');
    const inviteUrl = `${appUrl}/accept-invite?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    try {
      await this.email.sendAdminInvite({
        to: email,
        name,
        roleLabel: ROLE_LABELS[dto.role] || dto.role,
        inviteUrl,
        message,
      });
    } catch (err) {
      this.logger.error(`Failed to send invite email to ${email}`, err as Error);
      throw new BadRequestException(
        'User was created but the invite email failed to send. Try again.',
      );
    }

    return normalizeAdmin(admin);
  }

  async update(id: string, dto: UpdateAdminDto, actorId: string) {
    const target = await this.prisma.admin.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

    if (dto.role !== undefined) {
      if (id === actorId && dto.role !== AdminRole.superadmin) {
        throw new ForbiddenException('You cannot demote your own account');
      }
      if (
        target.role === AdminRole.superadmin &&
        dto.role !== AdminRole.superadmin
      ) {
        const superCount = await this.prisma.admin.count({
          where: { role: AdminRole.superadmin },
        });
        if (superCount <= 1) {
          throw new ForbiddenException('Cannot remove the last superadmin');
        }
      }
    }

    if (dto.status === AdminStatus.invited) {
      throw new BadRequestException('Cannot set status to invited directly');
    }

    if (
      dto.status === AdminStatus.inactive &&
      target.role === AdminRole.superadmin
    ) {
      const superCount = await this.prisma.admin.count({
        where: { role: AdminRole.superadmin },
      });
      if (superCount <= 1) {
        throw new ForbiddenException('Cannot deactivate the last superadmin');
      }
    }

    if (id === actorId && dto.status === AdminStatus.inactive) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }

    try {
      const updated = await this.prisma.admin.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
        select: adminSelect,
      });
      return normalizeAdmin(updated);
    } catch (err) {
      if (dto.status !== undefined) {
        throw new BadRequestException(
          'Status updates require the latest database migration. Run prisma migrate deploy.',
        );
      }
      const updated = await this.prisma.admin.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
        },
        select: adminSelectLegacy,
      });
      return normalizeAdmin(updated);
    }
  }

  async updateRole(id: string, role: AdminRole, actorId: string) {
    return this.update(id, { role }, actorId);
  }

  async remove(id: string, actorId: string) {
    if (id === actorId) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    const target = await this.prisma.admin.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Admin not found');

    if (target.role === AdminRole.superadmin) {
      const superCount = await this.prisma.admin.count({
        where: { role: AdminRole.superadmin },
      });
      if (superCount <= 1) {
        throw new ForbiddenException('Cannot delete the last superadmin');
      }
    }

    await this.prisma.admin.delete({ where: { id } });
    return { message: 'User deleted' };
  }
}
