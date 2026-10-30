import type { Prisma, PrismaClient, SyncStatus } from '@ssrs/database';
import { addCounts, emptyCounts, type SyncCounts } from './types.js';

const TERMINAL: readonly SyncStatus[] = [
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
];

/**
 * Recomputes a GENERATION/ALL parent job from its per-source children (SYNC-06). The parent
 * row is locked so concurrently finishing children cannot both "finish" it.
 *  - all children SUCCEEDED → SUCCEEDED
 *  - all children FAILED → FAILED
 *  - any other mix → SUCCEEDED_WITH_ERRORS (an honest partial result)
 */
export async function refreshParentJob(
  prisma: PrismaClient,
  parentId: string,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: SyncStatus; started_at: Date | null }[]>`
      SELECT status, started_at FROM sync_jobs WHERE id = ${parentId}::uuid FOR UPDATE`;
    const parentStatus = locked[0]?.status;
    const startedAt = locked[0]?.started_at ?? now;
    if (!parentStatus || TERMINAL.includes(parentStatus)) return;

    const children = await tx.syncJob.findMany({
      where: { parentId },
      select: { status: true, counts: true, errorCount: true, warningCount: true },
    });
    const finished = children.filter((c) => TERMINAL.includes(c.status));
    if (finished.length < children.length) {
      await tx.syncJob.update({
        where: { id: parentId },
        data: {
          status: 'RUNNING',
          startedAt,
          progressCurrent: finished.length,
          progressTotal: children.length,
        },
      });
      return;
    }

    // Rows stored on the parent itself (a skipped busy workbook) belong in its totals too.
    const ownErrors = await tx.syncError.count({ where: { jobId: parentId, severity: 'ERROR' } });
    const ownWarnings = await tx.syncError.count({
      where: { jobId: parentId, severity: 'WARNING' },
    });
    const counts = emptyCounts();
    for (const child of children) addCounts(counts, child.counts as unknown as Partial<SyncCounts>);
    const allSucceeded = children.every((c) => c.status === 'SUCCEEDED');
    const allFailed = children.every((c) => c.status === 'FAILED' || c.status === 'CANCELLED');
    await tx.syncJob.update({
      where: { id: parentId },
      data: {
        status: allSucceeded ? 'SUCCEEDED' : allFailed ? 'FAILED' : 'SUCCEEDED_WITH_ERRORS',
        phase: 'DONE',
        startedAt,
        finishedAt: now,
        progressCurrent: children.length,
        progressTotal: children.length,
        counts: counts as unknown as Prisma.InputJsonValue,
        errorCount: children.reduce((n, c) => n + c.errorCount, ownErrors),
        warningCount: children.reduce((n, c) => n + c.warningCount, ownWarnings),
        ...(allFailed
          ? {
              failureCode: 'ALL_SOURCES_FAILED',
              failureMessage: 'Every spreadsheet in this sync failed.',
            }
          : {}),
      },
    });
  });
}
