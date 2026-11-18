-- One session per user and the inactivity logout (docs/decisions.md SR1-SR5, 2026-11-17).
ALTER TYPE "SessionRevokeReason" ADD VALUE IF NOT EXISTS 'SIGNED_IN_ELSEWHERE';
ALTER TYPE "SessionRevokeReason" ADD VALUE IF NOT EXISTS 'IDLE_TIMEOUT';

-- Last activity: login and POST /auth/heartbeat only. Existing sessions start from last_used_at,
-- so a session unused for longer than the idle limit ends at the first request after deploy.
ALTER TABLE "auth_sessions" ADD COLUMN "last_activity_at" TIMESTAMPTZ(3);
UPDATE "auth_sessions" SET "last_activity_at" = "last_used_at";
ALTER TABLE "auth_sessions" ALTER COLUMN "last_activity_at" SET DEFAULT CURRENT_TIMESTAMP,
                            ALTER COLUMN "last_activity_at" SET NOT NULL;

-- Refresh tokens are revoked together with their session.
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_at" TIMESTAMPTZ(3);
UPDATE "refresh_tokens" t SET "revoked_at" = s."revoked_at"
  FROM "auth_sessions" s
 WHERE s."id" = t."session_id" AND s."revoked_at" IS NOT NULL;
