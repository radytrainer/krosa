import type { Prisma, PrismaClient, StudentTermIssueKind } from '@ssrs/database';
import type { ParsedCourse, RosterStudent, SubjectRow } from '@ssrs/sheets';
import type { SyncIssue } from './types.js';

/**
 * A student's enrollment in a term: program and class (docs/database-design.md, student_terms).
 * The roster tab (ALL) is the only source of class; the term's class list maps the class to a
 * program. CLASS 2 in ALL cross-checks it, an admin assignment overrides it. Pure planning lives
 * here so a sync and a preview decide the same way; `applyStudentTerms` writes the plan.
 */

type Db = Prisma.TransactionClient | PrismaClient;

export interface TermConfig {
  termId: string;
  termNumber: number;
  programs: { id: string; code: string }[];
  /** Upper-cased class name → class. Names are unique within a term across programs. */
  classes: Map<string, { id: string; name: string; programId: string }>;
  /** Upper-cased program code or alias → program id. */
  programNames: Map<string, string>;
}

export async function loadTermConfig(db: Db, termId: string): Promise<TermConfig> {
  const term = await db.term.findUniqueOrThrow({
    where: { id: termId },
    select: {
      number: true,
      programs: {
        select: {
          program: { select: { id: true, code: true, aliases: { select: { alias: true } } } },
          classes: { select: { id: true, name: true, programId: true } },
        },
      },
    },
  });
  const classes = new Map<string, { id: string; name: string; programId: string }>();
  const programNames = new Map<string, string>();
  for (const tp of term.programs) {
    programNames.set(tp.program.code.toUpperCase(), tp.program.id);
    for (const a of tp.program.aliases) programNames.set(a.alias.toUpperCase(), tp.program.id);
    for (const c of tp.classes) classes.set(c.name.toUpperCase(), c);
  }
  return {
    termId,
    termNumber: term.number,
    programs: term.programs.map((tp) => ({ id: tp.program.id, code: tp.program.code })),
    classes,
    programNames,
  };
}

export const programCode = (config: TermConfig, programId: string) =>
  config.programs.find((p) => p.id === programId)?.code ?? programId;

/**
 * The program a cell names ("WEP A" → WEP, "SNAC", the alias "SNA"), and the class after it.
 * undefined: blank. program null: not a program of this term.
 */
export function readProgramText(
  config: TermConfig,
  text: string | null | undefined,
): { program: string | null; className: string | null } | undefined {
  const words = text?.trim().toUpperCase().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return undefined;
  const whole = config.programNames.get(words.join(' '));
  if (whole) return { program: whole, className: null };
  const [first = '', ...rest] = words;
  return {
    program: config.programNames.get(first) ?? null,
    className: rest.length > 0 ? rest.join(' ') : null,
  };
}

/** Who takes a subject tab: every program of the term, or one. */
export type Audience = { kind: 'SHARED' } | { kind: 'PROGRAM'; programId: string };

/** A tab's audience; null when a term with several programs has none confirmed yet. */
export function tabAudience(
  config: TermConfig,
  tab: { audience: 'SHARED' | 'PROGRAM' | null; audienceProgramId: string | null },
): Audience | null {
  if (tab.audience === 'PROGRAM' && tab.audienceProgramId) {
    return { kind: 'PROGRAM', programId: tab.audienceProgramId };
  }
  if (tab.audience === 'SHARED' || config.programs.length <= 1) return { kind: 'SHARED' };
  return null;
}

/**
 * Guesses who takes a tab from the programs of the students it lists (their `ALL` class through
 * the class list): one program → that program only, several → shared. Null when no listed student
 * has a known class. The sync saves the guess once, so later mistakes in the tab are still caught.
 */
export function guessAudience(
  config: TermConfig,
  course: ParsedCourse,
  roster: ReadonlyMap<string, RosterStudent>,
): Audience | null {
  const programs = new Set<string>();
  for (const row of course.rows) {
    const cls = roster.get(row.studentCode)?.className;
    const programId = cls ? config.classes.get(upper(cls))?.programId : undefined;
    if (programId) programs.add(programId);
  }
  const [only] = programs;
  if (!only) return null;
  return programs.size === 1 ? { kind: 'PROGRAM', programId: only } : { kind: 'SHARED' };
}

/** The warning that reports a guessed audience, so an admin can check it. */
export function guessedAudienceIssue(
  config: TermConfig,
  course: ParsedCourse,
  audience: Audience,
): SyncIssue {
  const who =
    audience.kind === 'PROGRAM' ? `${programCode(config, audience.programId)} only` : 'shared';
  return {
    severity: 'WARNING',
    scope: 'COURSE',
    code: 'AUDIENCE_GUESSED',
    message: `"${course.worksheet}" was taken as ${who} from the students it lists. Change it on the tab if that is wrong.`,
    sheetTab: course.worksheet,
    courseKey: course.courseKey,
  };
}

/** Proposes an audience from the roster classes of the students a tab lists (detection). */
export function proposeAudience(
  config: TermConfig,
  rosterClasses: Record<string, number>,
): Audience {
  const programs = new Set(
    Object.keys(rosterClasses).flatMap((c) => config.classes.get(c.toUpperCase())?.programId ?? []),
  );
  const [only] = programs;
  if (config.programs.length > 1 && programs.size === 1 && only) {
    return { kind: 'PROGRAM', programId: only };
  }
  return { kind: 'SHARED' };
}

export interface ExistingTerm {
  id: string;
  programId: string;
  classId: string;
  programSource: 'SHEET' | 'ADMIN';
}

export interface PlannedIssue {
  kind: StudentTermIssueKind;
  /** IDs, class and program codes only. */
  detail: Record<string, unknown>;
}

export interface TermDecision {
  studentCode: string;
  /** The term enrollment after this sync; null: none, so the student's rows are skipped. */
  current: { programId: string; classId: string } | null;
  /** What to write: a new enrollment or a new class. */
  write: { kind: 'CREATE' | 'CLASS'; programId: string; classId: string } | null;
  /** A program switch waits for an admin: program-specific rows are skipped meanwhile. */
  pendingSwitch: boolean;
  issue: PlannedIssue | null;
}

export interface TermPlan {
  decisions: Map<string, TermDecision>;
  /** Report lines for the job, one per blocked or changed student. */
  issues: SyncIssue[];
  /** No class list at all: every student without an enrollment is skipped (one warning). */
  unconfigured: boolean;
}

const upper = (s: string | null) => s?.trim().toUpperCase() ?? '';

/**
 * Decides every roster student's enrollment in the term. Earlier terms are never looked at:
 * a new class or program in a later term is simply a new enrollment.
 */
export function planStudentTerms(
  config: TermConfig,
  roster: readonly RosterStudent[],
  existing: ReadonlyMap<string, ExistingTerm>,
  duplicates: readonly RosterStudent[][] = [],
  rosterTab = 'ALL',
): TermPlan {
  const decisions = new Map<string, TermDecision>();
  const issues: SyncIssue[] = [];
  const term = `Term ${config.termNumber}`;
  const unconfigured = config.classes.size === 0;
  if (unconfigured) {
    issues.push({
      severity: 'WARNING',
      scope: 'FILE',
      code: 'NO_CLASS_LIST',
      message: `${term} has no class list yet, so no new term enrollment was created. Set up its classes, then sync again.`,
    });
  }
  const code = (id: string) => programCode(config, id);

  for (const s of roster) {
    const ex = existing.get(s.studentCode) ?? null;
    const keep = ex ? { programId: ex.programId, classId: ex.classId } : null;
    const at = { sheetTab: rosterTab, rowNumber: s.rowNumber, studentCode: s.studentCode };
    const block = (kind: StudentTermIssueKind, issueCode: string, message: string, detail = {}) => {
      decisions.set(s.studentCode, {
        studentCode: s.studentCode,
        current: keep,
        write: null,
        pendingSwitch: false,
        issue: { kind, detail: { class: s.className, ...detail } },
      });
      issues.push({ severity: 'WARNING', scope: 'ROW', code: issueCode, message, ...at });
    };
    if (unconfigured) {
      decisions.set(s.studentCode, {
        studentCode: s.studentCode,
        current: keep,
        write: null,
        pendingSwitch: false,
        issue: null,
      });
      continue;
    }
    if (!s.className) {
      block(
        'UNDETERMINED_PROGRAM',
        'PROGRAM_UNDETERMINED',
        `${s.studentCode} has no class in ${rosterTab}, so their ${term} program is undetermined. An admin must assign it.`,
      );
      continue;
    }
    const cls = config.classes.get(upper(s.className));
    if (!cls) {
      block(
        'UNKNOWN_CLASS',
        'UNKNOWN_CLASS',
        `Class "${s.className}" of ${s.studentCode} is not in the ${term} class list. Their enrollment was not created or changed.`,
      );
      continue;
    }

    let programId = cls.programId;
    if (ex?.programSource === 'ADMIN') {
      if (cls.programId !== ex.programId) {
        block(
          'PROGRAM_CONFLICT',
          'PROGRAM_CONFLICT',
          `${s.studentCode}: class ${cls.name} belongs to ${code(cls.programId)}, but an admin assigned ${code(ex.programId)}. Nothing was changed.`,
          { classProgram: code(cls.programId), adminProgram: code(ex.programId) },
        );
        continue;
      }
      programId = ex.programId;
    } else {
      const hint = readProgramText(config, s.programText);
      if (hint && hint.program === null) {
        issues.push({
          severity: 'WARNING',
          scope: 'ROW',
          code: 'UNKNOWN_PROGRAM_VALUE',
          message: `${s.studentCode}: "${s.programText}" is not a program of ${term}; the class decides.`,
          ...at,
          rawValue: s.programText ?? undefined,
        });
      } else if (
        hint &&
        (hint.program !== cls.programId ||
          (hint.className !== null && hint.className !== upper(cls.name)))
      ) {
        block(
          'PROGRAM_CONFLICT',
          'PROGRAM_CONFLICT',
          `${s.studentCode}: class ${cls.name} (${code(cls.programId)}) disagrees with "${s.programText}" in ${rosterTab}. Nothing was changed; fix the sheet.`,
          { classProgram: code(cls.programId), programText: s.programText },
        );
        continue;
      }
    }

    if (ex && ex.programId !== programId) {
      decisions.set(s.studentCode, {
        studentCode: s.studentCode,
        current: keep,
        write: null,
        pendingSwitch: true,
        issue: {
          kind: 'PROGRAM_SWITCH',
          detail: { from: code(ex.programId), to: code(programId), class: cls.name },
        },
      });
      issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'PROGRAM_SWITCH_PENDING',
        message: `${s.studentCode} moves from ${code(ex.programId)} to ${code(programId)} within ${term}. An admin must confirm the switch; until then only shared subjects are imported.`,
        ...at,
      });
      continue;
    }
    const write = !ex
      ? { kind: 'CREATE' as const, programId, classId: cls.id }
      : ex.classId !== cls.id
        ? { kind: 'CLASS' as const, programId, classId: cls.id }
        : null;
    decisions.set(s.studentCode, {
      studentCode: s.studentCode,
      current: { programId, classId: cls.id },
      write,
      pendingSwitch: false,
      issue: null,
    });
  }

  for (const copies of duplicates) {
    const first = copies[0];
    if (!first) continue;
    const ex = existing.get(first.studentCode);
    decisions.set(first.studentCode, {
      studentCode: first.studentCode,
      current: ex ? { programId: ex.programId, classId: ex.classId } : null,
      write: null,
      pendingSwitch: false,
      issue: {
        kind: 'DUPLICATE_IN_ROSTER',
        detail: {
          rows: copies.map((c) => c.rowNumber),
          classes: copies.map((c) => c.className),
          programTexts: copies.map((c) => c.programText),
        },
      },
    });
  }
  return { decisions, issues, unconfigured };
}

export interface RowFilter {
  rows: SubjectRow[];
  /** Students whose rows were held back: they are in the tab, so never "missing" from it. */
  held: string[];
  issues: SyncIssue[];
}

/**
 * Which rows of a tab may be imported: the student needs a term enrollment, their program must
 * take the subject, and a pending program switch holds back program-specific subjects.
 */
export function filterRowsForTerm(
  config: TermConfig,
  course: ParsedCourse,
  audience: Audience,
  decisions: ReadonlyMap<string, TermDecision>,
): RowFilter {
  const rows: SubjectRow[] = [];
  const held: string[] = [];
  const issues: SyncIssue[] = [];
  const term = `Term ${config.termNumber}`;
  const code = (id: string) => programCode(config, id);
  for (const row of course.rows) {
    const at = {
      sheetTab: course.worksheet,
      courseKey: course.courseKey,
      rowNumber: row.rowNumber,
      studentCode: row.studentCode,
    };
    const d = decisions.get(row.studentCode);
    if (!d?.current) {
      held.push(row.studentCode);
      issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'NO_TERM_ENROLLMENT',
        message: `${row.studentCode} has no ${term} enrollment yet (see the student issues), so this row was skipped.`,
        ...at,
      });
      continue;
    }
    if (audience.kind === 'PROGRAM' && audience.programId !== d.current.programId) {
      issues.push({
        severity: 'ERROR',
        scope: 'ROW',
        code: 'PROGRAM_NOT_IN_AUDIENCE',
        message: `${row.studentCode} is in ${code(d.current.programId)}, but "${course.worksheet}" is for ${code(audience.programId)} only. The row was not imported.`,
        ...at,
      });
      continue;
    }
    if (audience.kind === 'PROGRAM' && d.pendingSwitch) {
      held.push(row.studentCode);
      issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'PROGRAM_SWITCH_PENDING',
        message: `${row.studentCode} has a program switch waiting for an admin (see the student issues), so this row was skipped.`,
        ...at,
      });
      continue;
    }
    const major = readProgramText(config, row.programText);
    if (major?.program && major.program !== d.current.programId) {
      issues.push({
        severity: 'WARNING',
        scope: 'CELL',
        code: 'PROFILE_MISMATCH',
        message: `MAJOR in "${course.worksheet}" (${row.programText}) differs from the roster's program (${code(d.current.programId)}) for ${row.studentCode}; the roster's program is used.`,
        ...at,
        columnKey: 'MAJOR',
        rawValue: row.programText ?? undefined,
      });
    }
    rows.push(row);
  }
  return { rows, held, issues };
}

/** Students of the audience who should be in the tab (shared: every enrolled student). */
export function expectedInTab(
  audience: Audience,
  decisions: ReadonlyMap<string, TermDecision>,
): Set<string> {
  const out = new Set<string>();
  for (const d of decisions.values()) {
    if (!d.current) continue;
    if (
      audience.kind === 'SHARED' ||
      (audience.programId === d.current.programId && !d.pendingSwitch)
    ) {
      out.add(d.studentCode);
    }
  }
  return out;
}

export interface TermCounts {
  created: number;
  classChanged: number;
  unchanged: number;
  blocked: number;
}

export function countPlan(plan: TermPlan): TermCounts {
  const counts = { created: 0, classChanged: 0, unchanged: 0, blocked: 0 };
  for (const d of plan.decisions.values()) {
    if (d.write?.kind === 'CREATE') counts.created++;
    else if (d.write?.kind === 'CLASS') counts.classChanged++;
    else if (d.issue || !d.current) counts.blocked++;
    else counts.unchanged++;
  }
  return counts;
}

export async function existingTerms(db: Db, termId: string): Promise<Map<string, ExistingTerm>> {
  const rows = await db.studentTerm.findMany({
    where: { termId },
    select: {
      id: true,
      programId: true,
      classId: true,
      programSource: true,
      student: { select: { studentCode: true } },
    },
  });
  return new Map(rows.map((r) => [r.student.studentCode, r]));
}

/** Kinds a sync raises and also closes again once the sheet is fixed. */
const SHEET_KINDS: StudentTermIssueKind[] = [
  'UNDETERMINED_PROGRAM',
  'UNKNOWN_CLASS',
  'PROGRAM_CONFLICT',
  'DUPLICATE_IN_ROSTER',
  'PROGRAM_SWITCH',
];

export interface ApplyTermsContext {
  syncJobId: string;
  sourceId: string;
  generationId: string;
  now: Date;
}

/**
 * Writes the plan: creates enrollments, updates classes (with an audit entry), opens and closes
 * student issues, and mirrors the latest term on the student, all in one transaction.
 */
export async function applyStudentTerms(
  tx: Prisma.TransactionClient,
  ctx: ApplyTermsContext,
  config: TermConfig,
  plan: TermPlan,
  studentIdByCode: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, ExistingTerm>,
): Promise<void> {
  const className = new Map([...config.classes.values()].map((c) => [c.id, c.name]));
  const touched: string[] = [];
  const seen: string[] = [];
  for (const d of plan.decisions.values()) {
    const studentId = studentIdByCode.get(d.studentCode);
    if (d.write && studentId) {
      if (d.write.kind === 'CREATE') {
        await tx.studentTerm.create({
          data: {
            studentId,
            termId: config.termId,
            generationId: ctx.generationId,
            programId: d.write.programId,
            classId: d.write.classId,
            sourceId: ctx.sourceId,
            lastSeenSyncJobId: ctx.syncJobId,
          },
        });
      } else {
        const before = existing.get(d.studentCode);
        if (!before) throw new Error(`No ${d.studentCode} enrollment to change the class of`);
        await tx.studentTerm.update({
          where: { id: before.id },
          data: {
            classId: d.write.classId,
            sourceId: ctx.sourceId,
            lastSeenSyncJobId: ctx.syncJobId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            action: 'student_term.class_changed',
            entityType: 'student_term',
            entityId: before.id,
            metadata: {
              studentCode: d.studentCode,
              termNumber: config.termNumber,
              from: className.get(before.classId) ?? null,
              to: className.get(d.write.classId) ?? null,
              syncJobId: ctx.syncJobId,
            },
            createdAt: ctx.now,
          },
        });
      }
      touched.push(studentId);
    } else {
      const ex = existing.get(d.studentCode);
      if (d.current && studentId && ex) seen.push(ex.id);
    }
  }
  if (seen.length > 0) {
    await tx.studentTerm.updateMany({
      where: { id: { in: seen } },
      data: { lastSeenSyncJobId: ctx.syncJobId },
    });
  }

  // Student issues: one open row per student, term and kind; closed once the sheet is fixed.
  const open = await tx.studentTermIssue.findMany({
    where: { termId: config.termId, resolvedAt: null, kind: { in: SHEET_KINDS } },
  });
  const openKey = new Map(open.map((i) => [`${i.studentCode}|${i.kind}`, i]));
  const raised = new Set<string>();
  for (const d of plan.decisions.values()) {
    if (!d.issue) continue;
    const key = `${d.studentCode}|${d.issue.kind}`;
    raised.add(key);
    const detail = d.issue.detail as Prisma.InputJsonObject;
    const current = openKey.get(key);
    if (current) {
      await tx.studentTermIssue.update({
        where: { id: current.id },
        data: { detail, syncJobId: ctx.syncJobId },
      });
    } else {
      await tx.studentTermIssue.create({
        data: {
          termId: config.termId,
          studentId: studentIdByCode.get(d.studentCode) ?? null,
          studentCode: d.studentCode,
          kind: d.issue.kind,
          detail,
          syncJobId: ctx.syncJobId,
        },
      });
    }
  }
  const fixed = open.filter(
    (i) => plan.decisions.has(i.studentCode) && !raised.has(`${i.studentCode}|${i.kind}`),
  );
  if (fixed.length > 0) {
    await tx.studentTermIssue.updateMany({
      where: { id: { in: fixed.map((i) => i.id) } },
      data: { resolvedAt: ctx.now, resolution: 'FIXED_IN_SHEET' },
    });
  }
  await refreshLatestTerm(tx, touched);
}

/**
 * Mirrors each student's latest term enrollment (highest term number) on `students.class_name`
 * and `program_id`. Called in the transaction that changed the enrollment, so they never drift.
 */
export async function refreshLatestTerm(
  tx: Prisma.TransactionClient,
  studentIds: readonly string[],
): Promise<void> {
  if (studentIds.length === 0) return;
  const terms = await tx.studentTerm.findMany({
    where: { studentId: { in: [...studentIds] } },
    select: {
      studentId: true,
      programId: true,
      term: { select: { number: true } },
      class: { select: { name: true } },
      student: { select: { className: true, programId: true } },
    },
  });
  const latest = new Map<string, (typeof terms)[number]>();
  for (const t of terms) {
    const best = latest.get(t.studentId);
    if (!best || t.term.number > best.term.number) latest.set(t.studentId, t);
  }
  for (const t of latest.values()) {
    if (t.student.className === t.class.name && t.student.programId === t.programId) continue;
    await tx.student.update({
      where: { id: t.studentId },
      data: { className: t.class.name, programId: t.programId },
    });
  }
}
