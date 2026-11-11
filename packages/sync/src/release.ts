import type { Prisma, PrismaClient } from '@ssrs/database';

/**
 * Releasing and hiding scores (docs/decisions.md R1–R5). Release is per term: one call shows or
 * hides every subject of the term, like the term button. A source is one term's workbook, so a
 * per-source action acts on its term. Nothing is deleted; students only ever get VISIBLE subjects.
 */

type Db = Pick<PrismaClient, 'courseOffering' | 'enrollment'>;
type Tx = Prisma.TransactionClient;

/** EMPTY: nothing synced yet. PARTLY_RELEASED: some subjects visible, some hidden. */
export type ReleaseState = 'RELEASED' | 'HIDDEN' | 'PARTLY_RELEASED' | 'EMPTY';

export interface TermReleaseFacts {
  /** ACTIVE subjects of the term. */
  subjects: number;
  visibleSubjects: number;
  /** Distinct students with an ENROLLED enrollment in those subjects: who a change reaches. */
  students: number;
  state: ReleaseState;
}

export function releaseState(subjects: number, visibleSubjects: number): ReleaseState {
  if (subjects === 0) return 'EMPTY';
  if (visibleSubjects === 0) return 'HIDDEN';
  return visibleSubjects === subjects ? 'RELEASED' : 'PARTLY_RELEASED';
}

export async function termReleaseFacts(db: Db, termId: string): Promise<TermReleaseFacts> {
  const [subjects, visibleSubjects, students] = await Promise.all([
    db.courseOffering.count({ where: { termId, status: 'ACTIVE' } }),
    db.courseOffering.count({ where: { termId, status: 'ACTIVE', visibility: 'VISIBLE' } }),
    db.enrollment.findMany({
      where: { status: 'ENROLLED', offering: { termId, status: 'ACTIVE' } },
      distinct: ['studentId'],
      select: { studentId: true },
    }),
  ]);
  return {
    subjects,
    visibleSubjects,
    students: students.length,
    state: releaseState(subjects, visibleSubjects),
  };
}

export interface TermReleaseChange {
  termId: string;
  oldState: ReleaseState;
  newState: ReleaseState;
  /** Subject rows set (every subject of the term, as the term button always did). */
  subjects: number;
  students: number;
}

/**
 * Shows or hides every subject of a term, inside the caller's transaction, and makes cached
 * student results stale at once. Marks the subjects as set by an admin (`visibility_overridden`),
 * which nothing reads today. Returns null when the term has no subject. The caller audits.
 */
export async function setTermVisibility(
  tx: Tx,
  termId: string,
  visible: boolean,
): Promise<TermReleaseChange | null> {
  const before = await termReleaseFacts(tx, termId);
  const updated = await tx.courseOffering.updateMany({
    where: { termId },
    data: { visibility: visible ? 'VISIBLE' : 'HIDDEN', visibilityOverridden: true },
  });
  if (updated.count === 0) return null;
  const term = await tx.term.findUniqueOrThrow({
    where: { id: termId },
    select: { generationId: true },
  });
  await tx.generation.update({
    where: { id: term.generationId },
    data: { cacheVersion: { increment: 1 } },
  });
  const after = await termReleaseFacts(tx, termId);
  return {
    termId,
    oldState: before.state,
    newState: after.state,
    subjects: updated.count,
    students: after.students,
  };
}
