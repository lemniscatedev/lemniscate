#!/usr/bin/env bash
# DEP-1: source verification of every contract a deployment created, on Blockscout and Sourcify (both free, no API key).
#
#   script/verify-deployment.sh submit   resume the broadcast with --verify (constructor arguments and linked libraries
#                                        come from the broadcast file) on Blockscout, then send each contract's build
#                                        metadata.json and sources to Sourcify /v2/verify/metadata (exact_match)
#   script/verify-deployment.sh bytecode compare the code at every address the broadcast created (proxies, implementations,
#                                        linked libraries, EngineHelper, OptionTokenFactory, the OptionToken template, the
#                                        timelock) with this checkout's forge build: immutables masked, libraries linked
#                                        from the broadcast; also the three EIP-1967 implementation slots and the launch
#                                        caps. Build first (`forge build`) at the commit the deployment came from.
#                                        Needs RPC_URL and BROADCAST_FILE (default broadcast/DeploySystem.s.sol/<chain>/run-latest.json)
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
    # Sourcify gets the build's metadata.json plus every source file (/v2/verify/metadata), not forge's own Sourcify
    # path: the testnet run reached only "match" that way, metadata gives exact_match on the first try.
    forge build >/dev/null
    python3 script/ci/sourcify-metadata.py "$DEPLOYMENT_FILE" "$CHAIN_ID" "$SOURCIFY_URL" --out out --root . \
      || echo "verify-deployment: Sourcify metadata submit reported errors" >&2
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
    return (data or {}).get("match") if (data or {}).get("match") in ("match", "exact_match", "perfect", "partial") else None

failed = []
print(f"{'contract':<18} {'address':<44} blockscout sourcify")
for key in ours:
    address = (contracts.get(key) or ZERO)
    if address.lower() == ZERO:
        continue
    b, s = on_blockscout(address), on_sourcify(address)
    print(f"{key:<18} {address:<44} {'yes' if b else 'NO':<10} {s or 'NO'}")
    if not (b or s):
        failed.append(key)
    elif s and s != "exact_match":
        print(f"verify-deployment: note: {key} is '{s}' on Sourcify, not exact_match", file=sys.stderr)
if failed:
    print("verify-deployment: NOT VERIFIED anywhere: " + ", ".join(failed), file=sys.stderr)
    sys.exit(1)
print("verify-deployment: every contract is verified on at least one explorer")
PY
    ;;
  bytecode)
    [ -n "${RPC_URL:-}" ] || { echo "verify-deployment: RPC_URL is required for bytecode" >&2; exit 2; }
    BROADCAST_FILE="${BROADCAST_FILE:-broadcast/DeploySystem.s.sol/${CHAIN_ID}/run-latest.json}"
    [ -f "$BROADCAST_FILE" ] || { echo "verify-deployment: $BROADCAST_FILE not found" >&2; exit 2; }
    exec python3 - "$DEPLOYMENT_FILE" "$BROADCAST_FILE" "$RPC_URL" <<'PY'
import glob, json, re, sys, urllib.request
dep_file, bc_file, rpc = sys.argv[1:4]
dep = json.load(open(dep_file))
bc = json.load(open(bc_file))

def call(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(rpc, body, {"content-type": "application/json", "user-agent": "lemniscate-verify/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]

libs = {}
for entry in bc.get("libraries") or []:
    path, name, addr = entry.split(":")
    libs[(path, name)] = addr.lower()[2:]

def artifact(name):
    hits = [f for f in glob.glob(f"out/*/{name}.json") if f.split("/")[1] == f"{name}.sol"] or glob.glob(f"out/*/{name}.json")
    if not hits:
        raise SystemExit(f"verify-deployment: no artifact for {name}; run forge build at the deployed commit")
    return json.load(open(hits[0]))["deployedBytecode"]

def expected(name):
    a = artifact(name)
    code = bytearray.fromhex(re.sub(r"__\$[0-9a-fA-F]{34}\$__", "0" * 40, a["object"][2:]))
    for path, names in (a.get("linkReferences") or {}).items():
        for lib, refs in names.items():
            addr = libs.get((path, lib))
            if addr is None:
                raise SystemExit(f"verify-deployment: library {path}:{lib} not in the broadcast")
            for ref in refs:
                code[ref["start"]:ref["start"] + 20] = bytes.fromhex(addr)
    masks = [(r["start"], r["length"]) for refs in (a.get("immutableReferences") or {}).values() for r in refs]
    return code, masks

created = []
for t in bc["transactions"]:
    if t.get("transactionType") in ("CREATE", "CREATE2") and t.get("contractAddress"):
        created.append((t["contractName"], t["contractAddress"]))
    for extra in t.get("additionalContracts") or []:
        created.append((extra["contractName"], extra["address"]))

failed = []
print(f"{'contract':<24} {'address':<44} result")
for name, addr in created:
    want, masks = expected(name)
    got = bytearray.fromhex(call("eth_getCode", [addr, "latest"])[2:])
    if len(got) != len(want):
        ok = False
    else:
        for start, length in masks:
            want[start:start + length] = got[start:start + length]
        ok = got == want
    print(f"{name:<24} {addr:<44} {'MATCH' if ok else 'DIFFERS'}")
    if not ok:
        failed.append(f"{name}@{addr}")

SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"  # EIP-1967 implementation slot // not-a-key
c = dep["contracts"]
for proxy, impl in (("engine", "engineImpl"), ("pool", "poolImpl"), ("marketHours", "marketHoursImpl")):
    got = "0x" + call("eth_getStorageAt", [c[proxy], SLOT, "latest"])[-40:]
    ok = got.lower() == c[impl].lower()
    print(f"{proxy + ' impl slot':<24} {got:<44} {'MATCH' if ok else 'DIFFERS (deployment file says ' + c[impl] + ')'}")
    if not ok:
        failed.append(f"{proxy}-impl-slot")
print("paymaster: not deployed on this network (sponsorship off); nothing to compare")
if failed:
    print("verify-deployment: BYTECODE MISMATCH: " + ", ".join(failed), file=sys.stderr)
    sys.exit(1)
print(f"verify-deployment: {len(created)} contracts match this build; implementation slots match")
PY
    ;;
  *) echo "usage: $0 [submit|check|bytecode]" >&2; exit 2 ;;
esac
