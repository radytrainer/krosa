import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@ssrs/database';
import { setTermVisibility, termReleaseFacts, type ReleaseState } from '@ssrs/sync';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';

/** One source's release state: its term's subjects, how many are released, who they reach. */
export interface SourceReleaseView {
  sourceId: string;
  label: string;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  generation: { id: string; name: string };
  term: { id: string; number: number; name: string };
  state: ReleaseState;
  subjects: number;
  visibleSubjects: number;
  students: number;
}

export interface SourceReleaseResult {
  sourceId: string;
  termId: string;
  oldState: ReleaseState;
  newState: ReleaseState;
  subjects: number;
  students: number;
}

const SOURCE_SELECT = {
  id: true,
  label: true,
  status: true,
  generation: { select: { id: true, name: true, status: true } },
  term: { select: { id: true, number: true, name: true } },
} satisfies Prisma.GoogleSheetSourceSelect;

/** Release state of the given sources, in the given order (decisions.md R1–R3). */
export async function sourceReleaseViews(
  db: Pick<PrismaClient, 'googleSheetSource' | 'courseOffering' | 'enrollment'>,
  where: Prisma.GoogleSheetSourceWhereInput,
  order?: readonly string[],
): Promise<SourceReleaseView[]> {
  const sources = await db.googleSheetSource.findMany({
    where,
    select: SOURCE_SELECT,
    orderBy: { createdAt: 'asc' },
  });
  const facts = new Map<string, Awaited<ReturnType<typeof termReleaseFacts>>>();
  const views: SourceReleaseView[] = [];
  for (const s of sources) {
    const f = facts.get(s.term.id) ?? (await termReleaseFacts(db, s.term.id));
    facts.set(s.term.id, f);
    views.push({
      sourceId: s.id,
      label: s.label,
      status: s.status,
      generation: { id: s.generation.id, name: s.generation.name },
      term: s.term,
      state: f.state,
      subjects: f.subjects,
      visibleSubjects: f.visibleSubjects,
      students: f.students,
    });
  }
  if (!order) return views;
  const rank = new Map(order.map((id, i) => [id, i]));
  return views.toSorted((a, b) => (rank.get(a.sourceId) ?? 0) - (rank.get(b.sourceId) ?? 0));
}

/**
 * Hide and Release from the Sync Center's per-source list. A source is one term's workbook, so
 * each action acts on the whole term, exactly like the term button (setTermVisibility).
 */
@Injectable()
export class SourceReleaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  status(sourceIds: readonly string[]): Promise<SourceReleaseView[]> {
    return sourceReleaseViews(this.prisma.client, { id: { in: [...sourceIds] } }, sourceIds);
  }

  /**
   * Releases or hides the terms of the given sources in one transaction, with one audit entry
   * per source: admin, source, term, old and new state, subjects and students; time is the
   * entry's own. A term listed twice (its active and pending sheet) changes once.
   */
  async setReleased(
    sourceIds: readonly string[],
    visible: boolean,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<SourceReleaseResult[]> {
    const ids = [...new Set(sourceIds)];
    const rows = await this.prisma.client.googleSheetSource.findMany({
      where: { id: { in: ids } },
      select: SOURCE_SELECT,
    });
    const sources = new Map(rows.map((s) => [s.id, s]));
    if (sources.size !== ids.length) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Spreadsheet source not found' });
    }
    for (const generationId of new Set(rows.map((s) => s.generation.id))) {
      await this.guard.assertGenerationEditable(generationId);
    }

    return this.prisma.client.$transaction(async (tx) => {
      const results: SourceReleaseResult[] = [];
      const done = new Map<string, SourceReleaseResult>();
      for (const source of ids.flatMap((id) => sources.get(id) ?? [])) {
        const already = done.get(source.term.id);
        const change = already ?? (await setTermVisibility(tx, source.term.id, visible));
        if (!change) {
          throw new UnprocessableEntityException({
            code: 'NOTHING_TO_RELEASE',
            message: `${source.generation.name}, ${source.term.name} has no synced subjects yet.`,
          });
        }
        const result = { ...change, sourceId: source.id };
        done.set(source.term.id, result);
        results.push(result);
        await this.audit.record(
          {
            action: visible ? 'source.released' : 'source.hidden',
            actorUserId: actor.userId,
            entityType: 'source',
            entityId: source.id,
            metadata: {
              sourceId: source.id,
              termId: source.term.id,
              termNumber: source.term.number,
              generationId: source.generation.id,
              oldState: change.oldState,
              newState: change.newState,
              subjects: change.subjects,
              students: change.students,
            },
            context: meta,
          },
          tx,
        );
      }
      return results;
    });
  }
}
