-- Term workbooks become the only source type: the strict template and its layout column go away.
-- Sources always belong to a term. Existing sources without a term cannot be kept.
DELETE FROM "google_sheet_sources" WHERE "term_id" IS NULL;

ALTER TABLE "google_sheet_sources" DROP CONSTRAINT "google_sheet_sources_layout_term_check";

-- DropIndex
DROP INDEX "google_sheet_sources_one_active_per_term";

-- AlterTable
ALTER TABLE "google_sheet_sources" DROP COLUMN "layout",
ALTER COLUMN "term_id" SET NOT NULL;

-- DropEnum
DROP TYPE "SourceLayout";

-- CreateIndex
CREATE UNIQUE INDEX "google_sheet_sources_one_active_per_term" ON "google_sheet_sources"("term_id") WHERE (status = 'ACTIVE');

