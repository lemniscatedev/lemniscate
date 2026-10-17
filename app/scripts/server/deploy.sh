#!/usr/bin/env bash
# Deploys the Lemniscate backend from the owner's machine to a server prepared by provision.sh, over SSH as root.
#
#   app/scripts/server/deploy.sh <host>                  deploy the committed HEAD
#   app/scripts/server/deploy.sh --ref <ref> <host>      deploy a commit, tag or branch
#   app/scripts/server/deploy.sh --provision <host>      first time: copy app/scripts/server up and run provision.sh
#   app/scripts/server/deploy.sh --check <host>          health-check every service, change nothing
#
# <host> is a host name, an ~/.ssh/config alias or user@host (without "user@" the user is root). Nothing about the
# server (address, SSH key, password) is stored here: the host comes from the command line and the key from
# ssh-agent or ~/.ssh/config.
#
# A deploy:
#   1. ships the committed tree at <ref> (git archive of app/ and vol-engine/: uncommitted changes are never shipped) plus
#      the mainnet deployment file app/deployments/4663.json (from LEMNISCATE_DEPLOYMENTS_SRC, usually gitignored) to a
#      new /opt/lemniscate/releases/<time>-<sha>;
#   2. checks /etc/lemniscate/lemniscate.env: no CHANGE_ME left, NETWORK=mainnet and CHAIN_ID=4663, the RPC answers chain
#      id 4663, the oracle address matches 4663.json, no raw key in any env file, and every keystore / password file in
#      /etc/lemniscate/keys is readable by the one service user that signs with it and by no other service user (only
#      tested for access, never read);
#   3. refreshes the systemd units, runs bun install --frozen-lockfile as lemniscate, builds the vol-engine virtualenv;
#   4. points /opt/lemniscate/current at the release and runs the migrations (lemniscate-migrate.service); if they fail,
#      the link goes back to the previous release and nothing is restarted;
#   5. restarts the services ONE BY ONE (indexer, api, keeper, hedger, vol-engine, mcp if enabled), checking each before
#      the next. If any check fails, the link goes back to the previous release, every service is restarted on it, and
#      the deploy exits 1 (migrations are not reversed: see README.md, "Roll back");
#   6. prints the API's view: head, indexer lag, each keeper job's coarse status.
# The last 5 releases are kept; README.md says how to roll back by hand.
#
# Env (all optional):
#   SSH_OPTS                  extra ssh options, e.g. "-i ~/.ssh/<key> -p 22"
#   LEMNISCATE_DEPLOYMENTS_SRC  folder holding 4663.json (default: app/deployments of this checkout)
#   LEMNISCATE_PUBLIC_API_URL   e.g. https://api.<your-domain>: also checked from this machine after the deploy
#   API_DOMAIN, MCP_DOMAIN, ACME_EMAIL, DB_NAME, SWAP_SIZE, TIMESCALE_CODENAME: passed to provision.sh by --provision
set -euo pipefail

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

MODE=deploy
REF=HEAD
HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --provision) MODE=provision; shift ;;
    --check) MODE=check; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$HOST" ]] || die "one host only"; HOST="$1"; shift ;;
  esac
done
[[ -n "$HOST" ]] || { usage >&2; exit 2; }
[[ "$HOST" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$ ]] || die "'$HOST' does not look like a host or user@host"

for bin in git ssh gzip curl; do
  command -v "$bin" >/dev/null || die "$bin not found"
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
APP="$ROOT/app"

# ---------------------------------------------------------------- ssh (one shared connection)
SSH_EXTRA=()
if [[ -n "${SSH_OPTS:-}" ]]; then read -r -a SSH_EXTRA <<<"$SSH_OPTS"; fi
[[ "$HOST" == *@* ]] || SSH_EXTRA+=(-l root)
CTL_DIR="$(mktemp -d)"
cleanup() {
  ssh -o ControlPath="$CTL_DIR/c" -O exit "$HOST" >/dev/null 2>&1 || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT
ssh_() {
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath="$CTL_DIR/c" -o ControlPersist=300 \
    -o ServerAliveInterval=30 ${SSH_EXTRA[@]+"${SSH_EXTRA[@]}"} "$HOST" "$@"
}

# ---------------------------------------------------------------- the script that runs on the server (as root)
# Wrapped in main() and called with stdin from /dev/null, so no command inside can swallow the rest of the script
# that bash -s is still reading from stdin.
remote_script() {
  cat <<'REMOTE'
main() {
  set -euo pipefail
  local mode="$1" rel="${2:-}" sha="${3:-}"
  local BASE=/opt/lemniscate ENVF=/etc/lemniscate/lemniscate.env KEYS=/etc/lemniscate/keys
  # Start order. Required services always; mcp only when it is already enabled.
  local CORE=(indexer api keeper hedger vol-engine)
  log() { printf '[server %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
  die() { printf 'deploy (server): %s\n' "$*" >&2; exit 1; }
  # Last assignment wins, as in systemd's EnvironmentFile.
  envval() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

  [[ "$(id -u)" == 0 ]] || die "connect as root"
  id lemniscate >/dev/null 2>&1 && [[ -x /usr/local/bin/bun && -f /etc/lemniscate/db.env && -f "$ENVF" ]] \
    || die "server not provisioned: run deploy.sh --provision <host> first"
  command -v jq >/dev/null || die "jq missing: re-run provision.sh"

  api_url() { local p; p="$(envval API_PORT)"; printf 'http://127.0.0.1:%s/v1/health' "${p:-3101}"; }

  # The API is the one service with an HTTP health route: it also reports the indexer and the keeper jobs from the database.
  health_api() {
    local timeout="$1" deadline body code
    deadline=$((SECONDS + timeout))
    while :; do
      body="$(curl -sS -m 15 -w '\n%{http_code}' "$(api_url)" 2>/dev/null)" || body=$'\n000'
      code="${body##*$'\n'}"
      body="${body%$'\n'*}"
      if [[ "$code" == 200 ]] && jq -e '.db.ok == true' >/dev/null 2>&1 <<<"$body"; then
        printf '  ok    %-12s head %s, indexed to %s (lag %s blocks)\n' api \
          "$(jq -r '.headBlock // "?"' <<<"$body")" "$(jq -r '.lastIndexedBlock // "?"' <<<"$body")" "$(jq -r '.lagBlocks // "?"' <<<"$body")"
        jq -r '.warnings[]? | "        warning: \(.)"' <<<"$body"
        return 0
      fi
      if ((SECONDS >= deadline)); then
        printf '  FAIL  %-12s HTTP %s %s\n' api "$code" "$(systemctl is-active lemniscate-api.service 2>/dev/null || true)"
        [[ -n "$body" ]] && printf '        %s\n' "$(printf '%s' "$body" | head -c 400)"
        journalctl -u lemniscate-api.service -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/        | /'
        return 1
      fi
      sleep 3
    done
  }

  # Services without a port: active, and the same process for a settle window (a crash loop restarts it, which moves
  # ActiveEnterTimestampMonotonic).
  health_unit() {
    local name="$1" settle="${2:-20}" unit="lemniscate-$1.service" t0 t1
    sleep 3
    t0="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")"
    sleep "$settle"
    t1="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit")"
    if systemctl is-active --quiet "$unit" && [[ -n "$t0" && "$t0" == "$t1" ]]; then
      printf '  ok    %-12s running (%ss without a restart)\n' "$name" "$settle"
      return 0
    fi
    printf '  FAIL  %-12s %s (restarted or stopped during the first %ss)\n' "$name" "$(systemctl is-active "$unit" 2>/dev/null || true)" "$settle"
    journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null | sed 's/^/        | /'
    return 1
  }

  service_list() {
    local s
    for s in "${CORE[@]}"; do printf '%s\n' "$s"; done
    systemctl is-enabled --quiet lemniscate-mcp.service 2>/dev/null && printf 'mcp\n'
    return 0
  }

  check_one() {
    case "$1" in
      api) health_api 120 ;;
      mcp) health_unit mcp 10 ;;
      *) health_unit "$1" 20 ;;
    esac
  }

  # The keeper jobs as the API sees them (coarse status only).
  print_keeper() {
    curl -fsS -m 15 "$(api_url)" 2>/dev/null | jq -r '(.keeper // {}) | to_entries[] | "        keeper job \(.key): \(.value.status), last ok \(.value.lastOk // "never")"' 2>/dev/null || true
  }

  if [[ "$mode" == check ]]; then
    local failed=0 s
    while IFS= read -r s; do check_one "$s" || failed=1; done < <(service_list)
    systemctl is-active --quiet caddy || { printf '  FAIL  %-12s not running\n' caddy; failed=1; }
    print_keeper
    [[ "$failed" == 0 ]] || die "unhealthy services above"
    log "all healthy ($(cat "$BASE/current/REVISION" 2>/dev/null || echo "unknown revision"))"
    return 0
  fi

  local R="$BASE/releases/$rel"
  [[ -n "$rel" && -d "$R/app" ]] || die "release $rel was not uploaded"

  # ---- preflight: lemniscate.env
  local left
  left="$(grep -oE '^[A-Z0-9_]+=(CHANGE_ME|GENERATED_BY_PROVISION)$' "$ENVF" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$left" ]] || die "fill these in /etc/lemniscate/lemniscate.env first: $left"
  [[ "$(envval NETWORK)" == mainnet ]] || die "NETWORK must be mainnet in /etc/lemniscate/lemniscate.env"
  [[ "$(envval CHAIN_ID)" == 4663 ]] || die "CHAIN_ID must be 4663 in /etc/lemniscate/lemniscate.env"
  [[ "$(envval DEPLOYMENT_FILE)" == /opt/lemniscate/current/app/deployments/4663.json ]] \
    || die "DEPLOYMENT_FILE must be /opt/lemniscate/current/app/deployments/4663.json"
  local v f
  # No raw key anywhere: the services read keystores (KEYS dir) themselves; NODE_ENV=production refuses a raw key too.
  for f in "$ENVF" /etc/lemniscate/*.env; do
    [[ -f "$f" ]] || continue
    for v in KEEPER_PRIVATE_KEY HEDGER_PRIVATE_KEY VOL_SIGNER_KEY VOL_SENDER_KEY PAYMASTER_SIGNER_KEY X402_SETTLER_KEY AGENT_KEY; do
      if grep -qE "^$v=." "$f"; then die "$v is set in $f: remove it and use a keystore in $KEYS instead"; fi
    done
  done
  local rpc chain
  rpc="$(envval PUBLIC_RPC_URL)"
  rpc="${rpc:-https://rpc.mainnet.chain.robinhood.com}"
  chain="$(curl -fsS -m 20 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc" | jq -r '.result // empty')" \
    || die "PUBLIC_RPC_URL did not answer eth_chainId"
  [[ -n "$chain" && "$((chain))" == 4663 ]] || die "PUBLIC_RPC_URL answered chain id ${chain:-nothing}, not Robinhood Chain mainnet 4663: refusing"

  local dep="$R/app/deployments/4663.json"
  [[ -f "$dep" ]] || die "4663.json missing from the release"
  jq -e '.chainId == 4663 and .network == "mainnet" and (.forkProof == null)' "$dep" >/dev/null || die "4663.json is not a mainnet (4663) deployment"
  local want have
  want="$(jq -r '.contracts.volOracle // empty' "$dep")"
  have="$(envval VOL_ORACLE_ADDRESS)"
  [[ -z "$want" || "$(lower "$want")" == "$(lower "$have")" ]] || die "VOL_ORACLE_ADDRESS in lemniscate.env is $have but 4663.json says volOracle = $want"

  # One Unix user per service (PRIV-5): make sure the users, state dirs and env files exist and each keystore belongs to the
  # one service that signs with it (a server provisioned before this change gets them here).
  bash "$R/app/scripts/server/provision.sh" --service-users
  # Keystores: the three required roles, then every file in the folder must be a readable pair.
  local role owner other
  for role in keeper hedger vol-signer; do
    [[ -e "$KEYS/$role.json" && -e "$KEYS/$role.password" ]] || die "$KEYS/$role.json and $role.password are missing (copy the $role keystore and password file in)"
  done
  for f in "$KEYS"/*.json; do
    [[ -e "$f" ]] || continue
    role="$(basename "$f" .json)"
    case "$role" in
      keeper) owner=keeper ;;
      hedger) owner=hedger ;;
      vol-signer | vol-sender) owner=vol-engine ;;
      paymaster-signer | x402-settler) owner=api ;;
      *) die "$f is not a known keystore role (keeper, hedger, vol-signer, paymaster-signer, x402-settler)" ;;
    esac
    # Access test only: the files are never read or printed here. Only the owning service's user may open them.
    runuser -u "lem-$owner" -- test -r "$f" && runuser -u "lem-$owner" -- test -r "$KEYS/$role.password" \
      || die "$KEYS/$role.json or $role.password is not readable by lem-$owner: run provision.sh --service-users"
    for other in keeper hedger vol-engine api; do
      [[ "$other" == "$owner" ]] && continue
      if runuser -u "lem-$other" -- test -r "$f" 2>/dev/null; then die "$f is readable by lem-$other, which does not sign with it: run provision.sh --service-users"; fi
    done
  done
  # Paymaster: address and keystore go together.
  if [[ -e "$KEYS/paymaster-signer.json" && -z "$(envval PAYMASTER_ADDRESS)" ]]; then die "paymaster-signer keystore exists but PAYMASTER_ADDRESS is empty"; fi
  if [[ ! -e "$KEYS/paymaster-signer.json" && -n "$(envval PAYMASTER_ADDRESS)" ]]; then die "PAYMASTER_ADDRESS is set but there is no paymaster-signer keystore"; fi
  # The api reads the optional keystores from a generated file of paths (no secret in it); only roles whose keystore exists.
  local keysenv="/etc/lemniscate/api-keys.env"
  : >"$keysenv.tmp"
  if [[ -e "$KEYS/paymaster-signer.json" ]]; then
    printf 'PAYMASTER_SIGNER_KEYSTORE=%s\nPAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE=%s\n' "$KEYS/paymaster-signer.json" "$KEYS/paymaster-signer.password" >>"$keysenv.tmp"
  fi
  if [[ -e "$KEYS/x402-settler.json" ]]; then
    printf 'X402_SETTLER_KEYSTORE=%s\nX402_SETTLER_KEYSTORE_PASSWORD_FILE=%s\n' "$KEYS/x402-settler.json" "$KEYS/x402-settler.password" >>"$keysenv.tmp"
  fi
  chmod 0644 "$keysenv.tmp" && mv "$keysenv.tmp" "$keysenv"
  log "preflight ok: chain 4663, deployment block $(jq -r '.deployBlock' "$dep"), keystores readable"

  # ---- units, ownership, dependencies
  bash "$R/app/scripts/server/provision.sh" --units-only
  printf '%s\n' "$sha" >"$R/REVISION"
  chown -R lemniscate:lemniscate "$R"
  # The service users (not the owner of the files) run the code: readable and traversable by them, writable by nobody else.
  chmod -R go-w,a+rX "$R"
  log "bun install --frozen-lockfile"
  (cd "$R/app" && runuser -u lemniscate -- env HOME=/var/lib/lemniscate PATH=/usr/local/bin:/usr/bin:/bin \
    bun install --frozen-lockfile --production) || die "bun install failed; /opt/lemniscate/current is unchanged"
  log "key preflight: every keystore unlocks, addresses are distinct (addresses only are printed)"
  # Runs as root: it must open every keystore to compare addresses, and no service user may open them all.
  (cd "$R/app" && env HOME=/root PATH=/usr/local/bin:/usr/bin:/bin bun src/bin/check-keys.ts "$KEYS") || die "key preflight failed (see above); /opt/lemniscate/current is unchanged"
  log "vol-engine virtualenv (hash-pinned: requirements.lock, --require-hashes)"
  (cd "$R/vol-engine" && runuser -u lemniscate -- env HOME=/var/lib/lemniscate PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c 'python3 -m venv .venv && ./.venv/bin/pip install --quiet --no-cache-dir --require-hashes --no-deps -r requirements.lock && ./.venv/bin/pip install --quiet --no-cache-dir --no-deps --no-build-isolation .') \
    || die "could not build the vol-engine virtualenv; /opt/lemniscate/current is unchanged"

  # ---- switch, migrate (roll the link back on failure)
  local prev=""
  [[ -L "$BASE/current" ]] && prev="$(readlink "$BASE/current")"
  point() { ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; }
  point "releases/$rel"
  log "current -> releases/$rel; migrating"
  if ! systemctl start lemniscate-migrate.service; then
    journalctl -u lemniscate-migrate.service -n 30 --no-pager -o cat | sed 's/^/  | /'
    [[ -z "$prev" ]] || point "$prev"
    die "migrations failed: current is back on ${prev:-nothing}; services were not restarted"
  fi

  # ---- restart one by one, check each; roll back on the first failure
  local s units=()
  while IFS= read -r s; do units+=("lemniscate-$s.service"); done < <(service_list)
  systemctl enable --quiet lemniscate.target "${units[@]}"
  local bad=""
  while IFS= read -r s; do
    log "restarting $s"
    systemctl restart "lemniscate-$s.service"
    if ! check_one "$s"; then bad="$s"; break; fi
  done < <(service_list)

  if [[ -n "$bad" ]]; then
    if [[ -z "$prev" ]]; then
      printf '\n%s failed on the first release (nothing to roll back to). Logs: journalctl -u lemniscate-%s -n 100\n' "$bad" "$bad" >&2
      exit 1
    fi
    log "$bad is unhealthy: rolling back to $prev"
    point "$prev"
    systemctl restart lemniscate.target || true
    local back=0
    while IFS= read -r s; do check_one "$s" || back=1; done < <(service_list)
    printf '\nRelease %s FAILED at %s and was rolled back to %s%s. Migrations were not reversed. Logs: journalctl -u lemniscate-%s -n 100\n' \
      "$rel" "$bad" "$prev" "$([[ "$back" == 0 ]] && echo " (healthy)" || echo " (STILL UNHEALTHY: look now)")" "$bad" >&2
    exit 1
  fi
  systemctl is-active --quiet caddy || log "WARNING: caddy is not running"
  print_keeper

  # ---- keep the 5 newest releases (never the current or the previous one)
  local keep_cur keep_prev d
  keep_cur="$(readlink -f "$BASE/current")"
  keep_prev=""
  [[ -n "$prev" ]] && keep_prev="$(cd "$BASE" && readlink -f "$prev" || true)"
  while IFS= read -r d; do
    [[ -n "$d" && "$d" != "$keep_cur" && "$d" != "$keep_prev" ]] && rm -rf "$d"
  done < <(ls -1dt "$BASE"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +6)

  log "release $rel ($sha) live and healthy"
}
main "$@" </dev/null
REMOTE
}

run_remote() { remote_script | ssh_ bash -s -- "$@"; }

# ---------------------------------------------------------------- --check
if [[ "$MODE" == check ]]; then
  run_remote check
  exit 0
fi

SHA="$(git -C "$ROOT" rev-parse --verify "${REF}^{commit}")" || die "no commit $REF"
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  log "note: the checkout has uncommitted changes; they are NOT deployed (only commit ${SHA:0:12})"
fi

# ---------------------------------------------------------------- --provision
if [[ "$MODE" == provision ]]; then
  log "copying app/scripts/server at ${SHA:0:12} to /root/lemniscate-server"
  git -C "$ROOT" archive --format=tar "$SHA" app/scripts/server | gzip -c \
    | ssh_ "rm -rf /root/lemniscate-server && mkdir -p /root/lemniscate-server && tar -xzf - -C /root/lemniscate-server --strip-components=3 --no-same-owner"
  envs=""
  for v in API_DOMAIN MCP_DOMAIN ACME_EMAIL DB_NAME SWAP_SIZE TIMESCALE_CODENAME; do
    [[ -n "${!v:-}" ]] && envs+="$v=$(printf '%q' "${!v}") "
  done
  log "running provision.sh on the server (takes a few minutes)"
  ssh_ "cd /root/lemniscate-server && ${envs}bash provision.sh"
  exit 0
fi

# ---------------------------------------------------------------- deploy: local checks
DEP_SRC="${LEMNISCATE_DEPLOYMENTS_SRC:-$APP/deployments}"
[[ -f "$DEP_SRC/4663.json" ]] || die "no mainnet deployment in $DEP_SRC (4663.json): set LEMNISCATE_DEPLOYMENTS_SRC to the folder that has it"
grep -Eq '"chainId"[[:space:]]*:[[:space:]]*4663([^0-9]|$)' "$DEP_SRC/4663.json" || die "$DEP_SRC/4663.json is not for chain 4663"
grep -Eq '"network"[[:space:]]*:[[:space:]]*"mainnet"' "$DEP_SRC/4663.json" || die "$DEP_SRC/4663.json is not a mainnet deployment (network must be mainnet)"
if grep -Eq '"forkProof"' "$DEP_SRC/4663.json"; then die "$DEP_SRC/4663.json comes from a fork run (it has forkProof)"; fi

# ---------------------------------------------------------------- deploy: upload, then run on the server
REL="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}"
log "deploying ${SHA:0:12} to $HOST as release $REL"
git -C "$ROOT" archive --format=tar "$SHA" app vol-engine LICENSE README.md | gzip -c \
  | ssh_ "set -e; test -d /opt/lemniscate/releases || { echo 'not provisioned: run deploy.sh --provision first' >&2; exit 1; }; mkdir /opt/lemniscate/releases/$REL; tar -xzf - -C /opt/lemniscate/releases/$REL --no-same-owner"
ssh_ "mkdir -p /opt/lemniscate/releases/$REL/app/deployments"
ssh_ "cat >/opt/lemniscate/releases/$REL/app/deployments/4663.json" <"$DEP_SRC/4663.json"
log "uploaded code and 4663.json"

run_remote deploy "$REL" "$SHA"

# ---------------------------------------------------------------- optional public checks from this machine
if [[ -n "${LEMNISCATE_PUBLIC_API_URL:-}" ]]; then
  curl -fsS -m 20 "${LEMNISCATE_PUBLIC_API_URL%/}/v1/health" >/dev/null && log "public API ok (${LEMNISCATE_PUBLIC_API_URL%/}/v1/health)" \
    || die "public API check failed at ${LEMNISCATE_PUBLIC_API_URL%/}/v1/health (DNS, Caddy certificate or firewall?)"
fi
log "done"
