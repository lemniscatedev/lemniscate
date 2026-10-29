#!/usr/bin/env bash
# Fork proof of the audit 2026-10-29 upgrade on an anvil fork of Robinhood Chain mainnet (4663): deploy the new engine and
# pool implementations, schedule the timelock batch as the owner, wait 48 h, execute, then check that state survived and
# PostDeployCheck still passes. Local anvil only: the armed flag is set for this fork run and removed after.
#   FORK_URL=https://rpc.mainnet.chain.robinhood.com PORT=8745 script/fork/audit-upgrade-proof.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
PORT="${PORT:-8745}"
RPC="http://127.0.0.1:${PORT}"
DEP="${DEPLOYMENT_FILE:-deployments/mainnet.json}"
CONFIG="${DEPLOY_CONFIG:?DEPLOY_CONFIG (the mainnet deploy config path) is required}"
OUT="${OUT:-/tmp/audit-upgrade-proof}"
mkdir -p "$OUT"
j() { python3 -c "import json,sys; print(json.load(open('$DEP'))['contracts']['$1'])"; }
ENGINE=$(j engine); POOL=$(j pool); TL=$(j timelock)
OWNER=$(python3 -c "import json; print(json.load(open('$DEP'))['safe'])")
ADMIN_ROLE=$(cast to-uint256 0)
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc # EIP-1967 implementation slot // not-a-key

anvil --fork-url "$FORK_URL" --port "$PORT" --silent > "$OUT/anvil.log" 2>&1 &
ANVIL=$!
ARM=".deploy-armed-audit-proof"
cleanup() { kill "$ANVIL" 2>/dev/null || true; rm -f "$ARM"; }
trap cleanup EXIT
for _ in $(seq 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
echo "fork chain $(cast chain-id --rpc-url "$RPC") block $(cast block-number --rpc-url "$RPC")"

state() {
  echo "engine impl  $(cast storage "$ENGINE" $SLOT --rpc-url "$RPC" | sed 's/0x000000000000000000000000/0x/')"
  echo "pool impl    $(cast storage "$POOL" $SLOT --rpc-url "$RPC" | sed 's/0x000000000000000000000000/0x/')"
  echo "pool assets  $(cast call "$POOL" 'totalAssets()(uint256)' --rpc-url "$RPC")"
  echo "pool supply  $(cast call "$POOL" 'totalSupply()(uint256)' --rpc-url "$RPC")"
  echo "book value   $(cast call "$ENGINE" 'bookValue()(uint256)' --rpc-url "$RPC")"
  echo "liab hi/lo   $(cast call "$ENGINE" 'navLiability(bool)(uint256)' true --rpc-url "$RPC") $(cast call "$ENGINE" 'navLiability(bool)(uint256)' false --rpc-url "$RPC")"
  echo "params       $(cast call "$ENGINE" 'capBps()(uint16,uint16)' --rpc-url "$RPC" | tr '\n' ' ')"
  echo "admin role   engine:$(cast call "$ENGINE" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$TL" --rpc-url "$RPC") pool:$(cast call "$POOL" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$TL" --rpc-url "$RPC")"
  for s in $(python3 -c "import json; print(' '.join(x['stock'] for x in json.load(open('$DEP'))['stocks']))"); do
    echo "live series  $s $(cast call "$ENGINE" 'liveSeries(address)(bytes32[])' "$s" --rpc-url "$RPC" | tr -cd ',' | wc -c | tr -d ' ')+1"
  done
}
state > "$OUT/before.txt"; cat "$OUT/before.txt"

DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # anvil dev account 0, fork only
touch "$ARM"
LEMNISCATE_ALLOW_REAL_DEPLOY=1 LEMNISCATE_ALLOW_FILE="$ARM" DEPLOYMENT_FILE="$DEP" \
  forge script script/AuditUpgrade.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$DEPLOYER" > "$OUT/deploy.log" 2>&1
rm -f "$ARM"
grep -E "new (engine|pool) implementation|operation id" -A1 "$OUT/deploy.log" | head -8
NEW_ENGINE=$(grep "new engine implementation" "$OUT/deploy.log" | grep -oE '0x[0-9a-fA-F]{40}')
NEW_POOL=$(grep "new pool implementation" "$OUT/deploy.log" | grep -oE '0x[0-9a-fA-F]{40}')
SCHEDULE=$(grep -A1 "scheduleBatch" "$OUT/deploy.log" | tail -1 | tr -d ' ')
EXECUTE=$(grep -A1 "executeBatch" "$OUT/deploy.log" | tail -1 | tr -d ' ')
GAS=$(python3 -c "
import json,glob
f=sorted(glob.glob('broadcast/AuditUpgrade.s.sol/4663/run-latest.json'))[-1]
print(sum(int(r['gasUsed'],16) for r in json.load(open(f))['receipts']))")
echo "deploy gas $GAS"

cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" 0x16345785D8A0000 --rpc-url "$RPC" >/dev/null # 0.1 ETH, fork only
SG=$(cast send "$TL" "$SCHEDULE" --from "$OWNER" --unlocked --rpc-url "$RPC" --json | python3 -c "import json,sys; print(int(json.load(sys.stdin)['gasUsed'],16))")
echo "schedule gas $SG"
if cast send "$TL" "$EXECUTE" --from "$OWNER" --unlocked --rpc-url "$RPC" >/dev/null 2>&1; then echo "FAIL: executed before the delay"; exit 1; fi
echo "execute before 48 h: refused (good)"
cast rpc evm_increaseTime 172801 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
EG=$(cast send "$TL" "$EXECUTE" --from "$OWNER" --unlocked --rpc-url "$RPC" --json | python3 -c "import json,sys; print(int(json.load(sys.stdin)['gasUsed'],16))")
echo "execute gas $EG"

state > "$OUT/after.txt"; cat "$OUT/after.txt"
python3 - "$DEP" "$NEW_ENGINE" "$NEW_POOL" "$OUT/deployment-after.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["contracts"]["engineImpl"] = sys.argv[2]; d["contracts"]["poolImpl"] = sys.argv[3]
json.dump(d, open(sys.argv[4], "w"), indent=1)
PY
cp "$OUT/deployment-after.json" deployments/audit-proof.json
ALLOW_EOA_OWNER=1 DEPLOYMENT_FILE=deployments/audit-proof.json DEPLOY_CONFIG_JSON="$(cat "$CONFIG")" \
  forge script script/PostDeployCheck.s.sol --rpc-url "$RPC" 2>&1 | grep -E "FAIL|PASS" | tee "$OUT/postdeploy.txt"
rm -f deployments/audit-proof.json
echo "new engine impl $NEW_ENGINE"; echo "new pool impl $NEW_POOL"
echo "TOTAL GAS deploy=$GAS schedule=$SG execute=$EG"
