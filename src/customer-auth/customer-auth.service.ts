import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Customer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RewardsService } from '../rewards/rewards.service';
import { generateUniqueReferralCode } from '../common/referral-code.util';
import {
  RegisterCustomerDto,
  LoginCustomerDto,
  RequestCustomerOtpDto,
  VerifyCustomerOtpDto,
  ForgotCustomerPasswordDto,
  VerifyCustomerResetOtpDto,
  ResetCustomerPasswordDto,
} from './dto/customer-auth.dto';
import {
  hashOtp,
  verifyOtpHash,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  TokenPayload,
} from '../auth/crypto.util';

const EMAIL_OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes — email verification
const RESET_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — password reset
const OTP_LENGTH = 6;

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly rewards: RewardsService,
  ) {}

  async register(dto: RegisterCustomerDto) {
    const phone = this.normalizePhone(dto.phone);
    const email = dto.email.trim().toLowerCase();

    const existingByPhone = await this.prisma.customer.findUnique({
      where: { whatsappNumber: phone },
    });
    if (existingByPhone?.passwordHash) {
      throw new ConflictException(
        'An account with this phone number already exists. Please log in instead.',
      );
    }

    const existingByEmail = await this.prisma.customer.findUnique({ where: { email } });
    if (existingByEmail && existingByEmail.id !== existingByPhone?.id) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await hashPassword(dto.password);

    let referredById: string | null = null;
    if (dto.referralCode?.trim()) {
      const referrer = await this.prisma.customer.findUnique({
        where: { referralCode: dto.referralCode.trim().toUpperCase() },
        select: { id: true },
      });
      if (referrer && referrer.id !== existingByPhone?.id) {
        referredById = referrer.id;
      }
    }

    if (existingByPhone) {
      // A Customer row can already exist with no password if they've only
      // ever messaged the WhatsApp bot — treat this as completing signup.
      await this.prisma.customer.update({
        where: { id: existingByPhone.id },
        data: {
          name: dto.name.trim(),
          email,
          passwordHash,
          deliveryArea: dto.deliveryArea.trim(),
          emailVerifiedAt: null,
          ...(referredById && !existingByPhone.referredById ? { referredById } : {}),
        },
      });
    } else {
      await this.prisma.customer.create({
        data: {
          whatsappNumber: phone,
          name: dto.name.trim(),
          email,
          passwordHash,
          deliveryArea: dto.deliveryArea.trim(),
          referralCode: await generateUniqueReferralCode(this.prisma),
          referredById,
        },
      });
    }

    await this.issueEmailOtp(email);
    return { message: 'A verification code has been sent to your email.', email };
  }

  async resendOtp(dto: RequestCustomerOtpDto) {
    const email = dto.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer?.passwordHash) {
      throw new NotFoundException('No account found for this email.');
    }

    await this.issueEmailOtp(email);
    return { message: 'A verification code has been sent to your email.', email };
  }

  async verifyOtp(dto: VerifyCustomerOtpDto) {
    const email = dto.email.trim().toLowerCase();
    const otp = await this.prisma.customerOtp.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) {
      throw new BadRequestException('Invalid or expired code');
    }

    const ok = await verifyOtpHash(dto.code, otp.codeHash);
    if (!ok) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.prisma.customerOtp.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });

    const existing = await this.prisma.customer.findUnique({ where: { email } });
    if (!existing) {
      throw new BadRequestException('Invalid or expired code');
    }
    const isFirstVerification = !existing.emailVerifiedAt;

    const customer = await this.prisma.customer.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    });

    if (isFirstVerification && customer.referredById) {
      await this.rewards.awardReferralBonuses(customer.id, customer.referredById);
    }

    const accessToken = this.signAccessToken(customer);
    return { accessToken, customer: this.toPublicCustomer(customer) };
  }

  async login(dto: LoginCustomerDto) {
    const phone = this.normalizePhone(dto.phone);
    const customer = await this.prisma.customer.findUnique({
      where: { whatsappNumber: phone },
    });
    if (!customer?.passwordHash) {
      throw new UnauthorizedException('Invalid phone number or password');
    }

    const ok = await verifyPassword(dto.password, customer.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid phone number or password');
    }

    const accessToken = this.signAccessToken(customer);
    return { accessToken, customer: this.toPublicCustomer(customer) };
  }

  async forgotPassword(dto: ForgotCustomerPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const customer = await this.prisma.customer.findUnique({ where: { email } });

    if (!customer?.passwordHash) {
      throw new NotFoundException('No account found for this email.');
    }

    const response = { message: 'A reset code has been sent to your email.' };

    const code = this.generateOtp();
    const codeHash = await hashOtp(code);

    await this.prisma.customerPasswordResetOtp.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.prisma.customerPasswordResetOtp.create({
      data: { email, codeHash, expiresAt: new Date(Date.now() + RESET_OTP_TTL_MS) },
    });

    try {
      await this.email.sendCustomerPasswordResetOtp(email, code);
    } catch (err) {
      this.logger.error(`Failed to send reset OTP to ${email}`, err as Error);
    }

    return response;
  }

  async verifyResetOtp(dto: VerifyCustomerResetOtpDto) {
    const email = dto.email.trim().toLowerCase();
    const otp = await this.prisma.customerPasswordResetOtp.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) {
      throw new BadRequestException('Invalid or expired code');
    }

    const ok = await verifyOtpHash(dto.code, otp.codeHash);
    if (!ok) {
      throw new BadRequestException('Invalid or expired code');
    }

    await this.prisma.customerPasswordResetOtp.update({
      where: { id: otp.id },
      data: { usedAt: new Date() },
    });

    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) {
      throw new BadRequestException('Invalid or expired code');
    }

    const resetToken = signToken(
      { sub: customer.id, type: 'reset', kind: 'customer' },
      this.jwtSecret,
      this.config.get<string>('jwt.resetExpiresIn') || '15m',
    );
    return { resetToken };
  }

  async resetPassword(dto: ResetCustomerPasswordDto) {
    let payload: TokenPayload;
    try {
      payload = verifyToken(dto.resetToken, this.jwtSecret);
    } catch {
      throw new BadRequestException('Invalid or expired reset token');
    }
    if (payload.type !== 'reset' || payload.kind !== 'customer') {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(dto.password);
    await this.prisma.customer.update({
      where: { id: payload.sub },
      data: { passwordHash },
    });

    return { message: 'Password updated successfully' };
  }

  async me(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      throw new UnauthorizedException('Customer not found');
    }
    return this.toPublicCustomer(customer);
  }

  private async issueEmailOtp(email: string) {
    const code = this.generateOtp();
    const codeHash = await hashOtp(code);

    await this.prisma.customerOtp.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });
    await this.prisma.customerOtp.create({
      data: { email, codeHash, expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS) },
    });

    try {
      await this.email.sendCustomerEmailVerificationOtp(email, code);
    } catch (err) {
      this.logger.error(`Failed to send verification OTP to ${email}`, err as Error);
    }
  }

  private toPublicCustomer(customer: Customer) {
    return {
      id: customer.id,
      name: customer.name,
      phone: customer.whatsappNumber,
      email: customer.email,
      deliveryArea: customer.deliveryArea,
      emailVerified: !!customer.emailVerifiedAt,
    };
  }

  private signAccessToken(customer: {
    id: string;
    whatsappNumber: string;
    email: string | null;
    name: string | null;
  }) {
    return signToken(
      {
        sub: customer.id,
        type: 'access',
        kind: 'customer',
        phone: customer.whatsappNumber,
        email: customer.email ?? undefined,
        name: customer.name ?? null,
      },
      this.jwtSecret,
      this.config.get<string>('jwt.expiresIn') || '7d',
    );
  }

  private get jwtSecret(): string {
    return this.config.get<string>('jwt.secret') || 'dev-only-change-me';
  }

  private generateOtp(): string {
    const max = 10 ** OTP_LENGTH;
    const n = Math.floor(Math.random() * max);
    return n.toString().padStart(OTP_LENGTH, '0');
  }

  /** Accepts local (0803...) or international (+234803... / 234803...) Nigerian formats and normalizes to +234803... */
  private normalizePhone(raw: string): string {
    let phone = raw.trim().replace(/[\s()-]/g, '');
    if (phone.startsWith('0')) {
      phone = `+234${phone.slice(1)}`;
    } else if (phone.startsWith('234')) {
      phone = `+${phone}`;
    } else if (!phone.startsWith('+')) {
      phone = `+234${phone}`;
    }
    return phone;
  }
}
