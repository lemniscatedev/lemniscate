# Shared settings for the Robinhood Chain TESTNET (46630) stack (sourced by the scripts beside it; never run alone).
# PORT_OFFSET (default 70) moves every local port at once, so this stack never collides with the fork stack (offset 0)
# or another project's anvil: anvil 8545+O (dry run only), rpc cache 9545+O (dry run only), Postgres 5433+O,
# api 3101+O, mcp 3102+O, bundler 4337+O, x402 api 3121+O.
# TESTNET_DIR (state, logs, pids, env files, database cluster) and TESTNET_KEYS_DIR (keystores) live outside the repo.
# TESTNET_RPC_URL defaults to the free public RPC; the dry run points it at its anvil fork (chain id 46630 too).
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
PORT_OFFSET="${PORT_OFFSET:-70}"
TESTNET_DIR="${TESTNET_DIR:-$HOME/.lemniscate/testnet}"
TESTNET_KEYS_DIR="${TESTNET_KEYS_DIR:-$HOME/.lemniscate/testnet-keys}"
PUBLIC_TESTNET_RPC="https://rpc.testnet.chain.robinhood.com"
TESTNET_RPC_URL="${TESTNET_RPC_URL:-$PUBLIC_TESTNET_RPC}"
EXPLORER="https://explorer.testnet.chain.robinhood.com"
ANVIL_PORT=$((8545 + PORT_OFFSET))
CACHE_PORT=$((9545 + PORT_OFFSET))
PG_PORT=$((5433 + PORT_OFFSET))
API_PORT=$((3101 + PORT_OFFSET))
MCP_PORT=$((3102 + PORT_OFFSET))
BUNDLER_PORT=$((4337 + PORT_OFFSET))
PG_BIN="${PG_BIN:-$(ls -d /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin 2>/dev/null | head -1 || true)}"
DB_NAME=lemniscate_testnet
DATABASE_URL="postgres://$(whoami)@127.0.0.1:$PG_PORT/$DB_NAME"
API_URL="http://127.0.0.1:$API_PORT"
export APP ROOT PORT_OFFSET TESTNET_DIR TESTNET_KEYS_DIR TESTNET_RPC_URL EXPLORER ANVIL_PORT CACHE_PORT PG_PORT API_PORT MCP_PORT \
  BUNDLER_PORT PG_BIN DB_NAME DATABASE_URL API_URL

alive() { [[ -f "$TESTNET_DIR/pids/$1.pid" ]] && kill -0 "$(cat "$TESTNET_DIR/pids/$1.pid")" 2>/dev/null; }

# stop <name>: stops only a process this stack started (its pid file), never anything else.
stop() {
  local name="$1"
  if alive "$name"; then
    local pid
    pid="$(cat "$TESTNET_DIR/pids/$name.pid")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    echo "testnet: stopped $name"
  fi
  rm -f "$TESTNET_DIR/pids/$name.pid"
}

is_local_rpc() { [[ "$TESTNET_RPC_URL" =~ ^https?://(127\.0\.0\.1|localhost)(:|/|$) ]]; }

# Refuses anything but chain 46630; a non-local RPC (the real testnet) also needs the arming flag AND the flag file, so
# no agent or test can broadcast to the testnet by accident (crypto-audit-lessons: real-deploy guard).
assert_testnet() {
  local id
  id="$(cast chain-id --rpc-url "$TESTNET_RPC_URL" 2>/dev/null || echo none)"
  [[ "$id" == 46630 ]] || { echo "testnet: $TESTNET_RPC_URL answered chain id $id, not 46630: refusing" >&2; exit 1; }
  if ! is_local_rpc; then
    if [[ "${LEMNISCATE_TESTNET_ARMED:-}" != 1 || ! -f "$HOME/.lemniscate/testnet-armed" ]]; then
      echo "testnet: $TESTNET_RPC_URL is the REAL testnet. Sending needs LEMNISCATE_TESTNET_ARMED=1 and the file ~/.lemniscate/testnet-armed" >&2
      echo "         (docs/runbooks/testnet-run.md). Refusing." >&2
      exit 1
    fi
  fi
}

# Foundry flags that sign as <role> from its keystore (password from its chmod-600 file; nothing printed).
ks() { echo "--keystore $TESTNET_KEYS_DIR/$1.json --password-file $TESTNET_KEYS_DIR/$1.password"; }
addr() { awk -v r="$1" '$1==r {print $2}' "$TESTNET_KEYS_DIR/addresses.txt"; }
