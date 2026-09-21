import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Pin-first quote. Lat/lng are required — fee is always computed from the pin,
 * never from free-text guessing.
 */
export class DeliveryQuoteDto {
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
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  deliveryAddress?: string;
}
