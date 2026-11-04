import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma, StudentTermIssueKind } from '@ssrs/database';
import { refreshLatestTerm } from '@ssrs/sync';
import { AcademicGuardService } from '../academic/academic-guard.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { paginated, skipTake, type Paginated } from '../common/pagination.js';
import type { RequestMeta } from '../common/request-meta.js';
import { PrismaService } from '../infra/prisma.service.js';
import type {
  AssignStudentTermDto,
  ListStudentIssuesQueryDto,
  SetTermClassesDto,
} from './programs.dto.js';

type Tx = Prisma.TransactionClient;

export interface ProgramView {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

export interface TermClassesView {
  termId: string;
  termNumber: number;
  termName: string;
  generationId: string;
  programs: {
    id: string;
    code: string;
    name: string;
    classes: { id: string; name: string; students: number }[];
  }[];
}

export interface StudentIssueView {
  id: string;
  termId: string;
  studentId: string | null;
  studentCode: string;
  fullName: string | null;
  kind: StudentTermIssueKind;
  detail: Record<string, unknown>;
  syncJobId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

/** Kinds an admin assignment settles, beside a program switch. */
const SETTLED_BY_ASSIGNMENT: StudentTermIssueKind[] = [
  'UNDETERMINED_PROGRAM',
  'UNKNOWN_CLASS',
  'PROGRAM_CONFLICT',
  'PROGRAM_SWITCH',
];

const fail = (code: string, message: string) => new UnprocessableEntityException({ code, message });
const upper = (s: string) => s.trim().toUpperCase();

/**
 * Programs, term class lists and the students' term enrollments as an admin manages them
 * (docs/google-sheets-template.md §3). Every change is audited and invalidates cached results.
 */
@Injectable()
export class ProgramsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly guard: AcademicGuardService,
  ) {}

  async programs(): Promise<ProgramView[]> {
    const rows = await this.prisma.client.program.findMany({
      where: { isActive: true },
      include: { aliases: { select: { alias: true } } },
      orderBy: { code: 'asc' },
    });
    return rows.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      aliases: p.aliases.map((a) => a.alias),
    }));
  }

  private async term(termId: string) {
    const term = await this.prisma.client.term.findUnique({ where: { id: termId } });
    if (!term) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Term not found' });
    return term;
  }

  async classes(termId: string, db: Tx | PrismaService['client'] = this.prisma.client) {
    const term = await this.term(termId);
    const rows = await db.termProgram.findMany({
      where: { termId },
      include: {
        program: true,
        classes: {
          include: { _count: { select: { studentTerms: true } } },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { program: { code: 'asc' } },
    });
    return {
      termId,
      termNumber: term.number,
      termName: term.name,
      generationId: term.generationId,
      programs: rows.map((tp) => ({
        id: tp.program.id,
        code: tp.program.code,
        name: tp.program.name,
        classes: tp.classes.map((c) => ({
          id: c.id,
          name: c.name,
          students: c._count.studentTerms,
        })),
      })),
    } satisfies TermClassesView;
  }

  /**
   * Replaces a term's programs and class lists. A class name may belong to one program per term;
   * a program or class that still has students cannot be removed.
   */
  async setClasses(
    termId: string,
    dto: SetTermClassesDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<TermClassesView> {
    const term = await this.term(termId);
    await this.guard.assertGenerationEditable(term.generationId);
    const programs = await this.prisma.client.program.findMany();
    const programByCode = new Map(programs.map((p) => [upper(p.code), p]));

    const wanted = new Map<string, { programId: string; code: string; classes: string[] }>();
    const owner = new Map<string, string>();
    for (const entry of dto.programs) {
      const program = programByCode.get(upper(entry.program));
      if (!program) throw fail('UNKNOWN_PROGRAM', `There is no program "${entry.program}".`);
      if (wanted.has(program.id)) {
        throw fail('DUPLICATE_PROGRAM', `${program.code} is listed twice.`);
      }
      const classes: string[] = [];
      for (const raw of entry.classes) {
        const name = raw.trim();
        const seen = owner.get(upper(name));
        if (seen === program.code) {
          throw fail('DUPLICATE_CLASS', `Class "${name}" is listed twice under ${program.code}.`);
        }
        if (seen) {
          throw fail(
            'CLASS_IN_TWO_PROGRAMS',
            `Class "${name}" is listed under ${seen} and ${program.code}. A class name can belong to one program per term.`,
          );
        }
        owner.set(upper(name), program.code);
        classes.push(name);
      }
      wanted.set(program.id, { programId: program.id, code: program.code, classes });
    }

    await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.termProgram.findMany({
        where: { termId },
        include: {
          program: true,
          classes: { include: { _count: { select: { studentTerms: true } } } },
        },
      });
      // Removals first: a class may move from one program to another in the same request.
      for (const tp of current) {
        const keep = wanted.get(tp.programId);
        for (const cls of tp.classes) {
          const stays = keep?.classes.some((n) => upper(n) === upper(cls.name));
          if (stays) continue;
          if (cls._count.studentTerms > 0) {
            throw new ConflictException({
              code: 'CLASS_IN_USE',
              message: `Class ${cls.name} (${tp.program.code}) has ${cls._count.studentTerms} students in Term ${term.number}. Move them first.`,
            });
          }
          await tx.termClass.delete({ where: { id: cls.id } });
        }
        if (!keep) {
          const students = await tx.studentTerm.count({
            where: { termId, programId: tp.programId },
          });
          if (students > 0) {
            throw new ConflictException({
              code: 'PROGRAM_IN_USE',
              message: `${tp.program.code} has ${students} students in Term ${term.number}.`,
            });
          }
          await tx.termProgram.delete({
            where: { termId_programId: { termId, programId: tp.programId } },
          });
        }
      }
      for (const entry of wanted.values()) {
        const tp = current.find((c) => c.programId === entry.programId);
        if (!tp) await tx.termProgram.create({ data: { termId, programId: entry.programId } });
        for (const name of entry.classes) {
          const existing = tp?.classes.find((c) => upper(c.name) === upper(name));
          if (existing && existing.name !== name) {
            await tx.termClass.update({ where: { id: existing.id }, data: { name } });
          } else if (!existing) {
            await tx.termClass.create({ data: { termId, programId: entry.programId, name } });
          }
        }
      }
      await this.audit.record(
        {
          action: 'term.classes_updated',
          actorUserId: actor.userId,
          entityType: 'term',
          entityId: termId,
          metadata: {
            termNumber: term.number,
            programs: Object.fromEntries([...wanted.values()].map((w) => [w.code, w.classes])),
          },
          context: meta,
        },
        tx,
      );
    });
    return this.classes(termId);
  }

  async issues(
    termId: string,
    query: ListStudentIssuesQueryDto,
  ): Promise<Paginated<StudentIssueView>> {
    await this.term(termId);
    const where: Prisma.StudentTermIssueWhereInput = {
      termId,
      ...(query.status === 'OPEN' ? { resolvedAt: null } : {}),
      ...(query.status === 'RESOLVED' ? { resolvedAt: { not: null } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.studentTermIssue.findMany({
        where,
        include: { student: { select: { fullName: true } } },
        orderBy: [{ kind: 'asc' }, { studentCode: 'asc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.client.studentTermIssue.count({ where }),
    ]);
    return paginated(
      rows.map((r) => ({
        id: r.id,
        termId: r.termId,
        studentId: r.studentId,
        studentCode: r.studentCode,
        fullName: r.student?.fullName ?? null,
        kind: r.kind,
        detail: r.detail as Record<string, unknown>,
        syncJobId: r.syncJobId,
        createdAt: r.createdAt.toISOString(),
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        resolution: r.resolution,
      })),
      total,
      query,
    );
  }

  /**
   * Applies a program switch the sync reported: the student's enrollment in the term moves to
   * the new program and class. Subjects the new program does not take are withdrawn (marks kept,
   * hidden from the student, flagged for admins); nothing is deleted.
   */
  async approveSwitch(issueId: string, actor: AuthUser, meta: RequestMeta) {
    const issue = await this.prisma.client.studentTermIssue.findUnique({
      where: { id: issueId },
      include: { term: true },
    });
    if (!issue) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Issue not found' });
    if (issue.kind !== 'PROGRAM_SWITCH' || issue.resolvedAt || !issue.studentId) {
      throw new ConflictException({
        code: 'NOT_AN_OPEN_SWITCH',
        message: 'Only an open program switch can be approved.',
      });
    }
    const studentId = issue.studentId;
    await this.guard.assertGenerationEditable(issue.term.generationId);
    const detail = issue.detail as { from?: string; to?: string; class?: string };
    await this.prisma.client.$transaction(async (tx) => {
      const target = await this.findClass(tx, issue.termId, detail.to ?? '', detail.class ?? '');
      const st = await tx.studentTerm.findUniqueOrThrow({
        where: { studentId_termId: { studentId, termId: issue.termId } },
        include: { program: true, class: true },
      });
      const changes = await this.moveProgram(tx, st, target);
      await tx.studentTermIssue.update({
        where: { id: issue.id },
        data: {
          resolvedAt: new Date(),
          resolvedById: actor.userId,
          resolution: 'APPROVED',
          detail: {
            ...detail,
            previous: { program: st.program.code, class: st.class.name },
            withdrawn: changes.withdrawn,
            restored: changes.restored,
          },
        },
      });
      await refreshLatestTerm(tx, [studentId]);
      await this.guard.bumpCacheVersion(issue.term.generationId, tx);
      await this.audit.record(
        {
          action: 'student_term.program_switch_approved',
          actorUserId: actor.userId,
          entityType: 'student_term',
          entityId: st.id,
          metadata: {
            studentCode: issue.studentCode,
            termNumber: issue.term.number,
            from: `${st.program.code} ${st.class.name}`,
            to: `${target.programCode} ${target.name}`,
            withdrawn: changes.withdrawn.length,
          },
          context: meta,
        },
        tx,
      );
    });
    return this.issueView(issue.id);
  }

  /** Undoes an approved switch: back to the previous program and class, subjects restored. */
  async reverseSwitch(issueId: string, actor: AuthUser, meta: RequestMeta) {
    const issue = await this.prisma.client.studentTermIssue.findUnique({
      where: { id: issueId },
      include: { term: true },
    });
    if (!issue) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Issue not found' });
    const detail = issue.detail as {
      previous?: { program: string; class: string };
      withdrawn?: string[];
    };
    if (
      issue.kind !== 'PROGRAM_SWITCH' ||
      issue.resolution !== 'APPROVED' ||
      !issue.studentId ||
      !detail.previous
    ) {
      throw new ConflictException({
        code: 'NOT_AN_APPROVED_SWITCH',
        message: 'Only an approved program switch can be reversed.',
      });
    }
    const studentId = issue.studentId;
    const previous = detail.previous;
    await this.guard.assertGenerationEditable(issue.term.generationId);
    await this.prisma.client.$transaction(async (tx) => {
      const target = await this.findClass(tx, issue.termId, previous.program, previous.class);
      const st = await tx.studentTerm.findUniqueOrThrow({
        where: { studentId_termId: { studentId, termId: issue.termId } },
        include: { program: true, class: true },
      });
      await this.moveProgram(tx, st, target);
      await tx.studentTermIssue.update({
        where: { id: issue.id },
        data: { resolution: 'REVERSED', resolvedById: actor.userId },
      });
      await refreshLatestTerm(tx, [studentId]);
      await this.guard.bumpCacheVersion(issue.term.generationId, tx);
      await this.audit.record(
        {
          action: 'student_term.program_switch_reversed',
          actorUserId: actor.userId,
          entityType: 'student_term',
          entityId: st.id,
          metadata: {
            studentCode: issue.studentCode,
            termNumber: issue.term.number,
            from: `${st.program.code} ${st.class.name}`,
            to: `${target.programCode} ${target.name}`,
          },
          context: meta,
        },
        tx,
      );
    });
    return this.issueView(issue.id);
  }

  /**
   * An admin sets a student's program and class for a term. Sync keeps the program from then on;
   * it still updates the class when the sheet names another class of that program.
   */
  async assign(
    studentId: string,
    termId: string,
    dto: AssignStudentTermDto,
    actor: AuthUser,
    meta: RequestMeta,
  ) {
    const student = await this.prisma.client.student.findUnique({ where: { id: studentId } });
    if (!student) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });
    const term = await this.term(termId);
    if (term.generationId !== student.generationId) {
      throw fail('TERM_NOT_IN_GENERATION', "This term is not in the student's generation.");
    }
    await this.guard.assertGenerationEditable(term.generationId);
    await this.prisma.client.$transaction(async (tx) => {
      const target = await this.findClass(tx, termId, dto.program, dto.className);
      const st = await tx.studentTerm.findUnique({
        where: { studentId_termId: { studentId, termId } },
        include: { program: true, class: true },
      });
      let from: string | null = null;
      let entityId: string;
      if (st) {
        from = `${st.program.code} ${st.class.name}`;
        await this.moveProgram(tx, st, target);
        await tx.studentTerm.update({ where: { id: st.id }, data: { programSource: 'ADMIN' } });
        entityId = st.id;
      } else {
        entityId = (
          await tx.studentTerm.create({
            data: {
              studentId,
              termId,
              generationId: term.generationId,
              programId: target.programId,
              classId: target.id,
              programSource: 'ADMIN',
            },
          })
        ).id;
      }
      await tx.studentTermIssue.updateMany({
        where: {
          termId,
          studentCode: student.studentCode,
          resolvedAt: null,
          kind: { in: SETTLED_BY_ASSIGNMENT },
        },
        data: { resolvedAt: new Date(), resolvedById: actor.userId, resolution: 'ADMIN_ASSIGNED' },
      });
      await refreshLatestTerm(tx, [studentId]);
      await this.guard.bumpCacheVersion(term.generationId, tx);
      await this.audit.record(
        {
          action: 'student_term.assigned',
          actorUserId: actor.userId,
          entityType: 'student_term',
          entityId,
          metadata: {
            studentCode: student.studentCode,
            termNumber: term.number,
            from,
            to: `${target.programCode} ${target.name}`,
          },
          context: meta,
        },
        tx,
      );
    });
    return {
      termNumber: term.number,
      program: dto.program.toUpperCase(),
      className: dto.className,
    };
  }

  /** A class of a program in a term, by program code (or alias) and class name. */
  private async findClass(tx: Tx, termId: string, program: string, className: string) {
    const prog = await tx.program.findFirst({
      where: {
        OR: [{ code: program }, { aliases: { some: { alias: program } } }],
      },
    });
    const cls = prog
      ? await tx.termClass.findFirst({ where: { termId, programId: prog.id, name: className } })
      : null;
    if (!prog || !cls) {
      throw fail(
        'CLASS_NOT_IN_LIST',
        `Class "${className}" of ${program} is not in this term's class list.`,
      );
    }
    return { id: cls.id, name: cls.name, programId: prog.id, programCode: prog.code };
  }

  /**
   * Moves a term enrollment to another program and class. Subjects of the term that the new
   * program does not take are withdrawn (ended_reason PROGRAM_SWITCH); ones it takes and that an
   * earlier switch withdrew are restored. Marks are never touched.
   */
  private async moveProgram(
    tx: Tx,
    st: { id: string; studentId: string; termId: string; programId: string },
    target: { id: string; programId: string },
  ): Promise<{ withdrawn: string[]; restored: string[] }> {
    await tx.studentTerm.update({
      where: { id: st.id },
      data: { programId: target.programId, classId: target.id },
    });
    const enrollments = await tx.enrollment.findMany({
      where: { studentId: st.studentId, offering: { termId: st.termId } },
      include: { offering: { include: { programs: { select: { programId: true } } } } },
    });
    const takes = (e: (typeof enrollments)[number]) =>
      e.offering.programs.length === 0 ||
      e.offering.programs.some((p) => p.programId === target.programId);
    const withdrawn = enrollments
      .filter((e) => e.status === 'ENROLLED' && !takes(e))
      .map((e) => e.id);
    const restored = enrollments
      .filter((e) => e.endedReason === 'PROGRAM_SWITCH' && takes(e))
      .map((e) => e.id);
    if (withdrawn.length > 0) {
      await tx.enrollment.updateMany({
        where: { id: { in: withdrawn } },
        data: { status: 'WITHDRAWN', endedReason: 'PROGRAM_SWITCH' },
      });
    }
    if (restored.length > 0) {
      await tx.enrollment.updateMany({
        where: { id: { in: restored } },
        data: { status: 'ENROLLED', endedReason: null },
      });
    }
    return { withdrawn, restored };
  }

  private async issueView(id: string): Promise<StudentIssueView> {
    const r = await this.prisma.client.studentTermIssue.findUniqueOrThrow({
      where: { id },
      include: { student: { select: { fullName: true } } },
    });
    return {
      id: r.id,
      termId: r.termId,
      studentId: r.studentId,
      studentCode: r.studentCode,
      fullName: r.student?.fullName ?? null,
      kind: r.kind,
      detail: r.detail as Record<string, unknown>,
      syncJobId: r.syncJobId,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolution: r.resolution,
    };
  }
}
