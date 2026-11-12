-- Columns missing from the sheet (docs/decisions.md TD2). When a tab confirmed before is reopened
-- and detected again, a column the teacher removed keeps its mapping row (role, name, weight,
-- criterion), flagged and with no position, instead of being deleted. Flagged rows exist on DRAFT
-- tabs only; confirming the tab drops them (audited). Sync, preview and scores never read them.
--
-- Additive: one new column with a default, NOT NULL relaxed on column_index, and a CHECK that a row
-- has no position exactly when it is flagged. No existing row changes (all keep their position
-- and get missing_from_sheet = false).
--
-- Revert (one transaction; drops only flagged mapping rows of draft tabs, never marks or
-- criteria):
--   BEGIN;
--   DELETE FROM "sheet_column_mappings" WHERE "missing_from_sheet";
--   ALTER TABLE "sheet_column_mappings" DROP CONSTRAINT "sheet_column_mappings_missing_check";
--   ALTER TABLE "sheet_column_mappings" ALTER COLUMN "column_index" SET NOT NULL;
--   ALTER TABLE "sheet_column_mappings" DROP COLUMN "missing_from_sheet";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261112090000_column_missing_from_sheet';
--   COMMIT;

ALTER TABLE "sheet_column_mappings" ADD COLUMN "missing_from_sheet" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "sheet_column_mappings" ALTER COLUMN "column_index" DROP NOT NULL;

ALTER TABLE "sheet_column_mappings"
  ADD CONSTRAINT "sheet_column_mappings_missing_check"
  CHECK ("missing_from_sheet" = ("column_index" IS NULL));
