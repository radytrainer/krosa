import type { PrismaClient } from '@ssrs/database';
import type { IssueScope, IssueSeverity, SheetsReader } from '@ssrs/sheets';

/** Counts persisted in `sync_jobs.counts` (docs/requirements.md SYNC-03). */
export interface SyncCounts {
  students: { created: number; updated: number; unchanged: number; rejected: number };
  offerings: {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    failed: number;
  };
  criteria: { created: number; updated: number; unchanged: number };
  schemes: { published: number; drafted: number; unchanged: number; skipped: number };
  enrollments: { created: number; unchanged: number; missingInSource: number };
  scores: {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    clearedInSource: number;
  };
}

export function emptyCounts(): SyncCounts {
  return {
    students: { created: 0, updated: 0, unchanged: 0, rejected: 0 },
    offerings: { created: 0, updated: 0, unchanged: 0, rejected: 0, failed: 0 },
    criteria: { created: 0, updated: 0, unchanged: 0 },
    schemes: { published: 0, drafted: 0, unchanged: 0, skipped: 0 },
    enrollments: { created: 0, unchanged: 0, missingInSource: 0 },
    scores: { created: 0, updated: 0, unchanged: 0, rejected: 0, clearedInSource: 0 },
  };
}

/** Adds every numeric leaf of `b` into `a` (used for parent-job aggregation). */
export function addCounts(a: SyncCounts, b: Partial<SyncCounts>): SyncCounts {
  for (const [group, values] of Object.entries(b) as [keyof SyncCounts, Record<string, number>][]) {
    const target = a[group] as Record<string, number> | undefined;
    if (!target || !values) continue;
    for (const [key, n] of Object.entries(values)) {
      if (typeof n === 'number' && key in target) target[key] = (target[key] ?? 0) + n;
    }
  }
  return a;
}

/** Problems found while applying (in addition to template issues from the parser). */
export type ApplyIssueCode =
  | 'STUDENT_IN_OTHER_GENERATION'
  | 'STUDENT_ID_CONFLICT'
  | 'OFFERING_NOT_FOUND'
  | 'APPLY_FAILED'
  | 'MARK_CLEARED_IN_SOURCE'
  | 'ENROLLMENT_MISSING_IN_SOURCE'
  | 'CRITERION_REMOVED_IN_SOURCE';

export interface SyncIssue {
  severity: IssueSeverity;
  scope: IssueScope;
  code: string;
  message: string;
  sheetTab?: string;
  rowNumber?: number;
  columnKey?: string;
  studentCode?: string;
  courseKey?: string;
  criterionKey?: string;
  rawValue?: string;
}

export interface SyncLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export const silentLogger: SyncLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface SyncDeps {
  prisma: PrismaClient;
  reader: SheetsReader;
  logger?: SyncLogger;
  now?: () => Date;
  /** Test seam: runs inside each course transaction just before commit. Throwing rolls it back. */
  hooks?: { beforeCourseCommit?: (courseKey: string) => void | Promise<void> };
}

export interface RunOptions {
  /** 1-based attempt number from the queue. */
  attempt: number;
  maxAttempts: number;
}

export type RunOutcome =
  | { kind: 'finished'; status: 'SUCCEEDED' | 'SUCCEEDED_WITH_ERRORS' | 'FAILED' | 'CANCELLED' }
  /** Transient failure before any write: the caller should let the queue retry. */
  | { kind: 'retry'; code: string; message: string }
  /** Another delivery of this job is running right now; nothing was done. */
  | { kind: 'busy' };
