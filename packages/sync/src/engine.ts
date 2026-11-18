import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Prisma, PrismaClient, SyncStatus } from '@ssrs/database';
import {
  isMetaIssueCode,
  readTermWorkbook,
  SheetsAccessError,
  type ParsedCourse,
  type TemplateIssue,
  type TermWorkbookRead,
} from '@ssrs/sheets';
import { applyCourse, type CourseTerm } from './apply-course.js';
import { applyRoster, lockRoster } from './apply-roster.js';
import {
  activePreviewGate,
  audienceByCourseKey,
  confirmedRemovals,
  confirmedSummary,
  confirmedTabs,
  type ConfirmedSummary,
  mappingVersions,
  previewGate,
  TAB_MAPPINGS_INCLUDE,
} from './confirmed.js';
import { refreshParentJob } from './parent.js';
import { setTermVisibility } from './release.js';
import { linkCriteria, prepareSubjects } from './promote.js';
import { archiveSubjects, compareSheet, sameRemovals, type RemovedSubject } from './removals.js';
import {
  applyReplacement,
  computeReplacement,
  deleteUnfedSubjects,
  replacedSource,
  type ReplacementSet,
} from './replacement.js';
import {
  isBlockingError,
  rosterCheck,
  rosterCheckKey,
  screenKey,
  screenRoster,
  withoutStudents,
} from './roster-check.js';
import {
  applyStudentTerms,
  countPlan,
  existingTerms,
  guessAudience,
  guessedAudienceIssue,
  loadTermConfig,
  planStudentTerms,
  tabAudience,
  type Audience,
} from './student-terms.js';
import {
  addCounts,
  emptyCounts,
  silentLogger,
  type RunOptions,
  type RunOutcome,
  type SyncCounts,
  type SyncDeps,
  type SyncIssue,
  type SyncLogger,
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
const LEASE_RELEASE_WAITS_MS = [0, 1_000, 3_000];
const MAX_STORED_ISSUES = 20_000;
/** A sheet change saves everything in one transaction, so it gets room for a whole workbook. */
const SHEET_CHANGE_TX = { maxWait: 30_000, timeout: 300_000 } as const;

/** Rolls back a sheet change: students keep the old scores and the sheet stays pending. */
class SheetChangeRejected extends Error {}
/** Rolls back a replacement whose deletion set is not the one the admin confirmed. */
class ReplacementChanged extends Error {}
/** Rolls back a sync whose roster check or student skips are not the ones the admin confirmed. */
class RosterChanged extends Error {}

const ROSTER_CHANGED = {
  failureCode: 'ROSTER_CHANGED',
  failureMessage:
    'The students missing from, new in or skipped by this sheet changed since the preview. Nothing was imported. Run a new preview.',
} as const;

const REPLACEMENT_CHANGED = {
  failureCode: 'REPLACEMENT_CHANGED',
  failureMessage:
    'The data to delete changed since the preview. Nothing was deleted or imported. Run a new preview.',
} as const;

/** A job's counts for its audit entry: ids of created students become a count. */
function auditCounts(counts: SyncCounts): Record<string, unknown> {
  const { newStudents, ...rest } = counts;
  return newStudents ? { ...rest, newStudents: { count: newStudents.ids.length } } : rest;
}

/** Every student ID in the roster tab, duplicates included. */
function rosterCodes(workbook: Pick<TermWorkbookRead, 'roster' | 'rosterDuplicates'>): Set<string> {
  return new Set([
    ...workbook.roster.map((s) => s.studentCode),
    ...workbook.rosterDuplicates.flat().map((s) => s.studentCode),
  ]);
}

/** A subject-tab row or cell issue of a skipped student: not reported again. */
function skippedRowIssue(
  issue: SyncIssue,
  skipped: ReadonlySet<string>,
  rosterTab: string | null,
): boolean {
  return (
    !!issue.studentCode &&
    skipped.has(issue.studentCode) &&
    issue.sheetTab !== rosterTab &&
    (issue.scope === 'ROW' || issue.scope === 'CELL')
  );
}

/**
 * Who a sync imports (decisions.md RP5–RP7). Students skipped by a name, generation or login
 * conflict are left out with one error each. Terms 2–5: a job with a preview must find the roster
 * check the admin confirmed (ROSTER_CHANGED otherwise); a job without one creates nobody new and
 * reports each new student once (ROSTER_APPROVAL_REQUIRED).
 */
async function screenStudents(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    source: { termId: string; rosterTab: string; term: { number: number } };
    generationId: string;
    workbook: TermWorkbookRead;
    replacement: ReplacementSet | null;
    /** The confirmed preview summary; undefined for a job without a preview. */
    preview: ConfirmedSummary | null | undefined;
  },
): Promise<
  | { workbook: TermWorkbookRead; skipped: Set<string>; issues: SyncIssue[]; rejected: number }
  | { failure: { failureCode: string; failureMessage: string } }
> {
  const { workbook, replacement } = input;
  const rosterTab = workbook.rosterTab ?? input.source.rosterTab;
  const deleted = new Set(replacement?.accounts.map((a) => a.studentId) ?? []);
  const screen = await screenRoster(
    prisma,
    { generationId: input.generationId, rosterTab, excludeStudentIds: deleted },
    workbook.roster,
  );
  const check = await rosterCheck(
    prisma,
    {
      generationId: input.generationId,
      termId: input.source.termId,
      termNumber: input.source.term.number,
      allCodes: rosterCodes(workbook),
      replacement: replacement !== null,
      deletedStudentIds: deleted,
    },
    screen.roster,
  );
  const issues = [...screen.issues];
  const skipped = new Set(screen.skipped);
  let roster = screen.roster;
  if (input.preview !== undefined) {
    if (
      rosterCheckKey(check) !== rosterCheckKey(input.preview?.rosterCheck) ||
      screenKey(screen) !== screenKey(input.preview)
    ) {
      return { failure: ROSTER_CHANGED };
    }
  } else if (check && check.new.length > 0) {
    const fresh = new Set(check.new.map((n) => n.studentCode));
    for (const s of roster) {
      if (!fresh.has(s.studentCode)) continue;
      skipped.add(s.studentCode);
      issues.push({
        severity: 'WARNING',
        scope: 'ROW',
        code: 'ROSTER_APPROVAL_REQUIRED',
        message: `${s.studentCode} is in no earlier term of this generation. Run a preview of this sheet and confirm its roster check to add this student.`,
        sheetTab: rosterTab,
        rowNumber: s.rowNumber,
        studentCode: s.studentCode,
      });
    }
    roster = roster.filter((s) => !fresh.has(s.studentCode));
  }
  return {
    workbook: withoutStudents(workbook, roster, skipped),
    skipped,
    issues,
    rejected: screen.skipped.size,
  };
}

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
 *  - FAILED: no subject was applied (access/config problem, file-level template error, roster
 *    failure, every course failed). A job failed from outside the run may have saved some: see
 *    `failJob`.
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
      select: { status: true, leaseExpiresAt: true },
    });
    if (!job) throw new Error(`Sync job ${syncJobId} not found`);
    if (TERMINAL.includes(job.status)) {
      return { kind: 'finished', status: job.status as 'SUCCEEDED' };
    }
    return { kind: 'busy', retryAt: job.leaseExpiresAt ?? leaseUntil() };
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
    await releaseLease(deps, syncJobId, token);
  }
}

/**
 * Never throws: a failed release must not hide the run's real error, and the lease expires by
 * itself. Retried because the database failure that ended a run is often over within seconds.
 */
async function releaseLease(deps: SyncDeps, syncJobId: string, token: string): Promise<void> {
  for (const waitMs of LEASE_RELEASE_WAITS_MS) {
    await sleep(waitMs);
    try {
      await deps.prisma.syncJob.updateMany({
        where: { id: syncJobId, leaseToken: token },
        data: { leaseToken: null, leaseExpiresAt: null },
      });
      return;
    } catch (err) {
      (deps.logger ?? silentLogger).warn('Could not release the run lease', {
        syncJobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * "Release scores after sync" (decisions.md R4): releases the job's term once its data is in,
 * audited for the admin who asked, with the source and job. False when it could not be done.
 */
async function releaseAfterSync(
  prisma: PrismaClient,
  job: { id: string; sourceId: string | null; requestedById: string },
  termId: string,
  logger: SyncLogger,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const change = await setTermVisibility(tx, termId, true);
      if (!change) return;
      const term = await tx.term.findUniqueOrThrow({
        where: { id: termId },
        select: { number: true },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'USER',
          actorUserId: job.requestedById,
          action: 'source.released',
          entityType: 'source',
          entityId: job.sourceId,
          metadata: {
            sourceId: job.sourceId,
            termId,
            termNumber: term.number,
            oldState: change.oldState,
            newState: change.newState,
            subjects: change.subjects,
            students: change.students,
            syncJobId: job.id,
          },
        },
      });
    });
    return true;
  } catch (err) {
    logger.error('Release after sync failed', {
      syncJobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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
      revokedSessionIds?: string[];
    } = {},
  ): Promise<RunOutcome> => {
    const issues = [...(extra.issues ?? [])];
    if (status !== 'FAILED' && job.releaseAfterSync && job.source) {
      const released = await releaseAfterSync(prisma, job, job.source.termId, logger);
      if (!released) {
        issues.push({
          severity: 'WARNING',
          scope: 'FILE',
          code: 'RELEASE_FAILED',
          message:
            'The scores were imported but could not be released. Release them from the list.',
        });
      }
    }
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
          // The job row keeps the new students' ids; the audit entry only their number.
          counts: (extra.counts
            ? auditCounts(extra.counts)
            : null) as unknown as Prisma.InputJsonValue,
        },
      },
    });
    if (job.parentId) await refreshParentJob(prisma, job.parentId, finishedAt);
    logger.info('Sync job finished', { syncJobId: job.id, status, failureCode: extra.failureCode });
    return extra.revokedSessionIds?.length
      ? { kind: 'finished', status, revokedSessionIds: extra.revokedSessionIds }
      : { kind: 'finished', status };
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
  let issues: SyncIssue[] = [...workbook.issues];
  countParseRejections(workbook.issues, workbook.rosterTab, counts);
  if (workbook.fatal) {
    // A workbook of another generation or term (or without `_meta`) says so in the failure itself.
    const meta = workbook.issues.find(
      (i) => i.severity === 'ERROR' && i.scope === 'FILE' && isMetaIssueCode(i.code),
    );
    return finish('FAILED', {
      failureCode: meta?.code ?? 'TEMPLATE_INVALID',
      failureMessage:
        meta?.message ?? 'The spreadsheet has file-level errors; nothing was imported.',
      counts,
      issues,
    });
  }
  // Only a usable workbook renames the source: a wrong one (another term, say) never does.
  if (workbook.spreadsheetTitle && workbook.spreadsheetTitle !== source.spreadsheetTitle) {
    await prisma.googleSheetSource.update({
      where: { id: source.id },
      data: { spreadsheetTitle: workbook.spreadsheetTitle },
    });
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { phase: 'APPLY', progressCurrent: 0, progressTotal: workbook.courses.length + 1 },
  });

  const pending = source.status === 'PENDING';
  const withPreview = pending || job.previewId !== null;
  let removed: RemovedSubject[] = [];
  // A pending sheet of another spreadsheet replaces the term's data (decisions.md RP1).
  const old = pending ? await replacedSource(prisma, source) : null;
  if (withPreview) {
    const gate =
      job.previewId && !pending
        ? await activePreviewGate(prisma, source.id, job.previewId)
        : await previewGate(prisma, source.id, workbook.fingerprint);
    if (gate) {
      return finish('FAILED', { failureCode: gate.code, failureMessage: gate.message, issues });
    }
    // Exactly what the admin confirmed, or nothing: checked before anything is written.
    const comparison = await compareSheet(prisma, source.termId, confirmed, workbook);
    const expected = await confirmedRemovals(prisma, source.id, job.previewId);
    if (!old && !sameRemovals(comparison.removed, expected)) {
      return finish('FAILED', {
        failureCode: 'REMOVALS_CHANGED',
        failureMessage:
          'The subjects this sync would remove changed since the preview. Nothing was imported or removed. Run a new preview.',
        issues,
      });
    }
    removed = comparison.removed;
    const removedTabs = new Set(removed.flatMap((r) => r.tabName ?? []));
    const remaining = issues.filter(
      (i) => !(i.code === 'WORKSHEET_NOT_FOUND' && removedTabs.has(i.sheetTab ?? '')),
    );
    counts.offerings.rejected -= issues.length - remaining.length;
    issues = remaining;
  }
  const summary = withPreview ? await confirmedSummary(prisma, source.id, job.previewId) : null;
  const replacement = old
    ? await computeReplacement(prisma, { source, old, confirmed, workbook })
    : null;
  if (
    withPreview &&
    (replacement?.manifestHash ?? null) !== (summary?.replacement?.manifestHash ?? null)
  ) {
    return finish('FAILED', { ...REPLACEMENT_CHANGED, issues });
  }

  // Who is imported: per-student skips (name, generation, login name) and the roster check.
  const screenInput = {
    source,
    generationId: generation.id,
    workbook,
    replacement,
    preview: withPreview ? summary : undefined,
  };
  const screened = await screenStudents(prisma, screenInput);
  if ('failure' in screened) return finish('FAILED', { ...screened.failure, issues });
  /** With a preview: checked again under the roster lock, so nothing changes after the check. */
  const verifyRoster = withPreview
    ? async (tx: Prisma.TransactionClient) => {
        if ('failure' in (await screenStudents(tx, screenInput))) throw new RosterChanged();
      }
    : undefined;
  const rawRoster = workbook.roster;
  issues = issues.filter((i) => !skippedRowIssue(i, screened.skipped, workbook.rosterTab));
  issues.push(...screened.issues);
  counts.students.rejected += screened.rejected;
  workbook = screened.workbook;

  if (pending || removed.length > 0) {
    const refused = pending
      ? {
          failureCode: 'SHEET_CHANGE_REJECTED',
          failureMessage:
            'The new sheet has errors, so nothing was imported. The current sheet stays active.',
        }
      : {
          failureCode: 'REMOVAL_REJECTED',
          failureMessage:
            'A sync that removes subjects needs zero errors, so nothing was imported or removed.',
        };
    if (issues.some(isBlockingError)) return finish('FAILED', { ...refused, issues });
    const archive = replacement ? [] : removed;
    const read = workbook;
    let revokedSessionIds: string[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        await lockRoster(tx);
        await verifyRoster?.(tx);
        if (replacement && old) {
          // Recomputed under the roster lock: anything else to delete stops the whole sync.
          const again = await computeReplacement(tx, {
            source,
            old,
            confirmed,
            workbook: { ...read, roster: rawRoster },
          });
          if (again.manifestHash !== replacement.manifestHash) throw new ReplacementChanged();
          const applied = await applyReplacement(tx, again, {
            sourceId: source.id,
            now: now(),
          });
          revokedSessionIds = applied.revokedSessionIds;
          counts.replacement = again.counts;
        }
        const courses = await prepareSubjects(tx, source, read.courses);
        if (replacement && counts.replacement) {
          await deleteUnfedSubjects(tx, replacement);
        }
        const roster = await applyRoster(
          prisma,
          {
            syncJobId: job.id,
            sourceId: source.id,
            generationId: generation.id,
            rosterTab: read.rosterTab ?? source.rosterTab,
          },
          read.roster,
          now(),
          tx,
        );
        issues.push(...roster.issues);
        addCounts(counts, { students: roster.counts });
        counts.newStudents = { ids: roster.createdIds };
        const termOf = await applyTerm(tx, {
          source,
          workbook: read,
          syncJobId: job.id,
          studentIdByCode: roster.studentIdByCode,
          now: now(),
          counts,
          issues,
        });
        for (const course of courses) {
          const result = await applyCourse(
            prisma,
            {
              syncJobId: job.id,
              sourceId: source.id,
              generationId: generation.id,
              requestedById: job.requestedById,
              studentIdByCode: roster.studentIdByCode,
              now: now(),
              hooks: deps.hooks,
              term: termOf(course),
            },
            course,
            tx,
          );
          issues.push(...result.issues);
          addCounts(counts, result.counts);
        }
        if (issues.some(isBlockingError)) {
          throw new SheetChangeRejected(refused.failureMessage);
        }
        await linkCriteria(tx, source.id);
        if (archive.length > 0) {
          await archiveSubjects(
            tx,
            {
              sourceId: source.id,
              syncJobId: job.id,
              requestedById: job.requestedById,
              termId: source.termId,
            },
            archive,
            now(),
          );
        }
        const previous = pending
          ? await tx.googleSheetSource.findFirst({
              where: { termId: source.termId, status: 'ACTIVE' },
              select: { id: true, spreadsheetId: true },
            })
          : null;
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
          where: { source: { termId: source.termId }, invalidatedAt: null },
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
        if (pending) {
          // No names, marks or student IDs: counts only.
          await tx.auditLog.create({
            data: {
              actorType: 'USER',
              actorUserId: job.requestedById,
              action: 'source.promoted',
              entityType: 'source',
              entityId: source.id,
              metadata: {
                syncJobId: job.id,
                termId: source.termId,
                oldSourceId: replacement?.oldSourceId ?? previous?.id ?? null,
                newSourceId: source.id,
                oldSpreadsheetId: replacement?.oldSpreadsheetId ?? previous?.spreadsheetId ?? null,
                newSpreadsheetId: source.spreadsheetId,
                deleted: counts.replacement ?? null,
                revokedSessions: revokedSessionIds.length,
              },
            },
          });
        }
      }, SHEET_CHANGE_TX);
    } catch (err) {
      delete counts.replacement;
      if (err instanceof ReplacementChanged) {
        return finish('FAILED', { ...REPLACEMENT_CHANGED, issues });
      }
      if (err instanceof RosterChanged) return finish('FAILED', { ...ROSTER_CHANGED, issues });
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
    for (const r of archive) {
      issues.push({
        severity: 'WARNING',
        scope: 'COURSE',
        code: 'SUBJECT_ARCHIVED',
        message: `${r.subject} is no longer in the sheet and was archived. Its ${r.scores} scores are kept.`,
        ...(r.tabName ? { sheetTab: r.tabName } : {}),
      });
    }
    const status = issues.some((i) => i.severity === 'ERROR')
      ? 'SUCCEEDED_WITH_ERRORS'
      : 'SUCCEEDED';
    return finish(status, { counts, issues, revokedSessionIds });
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
      undefined,
      verifyRoster,
    );
    studentIdByCode = roster.studentIdByCode;
    counts.newStudents = { ids: roster.createdIds };
    issues.push(...roster.issues);
    counts.students.created += roster.counts.created;
    counts.students.updated += roster.counts.updated;
    counts.students.unchanged += roster.counts.unchanged;
    counts.students.rejected += roster.counts.rejected;
  } catch (err) {
    if (err instanceof RosterChanged) return finish('FAILED', { ...ROSTER_CHANGED, issues });
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
  let termOf: (course: ParsedCourse) => CourseTerm;
  try {
    termOf = await prisma.$transaction(
      (tx) =>
        applyTerm(tx, {
          source,
          workbook,
          syncJobId: job.id,
          studentIdByCode,
          now: now(),
          counts,
          issues,
        }),
      { maxWait: 30_000, timeout: 120_000 },
    );
  } catch (err) {
    logger.error('Term enrollments failed', {
      syncJobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return finish('FAILED', {
      failureCode: 'APPLY_FAILED',
      failureMessage: 'Saving the term enrollments failed; no subject was imported.',
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
          requestedById: job.requestedById,
          studentIdByCode,
          now: now(),
          hooks: deps.hooks,
          term: termOf(course),
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
    // The scores a preview of this term was run against may have changed: it must be run again.
    prisma.sheetPreview.updateMany({
      where: { source: { termId: source.termId }, invalidatedAt: null },
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

/**
 * Decides and saves the term enrollments of the roster (student-terms.ts), then tells each subject
 * tab who may be imported and who takes it.
 */
async function applyTerm(
  tx: Prisma.TransactionClient,
  input: {
    source: {
      id: string;
      termId: string;
      generationId: string;
      rosterTab: string;
      tabMappings: Parameters<typeof audienceByCourseKey>[0];
    };
    workbook: TermWorkbookRead;
    syncJobId: string;
    studentIdByCode: Map<string, string>;
    now: Date;
    counts: SyncCounts;
    issues: SyncIssue[];
  },
): Promise<(course: ParsedCourse) => CourseTerm> {
  const { source, workbook } = input;
  const config = await loadTermConfig(tx, source.termId);
  const existing = await existingTerms(tx, source.termId);
  const plan = planStudentTerms(
    config,
    workbook.roster,
    existing,
    workbook.rosterDuplicates,
    workbook.rosterTab ?? source.rosterTab,
  );
  await applyStudentTerms(
    tx,
    {
      syncJobId: input.syncJobId,
      sourceId: source.id,
      generationId: source.generationId,
      now: input.now,
    },
    config,
    plan,
    input.studentIdByCode,
    existing,
  );
  input.issues.push(...plan.issues);
  addCounts(input.counts, { termEnrollments: countPlan(plan) });
  // A tab nobody gave an audience gets one guessed from who it lists, saved once and reported.
  const audiences = audienceByCourseKey(source.tabMappings);
  const roster = new Map(workbook.roster.map((s) => [s.studentCode, s]));
  const audienceOf = new Map<string, Audience | null>();
  for (const course of workbook.courses) {
    const key = course.courseKey.toUpperCase();
    const tab = audiences.get(key);
    let audience = tab ? tabAudience(config, tab) : null;
    if (!audience && tab) {
      audience = guessAudience(config, course, roster);
      if (audience) {
        await tx.sheetTabMapping.update({
          where: { id: tab.id },
          data:
            audience.kind === 'PROGRAM'
              ? { audience: 'PROGRAM', audienceProgramId: audience.programId }
              : { audience: 'SHARED', audienceProgramId: null },
        });
        input.issues.push(guessedAudienceIssue(config, course, audience));
      }
    }
    audienceOf.set(key, audience);
  }
  return (course) => ({
    config,
    decisions: plan.decisions,
    audience: audienceOf.get(course.courseKey.toUpperCase()) ?? null,
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
    select: { status: true, parentId: true, progressCurrent: true },
  });
  if (!job || TERMINAL.includes(job.status)) return;
  // Step 1 is the roster; each later step is a subject that committed on its own.
  const saved = job.progressCurrent > 1 ? ' Some subjects were already saved. Retry is safe.' : '';
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: {
      status: 'FAILED',
      phase: 'DONE',
      finishedAt: now,
      failureCode,
      failureMessage: `${failureMessage}${saved}`,
    },
  });
  if (job.parentId) await refreshParentJob(prisma, job.parentId, now);
}
