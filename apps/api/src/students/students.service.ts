import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@ssrs/database';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { checkPasswordPolicy } from '../auth/password-policy.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { toCsv } from '../common/csv.js';
import { paginated, skipTake, type Paginated } from '../common/pagination.js';
import type { RequestMeta } from '../common/request-meta.js';
import { API_ENV, type ApiEnv } from '../config/env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type {
  IssueCredentialsDto,
  ListStudentsQueryDto,
  UpdateStudentStatusDto,
} from './students.dto.js';

/** Bounded so one request cannot spend minutes hashing (Argon2 ≈ 30–50 ms per password). */
export const MAX_CREDENTIALS_PER_REQUEST = 500;
const HASH_CONCURRENCY = 4;

const STUDENT_INCLUDE = {
  user: {
    select: {
      id: true,
      status: true,
      mustChangePassword: true,
      passwordExpiresAt: true,
      lastLoginAt: true,
      lockedUntil: true,
    },
  },
  generation: { select: { id: true, code: true, name: true } },
} satisfies Prisma.StudentInclude;

type StudentRow = Prisma.StudentGetPayload<{ include: typeof STUDENT_INCLUDE }>;

export interface StudentView {
  id: string;
  studentCode: string;
  fullName: string;
  gender: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  className: string | null;
  generation: { id: string; code: string; name: string };
  account: {
    status: 'PENDING' | 'ACTIVE' | 'DISABLED';
    mustChangePassword: boolean;
    temporaryPasswordExpiresAt: string | null;
    lastLoginAt: string | null;
    locked: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface IssuedCredential {
  studentCode: string;
  temporaryPassword: string;
  expiresAt: string;
}

function toView(s: StudentRow, now = new Date()): StudentView {
  return {
    id: s.id,
    studentCode: s.studentCode,
    fullName: s.fullName,
    gender: s.gender,
    className: s.className,
    generation: s.generation,
    account: {
      status: s.user.status,
      mustChangePassword: s.user.mustChangePassword,
      temporaryPasswordExpiresAt: s.user.passwordExpiresAt?.toISOString() ?? null,
      lastLoginAt: s.user.lastLoginAt?.toISOString() ?? null,
      locked: s.user.lockedUntil !== null && s.user.lockedUntil > now,
    },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class StudentsService {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListStudentsQueryDto): Promise<Paginated<StudentView>> {
    const where: Prisma.StudentWhereInput = {
      ...(query.generationId ? { generationId: query.generationId } : {}),
      ...(query.className ? { className: { equals: query.className, mode: 'insensitive' } } : {}),
      ...(query.status ? { user: { status: query.status } } : {}),
      ...(query.q
        ? {
            OR: [
              { studentCode: { contains: query.q, mode: 'insensitive' } },
              { fullName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.student.findMany({
        where,
        include: STUDENT_INCLUDE,
        orderBy: { studentCode: 'asc' },
        ...skipTake(query),
      }),
      this.prisma.client.student.count({ where }),
    ]);
    return paginated(
      rows.map((r) => toView(r)),
      total,
      query,
    );
  }

  async get(id: string): Promise<StudentView> {
    const row = await this.prisma.client.student.findUnique({
      where: { id },
      include: STUDENT_INCLUDE,
    });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });
    return toView(row);
  }

  /**
   * ACTIVE ↔ DISABLED. Disabling revokes every session immediately. A PENDING account can be
   * disabled, but becomes ACTIVE only by issuing credentials (reset-password).
   */
  async setStatus(
    id: string,
    dto: UpdateStudentStatusDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<StudentView> {
    const student = await this.prisma.client.student.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, status: true, passwordChangedAt: true, mustChangePassword: true },
        },
      },
    });
    if (!student) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });
    const current = student.user.status;
    if (current === dto.status) return this.get(id);

    if (dto.status === 'ACTIVE' && current === 'PENDING') {
      throw new ConflictException({
        code: 'CREDENTIALS_NOT_ISSUED',
        message:
          'This account has no credentials yet. Use "reset password" to issue a temporary password.',
      });
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: student.user.id }, data: { status: dto.status } });
      let revoked = 0;
      if (dto.status === 'DISABLED') {
        revoked = await this.sessions.revokeAllForUser(student.user.id, 'ACCOUNT_DISABLED', { tx });
      }
      await this.audit.record(
        {
          action:
            dto.status === 'DISABLED' ? 'student.account.disabled' : 'student.account.enabled',
          actorUserId: actor.userId,
          entityType: 'student',
          entityId: id,
          metadata: {
            studentCode: student.studentCode,
            previousStatus: current,
            sessionsRevoked: revoked,
          },
          context: meta,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Issues a one-time temporary password (also used to activate PENDING accounts). The plain
   * password is returned exactly once and never stored or logged.
   */
  async resetPassword(id: string, actor: AuthUser, meta: RequestMeta): Promise<IssuedCredential> {
    const student = await this.prisma.client.student.findUnique({
      where: { id },
      include: { user: { select: { id: true, status: true, username: true } } },
    });
    if (!student) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Student not found' });
    if (student.user.status === 'DISABLED') {
      throw new ConflictException({
        code: 'ACCOUNT_DISABLED',
        message: 'Enable the account before issuing a new password',
      });
    }

    return this.issueTo(student, actor, meta);
  }

  /**
   * PROV-03: issues temporary passwords to many students at once and returns them as CSV
   * (the only time they are ever visible). By default only PENDING accounts are included, so
   * running it twice never resets passwords students already use.
   */
  async issueCredentials(
    dto: IssueCredentialsDto,
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<{ csv: string; count: number; filename: string }> {
    if (!dto.studentIds?.length && !dto.generationId) {
      throw new UnprocessableEntityException({
        code: 'SELECTION_REQUIRED',
        message: 'Select students by studentIds or generationId.',
      });
    }
    const onlyPending = dto.onlyPending ?? true;
    const where: Prisma.StudentWhereInput = {
      ...(dto.studentIds?.length ? { id: { in: dto.studentIds } } : {}),
      ...(dto.generationId ? { generationId: dto.generationId } : {}),
      ...(dto.className ? { className: { equals: dto.className, mode: 'insensitive' } } : {}),
      user: onlyPending ? { status: 'PENDING' } : { status: { in: ['PENDING', 'ACTIVE'] } },
    };
    const total = await this.prisma.client.student.count({ where });
    if (total > MAX_CREDENTIALS_PER_REQUEST) {
      throw new UnprocessableEntityException({
        code: 'TOO_MANY_STUDENTS',
        message: `${total} students match; issue at most ${MAX_CREDENTIALS_PER_REQUEST} per request (filter by class).`,
      });
    }
    const students = await this.prisma.client.student.findMany({
      where,
      include: { user: { select: { id: true, status: true, username: true } } },
      orderBy: [{ className: 'asc' }, { studentCode: 'asc' }],
    });

    // Argon2 runs on libuv's thread pool; a small concurrency keeps the API responsive.
    const issued: (IssuedCredential & { fullName: string; className: string | null })[] = [];
    for (let i = 0; i < students.length; i += HASH_CONCURRENCY) {
      const batch = students.slice(i, i + HASH_CONCURRENCY);
      const results = await Promise.all(batch.map((s) => this.issueTo(s, actor, meta)));
      results.forEach((r, j) => {
        const s = batch[j];
        if (s) issued.push({ ...r, fullName: s.fullName, className: s.className });
      });
    }

    await this.audit.record({
      action: 'student.credentials.bulk_issued',
      actorUserId: actor.userId,
      entityType: dto.generationId ? 'generation' : 'student',
      entityId: dto.generationId,
      metadata: {
        count: issued.length,
        onlyPending,
        className: dto.className ?? null,
        studentCodes: issued.slice(0, 50).map((c) => c.studentCode),
      },
      context: meta,
    });

    const csv = toCsv(
      ['student_id', 'student_name', 'class', 'temporary_password', 'expires_at'],
      issued.map((c) => [c.studentCode, c.fullName, c.className, c.temporaryPassword, c.expiresAt]),
    );
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return { csv, count: issued.length, filename: `credentials-${stamp}.csv` };
  }

  private async issueTo(
    student: {
      id: string;
      studentCode: string;
      user: { id: string; status: string; username: string };
    },
    actor: AuthUser,
    meta: RequestMeta,
  ): Promise<IssuedCredential> {
    let temporaryPassword = this.passwords.generateTemporaryPassword();
    while (checkPasswordPolicy(temporaryPassword, student.user.username).length > 0) {
      temporaryPassword = this.passwords.generateTemporaryPassword();
    }
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const expiresAt = new Date(Date.now() + this.env.TEMP_PASSWORD_TTL_DAYS * 86_400_000);
    const wasPending = student.user.status === 'PENDING';
    const id = student.id;

    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: student.user.id },
        data: {
          passwordHash,
          status: 'ACTIVE',
          mustChangePassword: true,
          passwordExpiresAt: expiresAt,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUser(student.user.id, 'PASSWORD_RESET', {
        tx,
      });
      await this.audit.record(
        {
          action: wasPending ? 'student.credentials.issued' : 'student.password.reset',
          actorUserId: actor.userId,
          entityType: 'student',
          entityId: id,
          metadata: { studentCode: student.studentCode, expiresAt, sessionsRevoked: revoked },
          context: meta,
        },
        tx,
      );
    });
    return {
      studentCode: student.studentCode,
      temporaryPassword,
      expiresAt: expiresAt.toISOString(),
    };
  }
}
