import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class SetCartItemQuantityDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CartMergeItemDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class MergeCartDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CartMergeItemDto)
  items!: CartMergeItemDto[];
}
