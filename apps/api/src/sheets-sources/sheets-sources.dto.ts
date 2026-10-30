import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
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
