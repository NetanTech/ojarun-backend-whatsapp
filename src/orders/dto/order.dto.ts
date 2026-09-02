import {
  IsArray,
  ArrayMinSize,
  ValidateNested,
  IsNumber,
  Min,
  IsUUID,
  IsIn,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderStatus } from '@prisma/client';

export class UpdateOrderStatusDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

export class ListOrdersQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
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

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsIn(['cash', 'card'])
  paymentMethod!: 'cash' | 'card';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  promoCode?: string;
}
