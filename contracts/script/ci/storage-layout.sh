#!/usr/bin/env bash
# Storage-layout snapshots of every upgradeable (UUPS / Initializable) contract, committed under contracts/layout/.
#   storage-layout.sh check    fail if any snapshot differs from the current build (default; CI runs this)
#   storage-layout.sh update   rewrite the snapshots (deliberate, reviewed change only: existing slots must never move)
# A direct-slot change of an upgradeable contract corrupts live proxies; the engine's own state sits in an ERC-7201
# namespace (EngineStorage), whose struct is covered by the layout of the contract that declares it only through slot 0,
# so changes to EngineStorage are reviewed by hand (append-only) and covered by the upgrade tests.
set -euo pipefail
cd "$(dirname "$0")/../.."
MODE="${1:-check}"
CONTRACTS=(LemniscateEngine WriterPool MarketHours)
mkdir -p layout
status=0
for c in "${CONTRACTS[@]}"; do
  tmp="$(mktemp)"
  forge inspect "$c" storageLayout --json | python3 -c '
import json, sys
layout = json.load(sys.stdin)
types = layout.get("types") or {}
rows = [{"label": s["label"], "slot": s["slot"], "offset": s["offset"], "type": (types.get(s["type"]) or {}).get("label", s["type"])}
        for s in layout.get("storage", [])]
print(json.dumps(rows, indent=2))
' > "$tmp"
  if [ "$MODE" = "update" ]; then
    mv "$tmp" "layout/$c.json"; echo "updated layout/$c.json"
  elif [ ! -f "layout/$c.json" ]; then
    echo "MISSING layout/$c.json (run script/ci/storage-layout.sh update and commit it)" >&2; status=1; rm -f "$tmp"
  elif diff -u "layout/$c.json" "$tmp"; then
    echo "ok   $c storage layout unchanged"; rm -f "$tmp"
  else
    echo "FAIL $c storage layout changed (existing slots must not move; if the change only appends, run update and review the diff)" >&2
    status=1; rm -f "$tmp"
  fi
done
exit $status
