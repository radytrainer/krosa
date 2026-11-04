-- A subject whose tab left the term's sheet is archived after an admin confirms it. Nothing is
-- deleted. A job applies removals only from the confirmed preview it points at.
ALTER TYPE "TabMappingStatus" ADD VALUE 'REMOVED';

ALTER TABLE "course_offerings" ADD COLUMN "archived_at" TIMESTAMPTZ(3);
ALTER TABLE "sync_jobs" ADD COLUMN "preview_id" UUID;

-- Earlier previews have no comparison of subjects, so they must be run again.
UPDATE "sheet_previews" SET "invalidated_at" = now() WHERE "invalidated_at" IS NULL;
