#!/usr/bin/env bash
# down.sh, then deletes the fork state, the pinned block, the deployment, env files and the database cluster, so the next
# up.sh forks a fresh block and deploys again. Keeps the rpc cache (block-pinned answers never go stale) and old logs.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
bash "$(dirname "$0")/down.sh"
rm -rf "$FORK_DIR/state.json" "$FORK_DIR/fork-block" "$FORK_DIR/deployment.json" "$FORK_DIR/deploy-config.json" \
  "$FORK_DIR/broadcast-deploy" "$FORK_DIR/anvil-accounts.json" "$FORK_DIR/mnemonic" "$FORK_DIR/env" "$FORK_DIR/pg" "$FORK_DIR/pids" "$FORK_DIR/exercise"
echo "fork: reset (next up.sh forks a fresh block and deploys)"
