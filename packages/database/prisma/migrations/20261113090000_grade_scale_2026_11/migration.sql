-- Official grade scale of 2026-11-12 (docs/decisions.md G5). It supersedes the scale of
-- 2026-11-10 (G1: A 90 / B 80 / C 70 / D 60 / E 50 / F 0) from migration 20261110090000_grade_scale.
--
--   A 85-100, B+ 80 to below 85, B 70 to below 80, C+ 65 to below 70, C 60 to below 65,
--   D 50 to below 60, E 0 to below 50. Lower bound inclusive; there is no F; E is the only fail.
--   Same table as OFFICIAL_GRADE_BANDS in packages/shared/src/grading/letters.ts.
--
-- What it changes: the bands of EVERY generation are replaced with these seven and each scale is
-- marked confirmed (approved 2026-11-12: no scale editor exists, so every stored scale is the
-- default). Each generation's cache_version is bumped so cached student results, which carry the
-- grade, are recomputed. New generations get the same bands. No marks, scores or results are
-- stored or changed: grades are computed when results are read.
--
-- Revert (one transaction): the previous function, bands and cache bump, word for word.
--   BEGIN;
--   CREATE OR REPLACE FUNCTION ssrs_apply_grade_defaults(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $f$
--   DECLARE
--     v_scale_id uuid;
--   BEGIN
--     IF NOT EXISTS (SELECT 1 FROM generations WHERE id = p_generation_id) THEN
--       RAISE EXCEPTION 'generation % does not exist', p_generation_id;
--     END IF;
--     INSERT INTO grade_scales (id, generation_id, confirmed, confirmed_at, updated_at)
--       VALUES (gen_random_uuid(), p_generation_id, true, now(), now())
--       ON CONFLICT (generation_id) DO NOTHING;
--     SELECT id INTO v_scale_id FROM grade_scales WHERE generation_id = p_generation_id;
--     IF EXISTS (SELECT 1 FROM grade_bands WHERE scale_id = v_scale_id) THEN
--       RETURN;
--     END IF;
--     INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass)
--       SELECT gen_random_uuid(), v_scale_id, b.letter, b.min_total, b.is_pass
--       FROM (VALUES ('A', 90.00, true), ('B', 80.00, true), ('C', 70.00, true),
--                    ('D', 60.00, true), ('E', 50.00, true), ('F', 0.00, false))
--         AS b (letter, min_total, is_pass);
--     UPDATE generations SET cache_version = cache_version + 1 WHERE id = p_generation_id;
--   END $f$;
--   DROP FUNCTION ssrs_set_official_grade_bands(uuid);
--   DELETE FROM grade_bands;
--   INSERT INTO grade_bands (id, scale_id, letter, min_total, is_pass)
--     SELECT gen_random_uuid(), s.id, b.letter, b.min_total, b.is_pass
--     FROM grade_scales s
--     CROSS JOIN (VALUES ('A', 90.00, true), ('B', 80.00, true), ('C', 70.00, true),
--                        ('D', 60.00, true), ('E', 50.00, true), ('F', 0.00, false))
--       AS b (letter, min_total, is_pass);
--   UPDATE generations SET cache_version = cache_version + 1;
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113090000_grade_scale_2026_11';
--   COMMIT;

-- Gives a generation the official bands, replacing any it has, and marks its scale confirmed.
CREATE FUNCTION ssrs_set_official_grade_bands(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $$
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

-- A new generation gets the official bands. A generation that already has bands is left alone,
-- so creating one never overwrites a scale.
CREATE OR REPLACE FUNCTION ssrs_apply_grade_defaults(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM generations WHERE id = p_generation_id) THEN
    RAISE EXCEPTION 'generation % does not exist', p_generation_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM grade_bands b JOIN grade_scales s ON s.id = b.scale_id
    WHERE s.generation_id = p_generation_id
  ) THEN
    RETURN;
  END IF;
  PERFORM ssrs_set_official_grade_bands(p_generation_id);
END $$;

-- Every existing generation: the new bands replace the old ones.
SELECT ssrs_set_official_grade_bands(id) FROM generations;
