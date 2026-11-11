-- Official letter grades (docs/decisions.md G1–G4). Replaces the D5 placeholder (A 85 / B 70 /
-- C 50 / F below 50), which was never written to the database. Minimum-score thresholds, so there
-- are no gaps: A 90, B 80, C 70, D 60, E 50, F 0. The same list is OFFICIAL_GRADE_BANDS in
-- packages/shared/src/grading/letters.ts.

-- Gives a generation the official scale, confirmed. A generation that already has bands is left
-- alone, so it never overwrites a scale an admin edited.
CREATE FUNCTION ssrs_apply_grade_defaults(p_generation_id uuid) RETURNS void LANGUAGE plpgsql AS $$
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

SELECT ssrs_apply_grade_defaults(id) FROM generations;
