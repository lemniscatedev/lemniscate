#!/usr/bin/env bash
# Offline test of script/verify-deployment.sh check: a local fixture server stands in for Blockscout and Sourcify.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
PORT="${VERIFY_TEST_PORT:-$((20000 + RANDOM % 20000))}"
trap 'kill "$SERVER" 2>/dev/null || true; rm -rf "$T"' EXIT
A=0x00000000000000000000000000000000000000e1
B=0x00000000000000000000000000000000000000e2
mkdir -p "$T/site/api/v2/smart-contracts" "$T/site/v2/contract/4663"
cat > "$T/dep.json" <<JSON
{"chainId":4663,"contracts":{"engine":"$A","pool":"$B","usdg":"0x00000000000000000000000000000000000000e9","priceReference":"0x0000000000000000000000000000000000000000"}}
JSON
echo '{"is_verified":true}' > "$T/site/api/v2/smart-contracts/$A"
echo '{"match":"exact_match"}' > "$T/site/v2/contract/4663/$B"
(cd "$T/site" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER=$!
sleep 1
run() { (cd "$ROOT" && DEPLOYMENT_FILE="$T/dep.json" BLOCKSCOUT_URL="http://127.0.0.1:$PORT" SOURCIFY_URL="http://127.0.0.1:$PORT" script/verify-deployment.sh check); }
run >/dev/null || { echo "FAIL: expected pass when each contract is verified on one explorer" >&2; exit 1; }
rm "$T/site/api/v2/smart-contracts/$A"
if run >/dev/null 2>&1; then echo "FAIL: expected failure when a contract is unverified everywhere" >&2; exit 1; fi
echo "verify-deployment.test: ok"
