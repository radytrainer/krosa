-- Term workbooks (one spreadsheet per term), programs, column mappings, letter grades.
-- Design: docs/delivery-plan-2027.md section A.
-- CreateEnum
CREATE TYPE "SourceLayout" AS ENUM ('STRICT_V1', 'TERM_WORKBOOK');

-- CreateEnum
CREATE TYPE "TabMappingStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ColumnRole" AS ENUM ('STUDENT_ID', 'FIRST_NAME', 'LAST_NAME', 'FULL_NAME', 'GENDER', 'CLASS', 'CRITERION', 'REFERENCE_TOTAL', 'COMMENT', 'IGNORE');

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "sheet_total" DECIMAL(8,3),
ADD COLUMN     "teacher_comment" TEXT;

-- AlterTable
ALTER TABLE "google_sheet_sources" ADD COLUMN     "ignored_tabs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "layout" "SourceLayout" NOT NULL DEFAULT 'STRICT_V1',
ADD COLUMN     "roster_tab" TEXT NOT NULL DEFAULT 'ALL',
ADD COLUMN     "term_id" UUID;

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "last_name" TEXT,
ADD COLUMN     "program_id" UUID;

-- AlterTable
ALTER TABLE "sync_jobs" ADD COLUMN     "mapping_versions" JSONB;

-- CreateTable
CREATE TABLE "course_aliases" (
    "alias" CITEXT NOT NULL,
    "course_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_aliases_pkey" PRIMARY KEY ("alias")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offering_programs" (
    "offering_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,

    CONSTRAINT "offering_programs_pkey" PRIMARY KEY ("offering_id","program_id")
);

-- CreateTable
CREATE TABLE "sheet_tab_mappings" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "tab_name" TEXT NOT NULL,
    "sheet_tab_id" INTEGER,
    "offering_id" UUID,
    "header_row" INTEGER NOT NULL,
    "status" "TabMappingStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "header_signature" CHAR(64) NOT NULL,
    "last_content_hash" CHAR(64),
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sheet_tab_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_column_mappings" (
    "id" UUID NOT NULL,
    "tab_mapping_id" UUID NOT NULL,
    "column_index" INTEGER NOT NULL,
    "header_label" TEXT,
    "group_label" TEXT,
    "role" "ColumnRole" NOT NULL,
    "criterion_id" UUID,
    "proposed_name" TEXT,
    "proposed_weight" DECIMAL(6,3),

    CONSTRAINT "sheet_column_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_scales" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "grade_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_bands" (
    "id" UUID NOT NULL,
    "scale_id" UUID NOT NULL,
    "letter" TEXT NOT NULL,
    "min_total" DECIMAL(5,2) NOT NULL,
    "is_pass" BOOLEAN NOT NULL,

    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_aliases_course_id_idx" ON "course_aliases"("course_id");

-- CreateIndex
CREATE UNIQUE INDEX "programs_code_key" ON "programs"("code");

-- CreateIndex
CREATE INDEX "offering_programs_program_id_idx" ON "offering_programs"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_tab_mappings_offering_id_key" ON "sheet_tab_mappings"("offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_tab_mappings_source_id_tab_name_key" ON "sheet_tab_mappings"("source_id", "tab_name");

-- CreateIndex
CREATE INDEX "sheet_column_mappings_criterion_id_idx" ON "sheet_column_mappings"("criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_column_mappings_tab_mapping_id_column_index_key" ON "sheet_column_mappings"("tab_mapping_id", "column_index");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_column_mappings_tab_mapping_id_criterion_id_key" ON "sheet_column_mappings"("tab_mapping_id", "criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "grade_scales_generation_id_key" ON "grade_scales"("generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "grade_bands_scale_id_letter_key" ON "grade_bands"("scale_id", "letter");

-- CreateIndex
CREATE UNIQUE INDEX "grade_bands_scale_id_min_total_key" ON "grade_bands"("scale_id", "min_total");

-- CreateIndex
CREATE UNIQUE INDEX "google_sheet_sources_one_active_per_term" ON "google_sheet_sources"("term_id") WHERE (term_id IS NOT NULL AND status = 'ACTIVE');

-- CreateIndex
CREATE INDEX "students_generation_id_program_id_class_name_idx" ON "students"("generation_id", "program_id", "class_name");

-- AddForeignKey
ALTER TABLE "course_aliases" ADD CONSTRAINT "course_aliases_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_programs" ADD CONSTRAINT "offering_programs_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_programs" ADD CONSTRAINT "offering_programs_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheet_sources" ADD CONSTRAINT "google_sheet_sources_term_id_generation_id_fkey" FOREIGN KEY ("term_id", "generation_id") REFERENCES "terms"("id", "generation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_tab_mappings" ADD CONSTRAINT "sheet_tab_mappings_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_tab_mappings" ADD CONSTRAINT "sheet_tab_mappings_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "course_offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_tab_mappings" ADD CONSTRAINT "sheet_tab_mappings_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_column_mappings" ADD CONSTRAINT "sheet_column_mappings_tab_mapping_id_fkey" FOREIGN KEY ("tab_mapping_id") REFERENCES "sheet_tab_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_column_mappings" ADD CONSTRAINT "sheet_column_mappings_criterion_id_fkey" FOREIGN KEY ("criterion_id") REFERENCES "assessment_criteria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_scales" ADD CONSTRAINT "grade_scales_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_scales" ADD CONSTRAINT "grade_scales_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_bands" ADD CONSTRAINT "grade_bands_scale_id_fkey" FOREIGN KEY ("scale_id") REFERENCES "grade_scales"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints ---------------------------------------------------------------------------
ALTER TABLE "google_sheet_sources"
  ADD CONSTRAINT "google_sheet_sources_layout_term_check"
    CHECK ((layout = 'TERM_WORKBOOK') = (term_id IS NOT NULL)),
  ADD CONSTRAINT "google_sheet_sources_roster_tab_check"
    CHECK (length(btrim(roster_tab)) BETWEEN 1 AND 100);

ALTER TABLE "programs"
  ADD CONSTRAINT "programs_code_check" CHECK (code::text ~ '^[A-Za-z0-9_]{2,16}$');

ALTER TABLE "course_aliases"
  ADD CONSTRAINT "course_aliases_alias_check"
    CHECK (length(alias::text) BETWEEN 1 AND 100 AND alias::text = btrim(alias::text));

ALTER TABLE "sheet_tab_mappings"
  ADD CONSTRAINT "sheet_tab_mappings_header_row_check" CHECK (header_row >= 1),
  ADD CONSTRAINT "sheet_tab_mappings_version_check" CHECK (version >= 0),
  ADD CONSTRAINT "sheet_tab_mappings_confirmed_check"
    CHECK (status <> 'CONFIRMED' OR (offering_id IS NOT NULL AND confirmed_at IS NOT NULL AND version >= 1)),
  ADD CONSTRAINT "sheet_tab_mappings_ignored_check" CHECK (status <> 'IGNORED' OR offering_id IS NULL);

ALTER TABLE "sheet_column_mappings"
  ADD CONSTRAINT "sheet_column_mappings_column_index_check" CHECK (column_index >= 0),
  ADD CONSTRAINT "sheet_column_mappings_criterion_role_check"
    CHECK (criterion_id IS NULL OR role = 'CRITERION'),
  ADD CONSTRAINT "sheet_column_mappings_proposed_weight_check"
    CHECK (proposed_weight IS NULL OR (proposed_weight > 0 AND proposed_weight <= 100));

ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_letter_check" CHECK (length(btrim(letter)) BETWEEN 1 AND 3),
  ADD CONSTRAINT "grade_bands_min_total_check" CHECK (min_total >= 0 AND min_total <= 100);

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_teacher_comment_check"
    CHECK (teacher_comment IS NULL OR length(teacher_comment) <= 4000);
