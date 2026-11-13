-- Revert of migration 20261114090000_grade_levels (grade band levels).
--
-- Restores the state migration 20261113090000_grade_scale_2026_11 left:
--   - ssrs_set_official_grade_bands: the previous body, word for word (no level);
--   - grade_bands: the CHECK and the level column dropped (letters, thresholds and pass flags
--     were never changed by the migration);
--   - the GradeLevel enum dropped;
--   - the migration record: removed, so `prisma migrate deploy` can apply it again.
-- No cache bump: the migration made none. Marks, scores and results are not touched.
--
-- Run only through the guard, against a database you have approval for, for example:
--   scripts/db-guard.sh ssrs_test "$TEST_DATABASE_URL" psql < packages/database/prisma/reverts/20261114090000_grade_levels.sql

BEGIN;

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
  INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass)
    SELECT gen_random_uuid(), v_scale_id, b.letter, b.min_total, b.is_pass
    FROM (VALUES ('A', 85.00, true), ('B+', 80.00, true), ('B', 70.00, true),
                 ('C+', 65.00, true), ('C', 60.00, true), ('D', 50.00, true),
                 ('E', 0.00, false))
      AS b (letter, min_total, is_pass);
  -- Cached student results carry the grade: make them stale.
  UPDATE generations SET cache_version = cache_version + 1 WHERE id = p_generation_id;
END $$;

ALTER TABLE "grade_bands" DROP CONSTRAINT "grade_bands_level_pass_check";
ALTER TABLE "grade_bands" DROP COLUMN "level";
DROP TYPE "GradeLevel";

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114090000_grade_levels';

COMMIT;
