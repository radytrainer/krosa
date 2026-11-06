#!/usr/bin/env bash
# Deploys one release on the server (docs/deployment.md §8.7). Called by the `deploy` job in
# .github/workflows/ci.yml over SSH, or by hand:
#
#   scripts/deploy.sh <commit-sha>            # images ghcr.io/...-{api,worker,web,migrate}:<sha>
#   scripts/deploy.sh --rollback              # back to the release before the current one
#
# Over SSH the CI key is pinned to this script with a forced command in ~/.ssh/authorized_keys,
# so the key can do nothing else; the requested sha arrives in SSH_ORIGINAL_COMMAND and a
# short-lived registry token (the job's GITHUB_TOKEN) on stdin. The token is used for one
# `docker login`, then logged out: nothing long-lived is stored on the server.
#
# Steps: check out the commit (compose file and Caddyfile match the images) → backup → pull →
# migrate + restart → wait until api and web are healthy → on failure, restart the previous
# images. Migrations are forward-only: if a failed release already migrated, the rollback may
# need the backup taken in step 2 (docs/operations.md §2).
#
# Everything is inside main() so bash has read the whole file before `git checkout` replaces it.
set -euo pipefail

main() {
  local app_dir="${SSRS_DIR:-/opt/ssrs}"
  local health_timeout="${DEPLOY_HEALTH_TIMEOUT:-180}"
  cd "$app_dir"

  log() { printf '%s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
  die() { log "ERROR: $*"; exit 1; }

  # --- Arguments: from the forced SSH command, or from the command line --------------------
  local request="${SSH_ORIGINAL_COMMAND:-${*:-}}"
  local -a words
  read -r -a words <<<"$request"
  [ "${words[0]:-}" = "deploy" ] && words=("${words[@]:1}")
  local target="${words[0]:-}"

  [ -f .env.production ] || die ".env.production is missing in $app_dir"
  [ -f .env.deploy ] || die ".env.deploy is missing (IMAGE_PREFIX=...); see docs/deployment.md §8.6"
  # shellcheck disable=SC1091
  . ./.env.deploy
  : "${IMAGE_PREFIX:?Set IMAGE_PREFIX in .env.deploy}"

  local previous="${IMAGE_TAG:-}"
  if [ "$target" = "--rollback" ]; then
    [ -s .deploy-history ] || die "no earlier release recorded in .deploy-history"
    target="$(tail -n 2 .deploy-history | head -n 1)"
    [ "$target" != "$previous" ] || die "only one release recorded; nothing to roll back to"
    log "rolling back from ${previous:-none} to $target"
  fi
  [[ "$target" =~ ^[0-9a-f]{40}$ ]] || die "expected a full 40-character commit sha, got '${target}'"

  local -a compose=(docker compose -f docker-compose.prod.yml --env-file .env.production --env-file .env.deploy)

  # --- 1. Registry login (only when CI passes a token on stdin) -----------------------------
  local logged_in=0
  if [ ! -t 0 ]; then
    local token=""
    IFS= read -r token || true
    if [ -n "$token" ]; then
      local registry="${IMAGE_PREFIX%%/*}"
      printf '%s' "$token" | docker login "$registry" -u "${REGISTRY_USER:-ci}" --password-stdin >/dev/null
      logged_in=1
      # shellcheck disable=SC2064
      trap "docker logout '$registry' >/dev/null 2>&1 || true" EXIT
    fi
  fi

  # --- 2. Same commit as the images ---------------------------------------------------------
  log "checking out $target"
  git fetch --quiet origin
  git -c advice.detachedHead=false checkout --quiet --detach "$target"

  # --- 3. Backup before anything changes (skipped on the very first deploy) -----------------
  if "${compose[@]}" ps --status running --services 2>/dev/null | grep -qx backup; then
    log "taking a backup"
    "${compose[@]}" exec -T backup sh /usr/local/bin/backup.sh --once
  fi

  # --- 4. Pull and start --------------------------------------------------------------------
  set_tag() { sed -i '/^IMAGE_TAG=/d' .env.deploy && printf 'IMAGE_TAG=%s\n' "$1" >>.env.deploy; }
  start() {
    # Only the application images; caddy, postgres and redis are pulled once (when missing) and
    # updated on purpose, not on every release.
    "${compose[@]}" pull --quiet api worker web migrate
    "${compose[@]}" up -d --no-build --remove-orphans
  }
  healthy() {
    local deadline=$((SECONDS + health_timeout)) svc id state
    while [ $SECONDS -lt $deadline ]; do
      local ok=1
      for svc in api web; do
        id="$("${compose[@]}" ps -q "$svc")"
        state="$([ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)"
        [ "$state" = "healthy" ] || ok=0
      done
      local migrate_id migrate_state
      migrate_id="$("${compose[@]}" ps -aq migrate)"
      migrate_state="$([ -n "$migrate_id" ] && docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$migrate_id" || true)"
      if [[ "$migrate_state" == exited* ]] && [ "$migrate_state" != "exited 0" ]; then
        log "migrate failed:"; "${compose[@]}" logs --tail 50 migrate; return 1
      fi
      [ $ok = 1 ] && return 0
      sleep 5
    done
    log "not healthy after ${health_timeout}s:"; "${compose[@]}" ps -a; return 1
  }

  set_tag "$target"
  log "starting $IMAGE_PREFIX-*:$target"
  if start && healthy; then
    printf '%s\n' "$target" >>.deploy-history
    tail -n 20 .deploy-history >.deploy-history.tmp && mv .deploy-history.tmp .deploy-history
    docker image prune -f --filter "until=168h" >/dev/null || true
    log "OK: $target is live"
    return 0
  fi

  # --- 5. Roll back -------------------------------------------------------------------------
  if [ -n "$previous" ] && [ "$previous" != "$target" ]; then
    log "release failed; restarting previous release $previous"
    git -c advice.detachedHead=false checkout --quiet --detach "$previous" || true
    set_tag "$previous"
    if start && healthy; then
      log "rolled back to $previous"
    else
      log "ROLLBACK ALSO FAILED: check '${compose[*]} ps -a' and logs now"
    fi
  fi
  die "deploy of $target failed"
}

main "$@"
exit
