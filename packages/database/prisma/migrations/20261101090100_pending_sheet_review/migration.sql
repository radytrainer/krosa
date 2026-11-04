-- Confirming a tab of a pending sheet writes only its mapping. These hold what the sync that
-- promotes the sheet applies. A new subject has no offering until then.
ALTER TABLE "sheet_tab_mappings" ADD COLUMN "proposed_title" TEXT;
ALTER TABLE "sheet_column_mappings" ADD COLUMN "proposed_key" TEXT;

ALTER TABLE "sheet_tab_mappings"
  DROP CONSTRAINT "sheet_tab_mappings_confirmed_check",
  ADD CONSTRAINT "sheet_tab_mappings_confirmed_check"
    CHECK (status <> 'CONFIRMED' OR (
      (offering_id IS NOT NULL OR proposed_title IS NOT NULL)
      AND confirmed_at IS NOT NULL AND version >= 1
    ));
