import type { PrismaClient } from '@ssrs/database';
import {
  readTermWorkbook,
  type ConfirmedTab,
  type ParsedCourse,
  type RosterStudent,
  type SheetsReader,
  type TemplateIssue,
} from '@ssrs/sheets';
import { confirmedTabs, mappingVersions, TAB_MAPPINGS_INCLUDE } from './confirmed.js';
import { sameSchemeItems } from './scheme-diff.js';

const ISSUE_LIMIT = 200;
const MISSING_STUDENT_LIMIT = 200;

export interface ImpactCounts {
  new: number;
  changed: number;
  unchanged: number;
  invalid: number;
}

export interface PreviewTab {
  tabName: string;
  subject: string;
  status: 'OK' | 'MISSING' | 'HEADERS_CHANGED' | 'INVALID';
  scores: ImpactCounts;
  /** Marks a blank cell would leave in place, since a sync never deletes them. */
  keptBlank: number;
  weightsChanged: boolean;
}

export interface PreviewSummary {
  spreadsheetTitle: string;
  /** False while a sync of this sheet would be refused or would roll back. */
  canConfirm: boolean;
  students: ImpactCounts;
  scores: ImpactCounts;
  tabs: PreviewTab[];
  /** Tabs in the workbook that are not confirmed, so a sync would skip them. */
  unmappedTabs: string[];
  /** Subjects of this term that no confirmed tab of this sheet feeds. They keep their scores. */
  subjectsNotInSheet: string[];
  /** Students with subjects in this term who are not in the new roster. They keep their scores. */
  missingStudents: {
    total: number;
    sample: { studentCode: string; fullName: string }[];
  };
  issues: TemplateIssue[];
  issuesTruncated: boolean;
}

export interface PreviewResult {
  fingerprint: string;
  mappingVersions: Record<string, number>;
  summary: PreviewSummary;
}

const zero = (): ImpactCounts => ({ new: 0, changed: 0, unchanged: 0, invalid: 0 });

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
      current.gender !== student.gender ||
      (current.className ?? null) !== student.className
    ) {
      counts.changed++;
    } else {
      counts.unchanged++;
    }
  }
}

async function tabImpact(prisma: PrismaClient, course: ParsedCourse, tab: PreviewTab) {
  const enrollments = await prisma.enrollment.findMany({
    where: { offeringId: course.offeringId },
    include: {
      student: { select: { studentCode: true } },
      scores: { include: { criterion: { select: { key: true } } } },
    },
  });
  const byCode = new Map(enrollments.map((e) => [e.student.studentCode, e]));
  for (const row of course.rows) {
    const scores = new Map(
      byCode.get(row.studentCode)?.scores.map((s) => [s.criterion.key.toUpperCase(), s]),
    );
    for (const [key, value] of row.marks) {
      const current = scores.get(key);
      if (value === 'BLANK') {
        if (current) tab.keptBlank++;
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

  const issues = [...workbook.issues];
  const students = zero();
  await rosterImpact(prisma, source.generationId, workbook.roster, students, issues);
  students.invalid += issues.filter(
    (i) => i.severity === 'ERROR' && i.scope === 'ROW' && i.sheetTab === workbook.rosterTab,
  ).length;

  const tabs: PreviewTab[] = [];
  const scores = zero();
  for (const tab of confirmed) {
    const course = workbook.courses.find((c) => c.offeringId === tab.offeringId);
    const row: PreviewTab = {
      tabName: course?.worksheet ?? tab.tabName,
      subject: tab.title,
      status: 'OK',
      scores: zero(),
      keptBlank: 0,
      weightsChanged: false,
    };
    const problem = issues.find(
      (i) => i.severity === 'ERROR' && i.scope === 'COURSE' && i.courseKey === tab.courseKey,
    );
    if (problem?.code === 'NEEDS_REMAP') row.status = 'HEADERS_CHANGED';
    else if (problem) row.status = 'MISSING';
    if (course) await tabImpact(prisma, course, row);
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
    tabs.push(row);
  }

  const mapped = new Set(confirmed.map((t) => t.offeringId));
  const offerings = await prisma.courseOffering.findMany({
    where: { termId: source.termId },
    select: { id: true, title: true },
  });
  const roster = new Set(workbook.roster.map((s) => s.studentCode));
  const inTerm = await prisma.student.findMany({
    where: {
      generationId: source.generationId,
      enrollments: { some: { offering: { termId: source.termId } } },
    },
    select: { studentCode: true, fullName: true },
    orderBy: { studentCode: 'asc' },
  });
  const missing = inTerm.filter((s) => !roster.has(s.studentCode));

  return {
    fingerprint: workbook.fingerprint,
    mappingVersions: mappingVersions(source.tabMappings),
    summary: {
      spreadsheetTitle: workbook.spreadsheetTitle,
      canConfirm:
        !workbook.fatal && confirmed.length > 0 && !issues.some((i) => i.severity === 'ERROR'),
      students,
      scores,
      tabs,
      unmappedTabs: issues
        .filter((i) => i.code === 'UNMAPPED_TAB')
        .flatMap((i) => i.sheetTab ?? []),
      subjectsNotInSheet: offerings.filter((o) => !mapped.has(o.id)).map((o) => o.title),
      missingStudents: { total: missing.length, sample: missing.slice(0, MISSING_STUDENT_LIMIT) },
      issues: issues.slice(0, ISSUE_LIMIT),
      issuesTruncated: issues.length > ISSUE_LIMIT,
    },
  };
}
