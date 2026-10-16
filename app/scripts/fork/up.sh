#!/usr/bin/env bash
# The whole Lemniscate stack on a persistent anvil fork of Robinhood Chain mainnet (chain id 31337, never 4663).
#
#   bash scripts/fork/up.sh       rpc cache -> anvil fork (pinned block, saved state) -> Postgres lemniscate_fork ->
#                                 deploy (first run only) -> post-deploy check -> env files -> migrate -> indexer, api,
#                                 keeper, hedger, vol-engine, mcp (HTTP), bundler; health-checks each
#   bash scripts/fork/down.sh     stops everything (state, database and deployment are kept)
#   bash scripts/fork/reset.sh    down + delete the fork state, deployment and database (next up forks a fresh block)
#
# Env: PORT_OFFSET (all ports, see env.sh), FORK_DIR (default ~/.lemniscate/fork, outside the repo), RHC_MAINNET_RPC_URL (upstream, default the free
# public RPC), DEPLOY_CONFIG (deploy config JSON path; required on the first run), VOL_ENGINE_PYTHON (a Python with the
# vol-engine dependencies; default vol-engine/.venv/bin/python), FORK_BLOCK (pin a block instead of upstream latest).
# The deployer and every bot are anvil's own dev accounts; their keys are read from anvil's --config-out file at run time.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
mkdir -p "$FORK_DIR"/{logs,pids,env}

for bin in anvil cast forge bun curl jq; do command -v "$bin" >/dev/null || { echo "up: $bin not found" >&2; exit 69; }; done
[[ -x "$PG_BIN/pg_ctl" ]] || { echo "up: Postgres 16 binaries not found (set PG_BIN)" >&2; exit 69; }

# start <name> <health: url | rpc url | none> -- <command...>  (cwd app/, env from $FORK_DIR/env/<name>.env when present)
start() {
  local name="$1" health="$2"
  shift 3
  if alive "$name"; then echo "up: $name already running"; return; fi
  (
    cd "$APP"
    if [[ -f "$FORK_DIR/env/$name.env" ]]; then set -a; source "$FORK_DIR/env/$name.env"; set +a; fi
    nohup "$@" >>"$FORK_DIR/logs/$name.log" 2>&1 &
    echo $! >"$FORK_DIR/pids/$name.pid"
  )
  for i in $(seq 1 240); do
    case "$health" in
      rpc:*) cast chain-id --rpc-url "${health#rpc:}" >/dev/null 2>&1 && { echo "up: $name healthy"; return; } ;;
      http*) curl -fsS "$health" >/dev/null 2>&1 && { echo "up: $name healthy ($health)"; return; } ;;
      *) [[ $i -ge 12 ]] && alive "$name" && { echo "up: $name running"; return; } ;;
    esac
    alive "$name" || { echo "up: $name exited; see $FORK_DIR/logs/$name.log" >&2; tail -25 "$FORK_DIR/logs/$name.log" >&2; exit 1; }
    sleep 0.5
  done
  echo "up: $name not healthy after 120 s; see $FORK_DIR/logs/$name.log" >&2
  exit 1
}

for p in $ANVIL_PORT $CACHE_PORT $PG_PORT $API_PORT $MCP_PORT $BUNDLER_PORT; do
  owner="$(lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$owner" ]] && ! grep -qs "^$owner\$" "$FORK_DIR"/pids/*.pid && [[ "$owner" != "$(head -1 "$FORK_DIR/pg/postmaster.pid" 2>/dev/null)" ]]; then
    echo "up: port $p is used by another process; pick another PORT_OFFSET" >&2
    exit 1
  fi
done

# 1. Caching proxy in front of the public RPC (it keeps ~15 min of history; the cache keeps everything we touched).
start rpc-cache "http://127.0.0.1:$CACHE_PORT/health" -- bun scripts/fork/rpc-cache.ts --port "$CACHE_PORT" --upstream "$UPSTREAM_RPC" --cache "$FORK_DIR/rpc-cache.jsonl"

# 2. anvil, pinned to a recorded block, state saved every minute and on exit.
if [[ ! -s "$FORK_DIR/fork-block" ]]; then
  [[ "$(cast chain-id --rpc-url "$UPSTREAM_RPC")" == 4663 ]] || { echo "up: upstream is not Robinhood Chain mainnet" >&2; exit 1; }
  echo "${FORK_BLOCK:-$(cast block-number --rpc-url "$UPSTREAM_RPC")}" >"$FORK_DIR/fork-block"
fi
FORK_BLOCK="$(cat "$FORK_DIR/fork-block")"
start anvil "rpc:$ANVIL_URL" -- anvil --host 127.0.0.1 --port "$ANVIL_PORT" --fork-url "http://127.0.0.1:$CACHE_PORT" \
  --fork-block-number "$FORK_BLOCK" --chain-id 31337 --hardfork cancun --block-time 1 --accounts 20 --balance 10000 \
  --state "$FORK_DIR/state.json" --state-interval 60 --config-out "$FORK_DIR/anvil-accounts.json" --no-rate-limit
[[ "$(cast chain-id --rpc-url "$ANVIL_URL")" == 31337 ]] || { echo "up: anvil is not chain 31337" >&2; exit 1; }
# Warm the mutable mainnet state inside the public node's ~15 minute history window (first start of a fork only).
if [[ ! -s "$FORK_DIR/deployment.json" ]]; then
  bun scripts/fork/warm.ts "${DEPLOY_CONFIG:?first run: set DEPLOY_CONFIG to the fork deploy config JSON}" 2>&1 | tail -2 | sed 's/^/up: /'
fi
echo "up: fork of mainnet block $FORK_BLOCK on $ANVIL_URL (chain 31337)"

# 3. Postgres cluster of its own (port PG_PORT), database lemniscate_fork.
if [[ ! -f "$FORK_DIR/pg/PG_VERSION" ]]; then
  "$PG_BIN/initdb" -D "$FORK_DIR/pg" -U "$(whoami)" -A trust --no-locale -E UTF8 >"$FORK_DIR/logs/initdb.log"
fi
if ! "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" status >/dev/null 2>&1; then
  LC_ALL=C "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" -l "$FORK_DIR/logs/postgres.log" -o "-p $PG_PORT -k $FORK_DIR -c listen_addresses=127.0.0.1" -w start >/dev/null
fi
"$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -d postgres -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
  || "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" "$DB_NAME"
echo "up: Postgres on $PG_PORT, database $DB_NAME"

# 4. Deploy the whole system against the real tokens, feeds and pools (first run of this fork only).
if [[ ! -s "$FORK_DIR/deployment.json" ]]; then
  CONFIG="${DEPLOY_CONFIG:?first run: set DEPLOY_CONFIG to the fork deploy config JSON (docs/runbooks/deploy/deploy-config.fork.json)}"
  cp "$CONFIG" "$FORK_DIR/deploy-config.json"
  DEPLOYER="$(jq -r '.available_accounts[0]' "$FORK_DIR/anvil-accounts.json")"
  (
    cd "$ROOT/contracts"
    DEPLOY_CONFIG_JSON="$(cat "$FORK_DIR/deploy-config.json")" DEPLOYMENT_OUT="deployments/fork.json" \
      forge script script/DeploySystem.s.sol --rpc-url "$ANVIL_URL" --unlocked --sender "$DEPLOYER" --broadcast --slow \
      >"$FORK_DIR/logs/deploy.log" 2>&1 || { tail -40 "$FORK_DIR/logs/deploy.log" >&2; exit 1; }
    DEPLOYMENT_FILE=deployments/fork.json DEPLOY_CONFIG_JSON="$(cat "$FORK_DIR/deploy-config.json")" \
      forge script script/PostDeployCheck.s.sol --rpc-url "$ANVIL_URL" >"$FORK_DIR/logs/post-deploy-check.log" 2>&1 \
      || { tail -40 "$FORK_DIR/logs/post-deploy-check.log" >&2; exit 1; }
    grep -q "PASS" "$FORK_DIR/logs/post-deploy-check.log"
    cp deployments/fork.json "$FORK_DIR/deployment.json"
    # Keep the broadcast (gas table) in FORK_DIR; the repo copies carry mainnet addresses and must not linger.
    rm -rf "$FORK_DIR/broadcast-deploy" && cp -R broadcast/DeploySystem.s.sol/31337 "$FORK_DIR/broadcast-deploy"
    rm -rf deployments/fork.json broadcast/DeploySystem.s.sol/31337 broadcast/PostDeployCheck.s.sol/31337 cache/DeploySystem.s.sol cache/PostDeployCheck.s.sol
    rmdir deployments 2>/dev/null || true
  )
  grep -E "PASS|FAIL" "$FORK_DIR/logs/deploy.log" "$FORK_DIR/logs/post-deploy-check.log" | sed 's/^/up: /'
  bun scripts/fork/setup.ts --proof --relax
fi

# 5. Env files (keys from anvil's config-out, never written to the repo), migrations, services.
bun scripts/fork/setup.ts --env
(cd "$APP" && set -a && source "$FORK_DIR/env/api.env" && set +a && bun scripts/fork/migrate.ts >>"$FORK_DIR/logs/migrate.log" 2>&1) \
  || { tail -20 "$FORK_DIR/logs/migrate.log" >&2; exit 1; }

start bundler "http://127.0.0.1:$BUNDLER_PORT/health" -- bun scripts/fork/bundler.ts
start indexer none -- bun src/bin/indexer.ts
start api "http://127.0.0.1:$API_PORT/v1/health" -- bun src/bin/api.ts
start keeper none -- bun src/bin/keeper.ts
start hedger none -- bun src/bin/hedger.ts
start mcp none -- bun src/bin/mcp.ts --http
VOL_PY="${VOL_ENGINE_PYTHON:-$ROOT/vol-engine/.venv/bin/python}"
if [[ -x "$VOL_PY" ]] && "$VOL_PY" -c "import numpy, eth_account, psycopg" 2>/dev/null; then
  start vol-engine none -- env PYTHONPATH="$ROOT/vol-engine/src" "$VOL_PY" -m vol_engine.cli post --loop --interval 60
else
  echo "up: vol-engine NOT started: no Python with numpy, eth-account, psycopg (python3 -m venv vol-engine/.venv && vol-engine/.venv/bin/pip install -e vol-engine, or VOL_ENGINE_PYTHON)"
fi

echo "up: fork stack ready. RPC $ANVIL_URL (chain 31337), API http://127.0.0.1:$API_PORT/v1, MCP http://127.0.0.1:$MCP_PORT, logs $FORK_DIR/logs"
