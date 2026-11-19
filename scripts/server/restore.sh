#!/usr/bin/env bash
# Restores an encrypted backup (backup.sh) into a NEW database (docs/runbook.md "Restore a backup").
# Runs as root on the server.
#
#   restore.sh --identity <age key file> (--s3-key <key> | --file <path>) [--target-db <name>]
#   restore.sh ... --replace-live            # also make the restored copy the live database
#
#   --identity    your age PRIVATE key, copied to the server only for this run. Put it in /dev/shm
#                 (memory, never on disk): it is shredded there when the script ends.
#   --s3-key      object key in BACKUP_BUCKET, e.g. beta/daily/ssrs-20270105T193000Z-daily.dump.age
#   --file        a local encrypted file instead (backup.sh --local-dir)
#   --target-db   name of the new database (default ssrs_restore_<UTC time>). Must not exist.
#
# Without --replace-live, the live database and the running app are never touched: the backup is
# restored next to them, row counts are printed, and the copy stays for you to inspect (drop it
# when done; the command is printed at the end).
#
# --replace-live (data loss or corruption only) asks you to type the live database name, stops
# api, worker and web, renames the live database to ssrs_before_restore_<time> (kept, not
# deleted), renames the restored copy to the live name, and starts the app again.
set -Eeuo pipefail
umask 077

ROOT=/opt/ssrs
ENV_FILE="${SSRS_ENV_FILE:-$ROOT/.env}"
PROJECT="${SSRS_PROJECT:-ssrs}"
TABLES=(users students generations terms student_terms course_offerings enrollments assessment_scores audit_logs _prisma_migrations)

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

identity="" s3_key="" file="" stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="ssrs_restore_${stamp,,}"
replace_live=0
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) identity="${2:?}"; shift 2 ;;
    --s3-key) s3_key="${2:?}"; shift 2 ;;
    --file) file="${2:?}"; shift 2 ;;
    --target-db) target="${2:?}"; shift 2 ;;
    --replace-live) replace_live=1; shift ;;
    *) die "unknown option: $1" ;;
  esac
done

cleanup() {
  [ -n "${work:-}" ] && rm -rf -- "$work"
  # The private key never stays on the server.
  if [ -n "$identity" ] && [ -f "$identity" ]; then
    shred -u "$identity" 2>/dev/null || rm -f -- "$identity"
    log "shredded $identity"
  fi
}

# The private key may only come from memory (/dev/shm), and is shredded when the script ends.
if [ -n "$identity" ]; then identity="$(realpath -e -- "$identity" 2>/dev/null || true)"; fi
if [ -z "$identity" ] || [ ! -f "$identity" ]; then die "--identity: file not found"; fi
[[ "$identity" == /dev/shm/* ]] || die "--identity must be a file in /dev/shm (memory), not on disk"
trap cleanup EXIT
[ -n "$s3_key" ] || [ -n "$file" ] || die "give --s3-key or --file"
[ -z "$s3_key" ] || [ -z "$file" ] || die "give only one of --s3-key and --file"
[[ "$target" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "--target-db: lower-case letters, digits and _ only"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE"
live_db="$(env_get POSTGRES_DB)"
[[ "$live_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_DB in $ENV_FILE is missing or not a plain name"
[ "$target" != "$live_db" ] || die "the target must be a NEW database, not the live '$live_db'"
case "$target" in postgres | template0 | template1) die "refusing target '$target'" ;; esac

cid="$(docker ps -q -f "label=com.docker.compose.project=$PROJECT" -f label=com.docker.compose.service=postgres -f status=running)"
[ -n "$cid" ] || die "the postgres container is not running"
psql_in() { docker exec -i "$cid" sh -c 'exec psql -v ON_ERROR_STOP=1 -X -q -At -U "$POSTGRES_USER" "$@"' psql "$@"; }

if [ "$(psql_in -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$target'")" != 0 ]; then
  die "database '$target' already exists; choose another --target-db"
fi

work="$(mktemp -d /var/lib/ssrs-backup/restore.XXXXXX 2>/dev/null || mktemp -d)"
if [ -n "$s3_key" ]; then
  [[ "$s3_key" =~ ^[A-Za-z0-9/._-]+\.dump\.age$ ]] || die "--s3-key does not look like a backup key"
  bucket="$(env_get BACKUP_BUCKET)" region="$(env_get AWS_REGION)"
  if [ -z "$bucket" ] || [ -z "$region" ]; then die "set BACKUP_BUCKET and AWS_REGION in $ENV_FILE"; fi
  file="$work/backup.dump.age"
  log "downloading s3://$bucket/$s3_key"
  AWS_REGION="$region" AWS_PAGER="" "$(command -v aws || echo /snap/bin/aws)" s3 cp --only-show-errors \
    "s3://$bucket/$s3_key" "$file"
fi
[ -f "$file" ] || die "backup file not found: $file"
[ "$(head -c 21 "$file")" = "age-encryption.org/v1" ] || die "not an age-encrypted backup: $file"

log "creating database $target"
psql_in -d postgres -c "CREATE DATABASE \"$target\""
log "decrypting and restoring into $target (the live database '$live_db' is not touched)"
started=$SECONDS
if ! age -d -i "$identity" "$file" |
  docker exec -i "$cid" sh -c 'exec pg_restore -U "$POSTGRES_USER" --no-owner --no-privileges --exit-on-error -d "$1"' pg_restore "$target"; then
  log "restore failed; dropping the incomplete copy $target"
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$target\"" || true
  die "restore failed (wrong key, damaged file, or a PostgreSQL error above)"
fi
log "restored in $((SECONDS - started))s"

printf '\n%-22s %12s %12s\n' table restored live
for t in "${TABLES[@]}"; do
  r="$(psql_in -d "$target" -c "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo '-')"
  l="$(psql_in -d "$live_db" -c "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo '-')"
  printf '%-22s %12s %12s\n' "$t" "$r" "$l"
done
migrations="$(psql_in -d "$target" -c 'SELECT count(*) FROM "_prisma_migrations"' 2>/dev/null || echo 0)"
[ "$migrations" -gt 0 ] || die "the restored database has no migrations: the backup is unusable"
echo

if [ "$replace_live" -ne 1 ]; then
  log "RESTORE OK into '$target'. The live database is unchanged."
  log "inspect it, then drop it: docker exec $cid sh -c 'dropdb -U \"\$POSTGRES_USER\" $target'"
  exit 0
fi

# --- Replace the live database (explicit flag + typed confirmation) ---------------------------
[ -t 0 ] || die "--replace-live needs an interactive terminal for the confirmation"
printf 'This makes the backup the LIVE database. Users lose every change since the backup.\n'
printf "The current live database is kept as ssrs_before_restore_%s.\n" "${stamp,,}"
printf "Type the live database name (%s) to continue: " "$live_db"
read -r answer
[ "$answer" = "$live_db" ] || die "confirmation did not match; nothing changed (restored copy kept as '$target')"

current="$(readlink -f "$ROOT/current")"
tag="$(cat "$ROOT/state/deployed-tag")"
compose() {
  (
    set -a
    # shellcheck source=/dev/null
    . "$current/digests.env"
    set +a
    IMAGE_TAG="$tag" docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$current/compose.yml" "$@"
  )
}
log "stopping api, worker and web"
compose stop api worker web
kept="ssrs_before_restore_${stamp,,}"
app_role="${live_db}_app"
# A backup from before the application role (migration 20261118120000_app_role) cannot serve the
# current release, which connects as that role: refuse before anything changes.
if [ "$(psql_in -d "$target" -c "SELECT to_regprocedure('ssrs_grant_app_role()') IS NOT NULL")" != t ]; then
  die "this backup predates the application role; nothing was replaced. Restored copy kept as '$target'. See docs/runbook.md \"Restore a backup\""
fi
psql_in -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$live_db', '$target') AND pid <> pg_backend_pid()" \
  -c "ALTER DATABASE \"$live_db\" RENAME TO \"$kept\"" \
  -c "ALTER DATABASE \"$target\" RENAME TO \"$live_db\"" >/dev/null
# Backups are taken with --no-privileges: give the application role its grants on the restored
# database (the role itself and its password are cluster-wide and unchanged).
psql_in -d "$live_db" -c "SELECT ssrs_grant_app_role()" >/dev/null
# The kept copy still carries the old grants: the application role must not read it.
psql_in -d postgres -c "REVOKE ALL ON DATABASE \"$kept\" FROM PUBLIC, \"$app_role\"" >/dev/null
log "live database is now the backup; the previous one is kept as '$kept'"
compose up -d --wait --wait-timeout 300 api worker web
log "app started. Re-run each term's sync to bring marks up to date (docs/runbook.md)."
