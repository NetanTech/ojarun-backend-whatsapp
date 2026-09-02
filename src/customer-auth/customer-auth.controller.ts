import { Controller, Post, Get, Body, UseGuards, HttpCode } from '@nestjs/common';
import { CustomerAuthService } from './customer-auth.service';
import {
  RegisterCustomerDto,
  LoginCustomerDto,
  RequestCustomerOtpDto,
  VerifyCustomerOtpDto,
  ForgotCustomerPasswordDto,
  VerifyCustomerResetOtpDto,
  ResetCustomerPasswordDto,
} from './dto/customer-auth.dto';
import { CustomerJwtAuthGuard } from './customer-jwt-auth.guard';
import { CurrentCustomer, AuthCustomer } from './current-customer.decorator';

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
}
