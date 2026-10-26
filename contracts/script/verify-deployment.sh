#!/usr/bin/env bash
# DEP-1: source verification of every contract a deployment created, on Blockscout and Sourcify (both free, no API key).
#
#   script/verify-deployment.sh submit   resume the broadcast with --verify (constructor arguments and linked libraries
#                                        come from the broadcast file) on Blockscout, then on Sourcify
#   script/verify-deployment.sh check    ask both explorers about every address in the deployment file; exit 1 unless
#                                        each one of ours is verified on at least one of them (default mode)
#
# Environment (run from contracts/):
#   DEPLOYMENT_FILE   deployment JSON written by DeploySystem (default deployments/<PROFILE>.json)
#   PROFILE           mainnet | testnet | fork (default mainnet)
#   RPC_URL           needed by `submit`
#   DEPLOY_CONFIG / DEPLOY_CONFIG_JSON   the same config the deploy used (needed by `submit`)
#   BLOCKSCOUT_URL    explorer base URL (default per chain: robinhoodchain.blockscout.com, explorer.testnet.chain.robinhood.com)
#   SOURCIFY_URL      default https://sourcify.dev/server
# Third-party contracts (USDG, the swap router, Stock Tokens, feeds) are not ours and are not checked.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-check}"
PROFILE="${PROFILE:-mainnet}"
DEPLOYMENT_FILE="${DEPLOYMENT_FILE:-deployments/${PROFILE}.json}"
SOURCIFY_URL="${SOURCIFY_URL:-https://sourcify.dev/server}"

[ -f "$DEPLOYMENT_FILE" ] || { echo "verify-deployment: $DEPLOYMENT_FILE not found" >&2; exit 2; }
CHAIN_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["chainId"])' "$DEPLOYMENT_FILE")"
case "$CHAIN_ID" in
  4663)  DEFAULT_BLOCKSCOUT="https://robinhoodchain.blockscout.com" ;;
  46630) DEFAULT_BLOCKSCOUT="https://explorer.testnet.chain.robinhood.com" ;;
  *)     DEFAULT_BLOCKSCOUT="" ;;
esac
BLOCKSCOUT_URL="${BLOCKSCOUT_URL:-$DEFAULT_BLOCKSCOUT}"

case "$MODE" in
  submit)
    : "${RPC_URL:?RPC_URL is required}"
    [ -n "$BLOCKSCOUT_URL" ] || { echo "verify-deployment: no Blockscout URL for chain $CHAIN_ID (set BLOCKSCOUT_URL)" >&2; exit 2; }
    # --resume re-reads the broadcast and verifies each created contract with its recorded constructor arguments.
    # Forge requires --broadcast with --resume; with every transaction of the run already mined it sends nothing (and
    # no signer is given, so it cannot). A verifier that is down must not hide the other one, so both are tried and
    # `check` is the judge.
    forge script script/DeploySystem.s.sol --rpc-url "$RPC_URL" --resume --broadcast --verify \
      --verifier blockscout --verifier-url "${BLOCKSCOUT_URL%/}/api/" || echo "verify-deployment: Blockscout submit reported errors" >&2
    forge script script/DeploySystem.s.sol --rpc-url "$RPC_URL" --resume --broadcast --verify \
      --verifier sourcify --verifier-url "${SOURCIFY_URL%/}/" || echo "verify-deployment: Sourcify submit reported errors" >&2
    exec "$0" check
    ;;
  check)
    exec python3 - "$DEPLOYMENT_FILE" "$CHAIN_ID" "$BLOCKSCOUT_URL" "$SOURCIFY_URL" <<'PY'
import json, sys, urllib.request, urllib.error
file, chain, blockscout, sourcify = sys.argv[1:5]
ours = ["engine", "engineImpl", "pool", "poolImpl", "registry", "priceGuard", "volOracle", "marketHours", "marketHoursImpl",
        "agentRouter", "reserve", "feeRouter", "hedgeAdapter", "priceReference", "timelock"]
contracts = json.load(open(file))["contracts"]
ZERO = "0x" + "0" * 40

def get(url):
    request = urllib.request.Request(url, headers={"accept": "application/json", "user-agent": "lemniscate-verify/1"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None

def on_blockscout(address):
    if not blockscout:
        return False
    data = get(f"{blockscout.rstrip('/')}/api/v2/smart-contracts/{address}")
    return bool(data and (data.get("is_verified") or data.get("is_fully_verified") or data.get("source_code")))

def on_sourcify(address):
    data = get(f"{sourcify.rstrip('/')}/v2/contract/{chain}/{address}")
    return bool(data and data.get("match") in ("match", "exact_match", "perfect", "partial"))

failed = []
print(f"{'contract':<18} {'address':<44} blockscout sourcify")
for key in ours:
    address = (contracts.get(key) or ZERO)
    if address.lower() == ZERO:
        continue
    b, s = on_blockscout(address), on_sourcify(address)
    print(f"{key:<18} {address:<44} {'yes' if b else 'NO':<10} {'yes' if s else 'NO'}")
    if not (b or s):
        failed.append(key)
if failed:
    print("verify-deployment: NOT VERIFIED anywhere: " + ", ".join(failed), file=sys.stderr)
    sys.exit(1)
print("verify-deployment: every contract is verified on at least one explorer")
PY
    ;;
  *) echo "usage: $0 [submit|check]" >&2; exit 2 ;;
esac
