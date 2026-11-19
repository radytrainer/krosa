#!/usr/bin/env bash
# OnFailure handler (ssrs-alert@.service): writes one error-priority journal line for a failed
# unit, so `journalctl -p err -t ssrs-alert` lists every backup or disk-check failure. The
# healthchecks.io pings in backup.sh and check-disk.sh are what reach a person (email).
set -euo pipefail
unit="${1:-unknown}"
logger -p user.err -t ssrs-alert "unit $unit failed; see: journalctl -u $unit -n 50"
