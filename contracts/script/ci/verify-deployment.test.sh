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
# Forge 1.x refuses `--resume` without `--broadcast` ("required arguments were not provided"): both submit commands
# must carry it, or the Sourcify/Blockscout submission never starts (found in the todo 26 testnet dry run).
[[ "$(grep -c -- '--resume --broadcast --verify' "$ROOT/script/verify-deployment.sh")" == 1 ]] \
  || { echo "FAIL: verify-deployment.sh submit must run forge script --resume --broadcast --verify for Blockscout" >&2; exit 1; }
# Sourcify must get the build metadata (exact_match on the first try), not forge's own --verifier sourcify path.
grep -q 'script/ci/sourcify-metadata.py' "$ROOT/script/verify-deployment.sh" \
  || { echo "FAIL: verify-deployment.sh submit must call sourcify-metadata.py" >&2; exit 1; }
if grep -q -- '--verifier sourcify' "$ROOT/script/verify-deployment.sh"; then echo "FAIL: forge's sourcify verifier must not be used" >&2; exit 1; fi
script/ci/sourcify-metadata.test.sh
echo "verify-deployment.test: ok"
