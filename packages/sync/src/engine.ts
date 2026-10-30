import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, SyncStatus } from '@ssrs/database';
import {
  readTermWorkbook,
  SheetsAccessError,
  type TemplateIssue,
  type TermWorkbookRead,
} from '@ssrs/sheets';
import { applyCourse } from './apply-course.js';
import { applyRoster } from './apply-roster.js';
import { confirmedTabs, mappingVersions, previewGate, TAB_MAPPINGS_INCLUDE } from './confirmed.js';
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
/** Run lease length; matches the BullMQ lock duration so a crashed worker's job is reclaimable. */
export const LEASE_MS = 120_000;
const LEASE_RENEW_MS = LEASE_MS / 3;
const MAX_STORED_ISSUES = 20_000;
/** A sheet change saves everything in one transaction, so it gets room for a whole workbook. */
const SHEET_CHANGE_TX = { maxWait: 30_000, timeout: 300_000 } as const;

/** Rolls back a sheet change: students keep the old scores and the sheet stays pending. */
class SheetChangeRejected extends Error {}

/** Counts parser rejections into the job report (students, courses and cells). */
function countParseRejections(
  issues: readonly TemplateIssue[],
  rosterTab: string | null,
  counts: SyncCounts,
): void {
  const rejectedCourses = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== 'ERROR') continue;
    if (issue.scope === 'ROW' && issue.sheetTab === rosterTab) counts.students.rejected++;
    if (issue.scope === 'CELL' && issue.code === 'INVALID_MARK') counts.scores.rejected++;
    if (issue.scope === 'COURSE') {
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
 * Exactly one run at a time: the run first claims a lease on the job row (atomic update that
 * succeeds only when no unexpired lease exists), renews it while working and releases it at the
 * end. A second delivery of the same job (BullMQ redelivers a job whose lock it thinks is lost)
 * gets `busy` and writes nothing. If the worker dies, the lease expires after LEASE_MS and a
 * redelivery takes over.
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
  const { prisma } = deps;
  const now = deps.now ?? (() => new Date());
  const token = randomUUID();
  const leaseUntil = () => new Date(now().getTime() + LEASE_MS);

  const claimed = await prisma.syncJob.updateMany({
    where: {
      id: syncJobId,
      finishedAt: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now() } }],
    },
    data: { leaseToken: token, leaseExpiresAt: leaseUntil() },
  });
  if (claimed.count === 0) {
    const job = await prisma.syncJob.findUnique({
      where: { id: syncJobId },
      select: { status: true },
    });
    if (!job) throw new Error(`Sync job ${syncJobId} not found`);
    if (TERMINAL.includes(job.status)) {
      return { kind: 'finished', status: job.status as 'SUCCEEDED' };
    }
    return { kind: 'busy' };
  }

  const renew = setInterval(() => {
    void prisma.syncJob
      .updateMany({
        where: { id: syncJobId, leaseToken: token },
        data: { leaseExpiresAt: leaseUntil() },
      })
      .catch(() => undefined); // a missed renewal only shortens the lease
  }, LEASE_RENEW_MS);
  renew.unref();
  try {
    return await execute(deps, syncJobId, options);
  } finally {
    clearInterval(renew);
    await prisma.syncJob.updateMany({
      where: { id: syncJobId, leaseToken: token },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }
}

/** The run itself; only called while holding the job's lease. */
async function execute(
  deps: SyncDeps,
  syncJobId: string,
  options: RunOptions,
): Promise<RunOutcome> {
  const { prisma, reader } = deps;
  const logger = deps.logger ?? silentLogger;
  const now = deps.now ?? (() => new Date());

  const job = await prisma.syncJob.findUnique({
    where: { id: syncJobId },
    include: {
      source: {
        include: {
          generation: true,
          term: true,
          tabMappings: { include: TAB_MAPPINGS_INCLUDE },
        },
      },
    },
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
  const confirmed = confirmedTabs(source.tabMappings);
  await prisma.syncJob.update({
    where: { id: job.id },
    data: { mappingVersions: mappingVersions(source.tabMappings) },
  });

  let workbook: TermWorkbookRead;
  try {
    workbook = await readTermWorkbook(
      reader,
      source.spreadsheetId,
      {
        generationCode: generation.code,
        termNumber: source.term.number,
        rosterTab: source.rosterTab,
        ignoredTabs: [
          ...source.ignoredTabs,
          ...source.tabMappings.filter((t) => t.status === 'IGNORED').map((t) => t.tabName),
        ],
      },
      confirmed,
    );
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
  countParseRejections(workbook.issues, workbook.rosterTab, counts);
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

  if (source.status === 'PENDING') {
    const gate = await previewGate(prisma, source.id, workbook.fingerprint);
    if (gate) {
      return finish('FAILED', { failureCode: gate.code, failureMessage: gate.message, issues });
    }
    const refused = {
      failureCode: 'SHEET_CHANGE_REJECTED',
      failureMessage:
        'The new sheet has errors, so nothing was imported. The current sheet stays active.',
    };
    if (issues.some((i) => i.severity === 'ERROR')) return finish('FAILED', { ...refused, issues });
    try {
      await prisma.$transaction(async (tx) => {
        const roster = await applyRoster(
          prisma,
          {
            syncJobId: job.id,
            sourceId: source.id,
            generationId: generation.id,
            rosterTab: workbook.rosterTab ?? source.rosterTab,
          },
          workbook.roster,
          now(),
          tx,
        );
        issues.push(...roster.issues);
        addCounts(counts, { students: roster.counts });
        for (const course of workbook.courses) {
          const result = await applyCourse(
            prisma,
            {
              syncJobId: job.id,
              sourceId: source.id,
              generationId: generation.id,
              studentIdByCode: roster.studentIdByCode,
              now: now(),
              hooks: deps.hooks,
            },
            course,
            tx,
          );
          issues.push(...result.issues);
          addCounts(counts, result.counts);
        }
        if (issues.some((i) => i.severity === 'ERROR')) {
          throw new SheetChangeRejected(refused.failureMessage);
        }
        const previous = await tx.googleSheetSource.findFirst({
          where: { termId: source.termId, status: 'ACTIVE' },
          select: { id: true, spreadsheetId: true },
        });
        if (previous) {
          await tx.googleSheetSource.update({
            where: { id: previous.id },
            data: { status: 'DISABLED' },
          });
        }
        await tx.googleSheetSource.update({
          where: { id: source.id },
          data: { status: 'ACTIVE', lastSyncedAt: now(), lastSyncJobId: job.id },
        });
        await tx.sheetPreview.updateMany({
          where: { sourceId: source.id, invalidatedAt: null },
          data: { invalidatedAt: now() },
        });
        await tx.generation.update({
          where: { id: generation.id },
          data: { cacheVersion: { increment: 1 } },
        });
        await tx.syncJob.update({
          where: { id: job.id },
          data: { progressCurrent: workbook.courses.length + 1 },
        });
        await tx.auditLog.create({
          data: {
            actorType: 'SYSTEM',
            action: 'source.promoted',
            entityType: 'source',
            entityId: source.id,
            metadata: {
              syncJobId: job.id,
              termId: source.termId,
              oldSpreadsheetId: previous?.spreadsheetId ?? null,
              newSpreadsheetId: source.spreadsheetId,
            },
          },
        });
      }, SHEET_CHANGE_TX);
    } catch (err) {
      if (!(err instanceof SheetChangeRejected)) {
        logger.error('Sheet change failed', {
          syncJobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        issues.push({
          severity: 'ERROR',
          scope: 'FILE',
          code: 'APPLY_FAILED',
          message: 'Saving the new sheet failed and was rolled back.',
        });
      }
      return finish('FAILED', { ...refused, issues });
    }
    return finish('SUCCEEDED', { counts, issues });
  }

  let studentIdByCode: Map<string, string>;
  try {
    const roster = await applyRoster(
      prisma,
      {
        syncJobId: job.id,
        sourceId: source.id,
        generationId: generation.id,
        rosterTab: workbook.rosterTab ?? source.rosterTab,
      },
      workbook.roster,
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

  let applied = 0;
  for (const [index, course] of workbook.courses.entries()) {
    try {
      const result = await applyCourse(
        prisma,
        {
          syncJobId: job.id,
          sourceId: source.id,
          generationId: generation.id,
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
          'Saving this subject failed and was rolled back. Other subjects were not affected; retry the sync.',
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
    // The scores a pending sheet was previewed against may have changed: it must be previewed again.
    prisma.sheetPreview.updateMany({
      where: { source: { termId: source.termId, status: 'PENDING' }, invalidatedAt: null },
      data: { invalidatedAt: now() },
    }),
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
      ? { failureCode: 'APPLY_FAILED', failureMessage: 'No subject could be saved.' }
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
