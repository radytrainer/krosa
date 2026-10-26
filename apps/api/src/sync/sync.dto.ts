import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';

export class RequestSyncDto {
  @ApiProperty({ enum: ['SOURCE', 'GENERATION', 'ALL'] })
  @IsEnum(['SOURCE', 'GENERATION', 'ALL'])
  scope!: 'SOURCE' | 'GENERATION' | 'ALL';

  @ApiPropertyOptional({ description: 'Required for scope SOURCE' })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'SOURCE')
  @IsUUID()
  sourceId?: string;

  @ApiPropertyOptional({ description: 'Required for scope GENERATION' })
  @ValidateIf((o: RequestSyncDto) => o.scope === 'GENERATION')
  @IsUUID()
  generationId?: string;
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
}
