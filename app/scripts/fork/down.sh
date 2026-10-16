#!/usr/bin/env bash
# Stops the fork stack started by up.sh (only processes whose pid files it wrote). The anvil state (saved on exit),
# the deployment, the rpc cache and the database are kept: up.sh resumes where it stopped.
set -uo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
for name in vol-engine mcp hedger keeper api indexer bundler web; do stop "$name"; done
stop anvil
stop rpc-cache
if [[ -n "$PG_BIN" && -f "$FORK_DIR/pg/postmaster.pid" ]]; then
  "$PG_BIN/pg_ctl" -D "$FORK_DIR/pg" -m fast -w stop >/dev/null 2>&1 && echo "fork: stopped postgres"
fi
