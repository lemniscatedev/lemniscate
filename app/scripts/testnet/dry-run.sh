#!/usr/bin/env bash
# Dry run of the WHOLE testnet run on a local anvil fork of the testnet (chain id 46630, so every signature, address and
# check is the real run's), with the deployer holding exactly the faucet amount from the gas ledger and nothing else.
# Nothing reaches the real testnet: anvil forks through scripts/fork/rpc-cache.ts, which refuses every send upstream.
#
#   bash scripts/testnet/dry-run.sh fork      start the rpc cache + anvil fork + fee shim (ports +70) and give the deployer FAUCET_ETH
#   bash scripts/testnet/dry-run.sh all       fork, deploy.sh, fund.ts, up.sh, exercise.ts, ledger.ts --actual, down
#   bash scripts/testnet/dry-run.sh down      stop the services, anvil and the cache (state in TESTNET_DIR is kept)
#   bash scripts/testnet/dry-run.sh reset     down, then delete the dry run's TESTNET_DIR (keystores are never touched)
#
# Env: FAUCET_ETH (default: the ledger's faucet amount, else 0.01), DEPLOY_CONFIG (the testnet deploy config),
#      TESTNET_DIR (default ~/.lemniscate/testnet-dryrun), FORK_BLOCK (pin a testnet block).
set -euo pipefail
export TESTNET_DIR="${TESTNET_DIR:-$HOME/.lemniscate/testnet-dryrun}"
export PORT_OFFSET="${PORT_OFFSET:-70}"
export TESTNET_RPC_URL="http://127.0.0.1:$((8545 + PORT_OFFSET))"
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
mkdir -p "$TESTNET_DIR"/{logs,pids,env}
UPSTREAM="${UPSTREAM_TESTNET_RPC:-$PUBLIC_TESTNET_RPC}"
MODE="${1:-all}"

start_bg() { # start_bg <name> -- <command...>
  local name="$1"; shift 2
  if alive "$name"; then echo "dry-run: $name already running"; return; fi
  (
    cd "$APP"
    nohup "$@" >>"$TESTNET_DIR/logs/$name.log" 2>&1 </dev/null &
    echo $! >"$TESTNET_DIR/pids/$name.pid"
  )
}

fork_up() {
  for p in "$ANVIL_PORT" "$((ANVIL_PORT + 1))" "$CACHE_PORT"; do
    owner="$(lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
    if [[ -n "$owner" ]] && ! grep -qs "^$owner\$" "$TESTNET_DIR"/pids/*.pid; then echo "dry-run: port $p is taken by another process" >&2; exit 1; fi
  done
  [[ "$(cast chain-id --rpc-url "$UPSTREAM")" == 46630 ]] || { echo "dry-run: upstream is not the testnet" >&2; exit 1; }
  start_bg rpc-cache -- bun scripts/fork/rpc-cache.ts --port "$CACHE_PORT" --upstream "$UPSTREAM" --cache "$TESTNET_DIR/rpc-cache.jsonl"
  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$CACHE_PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
  [[ -s "$TESTNET_DIR/fork-block" ]] || echo "${FORK_BLOCK:-$(cast block-number --rpc-url "$UPSTREAM")}" >"$TESTNET_DIR/fork-block"
  # chain id 46630: the dry run signs exactly what the real run will sign. Fresh random dev accounts (never used).
  # Fees as on the testnet: base fee 0.01 gwei at the start, priority fee 0 (anvil's 1 gwei default would make every
  # wallet reserve 100x the real gas price). anvil lets the base fee fall on empty blocks, so the ledger prices gas at the
  # testnet's 0.01 gwei floor from gasUsed, never from the anvil balances. --prune-history 7200: keep two hours of block
  # states in memory; anvil's on-disk historical states lose forked code ("missing bytecode for code hash"), which broke
  # the indexer's reads 20 blocks back (its testnet confirmation depth) after about 40 minutes.
  start_bg anvil -- anvil --host 127.0.0.1 --port "$((ANVIL_PORT + 1))" --fork-url "http://127.0.0.1:$CACHE_PORT" \
    --fork-block-number "$(cat "$TESTNET_DIR/fork-block")" --chain-id 46630 --hardfork cancun --block-time 1 --accounts 1 --block-base-fee-per-gas 10000000 --disable-min-priority-fee --prune-history 7200 \
    --state "$TESTNET_DIR/state.json" --state-interval 60 --no-rate-limit
  for _ in $(seq 1 120); do cast chain-id --rpc-url "http://127.0.0.1:$((ANVIL_PORT + 1))" >/dev/null 2>&1 && break; sleep 0.5; done
  # Everything talks to the fee shim (testnet fees: base fee pinned at 0.01 gwei, priority 0), which forwards to anvil.
  start_bg fee-shim -- bun scripts/testnet/fee-shim.ts --port "$ANVIL_PORT" --anvil "http://127.0.0.1:$((ANVIL_PORT + 1))"
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$TESTNET_RPC_URL" >/dev/null 2>&1 && break; sleep 0.5; done
  [[ "$(cast chain-id --rpc-url "$TESTNET_RPC_URL")" == 46630 ]] || { echo "dry-run: anvil did not come up" >&2; exit 1; }
  if [[ ! -s "$TESTNET_DIR/faucet-given" ]]; then
    local eth="${FAUCET_ETH:-}"
    [[ -n "$eth" ]] || eth="$(jq -r '.faucet.eth // empty' "${LEDGER_FILE:-$HOME/.lemniscate/testnet-ledger.json}" 2>/dev/null || true)"
    [[ -n "$eth" ]] || eth=0.01
    local wei; wei="$(cast to-wei "$eth" ether)"
    # The faucet stands in for Kal's one step: the deployer gets exactly this and every other wallet starts at zero.
    cast rpc anvil_setBalance "$(addr deployer)" "$(cast to-hex "$wei")" --rpc-url "$TESTNET_RPC_URL" >/dev/null
    echo "$eth" >"$TESTNET_DIR/faucet-given"
  fi
  echo "dry-run: anvil fork of testnet block $(cat "$TESTNET_DIR/fork-block") on $TESTNET_RPC_URL (chain 46630); deployer $(cast balance "$(addr deployer)" --ether --rpc-url "$TESTNET_RPC_URL") ETH"
}

fork_down() {
  bash "$(dirname "$0")/down.sh" || true
  stop fee-shim
  stop anvil
  stop rpc-cache
}

case "$MODE" in
  fork) fork_up ;;
  down) fork_down ;;
  reset) fork_down; rm -rf "$TESTNET_DIR"; echo "dry-run: reset $TESTNET_DIR" ;;
  all)
    fork_up
    DEPLOY_CONFIG="${DEPLOY_CONFIG:?set DEPLOY_CONFIG}" bash "$(dirname "$0")/deploy.sh"
    (cd "$APP" && bun scripts/testnet/fund.ts)
    bash "$(dirname "$0")/up.sh"
    (cd "$APP" && bun scripts/testnet/exercise.ts) || echo "dry-run: exercise reported failures (see $TESTNET_DIR/exercise/results.json)"
    # Nobody ran dry: every wallet that sends still holds ETH (the faucet amount covered the whole run).
    empty=""
    while read -r role address; do
      case "$role" in treasury|keepers-pot|hedger-pot|owner-2|owner-3|paymaster-signer|hedger) continue ;; esac
      bal="$(cast balance "$address" --rpc-url "$TESTNET_RPC_URL")"
      echo "dry-run: $role $(cast from-wei "$bal") ETH left"
      [[ "$bal" == 0 ]] && empty="$empty $role"
    done <"$TESTNET_KEYS_DIR/addresses.txt"
    [[ -z "$empty" ]] || echo "dry-run: RAN DRY:$empty" >&2
    # Re-measure into the dry run's own folder (the faucet ledger in LEDGER_FILE stays as given).
    (cd "$APP" && LEDGER_FILE="$TESTNET_DIR/ledger-measured.json" bun scripts/testnet/ledger.ts --actual --days "${LEDGER_DAYS:-1}") || true
    ;;
  *) echo "usage: $0 fork|all|down|reset" >&2; exit 2 ;;
esac
