#!/usr/bin/env bash
# Stops the testnet services started by up.sh (only processes whose pid files it wrote) and its Postgres cluster.
# Nothing on chain changes; the deployment, the database and the keystores are kept.
set -uo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
for name in vol-engine mcp hedger keeper api api-x402 indexer feed-mirror bundler; do stop "$name"; done
if [[ -n "$PG_BIN" && -f "$TESTNET_DIR/pg/postmaster.pid" ]]; then
  "$PG_BIN/pg_ctl" -D "$TESTNET_DIR/pg" -m fast -w stop >/dev/null 2>&1 && echo "testnet: stopped postgres"
fi
exit 0
