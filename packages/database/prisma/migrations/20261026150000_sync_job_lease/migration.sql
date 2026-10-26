-- Run lease for sync jobs (see packages/sync/src/engine.ts, runSourceSync).
ALTER TABLE "sync_jobs" ADD COLUMN "lease_token" UUID,
ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3);
