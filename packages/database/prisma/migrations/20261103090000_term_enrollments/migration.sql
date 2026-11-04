-- Term enrollments: a student's program and class per term, program and class configuration,
-- tab audiences and admin issues. Design: docs/qa/step3-check.md and docs/database-design.md.
-- Generated DDL first, then constraints Prisma cannot express, defaults and the backfill.
-- CreateEnum
CREATE TYPE "TabAudience" AS ENUM ('SHARED', 'PROGRAM');

-- CreateEnum
CREATE TYPE "EnrollmentEndReason" AS ENUM ('PROGRAM_SWITCH');

-- CreateEnum
CREATE TYPE "ProgramSource" AS ENUM ('SHEET', 'ADMIN');

-- CreateEnum
CREATE TYPE "StudentTermIssueKind" AS ENUM ('UNDETERMINED_PROGRAM', 'PROGRAM_CONFLICT', 'PROGRAM_SWITCH', 'UNKNOWN_CLASS', 'DUPLICATE_IN_ROSTER');

-- AlterEnum


ALTER TYPE "ColumnRole" ADD VALUE 'PROGRAM';
ALTER TYPE "ColumnRole" ADD VALUE 'ROW_NUMBER';

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "ended_reason" "EnrollmentEndReason";

-- AlterTable
ALTER TABLE "sheet_tab_mappings" ADD COLUMN     "audience" "TabAudience",
ADD COLUMN     "audience_program_id" UUID;

-- CreateTable
CREATE TABLE "program_aliases" (
    "alias" CITEXT NOT NULL,
    "program_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "program_aliases_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "term_programs" (
    "term_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_programs_pkey" PRIMARY KEY ("term_id","program_id")
);

-- CreateTable
CREATE TABLE "term_classes" (
    "id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "term_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_terms" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "program_source" "ProgramSource" NOT NULL DEFAULT 'SHEET',
    "source_id" UUID,
    "last_seen_sync_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "student_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_term_issues" (
    "id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "student_id" UUID,
    "student_code" TEXT NOT NULL,
    "kind" "StudentTermIssueKind" NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "sync_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by" UUID,
    "resolution" TEXT,

    CONSTRAINT "student_term_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "program_aliases_program_id_idx" ON "program_aliases"("program_id");

-- CreateIndex
CREATE INDEX "term_programs_program_id_idx" ON "term_programs"("program_id");

-- CreateIndex
CREATE INDEX "term_classes_term_id_program_id_idx" ON "term_classes"("term_id", "program_id");

-- CreateIndex
CREATE UNIQUE INDEX "term_classes_term_id_name_key" ON "term_classes"("term_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "term_classes_id_term_id_program_id_key" ON "term_classes"("id", "term_id", "program_id");

-- CreateIndex
CREATE INDEX "student_terms_term_id_program_id_class_id_idx" ON "student_terms"("term_id", "program_id", "class_id");

-- CreateIndex
CREATE INDEX "student_terms_class_id_idx" ON "student_terms"("class_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_terms_student_id_term_id_key" ON "student_terms"("student_id", "term_id");

-- CreateIndex
CREATE INDEX "student_term_issues_term_id_resolved_at_idx" ON "student_term_issues"("term_id", "resolved_at");

-- CreateIndex
CREATE INDEX "student_term_issues_student_id_idx" ON "student_term_issues"("student_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_term_issues_one_open" ON "student_term_issues"("term_id", "student_code", "kind") WHERE (resolved_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "students_id_generation_id_key" ON "students"("id", "generation_id");

-- AddForeignKey
ALTER TABLE "program_aliases" ADD CONSTRAINT "program_aliases_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_programs" ADD CONSTRAINT "term_programs_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_programs" ADD CONSTRAINT "term_programs_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_classes" ADD CONSTRAINT "term_classes_term_id_program_id_fkey" FOREIGN KEY ("term_id", "program_id") REFERENCES "term_programs"("term_id", "program_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_tab_mappings" ADD CONSTRAINT "sheet_tab_mappings_audience_program_id_fkey" FOREIGN KEY ("audience_program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_student_id_generation_id_fkey" FOREIGN KEY ("student_id", "generation_id") REFERENCES "students"("id", "generation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_term_id_program_id_fkey" FOREIGN KEY ("term_id", "program_id") REFERENCES "term_programs"("term_id", "program_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_class_id_term_id_program_id_fkey" FOREIGN KEY ("class_id", "term_id", "program_id") REFERENCES "term_classes"("id", "term_id", "program_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_terms" ADD CONSTRAINT "student_terms_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_term_issues" ADD CONSTRAINT "student_term_issues_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_term_issues" ADD CONSTRAINT "student_term_issues_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_term_issues" ADD CONSTRAINT "student_term_issues_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- CHECK constraints ---------------------------------------------------------------------------
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_ended_reason_check"
    CHECK (ended_reason IS NULL OR status = 'WITHDRAWN');

ALTER TABLE "sheet_tab_mappings"
  ADD CONSTRAINT "sheet_tab_mappings_audience_check"
    CHECK ((audience IS NOT DISTINCT FROM 'PROGRAM') = (audience_program_id IS NOT NULL));

ALTER TABLE "program_aliases"
  ADD CONSTRAINT "program_aliases_alias_check"
    CHECK (length(alias::text) BETWEEN 1 AND 40 AND alias::text = btrim(alias::text));

ALTER TABLE "term_classes"
  ADD CONSTRAINT "term_classes_name_check"
    CHECK (length(name::text) BETWEEN 1 AND 20 AND name::text = btrim(name::text));

ALTER TABLE "student_term_issues"
  ADD CONSTRAINT "student_term_issues_resolution_check"
    CHECK ((resolved_at IS NULL) = (resolution IS NULL));

-- Defaults ------------------------------------------------------------------------------------
-- The one place the default programs and classes are written down. New generations call
-- ssrs_apply_term_defaults for each term; admins edit the result. Validation never reads term
-- numbers: it reads term_programs and term_classes.

CREATE FUNCTION ssrs_ensure_programs() RETURNS void LANGUAGE sql AS $$
  INSERT INTO programs (id, code, name, updated_at) VALUES
    (gen_random_uuid(), 'GENERAL', 'General', now()),
    (gen_random_uuid(), 'WEP', 'Web Programming', now()),
    (gen_random_uuid(), 'SNAC', 'System Network Administrators and Cybersecurity', now())
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO program_aliases (alias, program_id)
    SELECT 'SNA', id FROM programs WHERE code = 'SNAC'
  ON CONFLICT (alias) DO NOTHING;
$$;

-- Term 1: GENERAL with classes A–D. Other terms: WEP (A, B, C) and SNAC (D). Does nothing for a
-- term that already has programs, so it never overwrites what an admin configured.
CREATE FUNCTION ssrs_apply_term_defaults(p_term_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  term_number smallint;
BEGIN
  PERFORM ssrs_ensure_programs();
  SELECT number INTO term_number FROM terms WHERE id = p_term_id;
  IF term_number IS NULL THEN
    RAISE EXCEPTION 'term % does not exist', p_term_id;
  END IF;
  IF EXISTS (SELECT 1 FROM term_programs WHERE term_id = p_term_id) THEN
    RETURN;
  END IF;
  INSERT INTO term_programs (term_id, program_id)
    SELECT p_term_id, id FROM programs
    WHERE code = ANY (CASE WHEN term_number = 1 THEN ARRAY['GENERAL'] ELSE ARRAY['WEP', 'SNAC'] END);
  INSERT INTO term_classes (id, term_id, program_id, name, updated_at)
    SELECT gen_random_uuid(), p_term_id, p.id, c.name, now()
    FROM (VALUES ('GENERAL', 'A'), ('GENERAL', 'B'), ('GENERAL', 'C'), ('GENERAL', 'D'),
                 ('WEP', 'A'), ('WEP', 'B'), ('WEP', 'C'), ('SNAC', 'D')) AS c (code, name)
    JOIN programs p ON p.code = c.code
    JOIN term_programs tp ON tp.term_id = p_term_id AND tp.program_id = p.id;
END $$;

SELECT ssrs_apply_term_defaults(id) FROM terms;

-- A confirmed tab of a term with a single program (Term 1, General) is taken by everyone.
UPDATE "sheet_tab_mappings" m SET audience = 'SHARED'
FROM google_sheet_sources s
WHERE s.id = m.source_id AND m.status = 'CONFIRMED' AND m.audience IS NULL
  AND (SELECT count(*) FROM term_programs tp WHERE tp.term_id = s.term_id) = 1;

-- Backfill ------------------------------------------------------------------------------------
-- One student_terms row per student and term with subject enrollments, when the class is known
-- for that term: students.class_name comes from the roster of students.source_id, so only that
-- sheet's term can take it. Other terms are left for their next sync. Safe to run again: existing
-- rows are kept. Returns what it did, in IDs and counts only.
CREATE FUNCTION ssrs_backfill_student_terms() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
BEGIN
  CREATE TEMP TABLE backfill_candidates ON COMMIT DROP AS
    SELECT DISTINCT st.id AS student_id, st.student_code, st.generation_id, st.source_id,
           o.term_id, t.number AS term_number,
           (src.term_id IS NOT DISTINCT FROM o.term_id) AS class_from_this_term,
           tc.id AS class_id, tc.program_id, tc.name AS class_name
    FROM students st
    JOIN enrollments e ON e.student_id = st.id
    JOIN course_offerings o ON o.id = e.offering_id
    JOIN terms t ON t.id = o.term_id
    LEFT JOIN google_sheet_sources src ON src.id = st.source_id
    LEFT JOIN term_classes tc ON tc.term_id = o.term_id AND tc.name = btrim(st.class_name);

  WITH inserted AS (
    INSERT INTO student_terms (id, student_id, term_id, generation_id, program_id, class_id,
                               program_source, source_id, updated_at)
    SELECT gen_random_uuid(), student_id, term_id, generation_id, program_id, class_id, 'SHEET',
           source_id, now()
    FROM backfill_candidates
    WHERE class_from_this_term AND class_id IS NOT NULL
    ON CONFLICT (student_id, term_id) DO NOTHING
    RETURNING term_id, class_id
  )
  SELECT jsonb_build_object(
    'created', (SELECT count(*) FROM inserted),
    'createdByTermAndClass', COALESCE((
      SELECT jsonb_object_agg(key, n) FROM (
        SELECT format('T%s %s %s', t.number, p.code, tc.name) AS key, count(*) AS n
        FROM inserted i
        JOIN terms t ON t.id = i.term_id
        JOIN term_classes tc ON tc.id = i.class_id
        JOIN programs p ON p.id = tc.program_id
        GROUP BY 1) x), '{}'::jsonb),
    'classFromAnotherTerm', COALESCE((
      SELECT jsonb_agg(format('%s T%s', student_code, term_number) ORDER BY student_code, term_number)
      FROM backfill_candidates WHERE NOT class_from_this_term), '[]'::jsonb),
    'unknownClass', COALESCE((
      SELECT jsonb_agg(format('%s T%s', student_code, term_number) ORDER BY student_code, term_number)
      FROM backfill_candidates WHERE class_from_this_term AND class_id IS NULL), '[]'::jsonb))
  INTO result;

  -- The student's latest term (highest number) decides students.class_name and program_id.
  UPDATE students s SET class_name = latest.class_name, program_id = latest.program_id
  FROM (
    SELECT DISTINCT ON (st.student_id) st.student_id, tc.name::text AS class_name, st.program_id
    FROM student_terms st
    JOIN terms t ON t.id = st.term_id
    JOIN term_classes tc ON tc.id = st.class_id
    ORDER BY st.student_id, t.number DESC
  ) latest
  WHERE s.id = latest.student_id
    AND (s.class_name IS DISTINCT FROM latest.class_name OR s.program_id IS DISTINCT FROM latest.program_id);

  INSERT INTO audit_logs (id, actor_type, action, entity_type, metadata)
  VALUES (gen_random_uuid(), 'SYSTEM', 'student_terms.backfilled', 'student_terms', result);

  DROP TABLE backfill_candidates;
  RETURN result;
END $$;

SELECT ssrs_backfill_student_terms();
