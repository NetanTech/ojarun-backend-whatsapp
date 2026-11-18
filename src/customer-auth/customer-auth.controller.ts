import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  UseGuards,
  HttpCode,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CustomerAuthService } from './customer-auth.service';
import {
  RegisterCustomerDto,
  LoginCustomerDto,
  RequestCustomerOtpDto,
  VerifyCustomerOtpDto,
  ForgotCustomerPasswordDto,
  VerifyCustomerResetOtpDto,
  ResetCustomerPasswordDto,
  UpdateCustomerProfileDto,
  ChangeCustomerPasswordDto,
} from './dto/customer-auth.dto';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard';
import { CurrentCustomer, AuthCustomer } from './current-customer.decorator';

// multer ships with @nestjs/platform-express (same approach as UploadController).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multer = require('multer');

@Controller('customer-auth')
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService) {}

  @Post('register')
  @HttpCode(200)
  register(@Body() dto: RegisterCustomerDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginCustomerDto) {
    return this.auth.login(dto);
  }

  @Post('resend-otp')
  @HttpCode(200)
  resendOtp(@Body() dto: RequestCustomerOtpDto) {
    return this.auth.resendOtp(dto);
  }

  @Post('verify-otp')
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyCustomerOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotCustomerPasswordDto) {
    return this.auth.forgotPassword(dto);
  }

  @Post('verify-reset-otp')
  @HttpCode(200)
  verifyResetOtp(@Body() dto: VerifyCustomerResetOtpDto) {
    return this.auth.verifyResetOtp(dto);
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetCustomerPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Get('me')
  @UseGuards(CustomerJwtAuthGuard)
  me(@CurrentCustomer() customer: AuthCustomer) {
    return this.auth.me(customer.id);
  }

  @Patch('me')
  @UseGuards(CustomerJwtAuthGuard)
  updateProfile(
    @CurrentCustomer() customer: AuthCustomer,
    @Body() dto: UpdateCustomerProfileDto,
  ) {
    return this.auth.updateProfile(customer.id, dto);
  }

  @Post('me/avatar')
  @UseGuards(CustomerJwtAuthGuard)
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      // Slightly above the 2MB rule so the service returns a friendly message.
      limits: { fileSize: 3 * 1024 * 1024 },
    }),
  )
  setAvatar(
    @CurrentCustomer() customer: AuthCustomer,
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
  ) {
    return this.auth.setAvatar(customer.id, file);
  }

  @Post('me/accept-terms')
  @UseGuards(CustomerJwtAuthGuard)
  @HttpCode(200)
  acceptTerms(@CurrentCustomer() customer: AuthCustomer) {
    return this.auth.acceptTerms(customer.id);
  }

  @Delete('me/avatar')
  @UseGuards(CustomerJwtAuthGuard)
  removeAvatar(@CurrentCustomer() customer: AuthCustomer) {
    return this.auth.removeAvatar(customer.id);
  }

  @Post('change-password')
  @UseGuards(CustomerJwtAuthGuard)
  @HttpCode(200)
  changePassword(
    @CurrentCustomer() customer: AuthCustomer,
    @Body() dto: ChangeCustomerPasswordDto,
  ) {
    return this.auth.changePassword(customer.id, dto);
  }

  @Post('deactivate')
  @UseGuards(CustomerJwtAuthGuard)
  @HttpCode(200)
  deactivate(@CurrentCustomer() customer: AuthCustomer) {
    return this.auth.deactivateAccount(customer.id);
  }
}
