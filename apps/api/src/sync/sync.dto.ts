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
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { TERMS_PER_GENERATION } from '@ssrs/shared';
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
  @Max(TERMS_PER_GENERATION)
  termNumber?: number;

  @ApiPropertyOptional({
    description: 'Scope SOURCE: the confirmed preview of the active sheet that this sync applies',
  })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'SOURCE' && o.previewId !== undefined)
  @IsUUID()
  previewId?: string;

  @ApiPropertyOptional({
    description: 'Release each synced term to students once its sync succeeds. Default false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  releaseAfterSync?: boolean;
}

/** What a Sync Center sync would cover, for its confirmation. Same targets as POST /sync. */
export class SyncPlanQueryDto {
  @ApiProperty({ enum: ['TERM', 'GENERATION', 'ALL'] })
  @IsEnum(['TERM', 'GENERATION', 'ALL'])
  scope!: 'TERM' | 'GENERATION' | 'ALL';

  @ApiPropertyOptional({ description: 'Required for scopes GENERATION and TERM' })
  @ValidateIf((o: SyncPlanQueryDto) => o.scope === 'GENERATION' || o.scope === 'TERM')
  @IsUUID()
  generationId?: string;

  @ApiPropertyOptional({ description: 'Required for scope TERM' })
  @ValidateIf((o: SyncPlanQueryDto) => o.scope === 'TERM')
  @IsUUID()
  termId?: string;

  @ApiPropertyOptional({ description: 'Scope ALL only' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === undefined ? value : Number(value)))
  @IsInt()
  @Min(1)
  @Max(TERMS_PER_GENERATION)
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
