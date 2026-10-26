import type { Prisma, PrismaClient, SyncStatus } from '@ssrs/database';
import {
  readWorkbook,
  SheetsAccessError,
  type TemplateIssue,
  type WorkbookReadResult,
} from '@ssrs/sheets';
import { applyCourse } from './apply-course.js';
import { applyRoster } from './apply-roster.js';
import { refreshParentJob } from './parent.js';
import {
  addCounts,
  emptyCounts,
  silentLogger,
  type RunOptions,
  type RunOutcome,
  type SyncCounts,
  type SyncDeps,
  type SyncIssue,
} from './types.js';

const TERMINAL: readonly SyncStatus[] = [
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
];
const ERROR_BATCH = 1_000;
const MAX_STORED_ISSUES = 20_000;

/** Counts parser rejections into the job report (students, courses and cells). */
function countParseRejections(issues: readonly TemplateIssue[], counts: SyncCounts): void {
  const rejectedCourses = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== 'ERROR') continue;
    if (issue.scope === 'ROW' && issue.sheetTab === 'Students') counts.students.rejected++;
    if (issue.scope === 'CELL' && issue.code === 'INVALID_MARK') counts.scores.rejected++;
    if (issue.scope === 'COURSE' && issue.code !== 'WEIGHTS_NOT_100') {
      rejectedCourses.add(issue.courseKey?.toUpperCase() ?? `${issue.sheetTab}:${issue.rowNumber}`);
    }
  }
  counts.offerings.rejected += rejectedCourses.size;
}

async function persistIssues(
  prisma: PrismaClient,
  jobId: string,
  issues: readonly SyncIssue[],
): Promise<void> {
  const stored = issues.slice(0, MAX_STORED_ISSUES);
  for (let i = 0; i < stored.length; i += ERROR_BATCH) {
    await prisma.syncError.createMany({
      data: stored.slice(i, i + ERROR_BATCH).map((issue): Prisma.SyncErrorCreateManyInput => ({
        jobId,
        severity: issue.severity,
        code: issue.code,
        message: issue.message.slice(0, 1_000),
        sheetTab: issue.sheetTab ?? null,
        rowNumber: issue.rowNumber ?? null,
        columnKey: issue.columnKey ?? null,
        studentCode: issue.studentCode ?? null,
        courseKey: issue.courseKey ?? null,
        criterionKey: issue.criterionKey ?? null,
        rawValue: issue.rawValue?.slice(0, 200) ?? null,
      })),
    });
  }
}

/**
 * Runs one SOURCE sync job end to end (docs/architecture.md §5). The job row in PostgreSQL is
 * the source of truth for status and progress; the queue only delivers the job id.
 *
 * Outcome semantics:
 *  - FAILED: nothing was applied (access/config problem, file-level template error, roster
 *    failure) — or every course failed to apply.
 *  - SUCCEEDED_WITH_ERRORS: data was applied, but some rows/cells/courses were rejected.
 *  - SUCCEEDED: applied with at most warnings.
 *  - retry: a transient Google failure before any write; the caller lets the queue retry.
 */
export async function runSourceSync(
  deps: SyncDeps,
  syncJobId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const { prisma, reader } = deps;
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());

  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
    include: { source: { include: { generation: { include: { terms: true } } } } },
  });
  if (!job) throw new Error(`Sync job ${syncJobId} not found`);
  if (TERMINAL.includes(job.status)) return { kind: 'finished', status: job.status as 'SUCCEEDED' };

  const finish = async (
    status: 'SUCCEEDED' | 'SUCCEEDED_WITH_ERRORS' | 'FAILED',
    extra: {
      failureCode?: string;
      failureMessage?: string;
      counts?: SyncCounts;
      issues?: SyncIssue[];
    } = {},
  ): Promise<RunOutcome> => {
    const issues = extra.issues ?? [];
    await persistIssues(prisma, job.id, issues);
    const finishedAt = now();
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        phase: 'DONE',
        finishedAt,
        counts: (extra.counts ?? emptyCounts()) as unknown as Prisma.InputJsonValue,
        errorCount: issues.filter((i) => i.severity === 'ERROR').length,
        warningCount: issues.filter((i) => i.severity === 'WARNING').length,
        failureCode: extra.failureCode ?? null,
        failureMessage: extra.failureMessage ?? null,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: status === 'FAILED' ? 'sync.failed' : 'sync.completed',
        entityType: 'sync_job',
        entityId: job.id,
        metadata: {
          status,
          sourceId: job.sourceId,
          failureCode: extra.failureCode ?? null,
          counts: (extra.counts ?? null) as unknown as Prisma.InputJsonValue,
        },
      },
    });
    if (job.parentId) await refreshParentJob(prisma, job.parentId, finishedAt);
    logger.info('Sync job finished', { syncJobId: job.id, status, failureCode: extra.failureCode });
    return { kind: 'finished', status };
  };

  // A re-delivered job (worker crash, stalled lock) starts its report from scratch.
  await prisma.syncError.deleteMany({ where: { jobId: job.id } });
  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: 'RUNNING',
      startedAt: job.startedAt ?? now(),
      phase: 'FETCH',
      failureCode: null,
      failureMessage: null,
    },
  });

  const source = job.source;
  if (job.scope !== 'SOURCE' || !source) {
    return finish('FAILED', {
      failureCode: 'INVALID_JOB',
      failureMessage: 'Only SOURCE jobs are executed by the worker.',
    });
  }
  if (source.status === 'DISABLED') {
    return finish('FAILED', {
      failureCode: 'SOURCE_DISABLED',
      failureMessage: 'The spreadsheet source is disabled.',
    });
  }
  const generation = source.generation;
  if (generation.status === 'ARCHIVED') {
    return finish('FAILED', {
      failureCode: 'GENERATION_ARCHIVED',
      failureMessage: 'The generation is archived.',
    });
  }

  logger.info('Sync job started', {
    syncJobId: job.id,
    sourceId: source.id,
    attempt: options.attempt,
  });
  let workbook: WorkbookReadResult;
  try {
    workbook = await readWorkbook(reader, source.spreadsheetId, generation.code);
  } catch (err) {
    if (err instanceof SheetsAccessError) {
      if (err.retryable && options.attempt < options.maxAttempts) {
        await prisma.syncJob.update({
          where: { id: job.id },
          data: { phase: 'WAITING_RETRY', failureCode: err.code, failureMessage: err.message },
        });
        logger.warn('Transient Google error; will retry', { syncJobId: job.id, code: err.code });
        return { kind: 'retry', code: err.code, message: err.message };
      }
      return finish('FAILED', { failureCode: err.code, failureMessage: err.message });
    }
    throw err;
  }

  const counts = emptyCounts();
  const issues: SyncIssue[] = [...workbook.issues];
  countParseRejections(workbook.issues, counts);
  if (workbook.spreadsheetTitle && workbook.spreadsheetTitle !== source.spreadsheetTitle) {
    await prisma.googleSheetSource.update({
      where: { id: source.id },
      data: { spreadsheetTitle: workbook.spreadsheetTitle },
    });
  }
  if (workbook.fatal) {
    return finish('FAILED', {
      failureCode: 'TEMPLATE_INVALID',
      failureMessage: 'The spreadsheet has file-level errors; nothing was imported.',
      counts,
      issues,
    });
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { phase: 'APPLY', progressCurrent: 0, progressTotal: workbook.courses.length + 1 },
  });

  let studentIdByCode: Map<string, string>;
  try {
    const roster = await applyRoster(
      prisma,
      { syncJobId: job.id, sourceId: source.id, generationId: generation.id },
      workbook.students,
      now(),
    );
    studentIdByCode = roster.studentIdByCode;
    issues.push(...roster.issues);
    counts.students.created += roster.counts.created;
    counts.students.updated += roster.counts.updated;
    counts.students.unchanged += roster.counts.unchanged;
    counts.students.rejected += roster.counts.rejected;
  } catch (err) {
    logger.error('Roster apply failed', {
      syncJobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return finish('FAILED', {
      failureCode: 'APPLY_FAILED',
      failureMessage: 'Applying the student roster failed; nothing was imported.',
      counts,
      issues,
    });
  }
  await prisma.syncJob.update({ where: { id: job.id }, data: { progressCurrent: 1 } });

  const termIdByNumber = new Map(generation.terms.map((t) => [t.number, t.id]));
  let applied = 0;
  for (const [index, course] of workbook.courses.entries()) {
    try {
      const result = await applyCourse(
        prisma,
        {
          syncJobId: job.id,
          sourceId: source.id,
          generationId: generation.id,
          termIdByNumber,
          studentIdByCode,
          now: now(),
          hooks: deps.hooks,
        },
        course,
      );
      issues.push(...result.issues);
      addCounts(counts, result.counts);
      if (!result.rejected) applied++;
    } catch (err) {
      counts.offerings.failed++;
      issues.push({
        severity: 'ERROR',
        scope: 'COURSE',
        code: 'APPLY_FAILED',
        message:
          'Saving this course failed and was rolled back. Other courses were not affected; retry the sync.',
        courseKey: course.courseKey,
        sheetTab: course.worksheet,
      });
      logger.error('Course apply failed', {
        syncJobId: job.id,
        courseKey: course.courseKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await prisma.syncJob.update({ where: { id: job.id }, data: { progressCurrent: index + 2 } });
  }

  await prisma.$transaction([
    // Cached student results embed the generation's cache version (docs/architecture.md §6).
    prisma.generation.update({
      where: { id: generation.id },
      data: { cacheVersion: { increment: 1 } },
    }),
    prisma.googleSheetSource.update({
      where: { id: source.id },
      data: { lastSyncedAt: now(), lastSyncJobId: job.id },
    }),
  ]);

  const hasErrors = issues.some((i) => i.severity === 'ERROR');
  const everythingFailed =
    workbook.courses.length > 0 && applied === 0 && counts.offerings.failed > 0;
  return finish(everythingFailed ? 'FAILED' : hasErrors ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED', {
    counts,
    issues,
    ...(everythingFailed
      ? { failureCode: 'APPLY_FAILED', failureMessage: 'No course could be saved.' }
      : {}),
  });
}

/** Marks a job FAILED without running it (e.g. it could not be enqueued, or its worker died). */
export async function failJob(
  prisma: PrismaClient,
  syncJobId: string,
  failureCode: string,
  failureMessage: string,
  now = new Date(),
): Promise<void> {
  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
    select: { status: true, parentId: true },
  });
  if (!job || TERMINAL.includes(job.status)) return;
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: 'FAILED', phase: 'DONE', finishedAt: now, failureCode, failureMessage },
  });
  if (job.parentId) await refreshParentJob(prisma, job.parentId, now);
}
