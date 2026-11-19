#!/usr/bin/env bash
# Hourly resource check (ssrs-disk.timer; docs/runbook.md "Out of disk or memory").
#
# Fails (exit 1, systemd marks the unit failed, ssrs-alert@ logs it, /fail ping) when a file
# system holding the app is above DISK_WARN_PERCENT (default 80). Also logs swap use: swap that
# stays above 500 MB is the signal to move from t3.micro to t3.small (docs/runbook.md).
set -Eeuo pipefail

ENV_FILE="${SSRS_ENV_FILE:-/opt/ssrs/.env}"
env_get() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
log() { printf '%s check-disk: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

limit="$(env_get DISK_WARN_PERCENT || true)"
limit="${limit:-80}"
hc_url="$(env_get HEALTHCHECKS_DISK_URL || true)"

status=0
for path in / /var/lib/docker; do
  [ -d "$path" ] || continue
  used="$(df --output=pcent "$path" | tail -n 1 | tr -dc '0-9')"
  if [ "$used" -gt "$limit" ]; then
    log "WARNING: $path is ${used}% full (limit ${limit}%)"
    status=1
  else
    log "$path ${used}% used"
  fi
done

swap_kb="$(awk '/^SwapTotal:/{t=$2} /^SwapFree:/{f=$2} END{print t-f}' /proc/meminfo)"
avail_kb="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
log "memory available $((avail_kb / 1024)) MB, swap used $((swap_kb / 1024)) MB"
[ "$swap_kb" -le $((500 * 1024)) ] || log "NOTICE: swap above 500 MB; if this persists, move to t3.small"

if [ -n "$hc_url" ]; then
  if [ "$status" -eq 0 ]; then suffix=""; else suffix="/fail"; fi
  curl -fsS -m 10 --retry 3 -o /dev/null "$hc_url$suffix" 2>/dev/null || true
fi
exit "$status"
