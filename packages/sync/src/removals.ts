import type { Prisma, PrismaClient } from '@ssrs/database';
import { cleanLabel, type ConfirmedTab, type TermWorkbookRead } from '@ssrs/sheets';
import { isNewOffering } from './promote.js';

type Db = Pick<PrismaClient, 'courseOffering' | 'enrollment' | 'assessmentScore'>;
type Tx = Prisma.TransactionClient;

export interface RemovedSubject {
  offeringId: string;
  subject: string;
  tabName: string | null;
  students: number;
  scores: number;
}

export interface AddedSubject {
  subject: string;
  tabName: string;
  /** An archived subject whose tab came back: it restarts empty. */
  returning: boolean;
}

/** The term's subjects against a sheet, computed the same way by a preview and by a sync. */
export interface SheetComparison {
  kept: string[];
  added: AddedSubject[];
  removed: RemovedSubject[];
  /** One tab gone and one new: it may be the same subject. */
  possibleRenames: { from: string; to: string }[];
  /** Why this sheet may not be confirmed, in the admin's words. */
  blockers: string[];
}

const normalize = (label: string) => cleanLabel(label).toLowerCase();

async function counted(db: Db, offeringIds: string[]) {
  const [students, scores] = await Promise.all([
    db.enrollment.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds }, status: 'ENROLLED' },
      _count: true,
    }),
    db.assessmentScore.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds }, status: { not: 'CLEARED' } },
      _count: true,
    }),
  ]);
  return {
    students: new Map(students.map((r) => [r.offeringId, r._count])),
    scores: new Map(scores.map((r) => [r.offeringId, r._count])),
  };
}

/**
 * Which of the term's subjects a sheet keeps, adds and removes. A subject is only called removed
 * when the workbook was read completely and none of its tabs feed it, so a failed or partial
 * read can never remove anything. A tab that is still in the sheet is never a removal: an
 * unconfirmed one blocks instead.
 */
export async function compareSheet(
  db: Db,
  termId: string,
  confirmed: readonly ConfirmedTab[],
  workbook: Pick<
    TermWorkbookRead,
    'fatal' | 'rosterTab' | 'missingTabs' | 'unmappedTabs' | 'roster'
  >,
): Promise<SheetComparison> {
  const offerings = await db.courseOffering.findMany({
    where: { termId },
    select: { id: true, title: true, status: true, sheetTab: true },
    orderBy: { title: 'asc' },
  });
  const missing = new Set(workbook.missingTabs);
  const fed = confirmed.filter((t) => !missing.has(t.tabName));
  const fedIds = new Set(fed.map((t) => t.offeringId));
  const active = offerings.filter((o) => o.status === 'ACTIVE');
  const archivedIds = new Set(offerings.filter((o) => o.status === 'ARCHIVED').map((o) => o.id));
  const unmapped = new Set(workbook.unmappedTabs.map(normalize));
  const stillInSheet = (o: { title: string; sheetTab: string | null }) =>
    unmapped.has(normalize(o.title)) ||
    (o.sheetTab !== null && unmapped.has(normalize(o.sheetTab)));

  const kept = active.filter((o) => fedIds.has(o.id));
  const added = fed
    .filter((t) => isNewOffering(t.offeringId) || archivedIds.has(t.offeringId))
    .map((t) => ({
      subject: t.title,
      tabName: t.tabName,
      returning: archivedIds.has(t.offeringId),
    }));
  const complete =
    !workbook.fatal &&
    workbook.rosterTab !== null &&
    workbook.roster.length > 0 &&
    fed.length + workbook.unmappedTabs.length > 0;
  const blockers: string[] = [];
  if (!workbook.fatal && !complete) {
    blockers.push('The workbook has no subject tabs or no students, so nothing can be removed.');
  }
  const gone = complete ? active.filter((o) => !fedIds.has(o.id) && !stillInSheet(o)) : [];
  const { students, scores } = await counted(
    db,
    gone.map((o) => o.id),
  );
  const removed = gone.map((o) => ({
    offeringId: o.id,
    subject: o.title,
    tabName: confirmed.find((t) => t.offeringId === o.id)?.tabName ?? o.sheetTab,
    students: students.get(o.id) ?? 0,
    scores: scores.get(o.id) ?? 0,
  }));
  const newTabs = [...added.map((a) => a.tabName), ...workbook.unmappedTabs];
  const [only] = removed;
  const [fresh] = newTabs;
  return {
    kept: kept.map((o) => o.title),
    added,
    removed,
    possibleRenames:
      only && fresh && removed.length === 1 && newTabs.length === 1
        ? [{ from: only.tabName ?? only.subject, to: fresh }]
        : [],
    blockers,
  };
}

const offeringKey = (list: readonly { offeringId: string }[]) =>
  JSON.stringify(list.map((r) => r.offeringId).toSorted());

export function sameRemovals(
  a: readonly { offeringId: string }[],
  b: readonly { offeringId: string }[],
): boolean {
  return offeringKey(a) === offeringKey(b);
}

/**
 * Applies the removals an admin confirmed, inside the sync's transaction: the subject is hidden
 * and its tab stops being read, while scores and history stay. Throwing rolls back the sync.
 */
export async function archiveSubjects(
  tx: Tx,
  context: { sourceId: string; syncJobId: string; requestedById: string; termId: string },
  removed: readonly RemovedSubject[],
  now: Date,
): Promise<void> {
  const { sourceId, syncJobId, requestedById, termId } = context;
  const archived = await tx.courseOffering.updateMany({
    where: { id: { in: removed.map((r) => r.offeringId) }, status: 'ACTIVE' },
    data: { status: 'ARCHIVED', archivedAt: now },
  });
  if (archived.count !== removed.length) throw new Error('The subjects changed during the sync');
  await tx.sheetTabMapping.updateMany({
    where: { sourceId, offeringId: { in: removed.map((r) => r.offeringId) } },
    data: { status: 'REMOVED', offeringId: null },
  });
  await tx.auditLog.createMany({
    data: removed.map((r) => ({
      actorType: 'USER' as const,
      actorUserId: requestedById,
      action: 'subject.archived',
      entityType: 'offering',
      entityId: r.offeringId,
      metadata: {
        termId,
        sourceId,
        syncJobId,
        subject: r.subject,
        tab: r.tabName,
        students: r.students,
        scores: r.scores,
      },
    })),
  });
}
