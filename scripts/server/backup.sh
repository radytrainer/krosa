#!/usr/bin/env bash
# Encrypted PostgreSQL backup to S3 (docs/runbook.md "Backups"). Runs as root: daily from
# ssrs-backup.timer, and before every deploy (deploy.sh step 2).
#
#   backup.sh [--reason <word>] [--local-dir <dir>]
#
#   --reason      added to the file name (e.g. predeploy-<sha>); default: daily
#   --local-dir   write the encrypted file there instead of uploading (restore tests, no S3)
#
# 1. pg_dump inside the postgres container, custom format, compressed
# 2. encrypted with age to the PUBLIC key(s) in /opt/ssrs/backup/age-recipients.txt; the private
#    key is kept off the server, so the server cannot read its own backups
# 3. uploaded with the instance's IAM role (no keys on the server) to
#    s3://$BACKUP_BUCKET/$BACKUP_PREFIX/daily/ (kept 14 days by a lifecycle rule) and, on Sundays,
#    also to .../weekly/ (kept 8 weeks); then confirmed with a HEAD request (size must match)
#
# Failures: non-zero exit (the systemd unit fails and ssrs-alert@ logs it), a "backup: FAILED"
# journal line, and a /fail ping to HEALTHCHECKS_BACKUP_URL when set. Success pings it too, so a
# backup that never runs also alerts. Unencrypted data never touches the disk.
set -Eeuo pipefail
umask 077

ROOT=/opt/ssrs
ENV_FILE="${SSRS_ENV_FILE:-$ROOT/.env}"
RECIPIENTS="${SSRS_AGE_RECIPIENTS:-$ROOT/backup/age-recipients.txt}"
WORK_BASE=/var/lib/ssrs-backup
PROJECT="${SSRS_PROJECT:-ssrs}"

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

reason=daily
local_dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reason) reason="${2:?}"; shift 2 ;;
    --local-dir) local_dir="${2:?}"; shift 2 ;;
    *) log "unknown option: $1"; exit 2 ;;
  esac
done
[[ "$reason" =~ ^[a-z0-9-]{1,40}$ ]] || { log "--reason: lower-case letters, digits and - only"; exit 2; }

hc_url="$(env_get HEALTHCHECKS_BACKUP_URL || true)"
ping_hc() {
  if [ -n "$hc_url" ]; then curl -fsS -m 10 --retry 3 -o /dev/null "$hc_url$1" 2>/dev/null || true; fi
}
on_error() {
  log "FAILED (line $1); no backup was stored by this run"
  ping_hc /fail
}
trap 'on_error $LINENO' ERR

[ -f "$ENV_FILE" ] || { log "missing $ENV_FILE"; false; }
grep -q '^age1[0-9a-z]\{58\}$' "$RECIPIENTS" 2>/dev/null ||
  { log "no age public key in $RECIPIENTS (docs/beta-checklist.md step 16)"; false; }
command -v age >/dev/null || { log "age is not installed (run bootstrap.sh)"; false; }

cid="$(docker ps -q -f "label=com.docker.compose.project=$PROJECT" -f label=com.docker.compose.service=postgres -f status=running)"
[ -n "$cid" ] || { log "the postgres container is not running"; false; }

install -d -m 700 "$WORK_BASE"
work="$(mktemp -d "$WORK_BASE/run.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="ssrs-$stamp-$reason.dump.age"
file="$work/$name"

log "dumping and encrypting ($reason)"
# Inside the container, pg_dump uses the local socket as the database owner (no password needed).
docker exec "$cid" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-privileges' |
  age -R "$RECIPIENTS" -o "$file"
size="$(stat -c %s "$file")"
[ "$size" -gt 1024 ] || { log "the encrypted dump is suspiciously small ($size bytes)"; false; }
[ "$(head -c 21 "$file")" = "age-encryption.org/v1" ] || { log "output is not an age file"; false; }

if [ -n "$local_dir" ]; then
  install -d -m 700 "$local_dir"
  mv "$file" "$local_dir/$name"
  log "OK: $local_dir/$name ($size bytes)"
  if [ "$reason" = daily ]; then ping_hc ""; fi
  exit 0
fi

bucket="$(env_get BACKUP_BUCKET)"
prefix="$(env_get BACKUP_PREFIX)"
region="$(env_get AWS_REGION)"
if [ -z "$bucket" ] || [ -z "$prefix" ] || [ -z "$region" ]; then
  log "set BACKUP_BUCKET, BACKUP_PREFIX and AWS_REGION in $ENV_FILE"
  false
fi
export AWS_REGION="$region" AWS_DEFAULT_REGION="$region" AWS_PAGER=""
aws_bin="$(command -v aws || echo /snap/bin/aws)"

upload() {
  local key="$prefix/$1/$name"
  "$aws_bin" s3api put-object --bucket "$bucket" --key "$key" --body "$file" \
    --server-side-encryption AES256 --content-type application/octet-stream \
    --query ETag --output text >/dev/null
  local stored
  stored="$("$aws_bin" s3api head-object --bucket "$bucket" --key "$key" --query ContentLength --output text)"
  [ "$stored" = "$size" ] || { log "s3://$bucket/$key has $stored bytes, expected $size"; return 1; }
  log "OK: s3://$bucket/$key ($size bytes, confirmed)"
}

upload daily
# Sunday (ISO day 7, UTC): also a weekly copy, kept 8 weeks.
if [ "$(date -u +%u)" = 7 ] && [ "$reason" = daily ]; then upload weekly; fi
# Only the daily run reports success, so a deploy backup cannot hide a stopped timer.
if [ "$reason" = daily ]; then ping_hc ""; fi
