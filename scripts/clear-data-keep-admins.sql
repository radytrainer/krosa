-- Clears all application data from a LOCAL database. Keeps admin accounts and the migration history.
-- Stop `pnpm dev` first. This cannot be undone without a backup.
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  tables text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'No active admin account: nothing was cleared';
  END IF;

  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tables
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('users', '_prisma_migrations');

  -- No CASCADE: a table that still points at a cleared one must fail, not be emptied silently.
  -- TRUNCATE does not fire the row triggers that make audit_logs and score history append-only.
  EXECUTE 'TRUNCATE TABLE ' || tables;
END $$;

DELETE FROM users WHERE role <> 'ADMIN';

UPDATE users SET failed_login_count = 0, locked_until = NULL;

COMMIT;

SELECT role, status, count(*) FROM users GROUP BY role, status;
