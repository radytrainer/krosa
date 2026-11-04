import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { Trim } from '../common/validation.js';

const COLUMN_ROLES = [
  'STUDENT_ID',
  'FIRST_NAME',
  'LAST_NAME',
  'FULL_NAME',
  'GENDER',
  'CLASS',
  'PROGRAM',
  'ROW_NUMBER',
  'CRITERION',
  'REFERENCE_TOTAL',
  'COMMENT',
  'IGNORE',
] as const;
export type ColumnRoleInput = (typeof COLUMN_ROLES)[number];

export class ConfirmPreviewDto {
  @ApiPropertyOptional({ description: 'Required when the preview removes subjects' })
  @IsOptional()
  @IsBoolean()
  acknowledgeRemovals?: boolean;
}

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

  @ApiPropertyOptional({
    example: 'SHARED',
    description:
      'Who takes the subject: SHARED, or a program code (WEP, SNAC). Left out: keep the proposal or the guess.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @Length(2, 16)
  audience?: string;

  @ApiProperty({ type: [ConfirmColumnDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ConfirmColumnDto)
  columns!: ConfirmColumnDto[];
}

export class ListPreviewIssuesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['ERROR', 'WARNING'] })
  @IsOptional()
  @IsEnum(['ERROR', 'WARNING'])
  severity?: 'ERROR' | 'WARNING';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  sheetTab?: string;
}
