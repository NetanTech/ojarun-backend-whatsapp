import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  UpdateProfileDto,
  ChangePasswordDto,
  AcceptInviteDto,
} from './dto/auth.dto';
import {
  hashPassword,
  verifyPassword,
  hashOtp,
  verifyOtpHash,
  signToken,
  verifyToken,
  TokenPayload,
  hashInviteToken,
} from './crypto.util';
import { AdminRole, AdminStatus } from '@prisma/client';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_LENGTH = 6;

const adminPublicSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  role: true,
  avatarUrl: true,
  createdAt: true,
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  async register(dto: RegisterDto) {
    const adminCount = await this.prisma.admin.count();
    if (adminCount > 0) {
      throw new ForbiddenException(
        'Public signup is disabled. Ask an admin to invite you.',
      );
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.admin.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await hashPassword(dto.password);
    const phone = dto.phone.trim();
    const admin = await this.prisma.admin.create({
      data: {
        email,
        passwordHash,
        name: dto.name.trim(),
        phone,
        role: AdminRole.superadmin,
      },
      select: adminPublicSelect,
    });

    const accessToken = this.signAccessToken(admin);
    return { accessToken, admin };
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const status = (admin as { status?: AdminStatus }).status;
    if (status === AdminStatus.invited) {
      throw new UnauthorizedException(
        'Accept your invite and set a password before signing in',
      );
    }
    if (status === AdminStatus.inactive) {
      throw new UnauthorizedException('This account is inactive');
    }

    const ok = await verifyPassword(dto.password, admin.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    let publicAdmin = {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      phone: admin.phone,
      role: admin.role,
      avatarUrl: admin.avatarUrl,
      createdAt: admin.createdAt,
    };

    try {
      publicAdmin = await this.prisma.admin.update({
        where: { id: admin.id },
        data: { lastActiveAt: new Date() },
        select: adminPublicSelect,
      });
    } catch {
      // lastActiveAt column may not exist until migrate is applied
    }

    const accessToken = this.signAccessToken(publicAdmin);
    return {
      accessToken,
      admin: publicAdmin,
    };
  }

  async acceptInvite(dto: AcceptInviteDto) {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin || admin.status !== AdminStatus.invited || !admin.inviteTokenHash) {
      throw new BadRequestException('Invalid or expired invite');
    }

    const tokenHash = hashInviteToken(dto.token);
    if (tokenHash !== admin.inviteTokenHash) {
      throw new BadRequestException('Invalid or expired invite');
    }

    const passwordHash = await hashPassword(dto.password);
    const updated = await this.prisma.admin.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        status: AdminStatus.active,
        inviteTokenHash: null,
        lastActiveAt: new Date(),
      },
      select: adminPublicSelect,
    });

    const accessToken = this.signAccessToken(updated);
    return { accessToken, admin: updated };
  }

  async me(adminId: string) {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: adminPublicSelect,
    });
    if (!admin) {
      throw new UnauthorizedException('Admin not found');
    }
    return admin;
  }

  async updateProfile(adminId: string, dto: UpdateProfileDto) {
    if (dto.email) {
      const email = dto.email.trim().toLowerCase();
      const taken = await this.prisma.admin.findFirst({
        where: { email, NOT: { id: adminId } },
      });
      if (taken) {
        throw new ConflictException('Email is already in use');
      }
    }

    const admin = await this.prisma.admin.update({
      where: { id: adminId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.email !== undefined
          ? { email: dto.email.trim().toLowerCase() }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone.trim() } : {}),
        ...(dto.avatarUrl !== undefined
          ? { avatarUrl: dto.avatarUrl?.trim() || null }
          : {}),
      },
      select: adminPublicSelect,
    });

    const accessToken = this.signAccessToken(admin);
    return { admin, accessToken };
  }

  async changePassword(adminId: string, dto: ChangePasswordDto) {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthorizedException('Admin not found');

    const ok = await verifyPassword(dto.currentPassword, admin.passwordHash);
    if (!ok) {
      throw new BadRequestException('Current password is incorrect');
    }

    const passwordHash = await hashPassword(dto.newPassword);
    await this.prisma.admin.update({
      where: { id: adminId },
      data: { passwordHash },
    });

    return { message: 'Password updated successfully' };
  }

  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.prisma.admin.findUnique({ where: { email } });

    const response = {
      message: 'If an account exists for that email, a reset code has been sent.',
    };

    if (!admin) {
      return response;
    }

    const code = this.generateOtp();
    const codeHash = await hashOtp(code);

    await this.prisma.passwordResetOtp.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    await this.prisma.passwordResetOtp.create({
      data: {
        email,
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    try {
      await this.email.sendPasswordResetOtp(email, code);
    } catch (err) {
      this.logger.error(`Failed to send reset OTP to ${email}`, err as Error);
    }

    return response;
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const email = dto.email.trim().toLowerCase();
    const otp = await this.prisma.passwordResetOtp.findFirst({
      where: {
        email,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) {
      throw new BadRequestException('Invalid or expired code');
    }

    const ok = await verifyOtpHash(dto.code, otp.codeHash);
    if (!ok) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.prisma.passwordResetOtp.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });

    const admin = await this.prisma.admin.findUnique({ where: { email } });
    if (!admin) {
      throw new BadRequestException('Invalid or expired code');
    }

    const resetToken = signToken(
      { sub: admin.id, email: admin.email, type: 'reset' },
      this.jwtSecret,
      this.config.get<string>('jwt.resetExpiresIn') || '15m',
    );

    return { resetToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    let payload: TokenPayload;
    try {
      payload = verifyToken(dto.resetToken, this.jwtSecret);
    } catch {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (payload.type !== 'reset') {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(dto.password);
    await this.prisma.admin.update({
      where: { id: payload.sub },
      data: { passwordHash },
    });

    return { message: 'Password updated successfully' };
  }

  private get jwtSecret(): string {
    return this.config.get<string>('jwt.secret') || 'dev-only-change-me';
  }

  private signAccessToken(admin: {
    id: string;
    email: string;
    name?: string | null;
    phone?: string | null;
    role: AdminRole;
    avatarUrl?: string | null;
  }) {
    return signToken(
      {
        sub: admin.id,
        email: admin.email,
        type: 'access',
        name: admin.name ?? null,
        phone: admin.phone ?? null,
        role: admin.role,
        avatarUrl: admin.avatarUrl ?? null,
      },
      this.jwtSecret,
      this.config.get<string>('jwt.expiresIn') || '7d',
    );
  }

  private generateOtp(): string {
    const max = 10 ** OTP_LENGTH;
    const n = Math.floor(Math.random() * max);
    return n.toString().padStart(OTP_LENGTH, '0');
  }
}
