-- Protected accounts (docs/decisions.md RP10, 2026-11-15): a sheet replacement never deletes an
-- account whose name an admin corrected, or one that has ever been used. This column marks the
-- first; users.status, password_changed_at and last_login_at mark the second.
ALTER TABLE "students" ADD COLUMN "name_edited_at" TIMESTAMPTZ(3);

-- Backfill from the audit log: the earliest name change of each student.
UPDATE "students" s
   SET "name_edited_at" = a.first_change
  FROM (
    SELECT entity_id, MIN(created_at) AS first_change
      FROM "audit_logs"
     WHERE action = 'student.name.changed'
       AND entity_type = 'student'
     GROUP BY entity_id
  ) a
 WHERE a.entity_id = s.id::text;
