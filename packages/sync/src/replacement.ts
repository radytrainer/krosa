import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@ssrs/database';
import {
  cleanLabel,
  keyFromName,
  type ConfirmedTab,
  type RosterStudent,
  type TermWorkbookRead,
} from '@ssrs/sheets';
import { compareNames } from './names.js';
import { isNewOffering } from './promote.js';
import { refreshLatestTerm } from './student-terms.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Sheet replacement (decisions.md RP1–RP4): a pending sheet of another spreadsheet than the one
 * that last fed the term replaces the term's data for good. The deletion set is computed here,
 * by the one function the preview and the sync both call; the sync recomputes it inside its
 * transaction and refuses to go on when it differs from the confirmed preview.
 */

export interface ReplacementCounts {
  subjects: number;
  scoreRows: number;
  scoreHistoryRows: number;
  comments: number;
  enrollments: number;
  termEnrollments: number;
  accounts: number;
  /** Accounts the rule would delete but never deletes: used, or name corrected (RP10). */
  accountsProtected: number;
}

export type ProtectedReason = 'LOGGED_IN' | 'NAME_EDITED';

/** Why an account is never deleted by a replacement (RP10); null: not protected. */
export function protectedReason(s: {
  nameEditedAt: Date | null;
  user: { status: string; passwordChangedAt: Date | null; lastLoginAt: Date | null };
}): ProtectedReason | null {
  if (s.nameEditedAt) return 'NAME_EDITED';
  if (s.user.status !== 'PENDING' || s.user.passwordChangedAt || s.user.lastLoginAt) {
    return 'LOGGED_IN';
  }
  return null;
}

export interface DeletedSubject {
  offeringId: string;
  subject: string;
  students: number;
  scores: number;
  comments: number;
}

export interface ReplacementSet {
  termId: string;
  oldSourceId: string | null;
  oldSpreadsheetId: string | null;
  /** Every offering of the term, kept or deleted: its student data goes. */
  offeringIds: string[];
  kept: string[];
  added: string[];
  deleted: DeletedSubject[];
  /** Accounts deleted with everything they have (only this term's data, by definition). */
  accounts: { studentId: string; userId: string; studentCode: string; fullName: string }[];
  /** Accounts that would be deleted but are protected (RP10): kept, only this term's data goes. */
  protectedAccounts: {
    studentId: string;
    studentCode: string;
    fullName: string;
    reason: ProtectedReason;
  }[];
  /** Students with data in the term, before the replacement. */
  oldStudents: { studentId: string; studentCode: string; fullName: string }[];
  /** The term enrollments (student_terms) to delete, decided once from the full roster. */
  termEnrollments: { id: string; studentId: string }[];
  counts: ReplacementCounts;
  manifestHash: string;
}

/** The preview's view of a replacement (contract: PreviewSummary['replacement']). */
export interface ReplacementSummary {
  termLabel: string;
  oldSourceId: string | null;
  subjects: { kept: string[]; added: string[]; deleted: DeletedSubject[] };
  students: {
    kept: number;
    added: number;
    dataRemoved: { studentCode: string; fullName: string }[];
    accountsDeleted: { studentCode: string; fullName: string }[];
    accountsProtected: { studentCode: string; fullName: string; reason: ProtectedReason }[];
  };
  counts: ReplacementCounts;
  manifestHash: string;
}

/**
 * The sheet a pending source would replace, when it is another spreadsheet: the term's active
 * source, or after a Remove the disabled one that synced last. Null: not a replacement.
 */
export async function replacedSource(
  db: Db,
  source: { id: string; termId: string; spreadsheetId: string; status: string },
): Promise<{ id: string; spreadsheetId: string } | null> {
  if (source.status !== 'PENDING') return null;
  const active = await db.googleSheetSource.findFirst({
    where: { termId: source.termId, status: 'ACTIVE', id: { not: source.id } },
    select: { id: true, spreadsheetId: true },
  });
  const last =
    active ??
    (await db.googleSheetSource.findFirst({
      where: { termId: source.termId, status: 'DISABLED', lastSyncedAt: { not: null } },
      orderBy: { lastSyncedAt: 'desc' },
      select: { id: true, spreadsheetId: true },
    }));
  if (!last || last.spreadsheetId === source.spreadsheetId) return null;
  return last;
}

export const termLabel = (generationCode: string, termNumber: number) =>
  `${generationCode} Term ${termNumber}`;

/**
 * The offering a confirmed tab will feed, found the way the promoting sync finds it
 * (promote.ts prepareSubjects): its mapping's offering, else the term's offering of the course its
 * name or alias names. Null: the sync creates a new subject.
 */
async function fedOffering(db: Db, termId: string, tab: ConfirmedTab): Promise<string | null> {
  if (!isNewOffering(tab.offeringId)) return tab.offeringId;
  const names = [...new Set([cleanLabel(tab.tabName), tab.title])];
  const alias = await db.courseAlias.findFirst({ where: { alias: { in: names } } });
  const courseId =
    alias?.courseId ??
    (await db.course.findUnique({ where: { code: keyFromName(tab.title) }, select: { id: true } }))
      ?.id;
  if (!courseId) return null;
  const offering = await db.courseOffering.findUnique({
    where: { termId_courseId: { termId, courseId } },
    select: { id: true },
  });
  return offering?.id ?? null;
}

const byCount = (rows: { offeringId: string; _count: number }[]) =>
  new Map(rows.map((r) => [r.offeringId, r._count]));

/** The deletion set of a replacement. Reads only; the same for a preview and a sync. */
export async function computeReplacement(
  db: Db,
  input: {
    source: { id: string; termId: string; generationId: string };
    old: { id: string; spreadsheetId: string };
    confirmed: readonly ConfirmedTab[];
    workbook: Pick<TermWorkbookRead, 'missingTabs' | 'roster' | 'rosterDuplicates'>;
  },
): Promise<ReplacementSet> {
  const { source, workbook } = input;
  const termId = source.termId;
  const missing = new Set(workbook.missingTabs);
  const fed = input.confirmed.filter((t) => !missing.has(t.tabName));
  const fedIds = new Set<string>();
  const added: string[] = [];
  for (const tab of fed) {
    const id = await fedOffering(db, termId, tab);
    if (id) fedIds.add(id);
    else added.push(tab.title);
  }
  const offerings = await db.courseOffering.findMany({
    where: { termId },
    select: { id: true, title: true },
    orderBy: { title: 'asc' },
  });
  const offeringIds = offerings.map((o) => o.id);
  const gone = offerings.filter((o) => !fedIds.has(o.id));

  const [students, scores, comments] = await Promise.all([
    db.enrollment.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds } },
      _count: true,
    }),
    db.assessmentScore.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds } },
      _count: true,
    }),
    db.enrollment.groupBy({
      by: ['offeringId'],
      where: { offeringId: { in: offeringIds }, teacherComment: { not: null } },
      _count: true,
    }),
  ]);
  const studentsOf = byCount(students);
  const scoresOf = byCount(scores);
  const commentsOf = byCount(comments);
  const deleted = gone.map((o) => ({
    offeringId: o.id,
    subject: o.title,
    students: studentsOf.get(o.id) ?? 0,
    scores: scoresOf.get(o.id) ?? 0,
    comments: commentsOf.get(o.id) ?? 0,
  }));

  // Accounts: created by a sheet of this term, with nothing in any other term, and not in the
  // new `ALL` (or in it under another name; another word order is the same name).
  const roster = new Map<string, RosterStudent>();
  for (const s of workbook.roster) roster.set(s.studentCode, s);
  for (const copies of workbook.rosterDuplicates) {
    for (const c of copies) if (!roster.has(c.studentCode)) roster.set(c.studentCode, c);
  }
  const sources = await db.googleSheetSource.findMany({ where: { termId }, select: { id: true } });
  const candidates = await db.student.findMany({
    where: {
      generationId: source.generationId,
      provisionedSourceId: { in: sources.map((s) => s.id) },
      terms: { none: { termId: { not: termId } } },
      enrollments: { none: { offering: { termId: { not: termId } } } },
      termIssues: { none: { termId: { not: termId } } },
    },
    select: {
      id: true,
      userId: true,
      studentCode: true,
      fullName: true,
      firstName: true,
      lastName: true,
      nameEditedAt: true,
      user: { select: { status: true, passwordChangedAt: true, lastLoginAt: true } },
    },
    orderBy: { studentCode: 'asc' },
  });
  const unlisted = candidates.filter((s) => {
    const listed = roster.get(s.studentCode);
    return !listed || compareNames(listed, s) === 'DIFFERENT';
  });
  // Never deleted (RP10): an account that was used, or whose name an admin corrected. Under
  // another name in the new sheet it is skipped by the name check; its term data still goes.
  const protectedAccounts = unlisted.flatMap((s) => {
    const reason = protectedReason(s);
    return reason
      ? [{ studentId: s.id, studentCode: s.studentCode, fullName: s.fullName, reason }]
      : [];
  });
  const accounts = unlisted
    .filter((s) => protectedReason(s) === null)
    .map((s) => ({
      studentId: s.id,
      userId: s.userId,
      studentCode: s.studentCode,
      fullName: s.fullName,
    }));
  const deletedIds = new Set(accounts.map((a) => a.studentId));

  const oldStudents = await db.student.findMany({
    where: {
      generationId: source.generationId,
      OR: [
        { terms: { some: { termId } } },
        { enrollments: { some: { offeringId: { in: offeringIds } } } },
      ],
    },
    select: { id: true, studentCode: true, fullName: true },
    orderBy: { studentCode: 'asc' },
  });
  // An admin's assignment stays for a student the new `ALL` lists (duplicates included).
  const termRows = await db.studentTerm.findMany({
    where: { termId },
    select: {
      id: true,
      programSource: true,
      studentId: true,
      student: { select: { studentCode: true } },
    },
    orderBy: { id: 'asc' },
  });
  const droppedTerms = termRows
    .filter(
      (t) =>
        t.programSource === 'SHEET' ||
        !roster.has(t.student.studentCode) ||
        deletedIds.has(t.studentId),
    )
    .map((t) => ({ id: t.id, studentId: t.studentId }));
  const termEnrollments = droppedTerms.length;

  const counts: ReplacementCounts = {
    subjects: deleted.length,
    scoreRows: [...scoresOf.values()].reduce((a, b) => a + b, 0),
    scoreHistoryRows: await db.assessmentScoreRevision.count({
      where: { score: { offeringId: { in: offeringIds } } },
    }),
    comments: [...commentsOf.values()].reduce((a, b) => a + b, 0),
    enrollments: [...studentsOf.values()].reduce((a, b) => a + b, 0),
    termEnrollments,
    accounts: accounts.length,
    accountsProtected: protectedAccounts.length,
  };
  const manifestHash = createHash('sha256')
    .update(
      JSON.stringify({
        termId,
        offerings: deleted.map((d) => d.offeringId).toSorted(),
        termOfferings: offeringIds.toSorted(),
        accounts: accounts.map((a) => a.studentId).toSorted(),
        protectedAccounts: protectedAccounts.map((a) => a.studentId).toSorted(),
        studentsLosingData: oldStudents.map((s) => s.id).toSorted(),
        termEnrollments: droppedTerms.map((t) => t.id).toSorted(),
        counts,
      }),
    )
    .digest('hex');
  return {
    termId,
    oldSourceId: input.old.id,
    oldSpreadsheetId: input.old.spreadsheetId,
    offeringIds,
    kept: offerings.filter((o) => fedIds.has(o.id)).map((o) => o.title),
    added,
    deleted,
    accounts,
    protectedAccounts,
    oldStudents: oldStudents.map((s) => ({
      studentId: s.id,
      studentCode: s.studentCode,
      fullName: s.fullName,
    })),
    termEnrollments: droppedTerms,
    counts,
    manifestHash,
  };
}

/** What the admin confirms. `importable`: roster students the sync imports (skips left out). */
export function replacementSummary(
  set: ReplacementSet,
  label: string,
  importable: readonly RosterStudent[],
  existingCodes: ReadonlySet<string>,
): ReplacementSummary {
  const deletedIds = new Set(set.accounts.map((a) => a.studentId));
  const codes = new Set(importable.map((s) => s.studentCode));
  const old = set.oldStudents.filter((s) => !deletedIds.has(s.studentId));
  const deletedCodes = new Set(set.accounts.map((a) => a.studentCode));
  return {
    termLabel: label,
    oldSourceId: set.oldSourceId,
    subjects: { kept: set.kept, added: set.added, deleted: set.deleted },
    students: {
      kept: old.filter((s) => codes.has(s.studentCode)).length,
      added: importable.filter(
        (s) => deletedCodes.has(s.studentCode) || !existingCodes.has(s.studentCode),
      ).length,
      dataRemoved: old
        .filter((s) => !codes.has(s.studentCode))
        .map(({ studentCode, fullName }) => ({ studentCode, fullName })),
      accountsDeleted: set.accounts.map(({ studentCode, fullName }) => ({ studentCode, fullName })),
      accountsProtected: set.protectedAccounts.map(({ studentCode, fullName, reason }) => ({
        studentCode,
        fullName,
        reason,
      })),
    },
    counts: set.counts,
    manifestHash: set.manifestHash,
  };
}

/**
 * Deletes the term's data as the set says, inside the sync's transaction. Only this term's rows
 * are deleted (the database refuses any other: migration 20261114120000_term_replacement).
 * Returns the ids of the sessions it revoked, for the caller's denylist after commit.
 */
export async function applyReplacement(
  tx: Prisma.TransactionClient,
  set: ReplacementSet,
  ctx: { sourceId: string; now: Date },
): Promise<{ revokedSessionIds: string[] }> {
  const { termId } = set;
  await tx.$queryRaw`SELECT set_config('ssrs.allow_term_replacement', 'on', true),
                            set_config('ssrs.replacement_term_id', ${termId}, true)`;
  const studentIds = set.accounts.map((a) => a.studentId);
  const userIds = set.accounts.map((a) => a.userId);
  // Users before sessions, the same lock order as login (decisions.md SR1): a login of one of
  // these accounts waits here instead of creating a session the deletion would miss.
  if (userIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ANY(${userIds}::uuid[]) ORDER BY id FOR UPDATE`;
  }
  const sessions = await tx.authSession.findMany({
    where: { userId: { in: userIds }, revokedAt: null },
    select: { id: true },
  });
  if (sessions.length > 0) {
    await tx.authSession.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: ctx.now, revokeReason: 'ACCOUNT_DELETED' },
    });
    // Their refresh tokens too, so a stored one can never be presented (decisions.md SR3).
    await tx.refreshToken.updateMany({
      where: { sessionId: { in: sessions.map((s) => s.id) }, revokedAt: null },
      data: { revokedAt: ctx.now },
    });
  }

  // Student data of every offering of the term: history before scores, then enrollments.
  const offeringIds = set.offeringIds;
  await tx.assessmentScoreRevision.deleteMany({
    where: { score: { offeringId: { in: offeringIds } } },
  });
  await tx.assessmentScore.deleteMany({ where: { offeringId: { in: offeringIds } } });
  await tx.enrollment.deleteMany({ where: { offeringId: { in: offeringIds } } });

  // Term enrollments: exactly the ones the set lists (decided from the full roster).
  await tx.studentTermIssue.deleteMany({ where: { termId } });
  const deletedIds = new Set(studentIds);
  const dropped = set.termEnrollments;
  if (dropped.length > 0) {
    await tx.studentTerm.deleteMany({
      where: { id: { in: dropped.map((t) => t.id) }, termId },
    });
  }
  await tx.sheetPreview.deleteMany({
    where: { source: { termId }, sourceId: { not: ctx.sourceId } },
  });

  if (studentIds.length > 0) {
    await tx.student.deleteMany({ where: { id: { in: studentIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds }, role: 'STUDENT' } });
  }
  await refreshLatestTerm(
    tx,
    [...new Set(dropped.map((t) => t.studentId))].filter((id) => !deletedIds.has(id)),
  );
  return { revokedSessionIds: sessions.map((s) => s.id) };
}

/**
 * Deletes the subjects the new sheet does not feed, with their structure; mappings let go of them.
 * Runs after the new subjects were created, so they take the term's visibility from the subjects
 * it had (release rule R4), in the same transaction as `applyReplacement`.
 */
export async function deleteUnfedSubjects(
  tx: Prisma.TransactionClient,
  set: ReplacementSet,
): Promise<void> {
  const { termId } = set;
  const gone = set.deleted.map((d) => d.offeringId);
  if (gone.length > 0) {
    await tx.sheetColumnMapping.updateMany({
      where: { criterion: { offeringId: { in: gone } } },
      data: { criterionId: null },
    });
    await tx.sheetTabMapping.updateMany({
      where: { offeringId: { in: gone } },
      data: { offeringId: null, status: 'REMOVED' },
    });
    await tx.gradingSchemeItem.deleteMany({ where: { offeringId: { in: gone } } });
    await tx.gradingScheme.deleteMany({ where: { offeringId: { in: gone } } });
    await tx.assessmentCriterion.deleteMany({ where: { offeringId: { in: gone } } });
    await tx.offeringProgram.deleteMany({ where: { offeringId: { in: gone } } });
    await tx.courseOffering.deleteMany({ where: { id: { in: gone }, termId } });
  }
  // Nothing after this point deletes protected rows: the bypass ends here, not at commit.
  await tx.$queryRaw`SELECT set_config('ssrs.allow_term_replacement', '', true),
                            set_config('ssrs.replacement_term_id', '', true)`;
}
