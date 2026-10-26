import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { IsDateOnly, Trim } from '../common/validation.js';

export const GENERATION_CODE_PATTERN = /^[A-Za-z0-9_-]{2,32}$/;

export class CreateGenerationDto {
  @ApiProperty({
    example: 'GEN2026',
    description: 'Must equal `_meta.generation_code` in its spreadsheets',
  })
  @Trim()
  @IsString()
  @Matches(GENERATION_CODE_PATTERN, { message: 'code must be 2-32 letters, digits, _ or -' })
  code!: string;

  @ApiProperty({ example: 'Generation 2026' })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiProperty({ example: '2026-01-05' })
  @IsDateOnly()
  startDate!: string;

  @ApiPropertyOptional({ example: '2028-12-20', nullable: true })
  @IsOptional()
  @IsDateOnly()
  endDate?: string | null;
}

export class UpdateGenerationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateOnly()
  startDate?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateOnly()
  endDate?: string | null;
}

export class ListGenerationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsEnum(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ description: 'Search in code and name' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  q?: string;
}

export class UpdateTermDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateOnly()
  startDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsDateOnly()
  endDate?: string | null;
}
