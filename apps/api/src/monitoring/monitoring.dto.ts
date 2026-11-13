import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Matches,
  Min,
  NotContains,
} from 'class-validator';
import {
  MONITORING_DEFAULT_PAGE_SIZE,
  MONITORING_LEVELS,
  MONITORING_MAX_PAGE_SIZE,
  MONITORING_STUDENT_SORTS,
  MONITORING_SUBJECT_SORTS,
  TERMS_PER_GENERATION,
  type MonitoringLevel,
  type MonitoringStudentSort,
  type MonitoringSubjectSort,
  type SortOrder,
} from '@ssrs/shared';
import { MAX_PAGE } from '../common/pagination.js';
import { Trim } from '../common/validation.js';

const ToBoolean = () =>
  Transform(({ value }: { value: unknown }) => value === true || value === 'true');

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** One of MONITORING_STUDENT_SORTS, or `criterion:<uuid>` (checked against the scheme later). */
const STUDENT_SORT = new RegExp(`^(${MONITORING_STUDENT_SORTS.join('|')}|criterion:${UUID})$`);

/** Same envelope as the global ValidationPipe (400 details carry no `field`). */
const validationFailed = (message: string) =>
  new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed',
    details: [{ message }],
  });

/** `:termNumber`: an integer from 1 to TERMS_PER_GENERATION. */
export class TermNumberPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const n = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > TERMS_PER_GENERATION) {
      throw validationFailed(`termNumber must be an integer from 1 to ${TERMS_PER_GENERATION}`);
    }
    return n;
  }
}

export class TermSubjectsQueryDto {
  @ApiPropertyOptional({ default: false, description: 'Also list archived subjects' })
  @IsOptional()
  @ToBoolean()
  includeArchived: boolean = false;

  @ApiPropertyOptional({ enum: MONITORING_SUBJECT_SORTS, default: 'name' })
  @IsOptional()
  @IsIn(MONITORING_SUBJECT_SORTS)
  sort: MonitoringSubjectSort = 'name';
}

export class SubjectQueryDto {
  @ApiProperty()
  @IsUUID()
  generationId!: string;

  @ApiProperty({ minimum: 1, maximum: TERMS_PER_GENERATION })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TERMS_PER_GENERATION)
  termNumber!: number;

  @ApiProperty({ description: 'Course id' })
  @IsUUID()
  subjectId!: string;

  @ApiPropertyOptional({ example: 'WEP', description: 'Program code; omitted = all programs' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 16)
  program?: string;

  @ApiPropertyOptional({ description: "A class from the term's class list" })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 60)
  className?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Accepted for symmetry; an archived subject is always returned, flagged',
  })
  @IsOptional()
  @ToBoolean()
  includeArchived: boolean = false;
}

export class SubjectStudentsQueryDto extends SubjectQueryDto {
  @ApiPropertyOptional({ enum: MONITORING_LEVELS })
  @IsOptional()
  @IsIn(MONITORING_LEVELS)
  level?: MonitoringLevel;

  @ApiPropertyOptional({ description: 'Student ID or name, case-insensitive', maxLength: 100 })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 100)
  @NotContains('\u0000', { message: 'search must not contain a NUL character' })
  search?: string;

  @ApiPropertyOptional({
    description: `${MONITORING_STUDENT_SORTS.join(', ')}, or criterion:<criterionId>`,
    default: 'studentCode',
  })
  @IsOptional()
  @IsString()
  @Matches(STUDENT_SORT, { message: 'sort is not a known sort key' })
  sort: MonitoringStudentSort = 'studentCode';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: SortOrder = 'asc';

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MONITORING_MAX_PAGE_SIZE,
    default: MONITORING_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MONITORING_MAX_PAGE_SIZE)
  pageSize: number = MONITORING_DEFAULT_PAGE_SIZE;
}
