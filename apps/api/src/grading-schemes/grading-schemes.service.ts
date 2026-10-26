import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import { validateScheme, type SchemeIssue } from '@ssrs/shared';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { SaveDraftSchemeDto } from './grading-schemes.dto.js';

/** Engine issues plus checks that need the database. */
export type PublishIssue =
  | SchemeIssue
  | { code: 'INACTIVE_CRITERION'; message: string; criterionId: string }
  | { code: 'MARKS_EXCEED_MAX'; message: string; criterionId: string; count: number };

export interface SchemeValidationView {
  valid: boolean;
  totalWeight: string;
  issues: PublishIssue[];
}

export interface SchemeItemView {
  criterionId: string;
  key: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
  maxMark: string;
  weight: string;
}

export interface SchemeView {
  id: string;
  offeringId: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  origin: 'SHEET' | 'ADMIN';
  totalWeight: string;
  publishedAt: string | null;
  publishedBy: { id: string; username: string } | null;
  notes: string | null;
  createdAt: string;
  items: SchemeItemView[];
  /** Present on drafts: whether it could be published now. */
  validation?: SchemeValidationView;
}

const SCHEME_INCLUDE = {
  items: {
    include: {
      criterion: { select: { key: true, name: true, isActive: true, displayOrder: true } },
    },
  },
  publishedBy: { select: { id: true, username: true } },
} satisfies Prisma.GradingSchemeInclude;

type SchemeRow = Prisma.GradingSchemeGetPayload<{ include: typeof SCHEME_INCLUDE }>;
type Tx = Prisma.TransactionClient;

function toView(s: SchemeRow, validation?: SchemeValidationView): SchemeView {
  return {
    id: s.id,
    offeringId: s.offeringId,
    version: s.version,
    status: s.status,
    origin: s.origin,
    totalWeight: s.totalWeight.toFixed(3),
    publishedAt: s.publishedAt?.toISOString() ?? null,
    publishedBy: s.publishedBy,
    notes: s.notes,
    createdAt: s.createdAt.toISOString(),
    items: s.items
      .map((i) => ({
        criterionId: i.criterionId,
        key: i.criterion.key,
        name: i.criterion.name,
        isActive: i.criterion.isActive,
        displayOrder: i.criterion.displayOrder,
        maxMark: i.maxMark.toFixed(3),
        weight: i.weight.toFixed(3),
      }))
      .toSorted((a, b) => a.displayOrder - b.displayOrder),
    ...(validation ? { validation } : {}),
  };
}

/** Serializes scheme changes per offering (version numbering, publish/archive swap). */
async function lockOffering(tx: Tx, offeringId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM course_offerings WHERE id = ${offeringId}::uuid FOR UPDATE`;
}

@Injectable()
export class GradingSchemesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  async list(offeringId: string): Promise<SchemeView[]> {
    const offering = await this.prisma.client.courseOffering.findUnique({
      where: { id: offeringId },
      select: { id: true },
    });
    if (!offering)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course offering not found' });
    const schemes = await this.prisma.client.gradingScheme.findMany({
      where: { offeringId },
      include: SCHEME_INCLUDE,
      orderBy: { version: 'desc' },
    });
    return Promise.all(
      schemes.map(async (s) =>
        toView(s, s.status === 'DRAFT' ? await this.validate(s) : undefined),
      ),
    );
  }

  private async getRow(id: string): Promise<SchemeRow> {
    const scheme = await this.prisma.client.gradingScheme.findUnique({
      where: { id },
      include: SCHEME_INCLUDE,
    });
    if (!scheme)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Grading scheme not found' });
    return scheme;
  }

  async get(id: string): Promise<SchemeView> {
    const scheme = await this.getRow(id);
    return toView(scheme, scheme.status === 'DRAFT' ? await this.validate(scheme) : undefined);
  }

  /** Validation for publishing: weights/max marks, active criteria, existing marks within max. */
  private async validate(scheme: SchemeRow): Promise<SchemeValidationView> {
    const result = validateScheme(
      scheme.items.map((i) => ({
        criterionId: i.criterionId,
        maxMark: i.maxMark.toString(),
        weight: i.weight.toString(),
      })),
    );
    const issues: PublishIssue[] = [...result.issues];

    for (const item of scheme.items) {
      if (!item.criterion.isActive) {
        issues.push({
          code: 'INACTIVE_CRITERION',
          message: `Criterion ${item.criterion.key} is inactive.`,
          criterionId: item.criterionId,
        });
      }
    }

    // Lowering a max mark must not make stored marks invalid.
    if (scheme.items.length > 0) {
      const exceeded = await this.prisma.client.$queryRaw<
        { criterion_id: string; count: bigint }[]
      >`
        SELECT s.criterion_id, COUNT(*)::bigint AS count
        FROM assessment_scores s
        JOIN grading_scheme_items i ON i.criterion_id = s.criterion_id AND i.scheme_id = ${scheme.id}::uuid
        WHERE s.mark > i.max_mark
        GROUP BY s.criterion_id`;
      for (const row of exceeded) {
        const key =
          scheme.items.find((i) => i.criterionId === row.criterion_id)?.criterion.key ?? '?';
        issues.push({
          code: 'MARKS_EXCEED_MAX',
          message: `${row.count} recorded mark(s) for ${key} exceed the new maximum mark.`,
          criterionId: row.criterion_id,
          count: Number(row.count),
        });
      }
    }
    return { valid: issues.length === 0, totalWeight: result.totalWeight, issues };
  }

  async validateDraft(offeringId: string): Promise<SchemeValidationView> {
    const draft = await this.prisma.client.gradingScheme.findFirst({
      where: { offeringId, status: 'DRAFT' },
      include: SCHEME_INCLUDE,
    });
    if (!draft)
      throw new NotFoundException({ code: 'NO_DRAFT', message: 'This course has no draft scheme' });
    return this.validate(draft);
  }

  /** Creates the offering's draft, or replaces the items of the existing draft. */
  async saveDraft(
    offeringId: string,
    dto: SaveDraftSchemeDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SchemeView> {
    await this.guard.editableOffering(offeringId);

    const ids = dto.items.map((i) => i.criterionId);
    if (new Set(ids).size !== ids.length) {
      throw new UnprocessableEntityException({
        code: 'DUPLICATE_CRITERION',
        message: 'A criterion appears more than once',
      });
    }
    const criteria = await this.prisma.client.assessmentCriterion.findMany({
      where: { id: { in: ids } },
      select: { id: true, offeringId: true, isActive: true, key: true },
    });
    const byId = new Map(criteria.map((c) => [c.id, c]));
    for (const id of ids) {
      const c = byId.get(id);
      if (!c || c.offeringId !== offeringId) {
        throw new UnprocessableEntityException({
          code: 'CRITERION_NOT_IN_OFFERING',
          message: 'Every criterion must belong to this course',
          details: [{ field: 'items', message: `Unknown criterion ${id}` }],
        });
      }
      if (!c.isActive) {
        throw new UnprocessableEntityException({
          code: 'INACTIVE_CRITERION',
          message: `Criterion ${c.key} is inactive and cannot be added to a scheme`,
        });
      }
    }

    const totalWeight = validateScheme(dto.items).totalWeight;
    try {
      const schemeId = await this.prisma.client.$transaction(async (tx) => {
        await lockOffering(tx, offeringId);
        const existing = await tx.gradingScheme.findFirst({
          where: { offeringId, status: 'DRAFT' },
        });
        let id: string;
        let version: number;
        if (existing) {
          await tx.gradingSchemeItem.deleteMany({ where: { schemeId: existing.id } });
          await tx.gradingScheme.update({
            where: { id: existing.id },
            data: {
              origin: 'ADMIN',
              createdById: actor.userId,
              syncJobId: null,
              notes: dto.notes || null,
              totalWeight,
            },
          });
          id = existing.id;
          version = existing.version;
        } else {
          const last = await tx.gradingScheme.aggregate({
            where: { offeringId },
            _max: { version: true },
          });
          version = (last._max.version ?? 0) + 1;
          const created = await tx.gradingScheme.create({
            data: {
              offeringId,
              version,
              status: 'DRAFT',
              origin: 'ADMIN',
              createdById: actor.userId,
              notes: dto.notes || null,
              totalWeight,
            },
          });
          id = created.id;
        }
        if (dto.items.length > 0) {
          await tx.gradingSchemeItem.createMany({
            data: dto.items.map((i) => ({
              schemeId: id,
              offeringId,
              criterionId: i.criterionId,
              maxMark: i.maxMark,
              weight: i.weight,
            })),
          });
        }
        await this.audit.record(
          {
            action: 'scheme.draft_saved',
            actorUserId: actor.userId,
            entityType: 'grading_scheme',
            entityId: id,
            metadata: { offeringId, version, totalWeight, items: dto.items },
            context: meta,
          },
          tx,
        );
        return id;
      });
      return this.get(schemeId);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'CONCURRENT_SCHEME_CHANGE',
          message: 'The grading scheme was changed concurrently. Reload and try again.',
        });
      }
      throw err;
    }
  }

  /** Publishes a draft: the previously published version is archived in the same transaction. */
  async publish(id: string, actor: AuthUser, meta: RequestMeta): Promise<SchemeView> {
    const scheme = await this.getRow(id);
    if (scheme.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'SCHEME_NOT_DRAFT',
        message: 'Only a draft can be published',
      });
    }
    const offering = await this.guard.editableOffering(scheme.offeringId);

    const validation = await this.validate(scheme);
    if (!validation.valid) {
      throw new UnprocessableEntityException({
        code: validation.issues[0]?.code ?? 'SCHEME_INVALID',
        message: 'The grading scheme cannot be published',
        details: validation.issues.map((i) => ({ field: 'items', message: i.message })),
        issues: validation.issues,
      });
    }

    await this.prisma.client.$transaction(async (tx) => {
      await lockOffering(tx, scheme.offeringId);
      const current = await tx.gradingScheme.findUnique({
        where: { id },
        select: { status: true },
      });
      if (current?.status !== 'DRAFT') {
        throw new ConflictException({
          code: 'SCHEME_NOT_DRAFT',
          message: 'Only a draft can be published',
        });
      }
      const previous = await tx.gradingScheme.findFirst({
        where: { offeringId: scheme.offeringId, status: 'PUBLISHED' },
        select: { id: true, version: true },
      });
      if (previous) {
        await tx.gradingScheme.update({ where: { id: previous.id }, data: { status: 'ARCHIVED' } });
      }
      await tx.gradingScheme.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedById: actor.userId,
          totalWeight: validation.totalWeight,
        },
      });
      // Results are recalculated on read from the published scheme; drop cached copies.
      await this.guard.bumpCacheVersion(offering.generationId, tx);
      await this.audit.record(
        {
          action: 'scheme.published',
          actorUserId: actor.userId,
          entityType: 'grading_scheme',
          entityId: id,
          metadata: {
            offeringId: scheme.offeringId,
            version: scheme.version,
            replacedVersion: previous?.version ?? null,
            items: scheme.items.map((i) => ({
              key: i.criterion.key,
              maxMark: i.maxMark.toFixed(3),
              weight: i.weight.toFixed(3),
            })),
          },
          context: meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async deleteDraft(id: string, actor: AuthUser, meta: RequestMeta): Promise<void> {
    const scheme = await this.getRow(id);
    if (scheme.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'SCHEME_NOT_DRAFT',
        message: 'Published and archived schemes are kept for auditability and cannot be deleted',
      });
    }
    await this.guard.editableOffering(scheme.offeringId);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.gradingScheme.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'scheme.draft_deleted',
          actorUserId: actor.userId,
          entityType: 'grading_scheme',
          entityId: id,
          metadata: { offeringId: scheme.offeringId, version: scheme.version },
          context: meta,
        },
        tx,
      );
    });
  }
}
