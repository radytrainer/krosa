import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import { PrismaService } from '../infra/prisma.service.js';

type Db = Pick<Prisma.TransactionClient, 'generation'>;

/**
 * Shared lookups that enforce ACAD-06: archived generations are read-only for configuration
 * (terms, workbooks, mappings).
 */
@Injectable()
export class AcademicGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async assertGenerationEditable(generationId: string, db: Db = this.prisma.client): Promise<void> {
    const generation = await db.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (!generation)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    if (generation.status === 'ARCHIVED') {
      throw new ConflictException({
        code: 'GENERATION_ARCHIVED',
        message: 'This generation is archived and cannot be modified',
      });
    }
  }

  /** Invalidates cached results for a generation (see docs/architecture.md §6). */
  async bumpCacheVersion(
    generationId: string,
    db: Pick<Prisma.TransactionClient, 'generation'> = this.prisma.client,
  ) {
    await db.generation.update({
      where: { id: generationId },
      data: { cacheVersion: { increment: 1 } },
    });
  }
}
