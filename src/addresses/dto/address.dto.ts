import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

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

  @Type(() => Number)
  @IsNumber()
  @Min(7.15)
  @Max(7.65)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(3.7)
  @Max(4.1)
  lng!: number;

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
  @Type(() => Number)
  @IsNumber()
  @Min(7.15)
  @Max(7.65)
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(3.7)
  @Max(4.1)
  lng?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
