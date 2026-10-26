import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Generation, Prisma, Term } from '@ssrs/database';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { formatDateOnly, parseDateOnly } from '../common/dates.js';
import { paginated, skipTake, type Paginated } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type {
  CreateGenerationDto,
  ListGenerationsQueryDto,
  UpdateGenerationDto,
  UpdateTermDto,
} from './generations.dto.js';

/** Every generation has exactly five terms (ACAD-02, docs/requirements.md A4). */
export const TERMS_PER_GENERATION = 5;

export interface TermView {
  id: string;
  number: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export interface GenerationView {
  id: string;
  code: string;
  name: string;
  startDate: string;
  endDate: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export interface GenerationDetailView extends GenerationView {
  terms: TermView[];
  counts: { students: number; offerings: number; sources: number };
}

export function toTermView(t: Term): TermView {
  return {
    id: t.id,
    number: t.number,
    name: t.name,
    startDate: formatDateOnly(t.startDate),
    endDate: formatDateOnly(t.endDate),
  };
}

function toView(g: Generation): GenerationView {
  return {
    id: g.id,
    code: g.code,
    name: g.name,
    startDate: formatDateOnly(g.startDate),
    endDate: formatDateOnly(g.endDate),
    status: g.status,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

function assertDateRange(start: Date | null, end: Date | null): void {
  if (start && end && end < start) {
    throw new UnprocessableEntityException({
      code: 'INVALID_DATE_RANGE',
      message: 'End date must not be before start date',
    });
  }
}

@Injectable()
export class GenerationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  async list(query: ListGenerationsQueryDto): Promise<Paginated<GenerationView>> {
    const where: Prisma.GenerationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { name: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.generation.findMany({
        where,
        orderBy: [{ startDate: 'desc' }, { code: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.client.generation.count({ where }),
    ]);
    return paginated(rows.map(toView), total, query);
  }

  async get(id: string): Promise<GenerationDetailView> {
    const generation = await this.prisma.client.generation.findUnique({
      where: { id },
      include: {
        terms: { orderBy: { number: 'asc' } },
        _count: { select: { students: true, offerings: true, sources: true } },
      },
    });
    if (!generation)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    return {
      ...toView(generation),
      terms: generation.terms.map(toTermView),
      counts: generation._count,
    };
  }

  /** Creates the generation and its five terms atomically. */
  async create(
    dto: CreateGenerationDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<GenerationDetailView> {
    const startDate = parseDateOnly(dto.startDate);
    const endDate = dto.endDate ? parseDateOnly(dto.endDate) : null;
    assertDateRange(startDate, endDate);

    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const generation = await tx.generation.create({
          data: {
            code: dto.code,
            name: dto.name,
            startDate,
            endDate,
            terms: {
              create: Array.from({ length: TERMS_PER_GENERATION }, (_, i) => ({
                number: i + 1,
                name: `Term ${i + 1}`,
              })),
            },
          },
        });
        await this.audit.record(
          {
            action: 'generation.created',
            actorUserId: actor.userId,
            entityType: 'generation',
            entityId: generation.id,
            metadata: { code: generation.code, name: generation.name },
            context: meta,
          },
          tx,
        );
        return generation;
      });
      return this.get(created.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'GENERATION_CODE_EXISTS',
          message: `A generation with code "${dto.code}" already exists`,
        });
      }
      throw err;
    }
  }

  async update(
    id: string,
    dto: UpdateGenerationDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<GenerationDetailView> {
    const existing = await this.prisma.client.generation.findUnique({ where: { id } });
    if (!existing)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    await this.guard.assertGenerationEditable(id);

    const startDate = dto.startDate ? parseDateOnly(dto.startDate) : existing.startDate;
    const endDate =
      dto.endDate === undefined
        ? existing.endDate
        : dto.endDate === null
          ? null
          : parseDateOnly(dto.endDate);
    assertDateRange(startDate, endDate);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.generation.update({
        where: { id },
        data: { name: dto.name ?? existing.name, startDate, endDate },
      });
      await this.audit.record(
        {
          action: 'generation.updated',
          actorUserId: actor.userId,
          entityType: 'generation',
          entityId: id,
          metadata: { changes: dto },
          context: meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async setStatus(
    id: string,
    status: 'ACTIVE' | 'ARCHIVED',
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<GenerationDetailView> {
    const existing = await this.prisma.client.generation.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!existing)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    if (existing.status !== status) {
      await this.prisma.client.$transaction(async (tx) => {
        await tx.generation.update({ where: { id }, data: { status } });
        await this.audit.record(
          {
            action: status === 'ARCHIVED' ? 'generation.archived' : 'generation.activated',
            actorUserId: actor.userId,
            entityType: 'generation',
            entityId: id,
            context: meta,
          },
          tx,
        );
      });
    }
    return this.get(id);
  }

  async listTerms(generationId: string): Promise<TermView[]> {
    const generation = await this.prisma.client.generation.findUnique({
      where: { id: generationId },
      include: { terms: { orderBy: { number: 'asc' } } },
    });
    if (!generation)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Generation not found' });
    return generation.terms.map(toTermView);
  }

  async updateTerm(
    id: string,
    dto: UpdateTermDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermView> {
    const term = await this.prisma.client.term.findUnique({ where: { id } });
    if (!term) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Term not found' });
    await this.guard.assertGenerationEditable(term.generationId);

    const startDate =
      dto.startDate === undefined
        ? term.startDate
        : dto.startDate === null
          ? null
          : parseDateOnly(dto.startDate);
    const endDate =
      dto.endDate === undefined
        ? term.endDate
        : dto.endDate === null
          ? null
          : parseDateOnly(dto.endDate);
    assertDateRange(startDate, endDate);

    const updated = await this.prisma.client.$transaction(async (tx) => {
      const t = await tx.term.update({
        where: { id },
        data: { name: dto.name ?? term.name, startDate, endDate },
      });
      await this.audit.record(
        {
          action: 'term.updated',
          actorUserId: actor.userId,
          entityType: 'term',
          entityId: id,
          metadata: { changes: dto },
          context: meta,
        },
        tx,
      );
      return t;
    });
    return toTermView(updated);
  }
}
