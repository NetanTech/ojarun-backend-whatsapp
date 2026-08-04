import { IsString, MinLength, MaxLength } from 'class-validator';

export class ReplyConversationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}
