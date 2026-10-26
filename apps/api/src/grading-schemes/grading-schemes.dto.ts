import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { decimalPattern, ToDecimalString, Trim } from '../common/validation.js';

export class GradingSchemeItemDto {
  @ApiProperty()
  @IsUUID()
  criterionId!: string;

  @ApiProperty({ example: '10', description: 'Decimal string or number, up to 3 decimal places' })
  @ToDecimalString()
  @IsString()
  @Matches(decimalPattern(5, 3), {
    message: 'maxMark must be a decimal with up to 3 decimal places',
  })
  maxMark!: string;

  @ApiProperty({ example: '5', description: 'Percentage weight, up to 3 decimal places' })
  @ToDecimalString()
  @IsString()
  @Matches(decimalPattern(3, 3), {
    message: 'weight must be a decimal with up to 3 decimal places',
  })
  weight!: string;
}

export class SaveDraftSchemeDto {
  @ApiProperty({ type: [GradingSchemeItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GradingSchemeItemDto)
  items!: GradingSchemeItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Trim()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}
