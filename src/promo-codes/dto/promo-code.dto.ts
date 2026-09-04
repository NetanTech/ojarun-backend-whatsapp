import { IsNumber, IsString, Min, MinLength } from 'class-validator';

export class ValidatePromoCodeDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsNumber()
  @Min(0)
  subtotal!: number;
}
