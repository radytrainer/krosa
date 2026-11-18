import type { Prisma, PrismaClient } from '@ssrs/database';
import type { ParsedCourse, RosterStudent, TermWorkbookRead } from '@ssrs/sheets';
import { compareNames } from './names.js';
import type { SyncIssue } from './types.js';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Per-student errors that skip only that student (decisions.md RP6, RP7): nothing is created or
 * changed for them and their rows are not imported, but the sync of everyone else goes on, even
 * a sheet change or a replacement that otherwise needs zero errors.
 */
export const STUDENT_SKIP_CODES: ReadonlySet<string> = new Set([
  'STUDENT_NAME_MISMATCH',
  'STUDENT_IN_OTHER_GENERATION',
  'STUDENT_ID_CONFLICT',
]);

/** An error that blocks an all-or-nothing sync (a per-student skip does not). */
export const isBlockingError = (issue: { severity: string; code: string }) =>
  issue.severity === 'ERROR' && !STUDENT_SKIP_CODES.has(issue.code);

export interface NameIssueRow {
  sheetTab: string;
  rowNumber: number;
  studentCode: string;
  sheetName: string;
  systemName: string;
}

export interface StudentConflictRow {
  sheetTab: string;
  rowNumber: number;
  studentCode: string;
  code: 'STUDENT_IN_OTHER_GENERATION' | 'STUDENT_ID_CONFLICT';
}

export interface RosterScreen {
  /** The students that may be applied. A name in another word order keeps the stored name. */
  roster: RosterStudent[];
  /** Students skipped by an error: their rows are not imported. */
  skipped: Set<string>;
  issues: SyncIssue[];
  nameMismatches: NameIssueRow[];
  nameOrderWarnings: NameIssueRow[];
  studentConflicts: StudentConflictRow[];
}

/**
 * Checks each `ALL` student against the stored accounts before anything is written: an ID of
 * another generation or another account's login name, and a stored name that is not the sheet's
 * (word order aside). Students in `excludeStudentIds` are about to be deleted (a replacement), so
 * they count as not existing.
 */
export async function screenRoster(
  db: Db,
  ctx: { generationId: string; rosterTab: string; excludeStudentIds?: ReadonlySet<string> },
  roster: readonly RosterStudent[],
): Promise<RosterScreen> {
  const out: RosterScreen = {
    roster: [],
    skipped: new Set(),
    issues: [],
    nameMismatches: [],
    nameOrderWarnings: [],
    studentConflicts: [],
  };
  if (roster.length === 0) return out;
  const codes = roster.map((s) => s.studentCode);
  const exclude = ctx.excludeStudentIds ?? new Set<string>();
  const stored = (
    await db.student.findMany({
      where: { studentCode: { in: codes } },
      select: {
        id: true,
        studentCode: true,
        generationId: true,
        fullName: true,
        firstName: true,
        lastName: true,
      },
    })
  ).filter((s) => !exclude.has(s.id));
  const byCode = new Map(stored.map((s) => [s.studentCode, s]));
  const logins = await db.user.findMany({
    where: { username: { in: codes }, student: null },
    select: { username: true },
  });
  const taken = new Set(logins.map((u) => u.username.toUpperCase()));

  for (const s of roster) {
    const at = { sheetTab: ctx.rosterTab, rowNumber: s.rowNumber, studentCode: s.studentCode };
    const current = byCode.get(s.studentCode);
    const conflict = (code: StudentConflictRow['code'], message: string) => {
      out.skipped.add(s.studentCode);
      out.studentConflicts.push({ ...at, code });
      out.issues.push({ severity: 'ERROR', scope: 'ROW', code, message, ...at });
    };
    if (!current) {
      if (taken.has(s.studentCode)) {
        conflict(
          'STUDENT_ID_CONFLICT',
          `Student ID ${s.studentCode} is already used as the login name of another account. This student was skipped.`,
        );
      } else {
        out.roster.push(s);
      }
      continue;
    }
    if (current.generationId !== ctx.generationId) {
      conflict(
        'STUDENT_IN_OTHER_GENERATION',
        `Student ${s.studentCode} belongs to another generation. This student was skipped.`,
      );
      continue;
    }
    const names = { ...at, sheetName: s.fullName, systemName: current.fullName };
    const same = compareNames(s, current);
    if (same === 'DIFFERENT') {
      out.skipped.add(s.studentCode);
      out.nameMismatches.push(names);
      out.issues.push({
        severity: 'ERROR',
        scope: 'ROW',
        code: 'STUDENT_NAME_MISMATCH',
        // Admin-only issue data (job and preview); never passed to a logger.
        message: `The name of ${s.studentCode} in ${ctx.rosterTab} is not the stored name. Name in sheet: ${s.fullName} / in system: ${current.fullName}. Nothing was imported for this student; fix the sheet or edit the stored name.`,
        ...at,
      });
      continue;
    }
    if (same === 'ORDER') {
      out.nameOrderWarnings.push(names);
      out.issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'STUDENT_NAME_ORDER',
        message: `The name of ${s.studentCode} in ${ctx.rosterTab} has its words in another order. Name in sheet: ${s.fullName} / in system: ${current.fullName}. The stored name is kept.`,
        ...at,
      });
      out.roster.push({
        ...s,
        fullName: current.fullName,
        firstName: current.firstName,
        lastName: current.lastName,
      });
      continue;
    }
    out.roster.push(s);
  }
  return out;
}

/** The workbook without the skipped students: roster, subject rows and their row issues. */
export function withoutStudents<
  W extends Pick<TermWorkbookRead, 'roster' | 'courses' | 'issues' | 'rosterTab'>,
>(workbook: W, roster: RosterStudent[], skipped: ReadonlySet<string>): W {
  if (skipped.size === 0) return { ...workbook, roster };
  // Their rows are held back, never "missing from the tab" (as apply-course treats duplicates).
  const courses: ParsedCourse[] = workbook.courses.map((c) => ({
    ...c,
    rows: c.rows.filter((r) => !skipped.has(r.studentCode)),
    duplicateStudents: [
      ...c.duplicateStudents,
      ...c.rows.filter((r) => skipped.has(r.studentCode)).map((r) => r.studentCode),
    ],
  }));
  const issues = workbook.issues.filter(
    (i) =>
      !(
        i.studentCode &&
        skipped.has(i.studentCode) &&
        i.sheetTab !== workbook.rosterTab &&
        (i.scope === 'ROW' || i.scope === 'CELL')
      ),
  );
  return { ...workbook, roster, courses, issues };
}

export interface RosterCheck {
  earlierTerms: number[];
  missing: { studentCode: string; fullName: string; lastTerm: number }[];
  new: { studentCode: string; fullName: string; existingAccount: boolean }[];
}

/**
 * Terms 2–5: the roster against the generation's earlier terms, by student ID (decisions.md
 * RP5). Missing: enrolled in an earlier term, not in `ALL`. New: in `ALL`, enrolled in no
 * earlier term and not in this one (in a replacement this term's enrollments count as gone).
 * Null for Term 1.
 */
export async function rosterCheck(
  db: Db,
  ctx: {
    generationId: string;
    termId: string;
    termNumber: number;
    /** Every student ID in `ALL`, skipped ones and duplicates included. */
    allCodes: ReadonlySet<string>;
    replacement: boolean;
    deletedStudentIds?: ReadonlySet<string>;
  },
  /** The screened roster (skipped students left out). */
  roster: readonly RosterStudent[],
): Promise<RosterCheck | null> {
  if (ctx.termNumber < 2) return null;
  const terms = await db.term.findMany({
    where: { generationId: ctx.generationId, number: { lt: ctx.termNumber } },
    select: { number: true },
    orderBy: { number: 'asc' },
  });
  const enrolled = await db.studentTerm.findMany({
    where: {
      generationId: ctx.generationId,
      OR: [
        { term: { number: { lt: ctx.termNumber } } },
        ...(ctx.replacement ? [] : [{ termId: ctx.termId }]),
      ],
    },
    select: {
      termId: true,
      term: { select: { number: true } },
      student: { select: { studentCode: true, fullName: true } },
    },
  });
  const lastTerm = new Map<string, { fullName: string; lastTerm: number }>();
  const inThisTerm = new Set<string>();
  for (const e of enrolled) {
    const code = e.student.studentCode;
    if (e.termId === ctx.termId) {
      inThisTerm.add(code);
      continue;
    }
    const best = lastTerm.get(code);
    if (!best || e.term.number > best.lastTerm) {
      lastTerm.set(code, { fullName: e.student.fullName, lastTerm: e.term.number });
    }
  }
  const missing = [...lastTerm.entries()]
    .filter(([code]) => !ctx.allCodes.has(code))
    .map(([studentCode, v]) => ({ studentCode, ...v }))
    .toSorted((a, b) => a.studentCode.localeCompare(b.studentCode));
  const fresh = roster.filter(
    (s) => !lastTerm.has(s.studentCode) && !inThisTerm.has(s.studentCode),
  );
  const deleted = ctx.deletedStudentIds ?? new Set<string>();
  const accounts = await db.student.findMany({
    where: {
      generationId: ctx.generationId,
      studentCode: { in: fresh.map((s) => s.studentCode) },
    },
    select: { id: true, studentCode: true },
  });
  const existing = new Set(accounts.filter((a) => !deleted.has(a.id)).map((a) => a.studentCode));
  return {
    earlierTerms: terms.map((t) => t.number),
    missing,
    new: fresh
      .map((s) => ({
        studentCode: s.studentCode,
        fullName: s.fullName,
        existingAccount: existing.has(s.studentCode),
      }))
      .toSorted((a, b) => a.studentCode.localeCompare(b.studentCode)),
  };
}

const keyIds = (rows: { studentCode: string; code?: string }[] | undefined) =>
  (rows ?? []).map((r) => (r.code ? `${r.code}:${r.studentCode}` : r.studentCode)).toSorted();

/** The skips and name warnings a sync compares with the confirmed preview, by student ID. */
export function screenKey(
  screen:
    | {
        nameMismatches?: { studentCode: string }[];
        nameOrderWarnings?: { studentCode: string }[];
        studentConflicts?: { studentCode: string; code: string }[];
      }
    | null
    | undefined,
): string {
  return JSON.stringify([
    keyIds(screen?.nameMismatches),
    keyIds(screen?.nameOrderWarnings),
    keyIds(screen?.studentConflicts),
  ]);
}

/** What a sync compares with the confirmed preview: the student IDs on both lists. */
export function rosterCheckKey(
  check: { missing: { studentCode: string }[]; new: { studentCode: string }[] } | null | undefined,
): string {
  if (!check) return 'null';
  return JSON.stringify({
    missing: check.missing.map((m) => m.studentCode).toSorted(),
    new: check.new.map((n) => n.studentCode).toSorted(),
  });
}
