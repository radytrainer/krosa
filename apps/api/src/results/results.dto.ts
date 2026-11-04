import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { TERMS_PER_GENERATION } from '@ssrs/shared';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Refuses every query parameter on a route that takes none (400, API spec §3). */
// oxlint-disable-next-line typescript/no-extraneous-class -- the validation pipe needs a class
export class NoQueryDto {}

export class ResultsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: TERMS_PER_GENERATION, description: 'Only this term' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TERMS_PER_GENERATION)
  term?: number;
}
