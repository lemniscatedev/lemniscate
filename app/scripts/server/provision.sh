#!/usr/bin/env bash
# Prepares a fresh Ubuntu server (Cherry Servers VPS, Ubuntu 26.04 64-bit, 2-4 GB RAM) to run the Lemniscate services.
# Run as root ON THE SERVER, from this folder (it reads ./systemd, ./Caddyfile, ./env.example and ./backup.sh).
# Safe to run again: every step checks the current state first. `deploy.sh --provision <host>` copies the folder
# up and runs it for you.
#
#   bash provision.sh                 everything below
#   bash provision.sh --units-only    only (re)install the systemd units and the backup script (deploy.sh uses this)
#
# What it does: a `lemniscate` system user; apt upgrade; git, build tools, jq, Python 3 with venv (for vol-engine);
# Postgres (the distro's current major) plus TimescaleDB from Timescale's apt repository, with a `lemniscate` role and
# database whose random password goes to /etc/lemniscate/db.env (0600); ufw allowing only 22, 80 and 443; fail2ban for
# SSH; unattended security upgrades; a swap file when there is none; Bun and cast (Foundry) at pinned versions; Caddy as
# the HTTPS reverse proxy for the API (and the MCP server when MCP_DOMAIN is set); the systemd units; the nightly
# backup timer; /etc/lemniscate/lemniscate.env from env.example on the first run.
#
# Env (optional; saved to /etc/lemniscate/provision.conf and reused on the next run):
#   API_DOMAIN       REQUIRED on the first run, e.g. api.<your-domain> (no default: no domain is committed to the repo)
#   MCP_DOMAIN       optional, e.g. mcp.<your-domain>; blank = no public MCP route
#   ACME_EMAIL       contact address for Let's Encrypt (blank = none)
#   TIMESCALE_CODENAME  Ubuntu release name used for Timescale's apt repository (default: this server's; falls back to noble)
#   DB_NAME          default lemniscate_mainnet
#   SWAP_SIZE        default 2G when the server has no swap (0 = never add swap)
#
# It never creates, reads or moves keys: /etc/lemniscate/keys is created empty and the owner copies the keystores in.
set -euo pipefail

# Pinned tool versions. Bun matches app/package.json (packageManager bun@1.4.2) and CI; cast matches the Foundry release
# the contracts are built and tested with (1.8.4).
BUN_VERSION="1.4.2"
FOUNDRY_VERSION="1.8.4"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF=/etc/lemniscate/provision.conf

log() { printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
warn() { printf '[provision] WARNING: %s\n' "$*" >&2; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

UNITS_ONLY=0
case "${1:-}" in
  "") ;;
  --units-only) UNITS_ONLY=1 ;;
  -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
  *) die "unknown argument $1 (try --help)" ;;
esac

[[ "$(id -u)" == 0 ]] || die "run as root"
for f in systemd/lemniscate.target Caddyfile env.example backup.sh; do
  [[ -e "$HERE/$f" ]] || die "missing $HERE/$f: run provision.sh from the app/scripts/server folder"
done
cd /

# ---------------------------------------------------------------- systemd units + backup script
install_units() {
  local f dest changed=0
  for f in "$HERE"/systemd/*.service "$HERE"/systemd/*.target "$HERE"/systemd/*.timer; do
    dest="/etc/systemd/system/$(basename "$f")"
    if ! cmp -s "$f" "$dest"; then
      install -m 0644 "$f" "$dest"
      changed=1
    fi
  done
  if ! cmp -s "$HERE/backup.sh" /usr/local/sbin/lemniscate-backup; then
    install -m 0755 "$HERE/backup.sh" /usr/local/sbin/lemniscate-backup
  fi
  systemctl daemon-reload
  systemctl enable --now --quiet lemniscate-backup.timer || die "could not enable the backup timer"
  if [[ "$changed" == 1 ]]; then log "systemd units installed"; else log "systemd units unchanged"; fi
}

if [[ "$UNITS_ONLY" == 1 ]]; then
  install_units
  exit 0
fi

# ---------------------------------------------------------------- settings
saved() { [[ -r "$CONF" ]] && (set +u; source "$CONF" >/dev/null 2>&1; eval "printf '%s' \"\${$1:-}\""); }
API_DOMAIN="${API_DOMAIN:-$(saved API_DOMAIN || true)}"
MCP_DOMAIN="${MCP_DOMAIN:-$(saved MCP_DOMAIN || true)}"
ACME_EMAIL="${ACME_EMAIL:-$(saved ACME_EMAIL || true)}"
DB_NAME="${DB_NAME:-$(saved DB_NAME || true)}"
[[ -n "$API_DOMAIN" ]] || die "set API_DOMAIN=api.<your-domain> (no default: this repository holds no real domain)"
DB_NAME="${DB_NAME:-lemniscate_mainnet}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ "$API_DOMAIN" =~ $domain_re ]] || die "API_DOMAIN '$API_DOMAIN' is not a domain name"
[[ -z "$MCP_DOMAIN" || "$MCP_DOMAIN" =~ $domain_re ]] || die "MCP_DOMAIN '$MCP_DOMAIN' is not a domain name"
[[ -z "$ACME_EMAIL" || "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "ACME_EMAIL '$ACME_EMAIL' is not an email address"
[[ "$DB_NAME" =~ ^[a-z_][a-z0-9_]*$ ]] || die "DB_NAME '$DB_NAME' must be lowercase letters, digits and _"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || warn "written for Ubuntu, this is ${PRETTY_NAME:-unknown}"
fi

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
# needrestart (Ubuntu) would otherwise stop and ask which services to restart after an upgrade.
export NEEDRESTART_MODE=a
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
log "apt update + upgrade"
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install --no-install-recommends \
  git build-essential ca-certificates curl gnupg unzip jq openssl \
  ufw fail2ban python3-systemd unattended-upgrades \
  postgresql postgresql-client \
  python3 python3-venv python3-pip

# ---------------------------------------------------------------- swap, time
if [[ "$SWAP_SIZE" != 0 && -z "$(swapon --show --noheadings)" ]]; then
  log "adding a $SWAP_SIZE swap file"
  [[ -f /swapfile ]] || fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
printf 'vm.swappiness=10\n' >/etc/sysctl.d/60-lemniscate.conf
sysctl -q -p /etc/sysctl.d/60-lemniscate.conf
# The keeper, the hedger and the vol engine work in wall-clock windows (market hours, expiries): keep the clock synced.
timedatectl set-ntp true 2>/dev/null || warn "could not turn on NTP sync (timedatectl)"

# ---------------------------------------------------------------- user and directories
if ! id lemniscate >/dev/null 2>&1; then
  log "creating the lemniscate system user"
  useradd --system --user-group --home-dir /var/lib/lemniscate --create-home --shell /usr/sbin/nologin lemniscate
fi
install -d -o lemniscate -g lemniscate -m 0750 /var/lib/lemniscate /var/lib/lemniscate/data
install -d -o lemniscate -g lemniscate -m 0755 /opt/lemniscate /opt/lemniscate/releases
install -d -o root -g lemniscate -m 0750 /etc/lemniscate /etc/lemniscate/keys
install -d -o root -g root -m 0700 /var/backups/lemniscate

umask 077
{
  echo "# Written by provision.sh; read by provision.sh and lemniscate-backup."
  printf 'API_DOMAIN=%q\nMCP_DOMAIN=%q\nACME_EMAIL=%q\nDB_NAME=%q\n' "$API_DOMAIN" "$MCP_DOMAIN" "$ACME_EMAIL" "$DB_NAME"
} >"$CONF"
chmod 0600 "$CONF"
umask 022

# ---------------------------------------------------------------- Bun (pinned, checksum-verified)
install_bun() {
  if [[ -x /usr/local/bin/bun && "$(/usr/local/bin/bun --version 2>/dev/null)" == "$BUN_VERSION" ]]; then
    log "bun $BUN_VERSION already installed"
    return
  fi
  local asset tmp base
  case "$(uname -m)" in
    x86_64) asset=bun-linux-x64; grep -qw avx2 /proc/cpuinfo || asset=bun-linux-x64-baseline ;;
    aarch64 | arm64) asset=bun-linux-aarch64 ;;
    *) die "no Bun build for $(uname -m)" ;;
  esac
  log "installing bun $BUN_VERSION ($asset)"
  tmp="$(mktemp -d)"
  base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
  curl -fsSL --retry 3 -o "$tmp/$asset.zip" "$base/$asset.zip"
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  (cd "$tmp" && grep -E " \*?${asset}\.zip\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "bun download does not match SHASUMS256.txt"
  unzip -q "$tmp/$asset.zip" -d "$tmp"
  install -m 0755 "$tmp/$asset/bun" /usr/local/bin/bun
  rm -rf "$tmp"
  [[ "$(/usr/local/bin/bun --version)" == "$BUN_VERSION" ]] || die "bun --version is not $BUN_VERSION after install"
}
install_bun

# ---------------------------------------------------------------- cast (Foundry), pinned; only cast is installed
install_cast() {
  if command -v cast >/dev/null 2>&1 && cast --version 2>/dev/null | grep -qF "$FOUNDRY_VERSION"; then
    log "cast $FOUNDRY_VERSION already installed"
    return
  fi
  local arch tmp url
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no Foundry build for $(uname -m): cast is needed to create and inspect keystores on the server" ;;
  esac
  url="https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_${arch}.tar.gz"
  log "installing cast $FOUNDRY_VERSION"
  tmp="$(mktemp -d)"
  if curl -fsSL --retry 3 -o "$tmp/foundry.tar.gz" "$url" && tar -xzf "$tmp/foundry.tar.gz" -C "$tmp" cast; then
    install -m 0755 "$tmp/cast" /usr/local/bin/cast
  else
    rm -rf "$tmp"
    die "could not install cast from $url (operators use it to import and inspect keystores)"
  fi
  rm -rf "$tmp"
}
install_cast

# ---------------------------------------------------------------- TimescaleDB (the migrations use hypertables)
install_timescale() {
  local major codename
  major="$(runuser -u postgres -- psql -X -tAc "SHOW server_version_num" 2>/dev/null | cut -c1-2 || true)"
  [[ -n "$major" ]] || major="$(pg_lsclusters -h 2>/dev/null | awk 'NR==1{print $1}')"
  [[ "$major" =~ ^[0-9]+$ ]] || die "could not tell the Postgres major version"
  if dpkg -s "timescaledb-2-postgresql-$major" >/dev/null 2>&1; then
    log "timescaledb for postgres $major already installed"
  else
    codename="${TIMESCALE_CODENAME:-$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")}"
    install -d /usr/share/keyrings
    curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/timescaledb.gpg
    write_list() { printf 'deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ %s main\n' "$1" >/etc/apt/sources.list.d/timescaledb.list; }
    write_list "$codename"
    if ! apt-get update -q; then
      warn "Timescale's repository has no '$codename' packages: trying 'noble'"
      write_list noble
      apt-get update -q || die "could not read Timescale's apt repository (set TIMESCALE_CODENAME to a release it publishes)"
    fi
    log "installing timescaledb-2-postgresql-$major"
    apt-get "${APT_OPTS[@]}" install "timescaledb-2-postgresql-$major" || die "could not install timescaledb-2-postgresql-$major (Timescale may not publish it for postgres $major yet)"
  fi
  install -d "/etc/postgresql/$major/main/conf.d"
  printf '# Written by provision.sh.\nshared_preload_libraries = '"'"'timescaledb'"'"'\ntimescaledb.telemetry_level = off\n' >"/etc/postgresql/$major/main/conf.d/10-lemniscate-timescale.conf"
  systemctl restart postgresql
}
systemctl enable --now --quiet postgresql || die "postgresql did not start"
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q && break
  sleep 1
done
install_timescale
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q && break
  sleep 1
done

# ---------------------------------------------------------------- Postgres: role, database, /etc/lemniscate/db.env
log "postgres: role lemniscate, database $DB_NAME"
systemctl enable --now --quiet postgresql || die "postgresql did not start"
for _ in $(seq 1 30); do
  runuser -u postgres -- pg_isready -q && break
  sleep 1
done
psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

db_password=""
if [[ -f /etc/lemniscate/db.env ]]; then
  db_password="$(sed -n 's#^DATABASE_URL=postgres://lemniscate:\([^@]*\)@.*#\1#p' /etc/lemniscate/db.env | tail -1)"
fi
[[ -n "$db_password" ]] || db_password="$(openssl rand -hex 24)"

if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'lemniscate'")" != 1 ]]; then
  psql_admin -c "CREATE ROLE lemniscate LOGIN"
fi
# The password goes through stdin, never through a command line.
printf "ALTER ROLE lemniscate WITH LOGIN PASSWORD '%s';\n" "$db_password" | psql_admin
if [[ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" != 1 ]]; then
  runuser -u postgres -- createdb --owner=lemniscate "$DB_NAME"
fi
# The migration role is not a superuser: the extension is created here, the migration's IF NOT EXISTS then skips it.
runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" \
  || die "could not create the timescaledb extension in $DB_NAME"

umask 077
{
  echo "# Written by provision.sh. Read by systemd (as root) for every lemniscate-* unit. Do not commit or copy."
  echo "DATABASE_URL=postgres://lemniscate:${db_password}@127.0.0.1:5432/${DB_NAME}"
  # The shared config schema requires it; the services connect with DATABASE_URL.
  echo "POSTGRES_PASSWORD=${db_password}"
} >/etc/lemniscate/db.env.tmp
mv /etc/lemniscate/db.env.tmp /etc/lemniscate/db.env
chown root:root /etc/lemniscate/db.env
chmod 0600 /etc/lemniscate/db.env
umask 022
unset db_password

# ---------------------------------------------------------------- /etc/lemniscate/lemniscate.env (first run only)
umask 077
if [[ ! -f /etc/lemniscate/lemniscate.env ]]; then
  install -m 0600 -o root -g root "$HERE/env.example" /etc/lemniscate/lemniscate.env
  log "wrote /etc/lemniscate/lemniscate.env from env.example: replace every CHANGE_ME in it before deploying"
else
  log "/etc/lemniscate/lemniscate.env exists: left as it is"
fi
chown root:root /etc/lemniscate/lemniscate.env
chmod 0600 /etc/lemniscate/lemniscate.env
umask 022

# ---------------------------------------------------------------- firewall: 22, 80, 443 only
log "ufw: allow 22/tcp, 80/tcp, 443 (tcp + udp for HTTP/3); deny everything else inbound"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443 >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- fail2ban (SSH)
cat >/etc/fail2ban/jail.d/lemniscate.local <<'EOF'
# Written by provision.sh.
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban

# ---------------------------------------------------------------- SSH: keys only
if [[ -s /root/.ssh/authorized_keys ]]; then
  cat >/etc/ssh/sshd_config.d/10-lemniscate.conf <<'EOF'
# Written by provision.sh: key-only logins (root keeps key login for deploy.sh).
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  if sshd -t; then
    systemctl try-reload-or-restart ssh.service || warn "could not reload ssh; the settings apply at the next restart"
  else
    rm -f /etc/ssh/sshd_config.d/10-lemniscate.conf
    warn "sshd -t rejected the key-only settings: removed them, SSH unchanged"
  fi
else
  warn "/root/.ssh/authorized_keys is empty: SSH password settings left unchanged"
fi

# ---------------------------------------------------------------- unattended upgrades
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Written by provision.sh.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now --quiet unattended-upgrades || warn "could not enable unattended-upgrades"

# ---------------------------------------------------------------- /proc: hide other users' processes (a key being unlocked
# is briefly visible to the unlock tool's arguments; only its own user and root can see it)
if ! grep -qE '^proc[[:space:]]+/proc[[:space:]].*hidepid' /etc/fstab; then
  printf 'proc /proc proc defaults,hidepid=2 0 0\n' >>/etc/fstab
fi
mount -o remount,hidepid=2 /proc 2>/dev/null || warn "could not remount /proc with hidepid=2 (applies at the next boot)"

# ---------------------------------------------------------------- journald: bounded logs
install -d /etc/systemd/journald.conf.d
printf '# Written by provision.sh.\n[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=30day\n' >/etc/systemd/journald.conf.d/lemniscate.conf
systemctl restart systemd-journald

# ---------------------------------------------------------------- Caddy (HTTPS reverse proxy)
if ! command -v caddy >/dev/null 2>&1; then
  if apt-cache policy caddy 2>/dev/null | grep -qE 'Candidate: [0-9]'; then
    log "installing caddy (Ubuntu package)"
  else
    log "installing caddy (Caddy's own apt repository)"
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
  fi
  apt-get "${APT_OPTS[@]}" install caddy
fi

caddy_tmp="$(mktemp)"
sed -e "s/__API_DOMAIN__/${API_DOMAIN}/g" -e "s/__MCP_DOMAIN__/${MCP_DOMAIN}/g" -e "s/__ACME_EMAIL__/${ACME_EMAIL}/g" \
  "$HERE/Caddyfile" >"$caddy_tmp"
if [[ -z "$MCP_DOMAIN" ]]; then
  # No public MCP route: drop the block between the BEGIN mcp / END mcp markers.
  sed -i '/^# BEGIN mcp$/,/^# END mcp$/d' "$caddy_tmp"
fi
if [[ -z "$ACME_EMAIL" ]]; then
  # No contact address: drop the global options block ({ email ... }), the only block that opens on a bare "{".
  sed -i '/^{$/,/^}$/d' "$caddy_tmp"
fi
chmod 0644 "$caddy_tmp"
install -d -o caddy -g caddy /var/log/caddy
# Validate as the caddy user so any log file it opens is owned by caddy.
runuser -u caddy -- caddy validate --adapter caddyfile --config "$caddy_tmp" >/dev/null 2>&1 \
  || { runuser -u caddy -- caddy validate --adapter caddyfile --config "$caddy_tmp" || true; rm -f "$caddy_tmp"; die "the rendered Caddyfile does not validate"; }
if ! cmp -s "$caddy_tmp" /etc/caddy/Caddyfile; then
  [[ -f /etc/caddy/Caddyfile ]] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 0644 "$caddy_tmp" /etc/caddy/Caddyfile
  log "Caddyfile written for $API_DOMAIN${MCP_DOMAIN:+ and $MCP_DOMAIN}"
fi
rm -f "$caddy_tmp"
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

# ---------------------------------------------------------------- units
install_units

cat <<EOF

provision: done.
  Postgres   database $DB_NAME, role lemniscate, DATABASE_URL in /etc/lemniscate/db.env (0600)
  Caddy      https://$API_DOMAIN -> API :3101${MCP_DOMAIN:+, https://$MCP_DOMAIN -> MCP :3102}
             (certificates arrive once the DNS record(s) point at this server, grey cloud)
  Backups    nightly to /var/backups/lemniscate (systemctl list-timers lemniscate-backup.timer)
Next (README.md in this folder):
  1. Edit /etc/lemniscate/lemniscate.env: replace every CHANGE_ME.
  2. Copy the keystore (<role>.json) and password file (<role>.password) of keeper, hedger and vol-signer (and
     paymaster-signer if sponsoring gas) into /etc/lemniscate/keys/, then chown root:lemniscate and chmod 0440.
  3. From the owner's machine: app/scripts/server/deploy.sh <host>
EOF
