#!/usr/bin/env bash
# The Lemniscate services against Robinhood Chain MAINNET (4663) on THIS machine, for a local run of the closed beta
# (the VPS path is app/scripts/server). Usage:
#
#   bash scripts/mainnet/up.sh      check the chain id, check the deployment, prepare lemniscate_mainnet, migrate, start
#                                   indexer, api, keeper, hedger (dry run) and vol-engine (not sending)
#   bash scripts/mainnet/down.sh    stop the services (the chain and the deployment stay)
#
# It never deploys and never funds anything. Refuses unless the RPC answers chain id 4663.
# Keys: encrypted keystores as .mainnet/keys/<role>.json plus <role>.password (copy them in yourself); each service
# decrypts only its own role, in its own process (the env file holds the keystore and password file PATHS, no key).
# Env: RHC_MAINNET_RPC_URL (default the free public RPC), DATABASE_ADMIN_URL (lemniscate_mainnet is created on it).
set -euo pipefail

cd "$(dirname "$0")/../.."
APP="$(pwd)"
ROOT="$(cd .. && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
MAINNET_DIR="${MAINNET_DIR:-$APP/.mainnet}"
export MAINNET_DIR
RPC="${RHC_MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
mkdir -p "$MAINNET_DIR"/{logs,pids,env,keys}
chmod 700 "$MAINNET_DIR/keys"

for bin in cast bun curl; do
  command -v "$bin" >/dev/null || { echo "up: $bin not found on PATH" >&2; exit 69; }
done

CHAIN="$(cast chain-id --rpc-url "$RPC")"
if [[ "$CHAIN" != "4663" ]]; then
  echo "up: $RPC answered chain id $CHAIN, not Robinhood Chain mainnet 4663: refusing" >&2
  exit 1
fi

# The fork stack uses the same default API port: never start next to it.
if lsof -iTCP:3101 -sTCP:LISTEN -t >/dev/null 2>&1 && ! grep -qs "$(lsof -iTCP:3101 -sTCP:LISTEN -t | head -1)" "$MAINNET_DIR"/pids/*.pid 2>/dev/null; then
  echo "up: port 3101 is taken by another stack (fork?): stop it first" >&2
  exit 1
fi

for role in keeper hedger vol-signer; do
  [[ -e "$MAINNET_DIR/keys/$role.json" && -e "$MAINNET_DIR/keys/$role.password" ]] \
    || { echo "up: $MAINNET_DIR/keys/$role.json and $role.password are missing: copy the $role keystore and password file in" >&2; exit 1; }
done

alive() { [[ -f "$MAINNET_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$MAINNET_DIR/pids/$1.pid")" 2>/dev/null; }

(cd "$APP" && bun scripts/mainnet/setup.ts)

# start <name> <health url | none> -- <command...>   (runs from the app folder, with only that service's env file)
start() {
  local name="$1" health="$2"
  shift 3 # name, health, and the "--"
  if alive "$name"; then echo "up: $name already running"; return; fi
  [[ -f "$MAINNET_DIR/env/$name.env" ]] || return 0
  (
    cd "$APP"
    set -a
    # shellcheck disable=SC1090
    source "$MAINNET_DIR/env/$name.env"
    set +a
    nohup "$@" >>"$MAINNET_DIR/logs/$name.log" 2>&1 &
    echo $! >"$MAINNET_DIR/pids/$name.pid"
  )
  for i in $(seq 1 120); do
    if [[ "$health" == http* ]]; then
      if curl -fsS "$health" >/dev/null 2>&1; then echo "up: $name healthy ($health)"; return; fi
    elif [[ $i -ge 10 ]] && alive "$name"; then
      echo "up: $name running"; return
    fi
    if ! alive "$name"; then echo "up: $name exited; see $MAINNET_DIR/logs/$name.log" >&2; tail -20 "$MAINNET_DIR/logs/$name.log" >&2; exit 1; fi
    sleep 0.5
  done
  echo "up: $name not healthy; see $MAINNET_DIR/logs/$name.log" >&2
  exit 1
}

# Migrations first (one shot), with the same env as the api.
(cd "$APP" && set -a && source "$MAINNET_DIR/env/api.env" && set +a && bun src/bin/migrate.ts)

start indexer none -- bun src/bin/indexer.ts
start api http://127.0.0.1:3101/v1/health -- bun src/bin/api.ts
start keeper none -- bun src/bin/keeper.ts
start hedger none -- bun src/bin/hedger.ts
if [[ -x "$ROOT/vol-engine/.venv/bin/vol-engine" ]]; then
  start vol-engine none -- "$ROOT/vol-engine/.venv/bin/vol-engine" post --loop --interval 300
else
  echo "up: vol-engine not started (no $ROOT/vol-engine/.venv: python3 -m venv .venv && .venv/bin/pip install .)"
fi

echo "up: mainnet stack ready. Chain 4663 ($RPC), API http://127.0.0.1:3101/v1, logs $MAINNET_DIR/logs"
