/**
 * Contract between the API (producer) and the worker (consumer) for synchronization jobs.
 * The authoritative job state lives in PostgreSQL (`sync_jobs`); the queue only carries the id.
 */
export const SYNC_QUEUE = 'sync';
export const SYNC_SOURCE_JOB = 'sync.source';
/** BullMQ key prefix, so queue keys are namespaced like the rest of the app's Redis keys. */
export const QUEUE_PREFIX = 'ssrs:v1:bull';

export interface SyncSourceJobData {
  syncJobId: string;
}

/** Attempts for transient failures (Google quota/outage). Other failures are final. */
export const SYNC_JOB_ATTEMPTS = 3;
export const SYNC_JOB_BACKOFF_MS = 30_000;

export const SYNC_TERMINAL_STATUSES = [
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
] as const;

/**
 * Queue options for a sync job (shape of BullMQ JobsOptions, kept dependency-free). The queue
 * job id equals the database id, so a job can never be queued twice while it is pending.
 */
export function syncJobQueueOptions(syncJobId: string) {
  return {
    jobId: syncJobId,
    attempts: SYNC_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: SYNC_JOB_BACKOFF_MS },
    removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
    removeOnFail: { age: 30 * 24 * 3600 },
  };
}
