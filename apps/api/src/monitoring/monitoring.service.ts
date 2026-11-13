import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { releaseState } from '@ssrs/sync';
import {
  MONITORING_LEVELS,
  type MonitoringGenerationsView,
  type MonitoringStudentsPage,
  type MonitoringSubjectRow,
  type MonitoringSubjectSort,
  type MonitoringSubjectSummaryView,
  type MonitoringTermRef,
  type MonitoringTermSubjectsView,
  type ProgramRef,
} from '@ssrs/shared';
import { PrismaService } from '../infra/prisma.service.js';
import type { SubjectQueryDto, SubjectStudentsQueryDto } from './monitoring.dto.js';
import {
  audienceOf,
  criteriaOf,
  percent,
  subjectRef,
  summarize,
  toStudentRow,
  SubjectStudentsService,
  type OfferingRow,
  type SubjectStudent,
  type TermClassRef,
  type TermContext,
} from './subject-students.service.js';

/** Open student_term_issues counted as "program not decided" for a term (notes). */
export const UNDETERMINED_ISSUE_KINDS = [
  'UNDETERMINED_PROGRAM',
  'UNKNOWN_CLASS',
  'PROGRAM_CONFLICT',
  'DUPLICATE_IN_ROSTER',
] as const;

const fail = (code: string, message: string) => new UnprocessableEntityException({ code, message });
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function termRef(ctx: TermContext): MonitoringTermRef {
  const active = ctx.offerings.filter((o) => o.status === 'ACTIVE');
  return {
    ...ctx.term,
    releaseState: releaseState(
      active.length,
      active.filter((o) => o.visibility === 'VISIBLE').length,
    ),
    programs: ctx.programs,
  };
}

interface Selection {
  ctx: TermContext;
  offering: OfferingRow;
  program: ProgramRef | null;
  termClass: TermClassRef | null;
}

/** Rows of the selected program and class (student_terms of this term). */
function filterRows(rows: readonly SubjectStudent[], sel: Selection): SubjectStudent[] {
  return rows.filter(
    (r) =>
      (!sel.program || r.program?.id === sel.program.id) &&
      (!sel.termClass || (r.className !== null && sameText(r.className, sel.termClass.name))),
  );
}

const text = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Title, then course code. */
const byName = (a: MonitoringSubjectRow, b: MonitoringSubjectRow) =>
  text(a.title, b.title) || text(a.courseCode, b.courseCode);

const LEVEL_RANK = new Map(MONITORING_LEVELS.map((l, i) => [l, i]));

/** A sort value of a row; null always sorts last, in either order. */
function sortValue(
  r: SubjectStudent,
  sort: string,
  gradeRank: Map<string, number>,
): string | number | null {
  switch (sort) {
    case 'studentCode':
      return r.studentCode;
    case 'name':
      return r.fullName;
    case 'program':
      return r.program?.code ?? null;
    case 'class':
      return r.className;
    case 'total':
      return r.computed.view.finalScore === null ? null : Number(r.computed.view.finalScore);
    case 'grade':
      return r.computed.view.finalGrade === null
        ? null
        : (gradeRank.get(r.computed.view.finalGrade) ?? null);
    case 'level':
      return r.level === null ? null : (LEVEL_RANK.get(r.level) ?? null);
    default: {
      const id = sort.slice('criterion:'.length);
      const score = r.computed.view.criteria.find((c) => c.criterionId === id)?.score ?? null;
      if (!score) return null;
      const mark = score.status === 'ABSENT' ? 0 : Number(score.mark);
      return Number.isFinite(mark) ? mark : null;
    }
  }
}

@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjects: SubjectStudentsService,
  ) {}

  /** One query. Archived generations are listed with their status. */
  async generations(): Promise<MonitoringGenerationsView> {
    const rows = await this.prisma.client.generation.findMany({
      orderBy: [{ startDate: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        terms: {
          orderBy: { number: 'asc' },
          select: {
            id: true,
            number: true,
            name: true,
            offerings: { where: { status: 'ACTIVE' }, select: { visibility: true } },
            sources: { where: { status: 'ACTIVE' }, select: { lastSyncedAt: true } },
          },
        },
      },
    });
    return {
      data: rows.map((g) => ({
        id: g.id,
        code: g.code,
        name: g.name,
        status: g.status,
        terms: g.terms.map((t) => ({
          id: t.id,
          number: t.number,
          name: t.name,
          subjects: t.offerings.length,
          releaseState: releaseState(
            t.offerings.length,
            t.offerings.filter((o) => o.visibility === 'VISIBLE').length,
          ),
          lastSyncedAt: t.sources[0]?.lastSyncedAt?.toISOString() ?? null,
        })),
      })),
    };
  }

  /** Page 1. Four queries for every subject of the term together. */
  async termSubjects(
    generationId: string,
    termNumber: number,
    includeArchived: boolean,
    sort: MonitoringSubjectSort,
  ): Promise<MonitoringTermSubjectsView> {
    const ctx = await this.subjects.loadTerm(generationId, termNumber);
    const shown = ctx.offerings.filter((o) => includeArchived || o.status === 'ACTIVE');
    const rows = await this.subjects.loadRows(ctx, shown);
    const usable = ctx.gradeScale.usable;

    const subjects = shown.map((o): MonitoringSubjectRow => {
      // Page 1 counts "All programs": the same rows and function as page 2 without filters.
      const stats = summarize(rows.get(o.id) ?? [], usable);
      return {
        ...subjectRef(o, ctx.programs),
        students: stats.students,
        complete: stats.complete,
        needsReview: stats.needsReview,
        levels: stats.levels,
        passRate: stats.passRate,
      };
    });
    subjects.sort(
      sort === 'fail' ? (a, b) => b.levels.FAIL - a.levels.FAIL || byName(a, b) : byName,
    );

    return {
      generation: ctx.generation,
      term: termRef(ctx),
      gradeScale: ctx.gradeScale,
      lastSync: ctx.lastSync,
      subjects,
    };
  }

  /** Page 2 header and statistics. Five queries. */
  async subjectSummary(query: SubjectQueryDto): Promise<MonitoringSubjectSummaryView> {
    const sel = await this.select(query);
    const { ctx, offering } = sel;
    const [all, issues] = await Promise.all([
      this.subjects.loadRows(ctx, [offering]),
      this.prisma.client.studentTermIssue.findMany({
        where: {
          termId: ctx.term.id,
          resolvedAt: null,
          kind: { in: [...UNDETERMINED_ISSUE_KINDS, 'PROGRAM_SWITCH'] },
        },
        select: { kind: true, studentId: true, studentCode: true },
      }),
    ]);
    const rows = filterRows(all.get(offering.id) ?? [], sel);
    const stats = summarize(rows, ctx.gradeScale.usable);
    const studentIds = new Set(rows.map((r) => r.studentId));

    return {
      generation: ctx.generation,
      term: termRef(ctx),
      subject: subjectRef(offering, ctx.programs),
      filters: {
        programFilter: ctx.programs.length > 1,
        programs: audienceOf(offering, ctx.programs).programs,
        classes: ctx.classes
          .filter((c) => !sel.program || c.programId === sel.program.id)
          .map((c) => ({ id: c.id, name: c.name, programCode: c.programCode })),
      },
      gradeScale: ctx.gradeScale,
      criteria: criteriaOf(offering),
      stats: {
        students: stats.students,
        complete: stats.complete,
        incomplete: stats.incomplete,
        needsReview: stats.needsReview,
        levels: ctx.gradeScale.usable
          ? MONITORING_LEVELS.map((level) => ({
              level,
              count: stats.levels[level],
              percent: percent(stats.levels[level], stats.students),
            }))
          : null,
        averageTotal: stats.averageTotal,
        highestTotal: stats.highestTotal,
        lowestTotal: stats.lowestTotal,
        passRate: stats.passRate,
      },
      notes: {
        // Distinct students (by ID: a duplicate in the roster may have no student row yet).
        termUndeterminedProgram: new Set(
          issues.filter((i) => i.kind !== 'PROGRAM_SWITCH').map((i) => i.studentCode),
        ).size,
        pendingProgramSwitch: issues.filter(
          (i) => i.kind === 'PROGRAM_SWITCH' && i.studentId !== null && studentIds.has(i.studentId),
        ).length,
        withdrawn: stats.withdrawn,
        withdrawnByProgramSwitch: stats.withdrawnByProgramSwitch,
        missingFromSheet: stats.missingFromSheet,
      },
      lastSync: ctx.lastSync,
    };
  }

  /** Page 2 student table. Four queries; filtering, sorting and paging happen in memory. */
  async subjectStudents(query: SubjectStudentsQueryDto): Promise<MonitoringStudentsPage> {
    const sel = await this.select(query);
    const { ctx, offering } = sel;
    const criteria = criteriaOf(offering);
    if (
      query.sort.startsWith('criterion:') &&
      !criteria.some((c) => `criterion:${c.criterionId}` === query.sort)
    ) {
      throw fail('UNKNOWN_CRITERION', "This subject's grading scheme has no such criterion.");
    }

    const all = await this.subjects.loadRows(ctx, [offering]);
    let rows = filterRows(all.get(offering.id) ?? [], sel);
    // With a level filter the table counts what the summary counts: no withdrawn rows.
    if (query.level) rows = rows.filter((r) => !r.withdrawn && r.level === query.level);
    const search = query.search?.trim().toLowerCase();
    if (search) {
      rows = rows.filter(
        (r) =>
          r.studentCode.toLowerCase().includes(search) || r.fullName.toLowerCase().includes(search),
      );
    }

    const gradeRank = new Map(
      (ctx.bands ?? []).map((b) => [b.letter.trim(), b.minTotal.toNumber()]),
    );
    const direction = query.order === 'desc' ? -1 : 1;
    const keyed = rows.map((r) => ({ r, v: sortValue(r, query.sort, gradeRank) }));
    keyed.sort((a, b) => {
      if (a.v === null || b.v === null) {
        if (a.v !== b.v) return a.v === null ? 1 : -1;
      } else {
        const c =
          typeof a.v === 'number' && typeof b.v === 'number'
            ? a.v - b.v
            : text(String(a.v), String(b.v));
        if (c !== 0) return c * direction;
      }
      return text(a.r.studentCode, b.r.studentCode);
    });

    const start = (query.page - 1) * query.pageSize;
    return {
      data: keyed.slice(start, start + query.pageSize).map((k) => toStudentRow(k.r)),
      meta: { page: query.page, pageSize: query.pageSize, total: keyed.length },
      criteria,
    };
  }

  /**
   * The term (one query) and the checks that need no student data: the subject must be offered
   * in this term (404), the program must be one it is offered to and the class must be in the
   * term's list, and of that program (422). An archived subject is returned, flagged.
   */
  private async select(query: SubjectQueryDto): Promise<Selection> {
    const ctx = await this.subjects.loadTerm(query.generationId, query.termNumber);
    const offering = ctx.offerings.find((o) => o.courseId === query.subjectId);
    if (!offering) {
      throw new NotFoundException({
        code: 'SUBJECT_NOT_IN_TERM',
        message: 'This subject is not offered in this term.',
      });
    }

    let program: ProgramRef | null = null;
    if (query.program) {
      const wanted = query.program;
      program =
        audienceOf(offering, ctx.programs).programs.find((p) => sameText(p.code, wanted)) ?? null;
      if (!program) {
        throw fail('PROGRAM_NOT_OFFERED', 'This subject is not offered to that program.');
      }
    }

    let termClass: TermClassRef | null = null;
    if (query.className) {
      const wanted = query.className;
      termClass = ctx.classes.find((c) => sameText(c.name, wanted)) ?? null;
      if (!termClass)
        throw fail('CLASS_NOT_IN_TERM', "That class is not in this term's class list.");
      if (program && termClass.programId !== program.id) {
        throw fail('CLASS_NOT_IN_PROGRAM', 'That class belongs to another program.');
      }
    }
    return { ctx, offering, program, termClass };
  }
}
