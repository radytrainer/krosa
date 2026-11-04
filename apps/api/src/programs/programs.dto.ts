import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.js';
import { Trim } from '../common/validation.js';

/** Program codes and class names: letters, digits, spaces, dashes. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

export class TermProgramClassesDto {
  @ApiProperty({ example: 'WEP' })
  @Trim()
  @IsString()
  @Length(2, 16)
  program!: string;

  @ApiProperty({ example: ['A', 'B', 'C'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 20, { each: true })
  @Matches(NAME, { each: true, message: 'a class name may hold letters, digits, spaces and -' })
  classes!: string[];
}

/** The whole configuration of a term: its programs and their classes. */
export class SetTermClassesDto {
  @ApiProperty({ type: [TermProgramClassesDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TermProgramClassesDto)
  programs!: TermProgramClassesDto[];
}

export class ListStudentIssuesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'RESOLVED', 'ALL'], default: 'OPEN' })
  @IsOptional()
  @IsEnum(['OPEN', 'RESOLVED', 'ALL'])
  status: 'OPEN' | 'RESOLVED' | 'ALL' = 'OPEN';
}

/** An admin's choice of program and class for a student in one term. Sync keeps the program. */
export class AssignStudentTermDto {
  @ApiProperty({ example: 'SNAC' })
  @Trim()
  @IsString()
  @Length(2, 16)
  program!: string;

  @ApiProperty({ example: 'D' })
  @Trim()
  @IsString()
  @Length(1, 20)
  className!: string;
}
