import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ResultsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Only this term' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  term?: number;
}
