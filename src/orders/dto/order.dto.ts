import {
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsNumber,
  Min,
  Max,
  IsUUID,
  IsIn,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
  IsISO8601,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class ListOrdersQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  /** Only orders for this exact delivery run (ISO time, e.g. 2026-11-29T14:00:00.000Z). */
  @IsOptional()
  @IsISO8601()
  deliveryAt?: string;

  /** Only orders delivered on this WAT date (YYYY-MM-DD). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  deliveryDate?: string;
}

export class CreateOrderItemDto {
  // Only set when the item matches a real catalog product — the demo
  // storefront catalog doesn't have backend-side products yet, so this
  // is optional and the snapshot fields below are always trusted.
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  unit!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsNumber()
  @Min(0.01)
  quantity!: number;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @IsString()
  @MinLength(2)
  @MaxLength(500)
  deliveryAddress!: string;

  /** Map pin — required for distance-based delivery pricing. */
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
  @MaxLength(1000)
  note?: string;

  /**
   * Delivery run the customer picked (ISO time). If missing or no longer
   * available, the order gets the earliest run allowed by the cutoffs.
   */
  @IsOptional()
  @IsISO8601()
  deliveryAt?: string;

  @IsIn(['cash', 'card'])
  paymentMethod!: 'cash' | 'card';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  promoCode?: string;
}
