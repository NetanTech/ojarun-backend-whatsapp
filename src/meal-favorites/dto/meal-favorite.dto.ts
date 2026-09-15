import { IsInt, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class AddMealFavoriteDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  imageURL?: string;

  @IsString()
  @MinLength(1)
  servings!: string;

  @IsNumber()
  @Min(0)
  totalPrice!: number;

  @IsInt()
  @Min(0)
  ingredientCount!: number;
}
