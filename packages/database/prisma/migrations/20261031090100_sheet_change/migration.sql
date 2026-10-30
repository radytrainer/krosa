-- DropIndex
DROP INDEX "sheet_tab_mappings_offering_id_key";

-- AlterTable
ALTER TABLE "sync_jobs" ADD COLUMN     "term_id" UUID;

-- Existing jobs take the term of their source.
UPDATE "sync_jobs" j SET "term_id" = s."term_id"
FROM "google_sheet_sources" s
WHERE j."source_id" = s."id";

-- CreateTable
CREATE TABLE "sheet_previews" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "mapping_versions" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "run_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),

    CONSTRAINT "sheet_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sheet_previews_source_id_created_at_idx" ON "sheet_previews"("source_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "google_sheet_sources_one_pending_per_term" ON "google_sheet_sources"("term_id") WHERE (status = 'PENDING');

-- CreateIndex
CREATE INDEX "sheet_tab_mappings_offering_id_idx" ON "sheet_tab_mappings"("offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_tab_mappings_source_id_offering_id_key" ON "sheet_tab_mappings"("source_id", "offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_jobs_one_active_per_term" ON "sync_jobs"("term_id") WHERE (scope = 'SOURCE' AND finished_at IS NULL);

-- AddForeignKey
ALTER TABLE "sheet_previews" ADD CONSTRAINT "sheet_previews_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "google_sheet_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_previews" ADD CONSTRAINT "sheet_previews_run_by_fkey" FOREIGN KEY ("run_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_previews" ADD CONSTRAINT "sheet_previews_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

