-- "Release scores after sync" (docs/decisions.md R4): a successful run of a job with this flag
-- releases its term, audited as source.released with the job id.
ALTER TABLE "sync_jobs" ADD COLUMN "release_after_sync" BOOLEAN NOT NULL DEFAULT false;
