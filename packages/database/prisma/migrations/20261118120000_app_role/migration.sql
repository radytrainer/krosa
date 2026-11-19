-- Restricted application role (docs/database-design.md "Roles", docs/security.md §13).
--
-- Runs as the database owner (the role that runs migrations). Creates `<database>_app`, the role
-- the api and worker connect as: data access only (SELECT/INSERT/UPDATE/DELETE), no DDL, no
-- TRUNCATE, no superuser or BYPASSRLS, and it owns nothing, so it cannot ALTER, DROP or DISABLE
-- the triggers of any table. audit_logs: SELECT and INSERT only.
--
-- The role gets no password and cannot log in here: the password is a secret. The
-- `@ssrs/database` app-role command (dist/cli/app-role.js) sets LOGIN and the password, sending
-- only a SCRAM verifier, and re-applies the grants (needed after a restore: backups are taken
-- with --no-privileges).

-- Needs CREATEROLE (the Docker image's POSTGRES_USER is a superuser; on a managed PostgreSQL such
-- as RDS, run migrations as a role with CREATEROLE).
--
-- `prisma migrate dev` replays every migration in a throwaway shadow database
-- (prisma_migrate_shadow_db_<uuid>), whose name is too long for a role name (63 characters):
-- there the role steps are skipped.

-- 1. The role (cluster-wide; named after the database so ssrs_test never shares ssrs's role).
DO $$
DECLARE
  app_role text := current_database() || '_app';
BEGIN
  IF current_database() LIKE 'prisma_migrate_shadow_db_%' THEN
    RETURN;
  END IF;
  IF length(app_role) > 63 THEN
    RAISE EXCEPTION 'database name % is too long for its application role name (63 characters)',
      current_database();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    -- Below max_connections (30 on the beta), so the owner always has connections left.
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS '
      'NOINHERIT CONNECTION LIMIT 20', app_role);
  END IF;
END
$$;

-- 2. Grants, in one function so they can be re-applied (after a restore, or a new table). Run by
-- the owner; the app role cannot run it (EXECUTE revoked below), and could not grant anyway.
CREATE OR REPLACE FUNCTION ssrs_grant_app_role() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  app_role text := current_database() || '_app';
BEGIN
  IF current_database() LIKE 'prisma_migrate_shadow_db_%' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    RAISE EXCEPTION 'role % does not exist; run the migrations first', app_role;
  END IF;

  -- Backups are taken with --no-privileges, so a restored copy loses this revoke: re-issue it.
  REVOKE EXECUTE ON FUNCTION ssrs_grant_app_role() FROM PUBLIC;

  -- Only named roles may connect; nobody gets TEMPORARY (no temporary tables or functions).
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', current_database(), app_role);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), app_role);

  -- Use the schema, never create in it.
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', app_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);

  -- Data access on every table; nothing on Prisma's migration history; the audit log is
  -- append-only (no UPDATE or DELETE privilege, on top of its trigger).
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('REVOKE ALL ON TABLE "_prisma_migrations" FROM %I', app_role);
  EXECUTE format('REVOKE UPDATE, DELETE ON TABLE "audit_logs" FROM %I', app_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);

  -- Tables and sequences created by later migrations (as the same owner) get the same access.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    app_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);
END;
$$;
REVOKE EXECUTE ON FUNCTION ssrs_grant_app_role() FROM PUBLIC;

SELECT ssrs_grant_app_role();

-- 3. The retention purge flag (ssrs.allow_append_only_purge) can be set by any session, so it
-- now only lets the table's OWNER delete append-only rows. The application role can no longer
-- use it; the scoped replacement bypass (ssrs_replacing_term) is unchanged.
CREATE OR REPLACE FUNCTION ssrs_purge_allowed(p_table oid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('ssrs.allow_append_only_purge', true), '') = 'on'
     AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = p_table), 'MEMBER')
$$;

CREATE OR REPLACE FUNCTION ssrs_guard_score_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND ssrs_purge_allowed(TG_RELID) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND ssrs_replacing_term(
       (SELECT o.term_id FROM "assessment_scores" s
          JOIN "course_offerings" o ON o.id = s.offering_id
         WHERE s.id = OLD.score_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION ssrs_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND ssrs_purge_allowed(TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
