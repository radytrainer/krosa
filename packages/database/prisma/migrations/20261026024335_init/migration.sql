-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'STUDENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SessionRevokeReason" AS ENUM ('LOGOUT', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ACCOUNT_DISABLED', 'ADMIN');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ResultsVisibility" AS ENUM ('HIDDEN', 'VISIBLE');

-- CreateEnum
CREATE TYPE "OfferingStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ENROLLED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CriterionCategory" AS ENUM ('QUIZ', 'EXAM', 'HOMEWORK', 'ASSIGNMENT', 'PROJECT', 'PRESENTATION', 'PARTICIPATION', 'OTHER');

-- CreateEnum
CREATE TYPE "SchemeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SchemeOrigin" AS ENUM ('SHEET', 'ADMIN');

-- CreateEnum
CREATE TYPE "ScoreStatus" AS ENUM ('RECORDED', 'ABSENT');

-- CreateEnum
CREATE TYPE "SyncScope" AS ENUM ('SOURCE', 'GENERATION', 'ALL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'SUCCEEDED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncErrorSeverity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" CITEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "password_expires_at" TIMESTAMPTZ(3),
    "password_changed_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" "SessionRevokeReason",
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generations" (
    "id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "GenerationStatus" NOT NULL DEFAULT 'ACTIVE',
    "cache_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "number" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_offerings" (
    "id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "external_key" CITEXT NOT NULL,
    "title" TEXT NOT NULL,
    "credits" DECIMAL(4,1) NOT NULL DEFAULT 1,
    "visibility" "ResultsVisibility" NOT NULL DEFAULT 'HIDDEN',
    "visibility_overridden" BOOLEAN NOT NULL DEFAULT false,
    "source_id" UUID,
    "sheet_tab" TEXT,
    "status" "OfferingStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "course_offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_sheet_sources" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "spreadsheet_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "spreadsheet_title" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_synced_at" TIMESTAMPTZ(3),
    "last_sync_job_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "google_sheet_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "student_code" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'UNSPECIFIED',
    "class_name" TEXT,
    "source_id" UUID,
    "last_seen_sync_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "present_in_source" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_sync_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_criteria" (
    "id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "key" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "CriterionCategory" NOT NULL DEFAULT 'OTHER',
    "display_order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "sheet_column_key" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assessment_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_schemes" (
    "id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SchemeStatus" NOT NULL DEFAULT 'DRAFT',
    "origin" "SchemeOrigin" NOT NULL,
    "total_weight" DECIMAL(7,3) NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(3),
    "published_by" UUID,
    "created_by" UUID,
    "sync_job_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grading_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_scheme_items" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "criterion_id" UUID NOT NULL,
    "max_mark" DECIMAL(8,3) NOT NULL,
    "weight" DECIMAL(6,3) NOT NULL,

    CONSTRAINT "grading_scheme_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_scores" (
    "id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "criterion_id" UUID NOT NULL,
    "status" "ScoreStatus" NOT NULL,
    "mark" DECIMAL(8,3) NOT NULL,
    "source_id" UUID,
    "source_tab" TEXT,
    "source_row" INTEGER,
    "sync_job_id" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assessment_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_score_revisions" (
    "id" UUID NOT NULL,
    "score_id" UUID NOT NULL,
    "old_status" "ScoreStatus",
    "old_mark" DECIMAL(8,3),
    "new_status" "ScoreStatus" NOT NULL,
    "new_mark" DECIMAL(8,3) NOT NULL,
    "sync_job_id" UUID,
    "changed_by" UUID,
    "source_tab" TEXT,
    "source_row" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_score_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "parent_id" UUID,
    "scope" "SyncScope" NOT NULL,
    "source_id" UUID,
    "generation_id" UUID,
    "status" "SyncStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT,
    "progress_current" INTEGER NOT NULL DEFAULT 0,
    "progress_total" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "failure_code" TEXT,
    "failure_message" TEXT,
    "retry_of_id" UUID,
    "requested_by" UUID NOT NULL,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_errors" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "severity" "SyncErrorSeverity" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sheet_tab" TEXT,
    "row_number" INTEGER,
    "column_key" TEXT,
    "student_code" TEXT,
    "course_key" TEXT,
    "criterion_key" TEXT,
    "raw_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "auth_sessions_active_user_idx" ON "auth_sessions"("user_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "generations_code_key" ON "generations"("code");

-- CreateIndex
CREATE UNIQUE INDEX "terms_generation_id_number_key" ON "terms"("generation_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "terms_id_generation_id_key" ON "terms"("id", "generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "courses_code_key" ON "courses"("code");

-- CreateIndex
CREATE INDEX "course_offerings_generation_id_visibility_idx" ON "course_offerings"("generation_id", "visibility");

-- CreateIndex
CREATE INDEX "course_offerings_source_id_idx" ON "course_offerings"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_offerings_term_id_course_id_key" ON "course_offerings"("term_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_offerings_generation_id_external_key_key" ON "course_offerings"("generation_id", "external_key");

-- CreateIndex
CREATE UNIQUE INDEX "google_sheet_sources_spreadsheet_id_key" ON "google_sheet_sources"("spreadsheet_id");

-- CreateIndex
CREATE INDEX "google_sheet_sources_generation_id_idx" ON "google_sheet_sources"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_student_code_key" ON "students"("student_code");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE INDEX "students_generation_id_class_name_idx" ON "students"("generation_id", "class_name");

-- CreateIndex
CREATE INDEX "students_full_name_trgm_idx" ON "students" USING GIN ("full_name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "enrollments_offering_id_idx" ON "enrollments"("offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_student_id_offering_id_key" ON "enrollments"("student_id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_id_offering_id_key" ON "enrollments"("id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_criteria_offering_id_key_key" ON "assessment_criteria"("offering_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_criteria_offering_id_sheet_column_key_key" ON "assessment_criteria"("offering_id", "sheet_column_key");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_criteria_id_offering_id_key" ON "assessment_criteria"("id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "grading_schemes_offering_id_version_key" ON "grading_schemes"("offering_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "grading_schemes_id_offering_id_key" ON "grading_schemes"("id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "grading_schemes_one_published" ON "grading_schemes"("offering_id") WHERE (status = 'PUBLISHED');

-- CreateIndex
CREATE UNIQUE INDEX "grading_schemes_one_draft" ON "grading_schemes"("offering_id") WHERE (status = 'DRAFT');

-- CreateIndex
CREATE INDEX "grading_scheme_items_criterion_id_idx" ON "grading_scheme_items"("criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "grading_scheme_items_scheme_id_criterion_id_key" ON "grading_scheme_items"("scheme_id", "criterion_id");

-- CreateIndex
CREATE INDEX "assessment_scores_criterion_id_idx" ON "assessment_scores"("criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_scores_enrollment_id_criterion_id_key" ON "assessment_scores"("enrollment_id", "criterion_id");

-- CreateIndex
CREATE INDEX "assessment_score_revisions_score_id_created_at_idx" ON "assessment_score_revisions"("score_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_jobs_source_id_queued_at_idx" ON "sync_jobs"("source_id", "queued_at" DESC);

-- CreateIndex
CREATE INDEX "sync_jobs_parent_id_idx" ON "sync_jobs"("parent_id");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "sync_jobs_queued_at_idx" ON "sync_jobs"("queued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sync_jobs_one_active_per_source" ON "sync_jobs"("source_id") WHERE (scope = 'SOURCE' AND finished_at IS NULL);

-- CreateIndex
CREATE INDEX "sync_errors_job_id_severity_idx" ON "sync_errors"("job_id", "severity");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_term_id_generation_id_fkey" FOREIGN KEY ("term_id", "generation_id") REFERENCES "terms"("id", "generation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_offerings" ADD CONSTRAINT "course_offerings_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheet_sources" ADD CONSTRAINT "google_sheet_sources_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheet_sources" ADD CONSTRAINT "google_sheet_sources_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_criteria" ADD CONSTRAINT "assessment_criteria_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scheme_items" ADD CONSTRAINT "grading_scheme_items_scheme_id_offering_id_fkey" FOREIGN KEY ("scheme_id", "offering_id") REFERENCES "grading_schemes"("id", "offering_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_scheme_items" ADD CONSTRAINT "grading_scheme_items_criterion_id_offering_id_fkey" FOREIGN KEY ("criterion_id", "offering_id") REFERENCES "assessment_criteria"("id", "offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_enrollment_id_offering_id_fkey" FOREIGN KEY ("enrollment_id", "offering_id") REFERENCES "enrollments"("id", "offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_criterion_id_offering_id_fkey" FOREIGN KEY ("criterion_id", "offering_id") REFERENCES "assessment_criteria"("id", "offering_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_score_revisions" ADD CONSTRAINT "assessment_score_revisions_score_id_fkey" FOREIGN KEY ("score_id") REFERENCES "assessment_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_score_revisions" ADD CONSTRAINT "assessment_score_revisions_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "sync_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_retry_of_id_fkey" FOREIGN KEY ("retry_of_id") REFERENCES "sync_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================================
-- Hand-written integrity rules (not managed by Prisma; see docs/database-design.md)
-- =============================================================================================

-- CHECK constraints ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_failed_login_count_check" CHECK (failed_login_count >= 0),
  ADD CONSTRAINT "users_username_check" CHECK (length(username::text) BETWEEN 1 AND 64);

ALTER TABLE "generations"
  ADD CONSTRAINT "generations_code_check" CHECK (code::text ~ '^[A-Za-z0-9_-]{2,32}$'),
  ADD CONSTRAINT "generations_dates_check" CHECK (end_date IS NULL OR end_date >= start_date);

ALTER TABLE "terms"
  ADD CONSTRAINT "terms_number_check" CHECK (number BETWEEN 1 AND 5),
  ADD CONSTRAINT "terms_dates_check" CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);

ALTER TABLE "courses"
  ADD CONSTRAINT "courses_code_check" CHECK (code::text ~ '^[A-Za-z0-9_-]{1,32}$');

ALTER TABLE "course_offerings"
  ADD CONSTRAINT "course_offerings_credits_check" CHECK (credits > 0),
  ADD CONSTRAINT "course_offerings_external_key_check" CHECK (external_key::text ~ '^[A-Za-z0-9_-]{1,40}$');

ALTER TABLE "google_sheet_sources"
  ADD CONSTRAINT "google_sheet_sources_spreadsheet_id_check" CHECK (spreadsheet_id ~ '^[A-Za-z0-9_-]{20,128}$');

-- Student codes are stored normalized (upper case); see @ssrs/shared normalizeStudentId.
ALTER TABLE "students"
  ADD CONSTRAINT "students_student_code_check" CHECK (student_code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$');

ALTER TABLE "assessment_criteria"
  ADD CONSTRAINT "assessment_criteria_key_check" CHECK (key::text ~ '^[A-Za-z][A-Za-z0-9_]{0,31}$'),
  ADD CONSTRAINT "assessment_criteria_sheet_column_key_check"
    CHECK (sheet_column_key IS NULL OR sheet_column_key::text ~ '^[A-Za-z][A-Za-z0-9_]{0,31}$');

ALTER TABLE "grading_schemes"
  ADD CONSTRAINT "grading_schemes_version_check" CHECK (version >= 1),
  ADD CONSTRAINT "grading_schemes_total_weight_check" CHECK (total_weight >= 0),
  ADD CONSTRAINT "grading_schemes_published_check"
    CHECK (status = 'DRAFT' OR published_at IS NOT NULL);

ALTER TABLE "grading_scheme_items"
  ADD CONSTRAINT "grading_scheme_items_max_mark_check" CHECK (max_mark > 0),
  ADD CONSTRAINT "grading_scheme_items_weight_check" CHECK (weight > 0 AND weight <= 100);

ALTER TABLE "assessment_scores"
  ADD CONSTRAINT "assessment_scores_mark_check" CHECK (mark >= 0),
  ADD CONSTRAINT "assessment_scores_absent_check" CHECK (status <> 'ABSENT' OR mark = 0),
  ADD CONSTRAINT "assessment_scores_source_row_check" CHECK (source_row IS NULL OR source_row >= 1);

ALTER TABLE "sync_jobs"
  ADD CONSTRAINT "sync_jobs_scope_check" CHECK (
    (scope = 'SOURCE' AND source_id IS NOT NULL)
    OR (scope = 'GENERATION' AND generation_id IS NOT NULL)
    OR (scope = 'ALL')
  ),
  ADD CONSTRAINT "sync_jobs_progress_check" CHECK (progress_current >= 0 AND progress_total >= 0),
  -- Active (QUEUED/RUNNING) jobs are exactly the unfinished ones; the partial unique index relies on this.
  ADD CONSTRAINT "sync_jobs_finished_check" CHECK ((status IN ('QUEUED', 'RUNNING')) = (finished_at IS NULL));

-- Grading scheme lifecycle ----------------------------------------------------------------------
-- Allowed transitions: DRAFT -> PUBLISHED -> ARCHIVED. Only drafts may be deleted.
-- offering_id and version never change.
CREATE FUNCTION ssrs_guard_grading_scheme() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
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

CREATE TRIGGER grading_schemes_guard
  BEFORE UPDATE OR DELETE ON "grading_schemes"
  FOR EACH ROW EXECUTE FUNCTION ssrs_guard_grading_scheme();

-- Items of PUBLISHED / ARCHIVED schemes are immutable.
CREATE FUNCTION ssrs_guard_grading_scheme_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scheme_status "SchemeStatus";
BEGIN
  SELECT status INTO scheme_status FROM "grading_schemes"
    WHERE id = COALESCE(NEW.scheme_id, OLD.scheme_id);
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

CREATE TRIGGER grading_scheme_items_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "grading_scheme_items"
  FOR EACH ROW EXECUTE FUNCTION ssrs_guard_grading_scheme_item();

-- Append-only tables ------------------------------------------------------------------------------
-- Retention jobs may purge old rows only inside a transaction that sets
--   SET LOCAL ssrs.allow_append_only_purge = 'on';
CREATE FUNCTION ssrs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('ssrs.allow_append_only_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION ssrs_append_only();

CREATE TRIGGER assessment_score_revisions_append_only
  BEFORE UPDATE OR DELETE ON "assessment_score_revisions"
  FOR EACH ROW EXECUTE FUNCTION ssrs_append_only();
