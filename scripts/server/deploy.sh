#!/usr/bin/env bash
# Deploys one release on the beta server (docs/deployment.md §5). Runs as root, started by
# /usr/local/sbin/ssrs-deploy (installed by bootstrap.sh), which the SSM document SSRS-Beta-Deploy
# calls. ssrs-deploy holds the deploy lock, has pulled the api image BY DIGEST, extracted this
# script and its bundle to /opt/ssrs/releases/<sha>/ and written the three image digests to
# /opt/ssrs/releases/<sha>/digests.env. Images are only ever run by digest, so re-tagging an image
# in the registry cannot change what runs here.
#
#   deploy.sh <40-character commit sha>
#
# Steps, stopping at the first failure:
#   1. pull the three images of <sha> by digest (and the pinned caddy/postgres/redis if missing)
#   2. back up the database to S3 (backup.sh, the same script as the daily timer) and confirm it
#      arrived. Required whenever the database volume exists; skipped only on the very first
#      deploy, when there is no database yet.
#   3. run the migrations from the NEW api image as a one-off container, as the database owner,
#      then give the restricted application role its login and grants (APP_DB_PASSWORD). If
#      either fails: stop here; the running release is untouched.
#   4. start the new release and wait until every health check passes
#   5. if a health check fails: start the previous release again, report, exit 1
#   6. record the tag (/opt/ssrs/state), point /opt/ssrs/current at the release, install the
#      systemd timers of this release
#
# Migrations only go forward: step 5 rolls back images, not the schema. If a migrated database
# is damaged, restore the backup from step 2 (docs/runbook.md "Restore a backup").
#
# Output goes to SSM and the GitHub job log: it never prints .env values or container logs (the
# logs of a failed release are kept in /opt/ssrs/state/last-failure.log on the server).
set -Eeuo pipefail
export HOME="${HOME:-/root}"

ROOT=/opt/ssrs
ENV_FILE="$ROOT/.env"
STATE="$ROOT/state"
HEALTH_TIMEOUT="${DEPLOY_HEALTH_TIMEOUT:-300}"
KEEP_RELEASES=3
PROJECT=ssrs

log() { printf '%s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

tag="${1:-}"
previous=""
reported=0
summary() {
  printf 'DEPLOY_RESULT=%s\nDEPLOYED_TAG=%s\nPREVIOUS_TAG=%s\n' "$1" "$2" "${previous:-none}"
  reported=1
}
# Any exit without a result (pull, backup or postgres failure): nothing was changed.
# shellcheck disable=SC2317  # called by the EXIT trap
on_exit() {
  local code=$?
  if [ "$reported" = 0 ]; then summary FAILED_BEFORE_CHANGE "${previous:-none}"; fi
  exit "$code"
}
trap on_exit EXIT

[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "expected a full 40-character commit sha"
[ "$(id -u)" -eq 0 ] || die "run as root"
release="$ROOT/releases/$tag"
if [ ! -f "$release/compose.yml" ] || [ ! -f "$release/digests.env" ]; then
  die "release bundle missing: $release (deploy with ssrs-deploy, not this script)"
fi

# The env file must exist and be readable by root only.
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing (docs/beta-checklist.md step 14)"
[ "$(stat -c '%u %a' "$ENV_FILE")" = "0 600" ] || die "$ENV_FILE must be owner root, mode 600"

# ssrs-deploy already holds the lock on fd 9; a manual run takes it here.
if ! { true >&9; } 2>/dev/null; then exec 9>/run/ssrs-deploy.lock; fi
flock -n 9 || die "another deploy is running"

install -d -m 700 "$STATE"
previous="$(cat "$STATE/deployed-tag" 2>/dev/null || true)"
# Redeploying the live tag: the release to fall back to is the one before it.
fallback="$previous"
if [ "$fallback" = "$tag" ]; then fallback="$(cat "$STATE/previous-tag" 2>/dev/null || true)"; fi

compose() {
  local t="$1"
  shift
  (
    set -a
    # shellcheck source=/dev/null
    . "$ROOT/releases/$t/digests.env"
    set +a
    IMAGE_TAG="$t" docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
      -f "$ROOT/releases/$t/compose.yml" "$@"
  )
}

log "release $tag (live: ${previous:-none})"

# --- 1. Pull --------------------------------------------------------------------------------
log "step 1/6: pulling images by digest"
compose "$tag" pull --quiet api worker web
# Pinned by digest in compose.yml: pulled once, then reused (no Docker Hub call on every deploy).
compose "$tag" pull --quiet --policy missing caddy postgres redis

# --- 2. Backup ------------------------------------------------------------------------------
if docker volume inspect "${PROJECT}_postgres-data" >/dev/null 2>&1; then
  log "step 2/6: backing up the database before any change"
  compose "$tag" up -d --wait --wait-timeout 120 postgres redis || die "postgres/redis did not become healthy"
  "$release/bin/backup.sh" --reason "predeploy-${tag:0:12}" || die "backup failed; nothing was changed"
else
  log "step 2/6: no database volume yet (first deploy): nothing to back up"
fi

# --- 3. Migrations --------------------------------------------------------------------------
log "step 3/6: migrations from the new api image"
compose "$tag" up -d --wait --wait-timeout 120 postgres redis || die "postgres/redis did not become healthy"
# Connection URLs are masked in case Prisma ever prints one.
if ! compose "$tag" run --rm --no-deps migrate 2>&1 | sed -E 's#://[^@[:space:]/]*@#://***@#g'; then
  summary FAILED_MIGRATION "${previous:-none}"
  die "migrations failed; the running release (${previous:-none}) was left as it is (docs/runbook.md \"A migration failed\")"
fi
# The application role (api, worker): LOGIN, password and grants. Idempotent, prints no secret.
if ! compose "$tag" run --rm --no-deps migrate node node_modules/@ssrs/database/dist/cli/app-role.js 2>&1 |
  sed -E 's#://[^@[:space:]/]*@#://***@#g'; then
  summary FAILED_MIGRATION "${previous:-none}"
  die "setting up the application role failed; the running release (${previous:-none}) was left as it is"
fi

# --- 4. Start -------------------------------------------------------------------------------
log "step 4/6: starting $tag and waiting for health checks (up to ${HEALTH_TIMEOUT}s)"
if compose "$tag" up -d --wait --wait-timeout "$HEALTH_TIMEOUT" --remove-orphans; then
  # --- 6. Record ----------------------------------------------------------------------------
  log "step 6/6: recording the release"
  if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then printf '%s\n' "$previous" >"$STATE/previous-tag"; fi
  printf '%s\n' "$tag" >"$STATE/deployed-tag"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" >>"$STATE/history"
  ln -sfn "$release" "$ROOT/current.tmp" && mv -T "$ROOT/current.tmp" "$ROOT/current"

  # Timers of this release (backup, disk check); enabled from the first deploy on. The release is
  # already live here, so a problem with the timers is reported but does not fail the deploy.
  timers_ok=1
  if ! { install -m 0644 "$release"/systemd/* /etc/systemd/system/ &&
    systemctl daemon-reload &&
    systemctl enable --quiet --now ssrs-backup.timer ssrs-disk.timer; }; then
    timers_ok=0
    log "WARNING: could not install or enable the backup and disk timers; see docs/runbook.md"
  fi

  # Keep the last releases (and their images) for rollbacks; drop older ones.
  keep="$(awk '{print $2}' "$STATE/history" | tac | awk '!seen[$0]++' | head -n "$KEEP_RELEASES")"
  for dir in "$ROOT"/releases/*/; do
    old="$(basename "$dir")"
    grep -qx "$old" <<<"$keep" && continue
    [ "$old" = "$(cat "$STATE/previous-tag" 2>/dev/null || true)" ] && continue
    images="$(compose "$old" config --images 2>/dev/null || true)"
    rm -rf -- "${ROOT:?}/releases/$old"
    for img in $images; do
      case "$img" in *-api:* | *-worker:* | *-web:*) docker image rm -f "$img" >/dev/null 2>&1 || true ;; esac
    done
  done
  docker image prune -f >/dev/null 2>&1 || true

  summary OK "$tag"
  [ "$timers_ok" = 1 ] || echo 'DEPLOY_WARNING=timers'
  log "OK: $tag is live"
  exit 0
fi

# --- 5. Roll back ---------------------------------------------------------------------------
failure_log="$STATE/last-failure.log"
{
  echo "release $tag failed its health checks at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  compose "$tag" ps -a || true
  for svc in api web worker caddy; do
    echo "--- $svc"
    compose "$tag" logs --no-color --tail 100 "$svc" 2>&1 || true
  done
} >"$failure_log" 2>&1
chmod 600 "$failure_log"
log "step 5/6: health checks failed for $tag (container logs: $failure_log on the server)"
compose "$tag" ps -a --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | sed 's/^/    /' || true

if [ -n "$fallback" ] && [ "$fallback" != "$tag" ] && [ -f "$ROOT/releases/$fallback/digests.env" ]; then
  log "rolling back to $fallback (images only; migrations stay applied)"
  if compose "$fallback" up -d --wait --wait-timeout "$HEALTH_TIMEOUT" --remove-orphans; then
    printf '%s\n' "$fallback" >"$STATE/deployed-tag"
    ln -sfn "$ROOT/releases/$fallback" "$ROOT/current.tmp" && mv -T "$ROOT/current.tmp" "$ROOT/current"
    summary ROLLED_BACK "$fallback"
    die "release $tag failed its health checks; $fallback is running again"
  fi
  summary ROLLBACK_FAILED "$fallback"
  die "release $tag failed AND the rollback to $fallback failed: see docs/runbook.md now"
fi
summary FAILED "none"
die "release $tag failed its health checks and there is no earlier release to go back to"
