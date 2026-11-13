-- Performance levels for admin subject monitoring (docs/decisions.md, Subject monitoring).
--
-- Each grade band carries its level, so code never names letters:
--   A, B+ -> VERY_GOOD; B, C+ -> GOOD; C, D -> FAIR; E -> FAIL.
-- FAIL is exactly the failing band: CHECK ((level = 'FAIL') = (NOT is_pass)).
--
-- What it changes: a new enum and a NOT NULL column on grade_bands, backfilled from each band's
-- letter. ssrs_set_official_grade_bands writes the level too, so new generations (through
-- ssrs_apply_grade_defaults) get levels. No band letter, threshold or pass flag changes, and no
-- cache_version bump: student results do not carry the level. Marks and scores are not touched.
--
-- Revert: packages/database/prisma/reverts/20261114090000_grade_levels.sql.

CREATE TYPE "GradeLevel" AS ENUM ('VERY_GOOD', 'GOOD', 'FAIR', 'FAIL');

ALTER TABLE "grade_bands" ADD COLUMN "level" "GradeLevel";

UPDATE "grade_bands" SET "level" = CASE btrim("letter")
  WHEN 'A' THEN 'VERY_GOOD'::"GradeLevel"
  WHEN 'B+' THEN 'VERY_GOOD'::"GradeLevel"
  WHEN 'B' THEN 'GOOD'::"GradeLevel"
  WHEN 'C+' THEN 'GOOD'::"GradeLevel"
  WHEN 'C' THEN 'FAIR'::"GradeLevel"
  WHEN 'D' THEN 'FAIR'::"GradeLevel"
  WHEN 'E' THEN 'FAIL'::"GradeLevel"
END;

-- Fails (and rolls back the migration) if any band has a letter outside the official scale.
ALTER TABLE "grade_bands" ALTER COLUMN "level" SET NOT NULL;

ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_level_pass_check" CHECK (("level" = 'FAIL') = (NOT "is_pass"));

-- Same as migration 20261113090000_grade_scale_2026_11, now writing the level.
CREATE OR REPLACE FUNCTION ssrs_set_official_grade_bands(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_scale_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM generations WHERE id = p_generation_id) THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation_id;
  END IF;
  INSERT INTO grade_scales (id, generation_id, confirmed, confirmed_at, updated_at)
    VALUES (gen_random_uuid(), p_generation_id, true, now(), now())
    ON CONFLICT (generation_id) DO UPDATE SET confirmed = true, confirmed_at = now(), updated_at = now();
  SELECT id INTO v_scale_id FROM grade_scales WHERE generation_id = p_generation_id;
  DELETE FROM grade_bands WHERE scale_id = v_scale_id;
  INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass, level)
    SELECT gen_random_uuid(), v_scale_id, b.letter, b.min_total, b.is_pass, b.level::"GradeLevel"
    FROM (VALUES ('A', 85.00, true, 'VERY_GOOD'), ('B+', 80.00, true, 'VERY_GOOD'),
                 ('B', 70.00, true, 'GOOD'), ('C+', 65.00, true, 'GOOD'),
                 ('C', 60.00, true, 'FAIR'), ('D', 50.00, true, 'FAIR'),
                 ('E', 0.00, false, 'FAIL'))
      AS b (letter, min_total, is_pass, level);
  -- Cached student results carry the grade: make them stale.
  UPDATE generations SET cache_version = cache_version + 1 WHERE id = p_generation_id;
END $$;
