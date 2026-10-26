import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { Trim } from '../common/validation.js';

export const CRITERION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const CRITERION_CATEGORIES = [
  'QUIZ',
  'EXAM',
  'HOMEWORK',
  'ASSIGNMENT',
  'PROJECT',
  'PRESENTATION',
  'PARTICIPATION',
  'OTHER',
] as const;
export type CriterionCategoryValue = (typeof CRITERION_CATEGORIES)[number];

export class CreateCriterionDto {
  @ApiProperty({ example: 'Q3', description: 'Stable key; cannot be changed later' })
  @Trim()
  @IsString()
  @Matches(CRITERION_KEY_PATTERN, {
    message: 'key must start with a letter and contain up to 32 letters, digits or _',
  })
  key!: string;

  @ApiProperty({ example: 'Quiz 3' })
  @Trim()
  @IsString()
  @Length(1, 120)
  name!: string;

  @ApiPropertyOptional({ enum: CRITERION_CATEGORIES, default: 'OTHER' })
  @IsOptional()
  @IsEnum(CRITERION_CATEGORIES)
  category?: CriterionCategoryValue;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Column key in the sheet, if different from `key`' })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(CRITERION_KEY_PATTERN, { message: 'sheetColumnKey has the same format as key' })
  sheetColumnKey?: string;
}

/** `key` is deliberately absent: it is immutable (unknown fields are rejected). */
export class UpdateCriterionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ enum: CRITERION_CATEGORIES })
  @IsOptional()
  @IsEnum(CRITERION_CATEGORIES)
  category?: CriterionCategoryValue;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 1000)
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(CRITERION_KEY_PATTERN, { message: 'sheetColumnKey has the same format as key' })
  sheetColumnKey?: string | null;
}

export class ReorderCriteriaDto {
  @ApiProperty({
    type: [String],
    description: 'All criterion IDs of the offering, in display order',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  criterionIds!: string[];
}
