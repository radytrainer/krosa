#!/bin/sh
# Nightly PostgreSQL backups (docs/operations.md). Runs in the `backup` service of
# docker-compose.prod.yml: sleeps until BACKUP_TIME (UTC, HH:MM), writes a custom-format dump
# with a SHA-256 checksum to /backups, and deletes dumps older than BACKUP_RETENTION_DAYS.
#
#   backup.sh          loop forever (the service's command)
#   backup.sh --once   take one backup now and exit
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${PGPASSWORD:?}"
BACKUP_TIME="${BACKUP_TIME:-02:30}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DIR=/backups

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

backup_once() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  file="$DIR/${PGDATABASE}-${stamp}.dump"
  tmp="$file.partial"
  log "dumping $PGDATABASE to $file"
  # Custom format: compressed, restorable selectively with pg_restore.
  pg_dump --format=custom --no-owner --no-privileges --file="$tmp" "$PGDATABASE"
  mv "$tmp" "$file"
  (cd "$DIR" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256")
  log "done ($(du -h "$file" | cut -f1))"
  find "$DIR" -name "${PGDATABASE}-*.dump*" -type f -mtime +"$BACKUP_RETENTION_DAYS" -print -delete |
    sed 's/^/pruned: /'
}

seconds_until() {
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $1:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  echo $((next - now))
}

mkdir -p "$DIR"
if [ "${1:-}" = "--once" ]; then
  backup_once
  exit 0
fi

log "scheduled daily at $BACKUP_TIME UTC, keeping $BACKUP_RETENTION_DAYS days"
while true; do
  sleep "$(seconds_until "$BACKUP_TIME")"
  backup_once || log "FAILED (see above); will retry at the next scheduled time"
done
