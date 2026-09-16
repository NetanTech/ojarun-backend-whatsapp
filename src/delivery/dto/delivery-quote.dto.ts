import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeliveryQuoteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  deliveryAddress!: string;
}
