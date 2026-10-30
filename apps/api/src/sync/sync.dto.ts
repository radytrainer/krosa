import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';

export class RequestSyncDto {
  @ApiProperty({ enum: ['SOURCE', 'TERM', 'GENERATION', 'ALL'] })
  @IsEnum(['SOURCE', 'TERM', 'GENERATION', 'ALL'])
  scope!: 'SOURCE' | 'TERM' | 'GENERATION' | 'ALL';

  @ApiPropertyOptional({ description: 'Required for scope SOURCE' })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'SOURCE')
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({ description: 'Required for scopes GENERATION and TERM' })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'GENERATION' || o.scope === 'TERM')
  @IsUUID()
  generationId?: string;

  @ApiPropertyOptional({ description: 'Required for scope TERM; must belong to generationId' })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'TERM')
  @IsUUID()
  termId?: string;

  @ApiPropertyOptional({
    description: 'Scope ALL only: sync this term number of every active generation',
  })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'ALL' && o.termNumber !== undefined)
  @IsInt()
  @Min(1)
  termNumber?: number;
}

const STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
] as const;

export class ListSyncJobsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsEnum(STATUSES)
  status?: (typeof STATUSES)[number];

  @ApiPropertyOptional({ enum: ['SOURCE', 'GENERATION', 'ALL'] })
  @IsOptional()
  @IsEnum(['SOURCE', 'GENERATION', 'ALL'])
  scope?: 'SOURCE' | 'GENERATION' | 'ALL';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  generationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({
    description: 'Include per-source child jobs of multi-source syncs',
    default: false,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeChildren?: boolean;
}

export class ListSyncErrorsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ERROR', 'WARNING'] })
  @IsOptional()
  @IsEnum(['ERROR', 'WARNING'])
  severity?: 'ERROR' | 'WARNING';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  sheetTab?: string;

  @ApiPropertyOptional({ description: "Only this source's issues (child jobs of a parent job)" })
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}
