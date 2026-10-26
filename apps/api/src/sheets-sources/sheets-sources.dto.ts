import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { Trim } from '../common/validation.js';

export class CreateSourceDto {
  @ApiProperty({ example: 'https://docs.google.com/spreadsheets/d/1AbC…/edit' })
  @Trim()
  @IsString()
  @Length(1, 2048)
  url!: string;

  @ApiProperty({ example: 'Main scores 2026' })
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
