#!/usr/bin/env bash
# Deploys the Lemniscate backend from the owner's machine to a server prepared by provision.sh, over SSH as root.
#
#   app/scripts/server/deploy.sh <host>                  deploy the committed HEAD
#   app/scripts/server/deploy.sh --ref <ref> <host>      deploy a commit, tag or branch
#   app/scripts/server/deploy.sh --provision <host>      first time: copy app/scripts/server up and run provision.sh
#   app/scripts/server/deploy.sh --check <host>          health-check every service, change nothing
#   app/scripts/server/deploy.sh --local --repo <git dir> --ref <40-hex sha>   deploy ON this server (release runner), no ssh
#   app/scripts/server/deploy.sh --local --check          health-check this server, change nothing
#
# --local runs the same steps and the same automatic return to the previous release, on the machine it is started on
# (it must be the root of a provisioned server). It is the real-deploy path, so it refuses unless BOTH
# LEMNISCATE_ALLOW_REAL_DEPLOY=1 is set (by the runner's service) and the file named by LEMNISCATE_ALLOW_FILE exists
# (created only when the launch is armed). --ref must be a full 40-hex sha; --repo is a git dir (bare is fine).
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
# Files are created with umask 022 and the release dir is 0755, whatever umask the caller had (a sudo wrapper or a
# systemd unit with UMask=0027 would otherwise make the release, node_modules and the virtualenv unreadable to the
# lem-* service users). Network steps (eth_chainId, bun install, pip) are retried with backoff (DEPLOY_RETRY_WAITS,
# seconds, default "10 30": three tries).
#
# A release dir is named <UTC time>-<sha12>, so name order is age order. A deploy that passed every check writes
# <release>/.healthy; a deploy that stopped before the switch removes its staged dir. Rollback (by hand or
# lemniscate-release-rollback) and the prune pick only .healthy releases, by name (previous_healthy_release, prune_releases).
# --local --check is read-only and needs no arming file.
#
# Exit codes: 0 deployed and healthy (or --check healthy); 75 nothing was switched (a failure before the link moved:
# commit or 4663.json missing, upload, preflight, bun install, key preflight, virtualenv, or migrations that kept
# hitting a lock timeout; the running release is untouched, safe to try again later); 1 a failure after the switch (migrations, an unhealthy service: the link went
# back to the previous release), an unhealthy --check, or a refused command line; 2 usage.
#
# Env (all optional):
#   SSH_OPTS                  extra ssh options, e.g. "-i ~/.ssh/<key> -p 22"
#   LEMNISCATE_DEPLOYMENTS_SRC  folder holding 4663.json (default: app/deployments of this checkout)
#   LEMNISCATE_PUBLIC_API_URL   e.g. https://api.<your-domain>: also checked from this machine after the deploy
#   LEMNISCATE_ALLOW_REAL_DEPLOY, LEMNISCATE_ALLOW_FILE   the --local arming guard (see above)
#   DEPLOY_RETRY_WAITS        waits between tries of a network step (default "10 30")
#   DEPLOY_SH_TEST_ROOT, DEPLOY_SH_TEST_SERVER   tests only, refused as root: a fake root for /opt/lemniscate and a stand-in
#                             for the server script (the release runner's sandbox runs the real argument handling this way)
#   API_DOMAIN, MCP_DOMAIN, ACME_EMAIL, DB_NAME, SWAP_SIZE, TIMESCALE_CODENAME: passed to provision.sh by --provision
set -euo pipefail
umask 022

# Nothing was switched: the caller (the release runner) may try again later; it never rolls back on this code.
EX_NOT_SWITCHED=75

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
# a failure before anything on the server was switched
die_unswitched() { printf 'deploy: %s (nothing switched)\n' "$*" >&2; exit "$EX_NOT_SWITCHED"; }
log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# retry <what> <command...>: up to 1 + the number of DEPLOY_RETRY_WAITS tries, waiting that long between them.
retry() {
  local what="$1" w waits rc
  shift
  read -r -a waits <<<"${DEPLOY_RETRY_WAITS:-10 30}"
  for w in ${waits[@]+"${waits[@]}"} last; do
    if "$@"; then return 0; else rc=$?; fi
    [[ "$w" == last ]] && break
    log "$what failed (exit $rc); trying again in ${w}s" >&2
    sleep "$w"
  done
  return "$rc"
}

# stage_release <git dir> <sha> <release dir> <folder with 4663.json>: the committed tree of app/ and vol-engine/ at sha
# (git archive, so a bare repo works) plus the deployment file, in a NEW release dir that every service user can read.
stage_release() {
  local root="$1" sha="$2" dir="$3" dep="$4"
  mkdir -m 0755 "$dir" || return 1
  chmod 0755 "$dir" || return 1
  git -C "$root" archive --format=tar "$sha" app vol-engine LICENSE README.md | tar -xf - -C "$dir" --no-same-owner || return 1
  mkdir -p "$dir/app/deployments" && chmod 0755 "$dir/app/deployments" || return 1
  cat "$dep/4663.json" >"$dir/app/deployments/4663.json" || return 1
  chmod -R go-w,a+rX "$dir"
}

# ---------------------------------------------------------------- release dirs (shared by this script, the server script,
# the release runner's rollback wrapper and the tests: defined once, eval'ed here and sent ahead of the server script)
RELEASE_FNS="$(cat <<'FNS'
current_release() { local l; l="$(readlink "$1/current" 2>/dev/null)" || return 0; basename "$l"; }
# previous_healthy_release <base>: the newest .healthy release older (by name) than the current one; empty if none
previous_healthy_release() {
  local base="$1" cur r out=""
  cur="$(current_release "$base")"
  while IFS= read -r r; do
    [[ -n "$r" && "$r" != "$cur" && -e "$base/releases/$r/.healthy" ]] || continue
    if [[ -z "$cur" || "$r" < "$cur" ]]; then out="$r"; fi
  done < <(ls -1 "$base/releases" 2>/dev/null | LC_ALL=C sort)
  printf '%s' "$out"
}
# abandon_release <base> <rel>: a staged release that never went live is removed (never the current one)
abandon_release() {
  local base="$1" rel="$2"
  [[ -n "$rel" && -d "$base/releases/$rel" && "$rel" != "$(current_release "$base")" ]] || return 0
  rm -rf "${base:?}/releases/$rel"
}
# prune_releases <base> <keep> [<previous rel>]: removes every release without .healthy (failed or half-built) and keeps
# <keep> healthy ones in all: the current one, the given previous one and the newest others
prune_releases() {
  local base="$1" keep="$2" prev="${3:-}" cur r healthy=()
  cur="$(current_release "$base")"
  while IFS= read -r r; do
    [[ -n "$r" && "$r" != "$cur" && "$r" != "$prev" ]] || continue
    if [[ -e "$base/releases/$r/.healthy" ]]; then healthy+=("$r"); else rm -rf "${base:?}/releases/$r"; fi
  done < <(ls -1 "$base/releases" 2>/dev/null | LC_ALL=C sort)
  local n="${#healthy[@]}" i
  for ((i = 0; i < n - (keep - 2); i++)); do rm -rf "${base:?}/releases/${healthy[$i]}"; done
  return 0
}
FNS
)"
eval "$RELEASE_FNS"

# ---------------------------------------------------------------- the script that runs on the server (as root)
# Wrapped in main() and called with stdin from /dev/null, so no command inside can swallow the rest of the script
# that bash -s is still reading from stdin.
remote_script() {
  printf '%s\n' "$RELEASE_FNS"
  cat <<'REMOTE'
main() {
  set -euo pipefail
  umask 022
  local mode="$1" rel="${2:-}" sha="${3:-}"
  # Any failure of a deploy before the link moves exits 75 ("nothing switched"; the running release is untouched and the
  # caller may simply try again later). From the switch on, a failure exits 1 (the link was put back; see below).
  SWITCHED=0
  if [[ "$mode" == deploy ]]; then
    trap 'rc=$?; if [[ "$rc" != 0 && "$SWITCHED" == 0 ]]; then abandon_release /opt/lemniscate "$rel"; printf "deploy (server): stopped before the switch (exit %s): nothing switched, %s/current is unchanged\n" "$rc" /opt/lemniscate >&2; exit 75; fi' EXIT
  fi
  local BASE=/opt/lemniscate ENVF=/etc/lemniscate/lemniscate.env KEYS=/etc/lemniscate/keys
  # Start order. Required services always; mcp only when it is already enabled.
  local CORE=(indexer api keeper hedger vol-engine)
  log() { printf '[server %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
  die() { printf 'deploy (server): %s\n' "$*" >&2; exit 1; }
  # Last assignment wins, as in systemd's EnvironmentFile.
  envval() { sed -n "s/^$1=//p" "$ENVF" | tail -1; }
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
  # retry <what> <command...>: network steps (RPC, package registries) get 1 + len(DEPLOY_RETRY_WAITS) tries.
  retry() {
    local what="$1" w waits rc=1
    shift
    read -r -a waits <<<"${DEPLOY_RETRY_WAITS:-10 30}"
    for w in ${waits[@]+"${waits[@]}"} last; do
      if "$@"; then return 0; else rc=$?; fi
      [[ "$w" == last ]] && break
      log "$what failed (exit $rc); trying again in ${w}s" >&2
      sleep "$w"
    done
    return "$rc"
  }

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
  chain_id() { curl -fsS -m 20 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$rpc" | jq -er '.result'; }
  chain="$(retry "eth_chainId" chain_id)" || die "PUBLIC_RPC_URL did not answer eth_chainId (tried 3 times)"
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
  # registry outages (review 17): reuse the running release's node_modules when the lockfile and package.json are unchanged;
  # bun install below then only verifies it
  local live_dir=""
  [[ -L "$BASE/current" ]] && live_dir="$(readlink -f "$BASE/current")"
  if [[ -n "$live_dir" && -d "$live_dir/app/node_modules" ]] && cmp -s "$live_dir/app/bun.lock" "$R/app/bun.lock" \
    && cmp -s "$live_dir/app/package.json" "$R/app/package.json"; then
    cp -a "$live_dir/app/node_modules" "$R/app/node_modules" && log "reused node_modules of the running release (bun.lock unchanged)"
  fi
  chown -R lemniscate:lemniscate "$R"
  # The service users (not the owner of the files) run the code: readable and traversable by them, writable by nobody else.
  chmod -R go-w,a+rX "$R"
  log "bun install --frozen-lockfile"
  bun_install() { (cd "$R/app" && runuser -u lemniscate -- env HOME=/var/lib/lemniscate PATH=/usr/local/bin:/usr/bin:/bin \
    bun install --frozen-lockfile --production); }
  retry "bun install" bun_install || die "bun install failed (tried 3 times); /opt/lemniscate/current is unchanged"
  log "key preflight: every keystore unlocks, addresses are distinct (addresses only are printed)"
  # Runs as root: it must open every keystore to compare addresses, and no service user may open them all.
  (cd "$R/app" && env HOME=/root PATH=/usr/local/bin:/usr/bin:/bin bun src/bin/check-keys.ts "$KEYS") || die "key preflight failed (see above); /opt/lemniscate/current is unchanged"
  log "vol-engine virtualenv (hash-pinned: requirements.lock, --require-hashes)"
  venv_build() { (cd "$R/vol-engine" && runuser -u lemniscate -- env HOME=/var/lib/lemniscate PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c 'python3 -m venv .venv && ./.venv/bin/pip install --quiet --no-cache-dir --require-hashes --no-deps -r requirements.lock && ./.venv/bin/pip install --quiet --no-cache-dir --no-deps --no-build-isolation .'); }
  retry "vol-engine virtualenv" venv_build || die "could not build the vol-engine virtualenv (tried 3 times); /opt/lemniscate/current is unchanged"
  # node_modules and .venv were made by the lemniscate user: readable and traversable by every service user too
  chmod 0755 "$R"
  chmod -R go-w,a+rX "$R"

  # ---- switch, migrate (roll the link back on failure)
  local prev=""
  [[ -L "$BASE/current" ]] && prev="$(readlink "$BASE/current")"
  point() { ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; }
  # the release running now was healthy when it was deployed (releases from before .healthy existed get it here)
  [[ -n "$prev" && -d "$BASE/$prev" && ! -e "$BASE/$prev/.healthy" ]] && touch "$BASE/$prev/.healthy"
  SWITCHED=1
  point "releases/$rel"
  log "current -> releases/$rel; migrating"
  if ! systemctl start lemniscate-migrate.service; then
    journalctl -u lemniscate-migrate.service -n 30 --no-pager -o cat | sed 's/^/  | /'
    [[ -z "$prev" ]] || point "$prev"
    if [[ -n "$prev" && "$(systemctl show -p ExecMainStatus --value lemniscate-migrate.service 2>/dev/null)" == 75 ]]; then
      SWITCHED=0   # the migrator gave up on a lock timeout and rolled back: nothing changed, current is back
      die "migrations kept hitting a lock timeout under load (nothing applied): current is back on $prev; try again later"
    fi
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

  # ---- mark it healthy; keep the 5 newest healthy releases, drop failed / half-built ones (never current or previous)
  touch "$R/.healthy"
  prune_releases "$BASE" 5 "$(basename "${prev:-none}")"

  log "release $rel ($sha) live and healthy"
}
main "$@" </dev/null
REMOTE
}

# Tests source this file with DEPLOY_SH_SOURCE_ONLY=1 to reach the functions above (stage_release, retry, remote_script)
# without running a deploy (deploy-local.test.sh).
if [[ "${DEPLOY_SH_SOURCE_ONLY:-}" == 1 ]]; then return 0 2>/dev/null || exit 0; fi

MODE=deploy
REF=HEAD
HOST=""
LOCAL=0
REPO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) [[ $# -ge 2 ]] || die "--ref needs a value"; REF="$2"; shift 2 ;;
    --provision) MODE=provision; shift ;;
    --check) MODE=check; shift ;;
    --local) LOCAL=1; shift ;;
    --repo) [[ $# -ge 2 ]] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (try --help)" ;;
    *) [[ -z "$HOST" ]] || die "one host only"; HOST="$1"; shift ;;
  esac
done
if [[ "$LOCAL" == 1 && "$MODE" == check ]]; then
  [[ -z "$HOST" ]] || die "--local takes no host"   # read-only: no arming needed
elif [[ "$LOCAL" == 1 ]]; then
  # Real-deploy guard: first thing, before any other check, so a refused run touches nothing.
  [[ "${LEMNISCATE_ALLOW_REAL_DEPLOY:-}" == 1 ]] || die "--local refused: LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set (the real-deploy guard)"
  [[ -n "${LEMNISCATE_ALLOW_FILE:-}" && -f "$LEMNISCATE_ALLOW_FILE" ]] \
    || die "--local refused: the arming file named by LEMNISCATE_ALLOW_FILE is missing (the real-deploy guard)"
  [[ -z "$HOST" ]] || die "--local takes no host"
  [[ "$MODE" != provision ]] || die "--local cannot --provision"
  if [[ "$MODE" == deploy ]]; then
    [[ -n "$REPO" && -d "$REPO" ]] || die "--local deploy needs --repo <git dir>"
    [[ "$REF" =~ ^[0-9a-f]{40}$ ]] || die "--local deploy needs --ref <40-hex sha>, got '$REF'"
  fi
else
  [[ -z "$REPO" ]] || die "--repo only goes with --local"
  [[ -n "$HOST" ]] || { usage >&2; exit 2; }
  [[ "$HOST" =~ ^([A-Za-z0-9._-]+@)?[A-Za-z0-9._:-]+$ ]] || die "'$HOST' does not look like a host or user@host"
fi

for bin in git gzip curl; do
  command -v "$bin" >/dev/null || die "$bin not found"
done
[[ "$LOCAL" == 1 ]] || command -v ssh >/dev/null || die "ssh not found"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# tests only: a fake root and a stand-in server script (never as root, so never on a real server)
TEST_ROOT=""
if [[ -n "${DEPLOY_SH_TEST_ROOT:-}" ]]; then
  [[ "$(id -u)" != 0 ]] || die "DEPLOY_SH_TEST_ROOT is for tests only and is refused as root"
  [[ -x "${DEPLOY_SH_TEST_SERVER:-}" ]] || die "DEPLOY_SH_TEST_ROOT needs an executable DEPLOY_SH_TEST_SERVER"
  TEST_ROOT="$DEPLOY_SH_TEST_ROOT"
fi
BASE_DIR="$TEST_ROOT/opt/lemniscate"

# ---------------------------------------------------------------- ssh (one shared connection)
SSH_EXTRA=()
if [[ -n "${SSH_OPTS:-}" ]]; then read -r -a SSH_EXTRA <<<"$SSH_OPTS"; fi
[[ "$HOST" == *@* ]] || SSH_EXTRA+=(-l root)
CTL_DIR="$(mktemp -d)"
cleanup() {
  [[ "$LOCAL" == 1 ]] || ssh -o ControlPath="$CTL_DIR/c" -O exit "$HOST" >/dev/null 2>&1 || true
  rm -rf "$CTL_DIR"
}
trap cleanup EXIT
ssh_() {
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath="$CTL_DIR/c" -o ControlPersist=300 \
    -o ServerAliveInterval=30 ${SSH_EXTRA[@]+"${SSH_EXTRA[@]}"} "$HOST" "$@"
}

run_remote() {
  if [[ -n "$TEST_ROOT" ]]; then "$DEPLOY_SH_TEST_SERVER" "$BASE_DIR" "$@"
  elif [[ "$LOCAL" == 1 ]]; then remote_script | bash -s -- "$@"; else remote_script | ssh_ bash -s -- "$@"; fi
}

# ---------------------------------------------------------------- --check
if [[ "$MODE" == check ]]; then
  run_remote check
  exit 0
fi

# the commit's git dir: --repo (any git dir, bare is fine) for --local; this checkout otherwise. Resolved only now, after
# --check, so --check works from the pinned copy outside any checkout (/usr/local/lib/lemniscate-release/deploy.sh).
if [[ "$LOCAL" == 1 ]]; then
  ROOT="$(cd "$REPO" && pwd)"
else
  ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
fi
APP="$ROOT/app"

SHA="$(git -C "$ROOT" rev-parse --verify "${REF}^{commit}")" || die_unswitched "no commit $REF"
if [[ "$LOCAL" == 0 && -n "$(git -C "$ROOT" status --porcelain)" ]]; then
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
if [[ "$LOCAL" == 1 ]]; then [[ -n "${LEMNISCATE_DEPLOYMENTS_SRC:-}" ]] || die_unswitched "--local needs LEMNISCATE_DEPLOYMENTS_SRC (the folder that holds 4663.json)"; fi
[[ -f "$DEP_SRC/4663.json" ]] || die_unswitched "no mainnet deployment in $DEP_SRC (4663.json): set LEMNISCATE_DEPLOYMENTS_SRC to the folder that has it"
grep -Eq '"chainId"[[:space:]]*:[[:space:]]*4663([^0-9]|$)' "$DEP_SRC/4663.json" || die_unswitched "$DEP_SRC/4663.json is not for chain 4663"
grep -Eq '"network"[[:space:]]*:[[:space:]]*"mainnet"' "$DEP_SRC/4663.json" || die_unswitched "$DEP_SRC/4663.json is not a mainnet deployment (network must be mainnet)"
if grep -Eq '"forkProof"' "$DEP_SRC/4663.json"; then die_unswitched "$DEP_SRC/4663.json comes from a fork run (it has forkProof)"; fi

# ---------------------------------------------------------------- deploy: upload, then run on the server
REL="$(date -u +%Y%m%dT%H%M%SZ)-${SHA:0:12}"
if [[ "$LOCAL" == 1 ]]; then
  log "deploying ${SHA:0:12} on this server as release $REL"
  [[ -d "$BASE_DIR/releases" ]] || die_unswitched "not provisioned: $BASE_DIR/releases is missing"
  stage_release "$ROOT" "$SHA" "$BASE_DIR/releases/$REL" "$DEP_SRC" || { abandon_release "$BASE_DIR" "$REL"; die_unswitched "could not write the release dir $BASE_DIR/releases/$REL"; }
else
  log "deploying ${SHA:0:12} to $HOST as release $REL"
  git -C "$ROOT" archive --format=tar "$SHA" app vol-engine LICENSE README.md | gzip -c \
    | ssh_ "set -e; umask 022; test -d /opt/lemniscate/releases || { echo 'not provisioned: run deploy.sh --provision first' >&2; exit 1; }; mkdir -m 0755 /opt/lemniscate/releases/$REL; tar -xzf - -C /opt/lemniscate/releases/$REL --no-same-owner" \
    || die_unswitched "upload to $HOST failed"
  ssh_ "umask 022; mkdir -p /opt/lemniscate/releases/$REL/app/deployments"
  ssh_ "cat >/opt/lemniscate/releases/$REL/app/deployments/4663.json" <"$DEP_SRC/4663.json"
fi
log "uploaded code and 4663.json"

run_remote deploy "$REL" "$SHA"

# ---------------------------------------------------------------- optional public checks from this machine
if [[ -n "${LEMNISCATE_PUBLIC_API_URL:-}" ]]; then
  curl -fsS -m 20 "${LEMNISCATE_PUBLIC_API_URL%/}/v1/health" >/dev/null && log "public API ok (${LEMNISCATE_PUBLIC_API_URL%/}/v1/health)" \
    || die "public API check failed at ${LEMNISCATE_PUBLIC_API_URL%/}/v1/health (DNS, Caddy certificate or firewall?)"
fi
log "done"
