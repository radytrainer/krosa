-- Lets an "all generations" sync target one term number, e.g. Term 1 of every active generation.
-- Nullable and additive: existing jobs keep NULL, which means "all terms".
ALTER TABLE "sync_jobs" ADD COLUMN "term_number" SMALLINT;

ALTER TABLE "sync_jobs"
  ADD CONSTRAINT "sync_jobs_term_number_check"
    CHECK (term_number IS NULL OR (scope = 'ALL' AND term_number >= 1));
