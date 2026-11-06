#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 EC2 instance for Krosa (docs/deployment.md §8.3).
#
# Paste the whole file into "Advanced details → User data" when launching the instance, or run
# it once by hand:  sudo bash scripts/ec2-bootstrap.sh
# Safe to run again. Output of a user-data run: /var/log/cloud-init-output.log
#
# Installs Docker Engine + Compose, git and automatic security updates; adds 2 GB swap; caps
# Docker log size so logs cannot fill the disk; bans repeated SSH login failures; creates
# /opt/ssrs owned by the `ubuntu` user.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_USER="${APP_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/opt/ssrs}"

apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get -y install ca-certificates curl git unattended-upgrades fail2ban

# Docker from Docker's own apt repository (Engine and the Compose plugin).
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Container logs: at most 3 × 20 MB per container.
if [ ! -f /etc/docker/daemon.json ]; then
  cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
JSON
fi
systemctl enable --now docker
systemctl restart docker
usermod -aG docker "$APP_USER"

# Swap: headroom for a t3.medium (4 GB) during image pulls and Next.js start-up.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
echo 'vm.swappiness=10' >/etc/sysctl.d/99-krosa.conf

# Automatic security updates (no automatic reboot; reboot in a quiet hour when asked to).
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# SSH: keys only (the Ubuntu AMI already does this; made explicit), and fail2ban on.
cat >/etc/ssh/sshd_config.d/90-krosa.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
CONF
systemctl reload ssh || systemctl reload sshd || true
systemctl enable --now fail2ban

install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"

timedatectl set-timezone UTC
echo "ec2-bootstrap: done. Log in again as $APP_USER so the docker group applies."
