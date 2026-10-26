import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AssessmentCriterion } from '@ssrs/database';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { isUniqueViolation } from '../common/prisma-errors.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { CreateCriterionDto, ReorderCriteriaDto, UpdateCriterionDto } from './criteria.dto.js';

export interface CriterionView {
  id: string;
  offeringId: string;
  key: string;
  name: string;
  category: AssessmentCriterion['category'];
  displayOrder: number;
  isActive: boolean;
  description: string | null;
  sheetColumnKey: string | null;
  /** Max mark / weight in the PUBLISHED scheme, if the criterion is part of it. */
  published: { maxMark: string; weight: string } | null;
  scoreCount: number;
}

@Injectable()
export class CriteriaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  async list(offeringId: string): Promise<CriterionView[]> {
    const offering = await this.prisma.client.courseOffering.findUnique({
      where: { id: offeringId },
      select: { id: true },
    });
    if (!offering)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Course offering not found' });

    const criteria = await this.prisma.client.assessmentCriterion.findMany({
      where: { offeringId },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: {
        schemeItems: {
          where: { scheme: { status: 'PUBLISHED' } },
          select: { maxMark: true, weight: true },
        },
        _count: { select: { scores: true } },
      },
    });
    return criteria.map((c) => {
      const item = c.schemeItems[0];
      return {
        id: c.id,
        offeringId: c.offeringId,
        key: c.key,
        name: c.name,
        category: c.category,
        displayOrder: c.displayOrder,
        isActive: c.isActive,
        description: c.description,
        sheetColumnKey: c.sheetColumnKey,
        published: item
          ? { maxMark: item.maxMark.toFixed(3), weight: item.weight.toFixed(3) }
          : null,
        scoreCount: c._count.scores,
      };
    });
  }

  private async view(id: string): Promise<CriterionView> {
    const criterion = await this.prisma.client.assessmentCriterion.findUniqueOrThrow({
      where: { id },
      select: { offeringId: true },
    });
    const found = (await this.list(criterion.offeringId)).find((c) => c.id === id);
    if (!found) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Criterion not found' });
    return found;
  }

  async create(
    offeringId: string,
    dto: CreateCriterionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CriterionView> {
    await this.guard.editableOffering(offeringId);
    try {
      const created = await this.prisma.client.$transaction(async (tx) => {
        const last = await tx.assessmentCriterion.aggregate({
          where: { offeringId },
          _max: { displayOrder: true },
        });
        const criterion = await tx.assessmentCriterion.create({
          data: {
            offeringId,
            key: dto.key,
            name: dto.name,
            category: dto.category ?? 'OTHER',
            description: dto.description || null,
            sheetColumnKey: dto.sheetColumnKey ?? null,
            displayOrder: (last._max.displayOrder ?? 0) + 1,
          },
        });
        await this.audit.record(
          {
            action: 'criterion.created',
            actorUserId: actor.userId,
            entityType: 'criterion',
            entityId: criterion.id,
            metadata: { offeringId, key: criterion.key, name: criterion.name },
            context: meta,
          },
          tx,
        );
        return criterion;
      });
      return this.view(created.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'CRITERION_KEY_EXISTS',
          message:
            'This key or sheet column key is already used by another criterion of the course',
        });
      }
      throw err;
    }
  }

  /**
   * Renames and other edits never touch scores (they reference the criterion by id).
   * Deactivation policy (CRIT-05): a criterion in the PUBLISHED scheme cannot be deactivated
   * until a scheme without it is published; it is removed from the current draft, if any.
   */
  async update(
    id: string,
    dto: UpdateCriterionDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CriterionView> {
    const criterion = await this.prisma.client.assessmentCriterion.findUnique({ where: { id } });
    if (!criterion)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Criterion not found' });
    const offering = await this.guard.editableOffering(criterion.offeringId);

    const deactivating = dto.isActive === false && criterion.isActive;
    try {
      await this.prisma.client.$transaction(async (tx) => {
        let removedFromDraft = false;
        if (deactivating) {
          const inPublished = await tx.gradingSchemeItem.count({
            where: { criterionId: id, scheme: { status: 'PUBLISHED' } },
          });
          if (inPublished > 0) {
            throw new ConflictException({
              code: 'CRITERION_IN_PUBLISHED_SCHEME',
              message:
                'This criterion is part of the published grading scheme. Publish a scheme without it first.',
            });
          }
          const draftItems = await tx.gradingSchemeItem.findMany({
            where: { criterionId: id, scheme: { status: 'DRAFT' } },
            select: { id: true, schemeId: true, weight: true },
          });
          for (const item of draftItems) {
            await tx.gradingSchemeItem.delete({ where: { id: item.id } });
            await tx.gradingScheme.update({
              where: { id: item.schemeId },
              data: { totalWeight: { decrement: item.weight } },
            });
            removedFromDraft = true;
          }
        }

        await tx.assessmentCriterion.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.category !== undefined ? { category: dto.category } : {}),
            ...(dto.description !== undefined ? { description: dto.description || null } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
            ...(dto.sheetColumnKey !== undefined ? { sheetColumnKey: dto.sheetColumnKey } : {}),
          },
        });
        // Names appear in student results.
        if (dto.name !== undefined || dto.category !== undefined) {
          await this.guard.bumpCacheVersion(offering.generationId, tx);
        }
        await this.audit.record(
          {
            action: deactivating ? 'criterion.deactivated' : 'criterion.updated',
            actorUserId: actor.userId,
            entityType: 'criterion',
            entityId: id,
            metadata: {
              key: criterion.key,
              previousName: criterion.name,
              changes: dto,
              removedFromDraft,
            },
            context: meta,
          },
          tx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'CRITERION_KEY_EXISTS',
          message: 'This sheet column key is already used by another criterion of the course',
        });
      }
      throw err;
    }
    return this.view(id);
  }

  /** Sets display order 1…n. The list must contain every criterion of the offering exactly once. */
  async reorder(
    offeringId: string,
    dto: ReorderCriteriaDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<CriterionView[]> {
    const offering = await this.guard.editableOffering(offeringId);
    const existing = await this.prisma.client.assessmentCriterion.findMany({
      where: { offeringId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((c) => c.id));
    if (
      dto.criterionIds.length !== existingIds.size ||
      !dto.criterionIds.every((id) => existingIds.has(id))
    ) {
      throw new UnprocessableEntityException({
        code: 'INVALID_CRITERIA_ORDER',
        message: 'criterionIds must list every criterion of this course exactly once',
      });
    }

    await this.prisma.client.$transaction(async (tx) => {
      for (const [index, id] of dto.criterionIds.entries()) {
        await tx.assessmentCriterion.update({ where: { id }, data: { displayOrder: index + 1 } });
      }
      await this.guard.bumpCacheVersion(offering.generationId, tx);
      await this.audit.record(
        {
          action: 'criteria.reordered',
          actorUserId: actor.userId,
          entityType: 'offering',
          entityId: offeringId,
          metadata: { order: dto.criterionIds },
          context: meta,
        },
        tx,
      );
    });
    return this.list(offeringId);
  }
}
