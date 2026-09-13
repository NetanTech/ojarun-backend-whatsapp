import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  overallRating!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  qualityRating!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  deliveryRating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  comment?: string;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  photoUrls?: string[];
}
