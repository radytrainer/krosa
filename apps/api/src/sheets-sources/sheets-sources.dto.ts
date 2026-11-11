import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { Trim } from '../common/validation.js';

export class CreateTermSourceDto {
  @ApiProperty({ example: 'https://docs.google.com/spreadsheets/d/1AbC…/edit' })
  @Trim()
  @IsString()
  @Length(1, 2048)
  url!: string;

  @ApiProperty({ example: 'Term 1 scores' })
  @Trim()
  @IsString()
  @Length(1, 120)
  label!: string;

  @ApiPropertyOptional({ example: 'ALL', description: 'Master roster tab (default ALL)' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  rosterTab?: string;
}

export class CheckSheetDto {
  @ApiProperty({ example: 'https://docs.google.com/spreadsheets/d/1AbC…/edit' })
  @Trim()
  @IsString()
  @Length(1, 2048)
  url!: string;

  @ApiPropertyOptional({ example: 'ALL', description: 'Master roster tab (default ALL)' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 100)
  rosterTab?: string;
}

export class ChangeSheetDto extends CheckSheetDto {
  @ApiProperty({ example: 'Term 1 scores (corrected)' })
  @Trim()
  @IsString()
  @Length(1, 120)
  label!: string;
}

export class UpdateSourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  label?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsEnum(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

/** Hide or Release the scores of one or more sources (their terms) for students. */
export class SetSourceReleaseDto {
  @ApiProperty({ type: [String], description: '1–50 source ids' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  sourceIds!: string[];

  @ApiProperty({ description: 'true releases, false hides' })
  @IsBoolean()
  visible!: boolean;
}

export class SourceReleaseQueryDto {
  @ApiProperty({ type: [String], description: 'Source ids, comma separated or repeated (1–50)' })
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : String(value ?? '').split(','))
      .map((v) => String(v).trim())
      .filter(Boolean),
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids!: string[];
}
