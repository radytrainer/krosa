-- Revert of migration 20261113090000_grade_scale_2026_11 (the grade scale of 2026-11-12).
--
-- This file supersedes the revert notes inside that migration (an applied migration is never
-- edited: its checksum is recorded). Those notes did not restore the confirmed flag.
--
-- Restores the state migration 20261110090000_grade_scale left:
--   - ssrs_apply_grade_defaults: the previous body (A 90 / B 80 / C 70 / D 60 / E 50, and a fail
--     band at 0; inserted only when a generation has no bands);
--   - every generation's bands: those six;
--   - every scale's confirmed flag: true, as 20261110090000 created every scale. The confirmed_at
--     timestamp the migration overwrote cannot be recovered and is left as it is;
--   - cached student results: made stale (cache_version + 1);
--   - the migration record: removed, so `prisma migrate deploy` can apply it again.
-- Marks, scores and results are not touched (grades are computed on read).
--
-- Run only through the guard, against a database you have approval for, for example:
--   scripts/db-guard.sh ssrs_copy_20261112 "$COPY_URL" psql < packages/database/prisma/reverts/20261113090000_grade_scale_2026_11.sql

BEGIN;

CREATE OR REPLACE FUNCTION ssrs_apply_grade_defaults(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_scale_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM generations WHERE id = p_generation_id) THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation_id;
  END IF;
  INSERT INTO grade_scales (id, generation_id, confirmed, confirmed_at, updated_at)
    VALUES (gen_random_uuid(), p_generation_id, true, now(), now())
    ON CONFLICT (generation_id) DO NOTHING;
  SELECT id INTO v_scale_id FROM grade_scales WHERE generation_id = p_generation_id;
  IF EXISTS (SELECT 1 FROM grade_bands WHERE scale_id = v_scale_id) THEN
    RETURN;
  END IF;
  INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass)
    SELECT gen_random_uuid(), v_scale_id, b.letter, b.min_total, b.is_pass
    FROM (VALUES ('A', 90.00, true), ('B', 80.00, true), ('C', 70.00, true),
                 ('D', 60.00, true), ('E', 50.00, true), ('F', 0.00, false))
      AS b (letter, min_total, is_pass);
  -- Cached student results carry the grade: make them stale.
  UPDATE generations SET cache_version = cache_version + 1 WHERE id = p_generation_id;
END $$;

DROP FUNCTION ssrs_set_official_grade_bands(uuid);

DELETE FROM grade_bands;
INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass)
  SELECT gen_random_uuid(), s.id, b.letter, b.min_total, b.is_pass
  FROM grade_scales s
  CROSS JOIN (VALUES ('A', 90.00, true), ('B', 80.00, true), ('C', 70.00, true),
                     ('D', 60.00, true), ('E', 50.00, true), ('F', 0.00, false))
    AS b (letter, min_total, is_pass);

-- 20261110090000 created every scale confirmed; this migration set confirmed = true as well.
UPDATE grade_scales SET confirmed = true, updated_at = now();

UPDATE generations SET cache_version = cache_version + 1;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113090000_grade_scale_2026_11';

COMMIT;
