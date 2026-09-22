import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AssignmentStatus } from '@prisma/client';

export class ListMyAssignmentsQueryDto {
  @IsOptional()
  @IsEnum(AssignmentStatus)
  status?: AssignmentStatus;
}

export class ReleaseAssignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
