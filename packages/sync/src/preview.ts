import type { PrismaClient, StudentTermIssueKind } from '@ssrs/database';
import {
  detectTabLayout,
  IssueLog,
  readTermWorkbook,
  type ConfirmedTab,
  type ParsedCourse,
  type RosterStudent,
  type SheetsReader,
  type SubjectRow,
  type TemplateIssue,
} from '@ssrs/sheets';
import {
  audienceByCourseKey,
  confirmedTabs,
  mappingVersions,
  TAB_MAPPINGS_INCLUDE,
} from './confirmed.js';
import { isNewOffering } from './promote.js';
import { compareSheet, type SheetComparison } from './removals.js';
import { sameSchemeItems } from './scheme-diff.js';
import {
  countPlan,
  existingTerms,
  filterRowsForTerm,
  guessAudience,
  guessedAudienceIssue,
  loadTermConfig,
  planStudentTerms,
  tabAudience,
  type TermCounts,
} from './student-terms.js';

/** Issues kept on a preview, the same cap as a sync job. The API pages them. */
export const PREVIEW_ISSUE_LIMIT = 20_000;
const MISSING_STUDENT_LIMIT = 200;

export interface ImpactCounts {
  new: number;
  changed: number;
  unchanged: number;
  invalid: number;
}

/** Teacher comments a sync would write. A blank cell clears a stored comment. */
export interface CommentCounts {
  new: number;
  changed: number;
  cleared: number;
  unchanged: number;
  /** Over the length limit: not imported, the stored comment is kept. */
  tooLong: number;
}

export interface PreviewTab {
  tabName: string;
  subject: string;
  status: 'OK' | 'MISSING' | 'HEADERS_CHANGED' | 'INVALID';
  scores: ImpactCounts;
  comments: CommentCounts;
  /** Stored marks that a now-blank cell would clear. They stay in the history. */
  cleared: number;
  weightsChanged: boolean;
}

export interface PreviewSummary {
  spreadsheetTitle: string;
  /** False while a sync of this sheet would be refused or would roll back. */
  canConfirm: boolean;
  students: ImpactCounts;
  scores: ImpactCounts;
  comments: CommentCounts;
  /** Enrollments in this term: new, class changes, unchanged, blocked by a student issue. */
  termEnrollments: TermCounts;
  /** Program changes within the term. None is applied: each waits for an admin. */
  programChanges: { studentCode: string; from: string; to: string }[];
  /** Student issues the sync would open or keep open, by kind. */
  studentIssues: Partial<Record<StudentTermIssueKind, number>>;
  tabs: PreviewTab[];
  /** Tabs in the workbook that are not confirmed, so a sync would skip them. */
  unmappedTabs: string[];
  /** The term's subjects against this sheet: kept, added, removed. */
  comparison: SheetComparison;
  /** Students with subjects in this term who are not in the new roster. They keep their scores. */
  missingStudents: {
    total: number;
    sample: { studentCode: string; fullName: string }[];
  };
  /** At most PREVIEW_ISSUE_LIMIT; `issueCount` is the number found. */
  issues: TemplateIssue[];
  issueCount: number;
  issuesTruncated: boolean;
}

export interface PreviewResult {
  fingerprint: string;
  mappingVersions: Record<string, number>;
  summary: PreviewSummary;
}

const zero = (): ImpactCounts => ({ new: 0, changed: 0, unchanged: 0, invalid: 0 });
const zeroComments = (): CommentCounts => ({
  new: 0,
  changed: 0,
  cleared: 0,
  unchanged: 0,
  tooLong: 0,
});

function countComment(counts: CommentCounts, row: SubjectRow, stored: string | null): void {
  if (row.commentRejected) counts.tooLong++;
  else if (row.comment === null) {
    if (stored !== null) counts.cleared++;
  } else if (stored === null) counts.new++;
  else if (stored === row.comment) counts.unchanged++;
  else counts.changed++;
}

async function rosterImpact(
  prisma: PrismaClient,
  generationId: string,
  roster: readonly RosterStudent[],
  counts: ImpactCounts,
  issues: TemplateIssue[],
): Promise<void> {
  const existing = await prisma.student.findMany({
    where: { studentCode: { in: roster.map((s) => s.studentCode) } },
  });
  const byCode = new Map(existing.map((s) => [s.studentCode, s]));
  for (const student of roster) {
    const current = byCode.get(student.studentCode);
    if (!current) {
      counts.new++;
    } else if (current.generationId !== generationId) {
      // The sync would reject this row, so the preview must not look clean.
      counts.invalid++;
      issues.push({
        severity: 'ERROR',
        scope: 'ROW',
        code: 'STUDENT_IN_OTHER_GENERATION' as TemplateIssue['code'],
        message: `Student ${student.studentCode} belongs to another generation.`,
        rowNumber: student.rowNumber,
        studentCode: student.studentCode,
      });
    } else if (
      current.fullName !== student.fullName ||
      (current.firstName ?? null) !== student.firstName ||
      (current.lastName ?? null) !== student.lastName ||
      current.gender !== student.gender
    ) {
      counts.changed++;
    } else {
      counts.unchanged++;
    }
  }
}

/** Tabs nobody confirmed that hold subject data. A note or instructions tab is left alone. */
async function subjectLikeTabs(
  reader: SheetsReader,
  spreadsheetId: string,
  unmapped: readonly string[],
): Promise<string[]> {
  if (unmapped.length === 0) return [];
  const grids = await reader.readTabs(spreadsheetId, unmapped);
  return unmapped.filter((tab, i) => detectTabLayout(grids[i] ?? [], tab, new IssueLog()) !== null);
}

async function tabImpact(
  prisma: PrismaClient,
  course: ParsedCourse,
  tab: PreviewTab,
  startsFresh: boolean,
) {
  if (isNewOffering(course.offeringId) || startsFresh) {
    // No subject yet, or one that restarts empty, so every mark is new.
    for (const row of course.rows) {
      for (const value of row.marks.values()) if (value !== 'BLANK') tab.scores.new++;
      countComment(tab.comments, row, null);
    }
    return;
  }
  const enrollments = await prisma.enrollment.findMany({
    where: { offeringId: course.offeringId },
    include: {
      student: { select: { studentCode: true } },
      scores: { include: { criterion: { select: { key: true } } } },
    },
  });
  const byCode = new Map(enrollments.map((e) => [e.student.studentCode, e]));
  for (const row of course.rows) {
    const enrollment = byCode.get(row.studentCode);
    countComment(tab.comments, row, enrollment?.teacherComment ?? null);
    const scores = new Map(enrollment?.scores.map((s) => [s.criterion.key.toUpperCase(), s]));
    for (const [key, value] of row.marks) {
      const stored = scores.get(key);
      const current = stored?.status === 'CLEARED' ? undefined : stored;
      if (value === 'BLANK') {
        if (current) tab.cleared++;
      } else if (!current) {
        tab.scores.new++;
      } else if (current.status === value.status && current.mark.equals(value.mark)) {
        tab.scores.unchanged++;
      } else {
        tab.scores.changed++;
      }
    }
  }
  const published = await prisma.gradingScheme.findFirst({
    where: { offeringId: course.offeringId, status: 'PUBLISHED' },
    include: { items: { include: { criterion: { select: { key: true } } } } },
  });
  if (published) {
    const ids = new Map(published.items.map((i) => [i.criterion.key.toUpperCase(), i.criterionId]));
    tab.weightsChanged = !sameSchemeItems(
      published.items,
      course.criteria.map((c) => ({
        criterionId: ids.get(c.key.toUpperCase()) ?? c.key,
        maxMark: c.maxMark,
        weight: c.weight,
      })),
    );
  }
}

/**
 * What a sync of this sheet would do, computed without writing anything: the workbook is read
 * exactly as a sync reads it and compared with the database.
 */
export async function previewSource(
  prisma: PrismaClient,
  reader: SheetsReader,
  sourceId: string,
): Promise<PreviewResult> {
  const source = await prisma.googleSheetSource.findUniqueOrThrow({
    where: { id: sourceId },
    include: {
      generation: true,
      term: true,
      tabMappings: { include: TAB_MAPPINGS_INCLUDE, orderBy: { tabName: 'asc' } },
    },
  });
  const confirmed: ConfirmedTab[] = confirmedTabs(source.tabMappings);
  const workbook = await readTermWorkbook(
    reader,
    source.spreadsheetId,
    {
      generationCode: source.generation.code,
      termNumber: source.term.number,
      rosterTab: source.rosterTab,
      ignoredTabs: [
        ...source.ignoredTabs,
        ...source.tabMappings.filter((t) => t.status === 'IGNORED').map((t) => t.tabName),
      ],
    },
    confirmed,
  );

  const comparison = await compareSheet(prisma, source.termId, confirmed, workbook);
  const removedTabs = new Set(comparison.removed.flatMap((r) => r.tabName ?? []));
  const reviewing = source.status === 'PENDING';
  const startsFresh = new Set(comparison.added.filter((a) => a.returning).map((a) => a.tabName));
  // A tab that is going away is shown under Removed, not as a problem.
  const issues = workbook.issues.filter(
    (i) => !(i.code === 'WORKSHEET_NOT_FOUND' && removedTabs.has(i.sheetTab ?? '')),
  );
  if (reviewing || comparison.removed.length > 0) {
    const waiting = await subjectLikeTabs(reader, source.spreadsheetId, workbook.unmappedTabs);
    comparison.blockers.push(
      ...waiting.map((tab) => `Tab "${tab}" has no confirmed subject. Confirm or ignore it first.`),
    );
  }
  const students = zero();
  await rosterImpact(prisma, source.generationId, workbook.roster, students, issues);
  students.invalid += issues.filter(
    (i) => i.severity === 'ERROR' && i.scope === 'ROW' && i.sheetTab === workbook.rosterTab,
  ).length;

  // Term enrollments, decided exactly as the sync would (student-terms.ts).
  const config = await loadTermConfig(prisma, source.termId);
  const plan = planStudentTerms(
    config,
    workbook.roster,
    await existingTerms(prisma, source.termId),
    workbook.rosterDuplicates,
    workbook.rosterTab ?? source.rosterTab,
  );
  issues.push(...(plan.issues as TemplateIssue[]));
  const audiences = audienceByCourseKey(source.tabMappings);
  const rosterByCode = new Map(workbook.roster.map((s) => [s.studentCode, s]));
  const studentIssues: Partial<Record<StudentTermIssueKind, number>> = {};
  const programChanges: PreviewSummary['programChanges'] = [];
  for (const d of plan.decisions.values()) {
    if (!d.issue) continue;
    studentIssues[d.issue.kind] = (studentIssues[d.issue.kind] ?? 0) + 1;
    if (d.issue.kind === 'PROGRAM_SWITCH') {
      const { from, to } = d.issue.detail as { from: string; to: string };
      programChanges.push({ studentCode: d.studentCode, from, to });
    }
  }

  const tabs: PreviewTab[] = [];
  const scores = zero();
  const comments = zeroComments();
  for (const tab of confirmed) {
    if (removedTabs.has(tab.tabName)) continue;
    let course = workbook.courses.find((c) => c.offeringId === tab.offeringId);
    if (course) {
      const confirmedAudience = audiences.get(course.courseKey.toUpperCase());
      let audience = confirmedAudience ? tabAudience(config, confirmedAudience) : null;
      if (!audience && confirmedAudience) {
        // What the sync would guess and save; nothing is saved here.
        audience = guessAudience(config, course, rosterByCode);
        if (audience) {
          issues.push(guessedAudienceIssue(config, course, audience) as TemplateIssue);
        }
      }
      if (!audience) {
        issues.push({
          severity: 'ERROR',
          scope: 'COURSE',
          code: 'AUDIENCE_REQUIRED' as TemplateIssue['code'],
          message: `Choose who takes "${course.worksheet}" (shared, or one program) and confirm the tab again.`,
          sheetTab: course.worksheet,
          courseKey: course.courseKey,
        });
        course = undefined;
      } else {
        const filtered = filterRowsForTerm(config, course, audience, plan.decisions);
        issues.push(...(filtered.issues as TemplateIssue[]));
        course = { ...course, rows: filtered.rows };
      }
    }
    const row: PreviewTab = {
      tabName: course?.worksheet ?? tab.tabName,
      subject: tab.title,
      status: 'OK',
      scores: zero(),
      comments: zeroComments(),
      cleared: 0,
      weightsChanged: false,
    };
    const problem = issues.find(
      (i) => i.severity === 'ERROR' && i.scope === 'COURSE' && i.courseKey === tab.courseKey,
    );
    if (problem?.code === 'NEEDS_REMAP') row.status = 'HEADERS_CHANGED';
    else if (problem) row.status = 'MISSING';
    if (course) await tabImpact(prisma, course, row, startsFresh.has(tab.tabName));
    row.scores.invalid = issues.filter(
      (i) =>
        i.severity === 'ERROR' &&
        (i.scope === 'ROW' || i.scope === 'CELL') &&
        i.sheetTab === row.tabName,
    ).length;
    if (row.status === 'OK' && row.scores.invalid > 0) row.status = 'INVALID';
    scores.new += row.scores.new;
    scores.changed += row.scores.changed;
    scores.unchanged += row.scores.unchanged;
    scores.invalid += row.scores.invalid;
    for (const key of Object.keys(comments) as (keyof CommentCounts)[]) {
      comments[key] += row.comments[key];
    }
    tabs.push(row);
  }

  const roster = new Set(workbook.roster.map((s) => s.studentCode));
  const inTerm = await prisma.student.findMany({
    where: {
      generationId: source.generationId,
      enrollments: { some: { offering: { termId: source.termId, status: 'ACTIVE' } } },
    },
    select: { studentCode: true, fullName: true },
    orderBy: { studentCode: 'asc' },
  });
  const missing = inTerm.filter((s) => !roster.has(s.studentCode));
  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  // Plain re-syncs of the active sheet may save what they can; anything else needs zero errors.
  const allOrNothing = reviewing || comparison.removed.length > 0;

  return {
    fingerprint: workbook.fingerprint,
    mappingVersions: mappingVersions(source.tabMappings),
    summary: {
      spreadsheetTitle: workbook.spreadsheetTitle,
      canConfirm:
        !workbook.fatal &&
        confirmed.length > 0 &&
        comparison.blockers.length === 0 &&
        !(allOrNothing && hasErrors),
      students,
      termEnrollments: countPlan(plan),
      programChanges,
      studentIssues,
      scores,
      comments,
      tabs,
      unmappedTabs: workbook.unmappedTabs,
      comparison,
      missingStudents: { total: missing.length, sample: missing.slice(0, MISSING_STUDENT_LIMIT) },
      issues: issues.slice(0, PREVIEW_ISSUE_LIMIT),
      issueCount: issues.length,
      issuesTruncated: issues.length > PREVIEW_ISSUE_LIMIT,
    },
  };
}
