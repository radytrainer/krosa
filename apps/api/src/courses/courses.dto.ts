import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { decimalPattern, ToDecimalString, Trim } from '../common/validation.js';

export const COURSE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const OFFERING_KEY_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
/** 0.1–999.9, at most one decimal place; zero is rejected (DB CHECK credits > 0). */
const CREDITS_PATTERN = new RegExp(`(?!^0+(\\.0)?$)${decimalPattern(3, 1).source}`);

export class CreateCourseDto {
  @ApiProperty({ example: 'MATH101' })
  @Trim()
  @IsString()
  @Matches(COURSE_CODE_PATTERN, { message: 'code must be 1-32 letters, digits, _ or -' })
  code!: string;

  @ApiProperty({ example: 'Mathematics I' })
  @Trim()
  @IsString()
  @Length(1, 160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

export class UpdateCourseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 160)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 2000)
  description?: string | null;
}

export class ListCoursesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search in code and name' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  q?: string;
}

export class CreateOfferingDto {
  @ApiProperty()
  @IsUUID()
  termId!: string;

  @ApiProperty()
  @IsUUID()
  courseId!: string;

  @ApiProperty({ example: 'T1-MATH101', description: 'Stable key; matches `course_key` in sheets' })
  @Trim()
  @IsString()
  @Matches(OFFERING_KEY_PATTERN, { message: 'externalKey must be 1-40 letters, digits, _ or -' })
  externalKey!: string;

  @ApiProperty({ example: 'Mathematics I' })
  @Trim()
  @IsString()
  @Length(1, 160)
  title!: string;

  @ApiPropertyOptional({ example: '3', description: 'Positive, up to one decimal place' })
  @IsOptional()
  @ToDecimalString()
  @IsString()
  @Matches(CREDITS_PATTERN, { message: 'credits must be a positive number with at most 1 decimal' })
  credits?: string;
}

export class UpdateOfferingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 160)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ToDecimalString()
  @IsString()
  @Matches(CREDITS_PATTERN, { message: 'credits must be a positive number with at most 1 decimal' })
  credits?: string;

  @ApiPropertyOptional({ enum: ['HIDDEN', 'VISIBLE'] })
  @IsOptional()
  @IsEnum(['HIDDEN', 'VISIBLE'])
  visibility?: 'HIDDEN' | 'VISIBLE';
}

export class ListOfferingsQueryDto extends PaginationQueryDto {
  @ApiProperty()
  @IsUUID()
  generationId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  termNumber?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  q?: string;
}
