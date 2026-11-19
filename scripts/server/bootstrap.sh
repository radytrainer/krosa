#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 EC2 instance for the SSRS beta (docs/beta-checklist.md step 12).
# Run once as root through Systems Manager (Run Command or a Session Manager shell). Safe to run
# again: every step checks before it changes anything.
#
# It installs and configures: security updates and unattended-upgrades, a 2 GB swap file, UTC,
# Docker Engine and the Compose plugin from Docker's repository, Docker log rotation, ufw (80 and
# 443 only), hardened SSH (then turned off: Session Manager is the way in), the SSM agent check,
# the AWS CLI and age (backups), the /opt/ssrs layout, and /usr/local/sbin/ssrs-deploy (the
# command the SSM deploy document runs).
#
# It does NOT create secrets, write /opt/ssrs/.env, log in to a registry, or start the app.
#
# Set KEEP_SSH=1 to leave the SSH service running (port 22 stays closed in ufw and the security
# group either way).
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

log() { printf '==> %s\n' "$*"; }
die() { printf 'bootstrap: ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  die "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
fi

ROOT=/opt/ssrs
SECRETS_GROUP=ssrs-secrets
SECRETS_GID=2000

# --- Packages and security updates -----------------------------------------------------------
log "security updates"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg ufw unattended-upgrades age jq
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
# Security updates only (Ubuntu's default origins); no automatic reboot.
systemctl enable --now unattended-upgrades >/dev/null

# --- Time ------------------------------------------------------------------------------------
log "timezone UTC"
timedatectl set-timezone UTC
timedatectl set-ntp true || true

# --- Swap ------------------------------------------------------------------------------------
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  log "2 GB swap file"
  [ -f /swapfile ] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
cat >/etc/sysctl.d/99-ssrs.conf <<'CONF'
# Prefer RAM; use swap as headroom for a 1 GB instance.
vm.swappiness=10
CONF
sysctl -q --system

# --- Docker Engine + Compose (Docker's official repository) ---------------------------------
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  log "Docker Engine and the Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
log "Docker log rotation (10 MB x 3 per container)"
install -d -m 0755 /etc/docker
desired='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
if [ "$(cat /etc/docker/daemon.json 2>/dev/null)" != "$desired" ]; then
  printf '%s\n' "$desired" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# --- Firewall: 80 and 443 only (Systems Manager needs no inbound port) ----------------------
log "ufw: allow 80/tcp, 443/tcp, 443/udp; deny everything else inbound"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force delete allow 22/tcp >/dev/null 2>&1 || true
ufw --force delete allow OpenSSH >/dev/null 2>&1 || true
ufw --force enable >/dev/null

# --- SSH: hardened, then off ---------------------------------------------------------------
log "SSH: keys only, no root login, no passwords"
cat >/etc/ssh/sshd_config.d/90-ssrs.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
X11Forwarding no
AllowTcpForwarding no
MaxAuthTries 3
CONF
sshd -t
if [ "${KEEP_SSH:-0}" = 1 ]; then
  systemctl reload ssh 2>/dev/null || true
  log "SSH left running (KEEP_SSH=1); port 22 is still closed in ufw"
else
  systemctl disable --now ssh.socket ssh.service >/dev/null 2>&1 || true
  log "SSH service stopped and disabled (Session Manager is the way in)"
fi

# --- Systems Manager agent -----------------------------------------------------------------
log "SSM agent"
if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
  snap install amazon-ssm-agent --classic
fi
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service >/dev/null
systemctl is-active --quiet snap.amazon-ssm-agent.amazon-ssm-agent.service || die "the SSM agent is not running"

# --- AWS CLI (backups use the instance role; no keys are stored) --------------------------
if ! command -v aws >/dev/null && [ ! -x /snap/bin/aws ]; then
  log "AWS CLI"
  snap install aws-cli --classic
fi

# --- Layout ----------------------------------------------------------------------------------
log "/opt/ssrs layout"
getent group "$SECRETS_GROUP" >/dev/null || groupadd --system --gid "$SECRETS_GID" "$SECRETS_GROUP"
[ "$(getent group "$SECRETS_GROUP" | cut -d: -f3)" = "$SECRETS_GID" ] ||
  die "group $SECRETS_GROUP exists with another gid; set SECRETS_GID in /opt/ssrs/.env to match"
install -d -o root -g root -m 0755 "$ROOT" "$ROOT/releases" "$ROOT/backup"
install -d -o root -g root -m 0700 "$ROOT/state" /var/lib/ssrs-backup
install -d -o root -g "$SECRETS_GROUP" -m 0750 "$ROOT/secrets"
[ -f "$ROOT/.env" ] && chmod 600 "$ROOT/.env" && chown root:root "$ROOT/.env"
[ -f "$ROOT/secrets/google-sa.json" ] && chown root:"$SECRETS_GROUP" "$ROOT/secrets/google-sa.json" &&
  chmod 0440 "$ROOT/secrets/google-sa.json"

# --- Deploy entry point (run by the SSM document SSRS-Beta-Deploy) ------------------------
log "/usr/local/sbin/ssrs-deploy"
cat >/usr/local/sbin/ssrs-deploy <<'SCRIPT'
#!/usr/bin/env bash
# Deploys one release BY DIGEST: pulls that release's api image, checks it was built from the
# commit, extracts its server bundle (compose file, Caddyfile, scripts, timers) to
# /opt/ssrs/releases/<sha>, records the three image digests there, then runs its deploy.sh.
# Installed by scripts/server/bootstrap.sh; run by the SSM document SSRS-Beta-Deploy.
#
#   ssrs-deploy <sha> sha256:<api>,sha256:<worker>,sha256:<web>   new release (from the workflow)
#   ssrs-deploy <sha> stored                                       a release this server deployed
#                                                                  before (rollback): its recorded
#                                                                  digests, never a registry tag
set -Eeuo pipefail
export HOME="${HOME:-/root}"
die() { echo "ssrs-deploy: $*" >&2; exit 2; }
tag="${1:-}"
digests="${2:-stored}"
[[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "expected a 40-character commit sha"
[ "$(id -u)" -eq 0 ] || die "run as root"
# One deploy at a time; deploy.sh inherits this lock (fd 9).
exec 9>/run/ssrs-deploy.lock
flock -n 9 || die "another deploy is running"
prefix="$(sed -n 's/^IMAGE_PREFIX=//p' /opt/ssrs/.env 2>/dev/null | tail -n 1)"
[[ "$prefix" =~ ^ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+$ ]] ||
  die "set IMAGE_PREFIX=ghcr.io/<owner>/<repo> in /opt/ssrs/.env"
rel="/opt/ssrs/releases/$tag"
if [ "$digests" = stored ]; then
  [ -f "$rel/digests.env" ] || die "no recorded digests for $tag on this server; deploy it from a push to beta"
  api="$(sed -n 's/^API_DIGEST=//p' "$rel/digests.env")"
  worker="$(sed -n 's/^WORKER_DIGEST=//p' "$rel/digests.env")"
  web="$(sed -n 's/^WEB_DIGEST=//p' "$rel/digests.env")"
else
  re='^(sha256:[0-9a-f]{64}),(sha256:[0-9a-f]{64}),(sha256:[0-9a-f]{64})$'
  [[ "$digests" =~ $re ]] || die "expected sha256:<api>,sha256:<worker>,sha256:<web>"
  api="${BASH_REMATCH[1]}" worker="${BASH_REMATCH[2]}" web="${BASH_REMATCH[3]}"
fi
for d in "$api" "$worker" "$web"; do
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || die "bad recorded digest for $tag"
done
image="$prefix-api@$api"
echo "ssrs-deploy: pulling $image"
docker pull --quiet "$image" >/dev/null
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
[ "$revision" = "$tag" ] || die "the api image was built from '$revision', not $tag"
tmp="$(mktemp -d /opt/ssrs/releases/.incoming.XXXXXX)"
cid=""
trap 'rm -rf -- "$tmp"; if [ -n "$cid" ]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi' EXIT
cid="$(docker create "$image")"
docker cp --quiet "$cid:/app/deploy/." "$tmp/"
docker rm -f "$cid" >/dev/null
cid=""
if [ ! -f "$tmp/compose.yml" ] || [ ! -x "$tmp/bin/deploy.sh" ]; then die "bundle incomplete in $image"; fi
printf 'API_DIGEST=%s\nWORKER_DIGEST=%s\nWEB_DIGEST=%s\n' "$api" "$worker" "$web" >"$tmp/digests.env"
chown -R root:root "$tmp" && chmod -R go-w "$tmp" && chmod 0755 "$tmp"
rm -rf -- "$rel"
mv -T "$tmp" "$rel"
trap - EXIT
exec "$rel/bin/deploy.sh" "$tag"
SCRIPT
chmod 0755 /usr/local/sbin/ssrs-deploy

# --- `ssrs`: docker compose for the live release (docs/runbook.md) ------------------------
log "/usr/local/sbin/ssrs"
cat >/usr/local/sbin/ssrs <<'SCRIPT'
#!/usr/bin/env bash
# docker compose for the release that is live now, e.g. `ssrs ps`, `ssrs logs -f --tail 100 api`.
# Installed by scripts/server/bootstrap.sh. Run as root (sudo -i in a Session Manager shell).
set -euo pipefail
tag="$(cat /opt/ssrs/state/deployed-tag 2>/dev/null)" || { echo "ssrs: nothing deployed yet" >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. "/opt/ssrs/releases/$tag/digests.env"
set +a
exec env IMAGE_TAG="$tag" docker compose --project-name ssrs --env-file /opt/ssrs/.env \
  -f "/opt/ssrs/releases/$tag/compose.yml" "$@"
SCRIPT
chmod 0755 /usr/local/sbin/ssrs

log "done"
cat <<'NEXT'

bootstrap: done. Nothing is running yet. Next (docs/beta-checklist.md):
  - log in to GHCR as root with the read-only token (step 13)
  - create /opt/ssrs/.env from deploy/.env.beta.example (step 14)
  - put the Google key in /opt/ssrs/secrets/google-sa.json, root:ssrs-secrets 0440 (step 15)
  - put the age PUBLIC key in /opt/ssrs/backup/age-recipients.txt (step 16)
  - then deploy from GitHub (step 20)
NEXT
