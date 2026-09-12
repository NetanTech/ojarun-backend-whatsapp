import { IsString, IsEmail, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';

const PHONE_PATTERN = /^[+]?[\d\s()-]{7,20}$/;
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE = 'Password must include at least one letter and one number';

export class RegisterCustomerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(PHONE_PATTERN, { message: 'Enter a valid phone number' })
  phone!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  deliveryArea!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  referralCode?: string;
}

export class LoginCustomerDto {
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'Enter a valid phone number' })
  phone!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class RequestCustomerOtpDto {
  @IsEmail()
  email!: string;
}

export class VerifyCustomerOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

export class ForgotCustomerPasswordDto {
  @IsEmail()
  email!: string;
}

export class VerifyCustomerResetOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(6)
  code!: string;
}

export class ResetCustomerPasswordDto {
  @IsString()
  @MinLength(1)
  resetToken!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(PASSWORD_PATTERN, { message: PASSWORD_MESSAGE })
  password!: string;
}
