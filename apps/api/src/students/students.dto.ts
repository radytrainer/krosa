import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { Trim } from '../common/validation.js';

export class ListStudentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  generationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  className?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsEnum(['PENDING', 'ACTIVE', 'DISABLED'])
  status?: 'PENDING' | 'ACTIVE' | 'DISABLED';

  @ApiPropertyOptional({ description: 'Search by student ID or name' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  q?: string;
}

export class UpdateStudentStatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] })
  @IsEnum(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}

export class IssueCredentialsDto {
  @ApiPropertyOptional({ type: [String], description: 'Specific students (max 500)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  studentIds?: string[];

  @ApiPropertyOptional({ description: 'All matching students of a generation' })
  @IsOptional()
  @IsUUID()
  generationId?: string;

  @ApiPropertyOptional({ description: 'Narrow a generation to one class' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  className?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Only accounts without credentials. false also RESETS passwords of active accounts.',
  })
  @IsOptional()
  @IsBoolean()
  onlyPending?: boolean;
}
