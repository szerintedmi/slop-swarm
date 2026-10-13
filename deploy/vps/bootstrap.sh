#!/usr/bin/env bash
# Bootstrap the slop-swarm VPS (docs/deploy.md §2). Copy the repo's deploy/ directory to the VPS and run this as root:
#
#   sudo ./deploy/vps/bootstrap.sh                      Docker, Tailscale, dirs, env file, deploy user, sshd keys-only
#   sudo ./deploy/vps/bootstrap.sh lock-ssh --confirm   once `ssh slopswarm-vps` works: sshd on loopback + tailnet only
#   sudo ./deploy/vps/bootstrap.sh unlock-ssh           undo lock-ssh (from the OVH KVM console if the tailnet is down)
#
# Settings: /etc/slopswarm/deploy.conf (created from deploy.conf.example on the first run, which then stops).
# Idempotent: re-run after changing deploy/. It installs daemons and files only; containers belong to slopswarm-deploy
# (CI) and are never touched here. The OVH edge firewall rule (deny tcp/22) and the tailnet policy are set from the
# laptop (docs/deploy.md §1-2), not here.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CONF=/etc/slopswarm/deploy.conf
ENV_FILE=/etc/slopswarm/slopswarm.env
LISTEN_CONF=/etc/ssh/sshd_config.d/20-slopswarm-listen.conf

log() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die "run as root (sudo)"

# Copies $1 to $2 with mode $3 (and owner $4); returns 0 only if $2 changed.
put() {
  local src=$1 dest=$2 mode=$3 owner=${4:-root:root}
  if [[ -f $dest ]] && cmp -s "$src" "$dest"; then return 1; fi
  install -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$src" "$dest"
}

ts_state() { tailscale status --json 2>/dev/null | sed -n 's/.*"BackendState": *"\([A-Za-z]*\)".*/\1/p' | head -n1; }
ts_ip4() { tailscale ip -4 2>/dev/null | head -n1; }
ts_dns_name() { tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n1; }

lock_ssh() {
  [[ ${1:-} == --confirm ]] || die "first check that 'ssh slopswarm-vps' (over the tailnet) works, then re-run with --confirm"
  [[ $(ts_state) == Running ]] || die "tailscale isn't running"
  local ip; ip=$(ts_ip4); [[ -n $ip ]] || die "no tailnet IPv4 address"
  if systemctl is-active --quiet ssh.socket; then die "ssh.socket is active: ListenAddress would be ignored"; fi
  # At boot sshd may start before tailscale0 has its address; nonlocal bind lets it listen on it anyway.
  echo 'net.ipv4.ip_nonlocal_bind = 1' >/etc/sysctl.d/90-slopswarm-ssh.conf
  sysctl -q -p /etc/sysctl.d/90-slopswarm-ssh.conf
  printf '# Only loopback and the tailnet reach sshd. Undo: bootstrap.sh unlock-ssh\nListenAddress 127.0.0.1\nListenAddress ::1\nListenAddress %s\n' "$ip" >"$LISTEN_CONF"
  sshd -t
  systemctl restart ssh
  log "sshd now listens on loopback and $ip only:"
  ss -tlnp | grep -E ':22\b' || true
  echo "Break-glass: the OVH KVM console as your user (it needs a password: 'passwd <you>'), then 'sudo bootstrap.sh unlock-ssh'."
  echo "Also deny tcp/22 at OVH's edge firewall from the laptop (docs/deploy.md §2)."
}

unlock_ssh() {
  rm -f "$LISTEN_CONF"
  sshd -t
  systemctl restart ssh
  log "sshd listens on all addresses again"
}

case ${1:-} in
  lock-ssh) shift; lock_ssh "$@"; exit ;;
  unlock-ssh) unlock_ssh; exit ;;
  "") ;;
  *) die "usage: bootstrap.sh [lock-ssh --confirm | unlock-ssh]" ;;
esac

# shellcheck source=/dev/null
. /etc/os-release
[[ ${VERSION_CODENAME:-} == trixie ]] || warn "written for Debian 13 (trixie); this is ${PRETTY_NAME:-unknown}"

log "settings ($CONF)"
install -d -m 0700 /etc/slopswarm
if [[ ! -f $CONF ]]; then
  install -m 0600 "$HERE/deploy.conf.example" "$CONF"
  die "created $CONF: fill in CI_DEPLOY_PUBKEY, then re-run"
fi
# shellcheck source=/dev/null
. "$CONF"
[[ -n ${CI_DEPLOY_PUBKEY:-} ]] || die "set CI_DEPLOY_PUBKEY in $CONF"
TS_HOSTNAME=${TS_HOSTNAME:-slopswarm-vps}
TS_TAGS=${TS_TAGS:-tag:swarm-control}

log "packages: Docker (docker.com), Tailscale (pkgs.tailscale.com), base tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl unattended-upgrades qemu-guest-agent systemd-timesyncd
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOT
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOT
curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
apt-get update -q
apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tailscale

# Debian security updates only (the default origins); no automatic reboots. Docker and Tailscale are upgraded by
# hand between runs: restarting either interrupts the controller's forges and connections.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOT
systemctl enable --now qemu-guest-agent 2>/dev/null || warn "qemu-guest-agent not started (no guest channel?)"
# Keep the OVH console usable for a break-glass login:
# - systemd-ssh-generator (SSH over AF_VSOCK for VMs) fails on every daemon-reload here; nothing uses it.
# - Only kernel errors go to the console (routine Docker bridge/veth messages stay in the journal).
install -d -m 0755 /etc/systemd/system-generators
ln -sfn /dev/null /etc/systemd/system-generators/systemd-ssh-generator
echo 'kernel.printk = 3 4 1 3' >/etc/sysctl.d/90-slopswarm-console.conf
sysctl -q -p /etc/sysctl.d/90-slopswarm-console.conf
# systemd-resolved answers LLMNR (port 5355) on every interface by default; nothing here needs it.
if systemctl is-active --quiet systemd-resolved; then
  install -d -m 0755 /etc/systemd/resolved.conf.d
  tmp=$(mktemp)
  printf '[Resolve]\nLLMNR=no\nMulticastDNS=no\n' >"$tmp"
  if put "$tmp" /etc/systemd/resolved.conf.d/10-slopswarm.conf 0644; then systemctl restart systemd-resolved; fi
  rm -f "$tmp"
fi

log "Docker daemon"
# live-restore: containers (forges, the controller) keep running while dockerd restarts, e.g. on upgrade.
if [[ ! -f /etc/docker/daemon.json ]]; then
  install -d -m 0755 /etc/docker
  printf '{\n  "live-restore": true,\n  "log-driver": "local"\n}\n' >/etc/docker/daemon.json
  systemctl restart docker
else
  grep -q '"live-restore": *true' /etc/docker/daemon.json || warn "/etc/docker/daemon.json exists without live-restore: true"
fi
systemctl enable --now docker

log "Tailscale ($TS_HOSTNAME, $TS_TAGS)"
systemctl enable --now tailscaled
if [[ $(ts_state) == Running ]]; then
  # Re-applies the name and tag (a no-op when unchanged); a tag change needs the policy to allow it.
  tailscale up --hostname "$TS_HOSTNAME" --advertise-tags="$TS_TAGS" --timeout 30s \
    || warn "tailscale up: could not apply the name/tag (see above); the node stays as it is"
elif [[ -n ${TS_AUTHKEY:-} ]]; then
  tailscale up --auth-key="$TS_AUTHKEY" --hostname "$TS_HOSTNAME" --advertise-tags="$TS_TAGS" --timeout 60s
  warn "the node has joined: clear TS_AUTHKEY in $CONF"
else
  # Prints a login URL; the node joins once it's opened in the browser (tailscaled keeps waiting after the timeout).
  tailscale up --hostname "$TS_HOSTNAME" --advertise-tags="$TS_TAGS" --timeout 30s \
    || warn "tailscale: open the login URL above in your browser, then re-run this script"
fi

log "directories and the env file"
install -d -m 0755 /opt/slopswarm /var/lib/slopswarm
install -d -m 0700 /etc/slopswarm/secrets /etc/slopswarm/secrets/codex
if [[ ! -f $ENV_FILE ]]; then
  install -m 0600 "$HERE/../slopswarm.env.example" "$ENV_FILE"
  warn "created $ENV_FILE from the example: fill it in before the first deploy"
fi
chmod 0600 "$ENV_FILE" "$CONF"

log "deploy user and command"
if ! id deploy >/dev/null 2>&1; then
  adduser --system --group --home /home/deploy --shell /bin/sh --disabled-password deploy
fi
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
tmp=$(mktemp)
# restrict: no pty, no forwarding, no agent; the forced command gets the CI's argument line as SSH_ORIGINAL_COMMAND.
printf 'restrict,command="sudo /usr/local/bin/slopswarm-deploy" %s\n' "$CI_DEPLOY_PUBKEY" >"$tmp"
put "$tmp" /home/deploy/.ssh/authorized_keys 0600 deploy:deploy || true
rm -f "$tmp"
put "$HERE/../slopswarm-deploy" /usr/local/bin/slopswarm-deploy 0755 || true
tmp=$(mktemp)
echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/slopswarm-deploy' >"$tmp"
visudo -cqf "$tmp" || die "sudoers rule failed validation"
put "$tmp" /etc/sudoers.d/slopswarm-deploy 0440 || true
rm -f "$tmp"

log "sshd: keys only"
admin=${SUDO_USER:-}
admin_keys=$(getent passwd "${admin:-root}" | cut -d: -f6)/.ssh/authorized_keys
if [[ -s $admin_keys ]]; then
  tmp=$(mktemp)
  printf '# slop-swarm bootstrap: keys only.\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' >"$tmp"
  if put "$tmp" /etc/ssh/sshd_config.d/10-slopswarm.conf 0644; then sshd -t && systemctl reload ssh; fi
  rm -f "$tmp"
else
  warn "no SSH key in $admin_keys: password login left as it is (add a key, then re-run)"
fi

log "done"
echo "Listening TCP sockets (only sshd should be public until lock-ssh; the controller binds SLOPSWARM_BIND):"
ss -tlnp
echo
if [[ $(ts_state) == Running ]]; then
  ip=$(ts_ip4); name=$(ts_dns_name)
  echo "Tailnet: $name  $ip"
  echo "For $ENV_FILE: SLOPSWARM_BIND=127.0.0.1,$ip  SLOPSWARM_FORGE_PUBLISH=$ip  SLOPSWARM_ALLOWED_HOSTS=${name%%.*},$name"
  echo "GitHub secret VPS_SSH_HOST: ${name%%.*}"
  echo "GitHub secret VPS_SSH_KNOWN_HOSTS (this server's host key, read locally):"
  echo "${name%%.*},$name,$ip $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
else
  warn "not on the tailnet yet (state: $(ts_state)); re-run after the login to get the addresses"
fi
[[ -f $LISTEN_CONF ]] || echo "Public SSH is still on: run 'bootstrap.sh lock-ssh --confirm' once 'ssh $TS_HOSTNAME' works over the tailnet."
