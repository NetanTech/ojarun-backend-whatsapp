import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsString()
  @MinLength(4)
  @MaxLength(300)
  address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  landmark?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  landmark?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
