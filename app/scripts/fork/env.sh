# Shared settings for the anvil mainnet-fork stack (sourced by up.sh, down.sh, reset.sh; never run alone).
# PORT_OFFSET moves every port at once so two stacks (or another project's anvil) never collide:
#   anvil 8545+O (what MetaMask uses with O=0), rpc cache 9545+O, Postgres 5433+O, api 3101+O, mcp 3102+O,
#   bundler 4337+O. FORK_DIR holds the state, logs, pids, env files and the database cluster (git-ignored).
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
PORT_OFFSET="${PORT_OFFSET:-0}"
FORK_DIR="${FORK_DIR:-$APP/.fork}"
ANVIL_PORT=$((8545 + PORT_OFFSET))
CACHE_PORT=$((9545 + PORT_OFFSET))
PG_PORT=$((5433 + PORT_OFFSET))
API_PORT=$((3101 + PORT_OFFSET))
MCP_PORT=$((3102 + PORT_OFFSET))
BUNDLER_PORT=$((4337 + PORT_OFFSET))
UPSTREAM_RPC="${RHC_MAINNET_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
PG_BIN="${PG_BIN:-$(ls -d /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin 2>/dev/null | head -1 || true)}"
DB_NAME=lemniscate_fork
DATABASE_URL="postgres://$(whoami)@127.0.0.1:$PG_PORT/$DB_NAME"
ANVIL_URL="http://127.0.0.1:$ANVIL_PORT"
export APP ROOT PORT_OFFSET FORK_DIR ANVIL_PORT CACHE_PORT PG_PORT API_PORT MCP_PORT BUNDLER_PORT UPSTREAM_RPC PG_BIN DB_NAME DATABASE_URL ANVIL_URL

alive() { [[ -f "$FORK_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$FORK_DIR/pids/$1.pid")" 2>/dev/null; }

# stop <name>: stops only a process this stack started (its pid file), never anything else.
stop() {
  local name="$1"
  if alive "$name"; then
    local pid
    pid="$(cat "$FORK_DIR/pids/$name.pid")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "fork: stopped $name"
  fi
  rm -f "$FORK_DIR/pids/$name.pid"
}

port_free() { ! lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
