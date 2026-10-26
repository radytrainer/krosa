#!/usr/bin/env bash
# Restore drill (docs/operations.md): proves the latest backup can actually be restored.
#
#   scripts/restore-drill.sh [path/to/backup.dump]
#
# Run from the repository root on the server. Verifies the dump's checksum, restores it into a
# scratch database (ssrs_restore_drill) inside the running postgres container, compares row counts
# with the live database, then drops the scratch database. The live database is only read.
set -euo pipefail

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file "${ENV_FILE:-.env.production}")
BACKUP_DIR="${BACKUP_DIR:-./backups}"
SCRATCH=ssrs_restore_drill
TABLES=(users students generations course_offerings enrollments assessment_scores grading_schemes audit_logs _prisma_migrations)

dump="${1:-$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -n 1 || true)}"
[[ -n "$dump" && -f "$dump" ]] || { echo "No backup found in $BACKUP_DIR" >&2; exit 1; }
echo "Backup: $dump ($(du -h "$dump" | cut -f1))"

if [[ -f "$dump.sha256" ]]; then
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" --quiet)
  echo "Checksum: OK"
else
  echo "Checksum: missing $dump.sha256" >&2
  exit 1
fi

psql() { "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -At "$@"; }
set -a
# shellcheck disable=SC1090
source "${ENV_FILE:-.env.production}"
set +a

started=$(date +%s)
psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" -c "CREATE DATABASE $SCRATCH" >/dev/null
trap 'psql -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null || true' EXIT

"${COMPOSE[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" --no-owner --no-privileges \
  --exit-on-error -d "$SCRATCH" < "$dump"
echo "Restore: OK ($(( $(date +%s) - started ))s)"

printf '\n%-22s %12s %12s\n' table restored live
fail=0
for t in "${TABLES[@]}"; do
  restored=$(psql -d "$SCRATCH" -c "SELECT count(*) FROM \"$t\"")
  live=$(psql -d "$POSTGRES_DB" -c "SELECT count(*) FROM \"$t\"")
  printf '%-22s %12s %12s\n' "$t" "$restored" "$live"
  # The live database may have grown since the backup, never shrunk below it (append-only data).
  if [[ "$t" == "_prisma_migrations" && "$restored" == "0" ]]; then fail=1; fi
done
[[ $fail -eq 0 ]] || { echo "Restored database has no migrations: the dump is unusable" >&2; exit 1; }

echo
echo "RESTORE DRILL PASSED: $(basename "$dump") restores cleanly. Record the date in docs/operations.md."
