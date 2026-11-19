-- Sheet replacement and roster checks (docs/decisions.md, "Sheet replacement and roster checks
-- (2026-11-14)"). A pending sheet that replaces a different spreadsheet replaces the term's data
-- for good, inside one transaction that sets two transaction-local flags:
--   SELECT set_config('ssrs.allow_term_replacement', 'on', true);
--   SELECT set_config('ssrs.replacement_term_id', '<term id>', true);
-- Only rows of that one term may then be deleted from the otherwise protected tables.

-- 1. Audit entries outlive the accounts they name: no foreign key, the id stays.
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_user_id_fkey";

-- 2. Trigger functions ---------------------------------------------------------------------------
-- True only inside a replacement transaction of exactly this term.
CREATE FUNCTION ssrs_replacing_term(p_term_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_term_id IS NOT NULL
     AND COALESCE(current_setting('ssrs.allow_term_replacement', true), '') = 'on'
     AND COALESCE(current_setting('ssrs.replacement_term_id', true), '') = p_term_id::text
$$;

-- Non-draft schemes may be deleted only by a replacement of their offering's term.
CREATE OR REPLACE FUNCTION ssrs_guard_grading_scheme() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' AND NOT ssrs_replacing_term(
         (SELECT term_id FROM "course_offerings" WHERE id = OLD.offering_id)) THEN
      RAISE EXCEPTION 'grading scheme % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.offering_id <> OLD.offering_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'grading scheme offering and version are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED')
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'invalid grading scheme transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'DRAFT' AND NEW.total_weight <> OLD.total_weight THEN
    RAISE EXCEPTION 'total weight of a % scheme is immutable', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Items of PUBLISHED / ARCHIVED schemes are immutable; a replacement of their term may delete them.
CREATE OR REPLACE FUNCTION ssrs_guard_grading_scheme_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scheme_status "SchemeStatus";
BEGIN
  SELECT status INTO scheme_status FROM "grading_schemes"
    WHERE id = COALESCE(NEW.scheme_id, OLD.scheme_id);
  IF TG_OP = 'DELETE' AND ssrs_replacing_term(
       (SELECT term_id FROM "course_offerings" WHERE id = OLD.offering_id)) THEN
    RETURN OLD;
  END IF;
  -- During a cascaded delete of a draft the parent row may already be gone.
  IF scheme_status IS NOT NULL AND scheme_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'items of a % grading scheme are immutable', scheme_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.scheme_id <> OLD.scheme_id THEN
    RAISE EXCEPTION 'grading scheme items cannot move between schemes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Score history: append-only. A replacement of the score's term may delete it (before the score);
-- the retention purge flag keeps working as before.
CREATE FUNCTION ssrs_guard_score_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ssrs.allow_append_only_purge', true) = 'on' THEN
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

-- Audit log: its own function, which never looks at the replacement flags.
CREATE FUNCTION ssrs_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ssrs.allow_append_only_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER "audit_logs_append_only" ON "audit_logs";
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION ssrs_audit_log_append_only();

DROP TRIGGER "assessment_score_revisions_append_only" ON "assessment_score_revisions";
CREATE TRIGGER assessment_score_revisions_append_only
  BEFORE UPDATE OR DELETE ON "assessment_score_revisions"
  FOR EACH ROW EXECUTE FUNCTION ssrs_guard_score_revision();

DROP FUNCTION ssrs_append_only();

-- 3. Which source's sync created each account ----------------------------------------------------
ALTER TABLE "students" ADD COLUMN "provisioned_source_id" UUID;
ALTER TABLE "students" ADD CONSTRAINT "students_provisioned_source_id_fkey"
  FOREIGN KEY ("provisioned_source_id") REFERENCES "google_sheet_sources"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "students_provisioned_source_id_idx" ON "students"("provisioned_source_id");

-- Backfill from the provisioning audit entries. No entry, or a source that no longer exists:
-- stays NULL, so the account is never deleted by a replacement.
UPDATE "students" s
   SET "provisioned_source_id" = g.id
  FROM "audit_logs" a
  JOIN "google_sheet_sources" g ON g.id::text = a.metadata->>'sourceId'
 WHERE a.action = 'student.provisioned'
   AND a.entity_type = 'student'
   AND a.entity_id = s.id::text;

-- 4. Sessions revoked because the account was deleted.
ALTER TYPE "SessionRevokeReason" ADD VALUE 'ACCOUNT_DELETED';
