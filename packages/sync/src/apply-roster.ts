import type { Prisma, PrismaClient } from '@ssrs/database';
import type { ParsedStudent } from '@ssrs/sheets';
import { lockedPasswordHash } from '@ssrs/shared/node';
import type { SyncCounts, SyncIssue } from './types.js';

export interface RosterContext {
  syncJobId: string;
  sourceId: string;
  generationId: string;
}

export interface RosterResult {
  /** Students that may receive enrollments/marks from this sync (normalized code → student id). */
  studentIdByCode: Map<string, string>;
  issues: SyncIssue[];
  counts: SyncCounts['students'];
}

/** Serializes roster changes across all syncs, so two sources can't race to create one student. */
const ROSTER_LOCK = 'ssrs:sync:roster';
const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

/**
 * Creates or updates students from the roster (PROV-01/02):
 *  - New student → user (STUDENT, PENDING, locked password, must change) + student + audit row.
 *  - Existing student of this generation → profile fields updated if changed. The user account
 *    (password, status, sessions) is never touched.
 *  - A student ID owned by another generation, or a username already used by a non-student
 *    account, is rejected (never moved or merged).
 */
export async function applyRoster(
  prisma: PrismaClient,
  ctx: RosterContext,
  students: readonly ParsedStudent[],
  now: Date,
): Promise<RosterResult> {
  const issues: SyncIssue[] = [];
  const counts = { created: 0, updated: 0, unchanged: 0, rejected: 0 };
  const studentIdByCode = new Map<string, string>();
  if (students.length === 0) return { studentIdByCode, issues, counts };

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ROSTER_LOCK}))`;
    const codes = students.map((s) => s.studentCode);
    const existingStudents = await tx.student.findMany({ where: { studentCode: { in: codes } } });
    const byCode = new Map(existingStudents.map((s) => [s.studentCode, s]));
    const usersWithoutStudent = await tx.user.findMany({
      where: { username: { in: codes }, student: null },
      select: { username: true },
    });
    const takenUsernames = new Set(usersWithoutStudent.map((u) => u.username.toUpperCase()));

    const toCreate: ParsedStudent[] = [];
    const seenIds: string[] = [];
    for (const parsed of students) {
      const at = {
        sheetTab: 'Students',
        rowNumber: parsed.rowNumber,
        studentCode: parsed.studentCode,
      };
      const existing = byCode.get(parsed.studentCode);
      if (!existing) {
        if (takenUsernames.has(parsed.studentCode)) {
          issues.push({
            severity: 'ERROR',
            scope: 'ROW',
            code: 'STUDENT_ID_CONFLICT',
            message: `Student ID ${parsed.studentCode} is already used as the login name of another account.`,
            ...at,
          });
          counts.rejected++;
        } else {
          toCreate.push(parsed);
        }
        continue;
      }
      if (existing.generationId !== ctx.generationId) {
        issues.push({
          severity: 'ERROR',
          scope: 'ROW',
          code: 'STUDENT_IN_OTHER_GENERATION',
          message: `Student ${parsed.studentCode} belongs to another generation and was not changed.`,
          ...at,
        });
        counts.rejected++;
        continue;
      }
      const changed =
        existing.fullName !== parsed.fullName ||
        existing.gender !== parsed.gender ||
        (existing.className ?? null) !== parsed.className;
      if (changed) {
        await tx.student.update({
          where: { id: existing.id },
          data: { fullName: parsed.fullName, gender: parsed.gender, className: parsed.className },
        });
        counts.updated++;
      } else {
        counts.unchanged++;
      }
      seenIds.push(existing.id);
      studentIdByCode.set(parsed.studentCode, existing.id);
    }

    if (toCreate.length > 0) {
      const users = await tx.user.createManyAndReturn({
        data: toCreate.map((s) => ({
          username: s.studentCode,
          role: 'STUDENT' as const,
          status: 'PENDING' as const,
          passwordHash: lockedPasswordHash(),
          mustChangePassword: true,
        })),
        select: { id: true, username: true },
      });
      const userIdByCode = new Map(users.map((u) => [u.username.toUpperCase(), u.id]));
      const userIdFor = (code: string): string => {
        const id = userIdByCode.get(code);
        if (!id) throw new Error(`Provisioned user for ${code} not returned`);
        return id;
      };
      const created = await tx.student.createManyAndReturn({
        data: toCreate.map((s) => ({
          studentCode: s.studentCode,
          userId: userIdFor(s.studentCode),
          generationId: ctx.generationId,
          fullName: s.fullName,
          gender: s.gender,
          className: s.className,
          sourceId: ctx.sourceId,
          lastSeenSyncJobId: ctx.syncJobId,
        })),
        select: { id: true, studentCode: true },
      });
      for (const s of created) studentIdByCode.set(s.studentCode, s.id);
      counts.created = created.length;
      await tx.auditLog.createMany({
        data: created.map((s): Prisma.AuditLogCreateManyInput => ({
          actorType: 'SYSTEM',
          action: 'student.provisioned',
          entityType: 'student',
          entityId: s.id,
          metadata: {
            studentCode: s.studentCode,
            syncJobId: ctx.syncJobId,
            sourceId: ctx.sourceId,
          },
          createdAt: now,
        })),
      });
    }

    if (seenIds.length > 0) {
      await tx.student.updateMany({
        where: { id: { in: seenIds } },
        data: { lastSeenSyncJobId: ctx.syncJobId, sourceId: ctx.sourceId },
      });
    }
  }, TX_OPTIONS);

  return { studentIdByCode, issues, counts };
}
