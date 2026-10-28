#!/usr/bin/env bash
# The Lemniscate services against Robinhood Chain TESTNET (46630) on THIS Mac, after deploy.sh:
#
#   bash scripts/testnet/up.sh       Postgres lemniscate_testnet (own cluster) -> env files (keystore paths only) -> migrate ->
#                                    bundler, feed-mirror, indexer, api, keeper, mcp, vol-engine; health-checks each (no hedger:
#                                    the testnet has no Uniswap v3, see below)
#   bash scripts/testnet/down.sh     stops them (the chain, the deployment and the database stay)
#
# Every service signs with its own throwaway testnet keystore (TESTNET_KEYS_DIR). Refuses unless the RPC answers 46630.
# Stop the fork stack first if it uses the same ports (it does not by default: this stack is PORT_OFFSET 70).
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
mkdir -p "$TESTNET_DIR"/{logs,pids,env}
for bin in cast bun curl; do command -v "$bin" >/dev/null || { echo "up: $bin not found" >&2; exit 69; }; done
[[ -x "$PG_BIN/pg_ctl" ]] || { echo "up: Postgres 16 binaries not found (set PG_BIN)" >&2; exit 69; }
[[ "$(cast chain-id --rpc-url "$TESTNET_RPC_URL")" == 46630 ]] || { echo "up: $TESTNET_RPC_URL is not chain 46630: refusing" >&2; exit 1; }
[[ -s "$TESTNET_DIR/deployment.json" ]] || { echo "up: no $TESTNET_DIR/deployment.json: run deploy.sh first" >&2; exit 1; }

for p in $PG_PORT $API_PORT $MCP_PORT $BUNDLER_PORT; do
  owner="$(lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [[ -n "$owner" ]] && ! grep -qs "^$owner\$" "$TESTNET_DIR"/pids/*.pid && [[ "$owner" != "$(head -1 "$TESTNET_DIR/pg/postmaster.pid" 2>/dev/null)" ]]; then
    echo "up: port $p is used by another process; pick another PORT_OFFSET" >&2
    exit 1
  fi
done

# start <name> <health: url | none> -- <command...>  (cwd app/, env from $TESTNET_DIR/env/<name>.env)
start() {
  local name="$1" health="$2"
  shift 3
  if alive "$name"; then echo "up: $name already running"; return; fi
  (
    cd "$APP"
    if [[ -f "$TESTNET_DIR/env/$name.env" ]]; then set -a; source "$TESTNET_DIR/env/$name.env"; set +a; fi
    nohup "$@" >>"$TESTNET_DIR/logs/$name.log" 2>&1 </dev/null &
    echo $! >"$TESTNET_DIR/pids/$name.pid"
  )
  for i in $(seq 1 240); do
    case "$health" in
      http*) curl -fsS "$health" >/dev/null 2>&1 && { echo "up: $name healthy ($health)"; return; } ;;
      *) [[ $i -ge 12 ]] && alive "$name" && { echo "up: $name running"; return; } ;;
    esac
    alive "$name" || { echo "up: $name exited; see $TESTNET_DIR/logs/$name.log" >&2; tail -25 "$TESTNET_DIR/logs/$name.log" >&2; exit 1; }
    sleep 0.5
  done
  echo "up: $name not healthy after 120 s; see $TESTNET_DIR/logs/$name.log" >&2
  exit 1
}

# Postgres cluster of its own.
if [[ ! -f "$TESTNET_DIR/pg/PG_VERSION" ]]; then
  "$PG_BIN/initdb" -D "$TESTNET_DIR/pg" -U "$(whoami)" -A trust --no-locale -E UTF8 >"$TESTNET_DIR/logs/initdb.log"
fi
if ! "$PG_BIN/pg_ctl" -D "$TESTNET_DIR/pg" status >/dev/null 2>&1; then
  LC_ALL=C "$PG_BIN/pg_ctl" -D "$TESTNET_DIR/pg" -l "$TESTNET_DIR/logs/postgres.log" -o "-p $PG_PORT -k $TESTNET_DIR -c listen_addresses=127.0.0.1" -w start >/dev/null
fi
"$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -d postgres -tAc "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1 \
  || "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" "$DB_NAME"
echo "up: Postgres on $PG_PORT, database $DB_NAME"

(cd "$APP" && bun scripts/testnet/setup.ts --env)
(cd "$APP" && set -a && source "$TESTNET_DIR/env/api.env" && set +a && bun scripts/fork/migrate.ts >>"$TESTNET_DIR/logs/migrate.log" 2>&1) \
  || { tail -20 "$TESTNET_DIR/logs/migrate.log" >&2; exit 1; }

start bundler "http://127.0.0.1:$BUNDLER_PORT/health" -- bun scripts/testnet/bundler.ts
start feed-mirror none -- bun scripts/testnet/mirror.ts
start indexer none -- bun src/bin/indexer.ts
start api "http://127.0.0.1:$API_PORT/v1/health" -- bun src/bin/api.ts
start keeper none -- bun src/bin/keeper.ts
# The hedger sizes its trades from the Uniswap v3 pools (src/hedger/pools.ts reads the mainnet factory) and refuses to start
# without a route per name; the testnet has no Uniswap v3 (chain-facts), so it is not started here. The pool's hedge
# path itself (rebalance through the adapter into the mock swap router) is covered by the contract tests and the fork run.
if [[ "${TESTNET_HEDGER:-0}" == 1 ]]; then start hedger none -- bun src/bin/hedger.ts; else echo "up: hedger not started (no Uniswap v3 on testnet; TESTNET_HEDGER=1 to try)"; fi
start mcp none -- bun src/bin/mcp.ts --http
VOL_PY="${VOL_ENGINE_PYTHON:-$ROOT/vol-engine/.venv/bin/python}"
# Vol posts: a pass every TESTNET_VOL_INTERVAL s (default 480); it posts on a real sigma change or in the last third of the
# 30-minute validity, so a pass every 8 minutes keeps every name fresh at the lowest gas (faucet budget, 2026-10-28).
if [[ -x "$VOL_PY" ]] && "$VOL_PY" -c "import numpy, eth_account, psycopg" 2>/dev/null; then
  start vol-engine none -- env PYTHONPATH="$ROOT/vol-engine/src" "$VOL_PY" -m vol_engine.cli post --loop --interval "${TESTNET_VOL_INTERVAL:-480}"
else
  echo "up: vol-engine NOT started: no Python with numpy, eth-account, psycopg (python3 -m venv vol-engine/.venv && vol-engine/.venv/bin/pip install -e vol-engine, or VOL_ENGINE_PYTHON)"
fi
echo "up: testnet stack ready. Chain 46630 via $TESTNET_RPC_URL, API $API_URL/v1, MCP http://127.0.0.1:$MCP_PORT, logs $TESTNET_DIR/logs, explorer $EXPLORER"
