import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Course, Prisma } from '@ssrs/database';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { paginated, skipTake, type Paginated } from '../common/pagination.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type {
  CreateCourseDto,
  CreateOfferingDto,
  ListCoursesQueryDto,
  ListOfferingsQueryDto,
  UpdateCourseDto,
  UpdateOfferingDto,
} from './courses.dto.js';

export interface CourseView {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

export interface OfferingView {
  id: string;
  generationId: string;
  term: { id: string; number: number; name: string };
  course: { id: string; code: string; name: string };
  externalKey: string;
  title: string;
  credits: string;
  visibility: 'HIDDEN' | 'VISIBLE';
  visibilityOverridden: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  sourceId: string | null;
  sheetTab: string | null;
  criteriaCount: number;
  publishedSchemeVersion: number | null;
  hasDraftScheme: boolean;
}

const OFFERING_INCLUDE = {
  term: { select: { id: true, number: true, name: true } },
  course: { select: { id: true, code: true, name: true } },
  schemes: {
    where: { status: { in: ['PUBLISHED', 'DRAFT'] } },
    select: { status: true, version: true },
  },
  _count: { select: { criteria: true } },
} satisfies Prisma.CourseOfferingInclude;

type OfferingRow = Prisma.CourseOfferingGetPayload<{ include: typeof OFFERING_INCLUDE }>;

function toCourseView(c: Course): CourseView {
  return { id: c.id, code: c.code, name: c.name, description: c.description };
}

function toOfferingView(o: OfferingRow): OfferingView {
  return {
    id: o.id,
    generationId: o.generationId,
    term: o.term,
    course: o.course,
    externalKey: o.externalKey,
    title: o.title,
    credits: o.credits.toFixed(1),
    visibility: o.visibility,
    visibilityOverridden: o.visibilityOverridden,
    status: o.status,
    sourceId: o.sourceId,
    sheetTab: o.sheetTab,
    criteriaCount: o._count.criteria,
    publishedSchemeVersion: o.schemes.find((s) => s.status === 'PUBLISHED')?.version ?? null,
    hasDraftScheme: o.schemes.some((s) => s.status === 'DRAFT'),
  };
}

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  // -- Catalog --------------------------------------------------------------------------------

  async listCourses(query: ListCoursesQueryDto): Promise<Paginated<CourseView>> {
    const where: Prisma.CourseWhereInput = query.q
      ? {
          OR: [
            { code: { contains: query.q, mode: 'insensitive' } },
            { name: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.client.course.findMany({ where, orderBy: { code: 'asc' }, ...skipTake(query) }),
      this.prisma.client.course.count({ where }),
    ]);
    return paginated(rows.map(toCourseView), total, query);
  }

  async createCourse(
    dto: CreateCourseDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CourseView> {
    try {
      const course = await this.prisma.client.$transaction(async (tx) => {
        const c = await tx.course.create({
          data: { code: dto.code, name: dto.name, description: dto.description || null },
        });
        await this.audit.record(
          {
            action: 'course.created',
            actorUserId: actor.userId,
            entityType: 'course',
            entityId: c.id,
            metadata: { code: c.code, name: c.name },
            context: meta,
          },
          tx,
        );
        return c;
      });
      return toCourseView(course);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'COURSE_CODE_EXISTS',
          message: `A course with code "${dto.code}" already exists`,
        });
      }
      throw err;
    }
  }

  async updateCourse(
    id: string,
    dto: UpdateCourseDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CourseView> {
    const existing = await this.prisma.client.course.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course not found' });
    const course = await this.prisma.client.$transaction(async (tx) => {
      const c = await tx.course.update({
        where: { id },
        data: {
          name: dto.name ?? existing.name,
          description:
            dto.description === undefined ? existing.description : dto.description || null,
        },
      });
      await this.audit.record(
        {
          action: 'course.updated',
          actorUserId: actor.userId,
          entityType: 'course',
          entityId: id,
          metadata: { changes: dto },
          context: meta,
        },
        tx,
      );
      return c;
    });
    return toCourseView(course);
  }

  // -- Offerings ------------------------------------------------------------------------------

  async listOfferings(query: ListOfferingsQueryDto): Promise<Paginated<OfferingView>> {
    const where: Prisma.CourseOfferingWhereInput = {
      generationId: query.generationId,
      ...(query.termNumber ? { term: { number: query.termNumber } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { externalKey: { contains: query.q, mode: 'insensitive' } },
              { course: { code: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.courseOffering.findMany({
        where,
        include: OFFERING_INCLUDE,
        orderBy: [{ term: { number: 'asc' } }, { title: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.client.courseOffering.count({ where }),
    ]);
    return paginated(rows.map(toOfferingView), total, query);
  }

  async getOffering(id: string): Promise<OfferingView> {
    const row = await this.prisma.client.courseOffering.findUnique({
      where: { id },
      include: OFFERING_INCLUDE,
    });
    if (!row)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course offering not found' });
    return toOfferingView(row);
  }

  /** Manually created offering (no owning spreadsheet source). */
  async createOffering(
    dto: CreateOfferingDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<OfferingView> {
    const term = await this.prisma.client.term.findUnique({ where: { id: dto.termId } });
    if (!term) {
      throw new UnprocessableEntityException({ code: 'TERM_NOT_FOUND', message: 'Term not found' });
    }
    const course = await this.prisma.client.course.findUnique({ where: { id: dto.courseId } });
    if (!course) {
      throw new UnprocessableEntityException({
        code: 'COURSE_NOT_FOUND',
        message: 'Course not found',
      });
    }
    await this.guard.assertGenerationEditable(term.generationId);

    try {
      const offering = await this.prisma.client.$transaction(async (tx) => {
        const o = await tx.courseOffering.create({
          data: {
            termId: term.id,
            generationId: term.generationId,
            courseId: course.id,
            externalKey: dto.externalKey,
            title: dto.title,
            credits: dto.credits ?? '1',
          },
        });
        await this.audit.record(
          {
            action: 'offering.created',
            actorUserId: actor.userId,
            entityType: 'offering',
            entityId: o.id,
            metadata: {
              externalKey: o.externalKey,
              termNumber: term.number,
              courseCode: course.code,
            },
            context: meta,
          },
          tx,
        );
        return o;
      });
      return this.getOffering(offering.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'OFFERING_EXISTS',
          message:
            'This course is already offered in that term, or the key is already used in this generation',
        });
      }
      throw err;
    }
  }

  async updateOffering(
    id: string,
    dto: UpdateOfferingDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<OfferingView> {
    const offering = await this.prisma.client.courseOffering.findUnique({ where: { id } });
    if (!offering)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course offering not found' });
    await this.guard.assertGenerationEditable(offering.generationId);

    const visibilityChanged =
      dto.visibility !== undefined && dto.visibility !== offering.visibility;
    const creditsChanged = dto.credits !== undefined && !offering.credits.equals(dto.credits);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.courseOffering.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.credits !== undefined ? { credits: dto.credits } : {}),
          // An explicit admin choice wins over the sheet's `visible` column from now on.
          ...(dto.visibility !== undefined
            ? { visibility: dto.visibility, visibilityOverridden: true }
            : {}),
        },
      });
      if (visibilityChanged || creditsChanged || dto.title !== undefined) {
        await this.guard.bumpCacheVersion(offering.generationId, tx);
      }
      await this.audit.record(
        {
          action: visibilityChanged ? 'offering.visibility_changed' : 'offering.updated',
          actorUserId: actor.userId,
          entityType: 'offering',
          entityId: id,
          metadata: { changes: dto, previousVisibility: offering.visibility },
          context: meta,
        },
        tx,
      );
    });
    return this.getOffering(id);
  }
}
