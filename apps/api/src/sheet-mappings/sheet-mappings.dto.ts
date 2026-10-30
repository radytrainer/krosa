import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../common/validation.js';

const COLUMN_ROLES = [
  'STUDENT_ID',
  'FIRST_NAME',
  'LAST_NAME',
  'FULL_NAME',
  'GENDER',
  'CLASS',
  'CRITERION',
  'REFERENCE_TOTAL',
  'COMMENT',
  'IGNORE',
] as const;
export type ColumnRoleInput = (typeof COLUMN_ROLES)[number];

export class ConfirmColumnDto {
  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(0)
  columnIndex!: number;

  @ApiProperty({ enum: COLUMN_ROLES })
  @IsEnum(COLUMN_ROLES)
  role!: ColumnRoleInput;

  @ApiPropertyOptional({ example: 'Quiz 1', description: 'Required when role is CRITERION' })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({ example: '10', description: 'Required when role is CRITERION' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,3}(\.\d{1,3})?$/, { message: 'weight must be a number with up to 3 decimals' })
  weight?: string;
}

export class ConfirmMappingDto {
  @ApiProperty({ example: 'English' })
  @Trim()
  @IsString()
  @Length(1, 120)
  subjectName!: string;

  @ApiProperty({ type: [ConfirmColumnDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ConfirmColumnDto)
  columns!: ConfirmColumnDto[];
}
