#!/usr/bin/env bash
# Deploys the whole Lemniscate system to Robinhood Chain TESTNET (46630), signed by the throwaway testnet deployer keystore.
#
#   DEPLOY_CONFIG=<docs>/runbooks/deploy/deploy-config.testnet.json bash scripts/testnet/deploy.sh
#
# Steps (each refuses on a wrong chain; the real testnet also needs LEMNISCATE_TESTNET_ARMED=1 + ~/.lemniscate/testnet-armed):
#   1. copy the config into TESTNET_DIR and refresh every mockPriceUsdE8 from the mainnet Chainlink feed (read only)
#   2. create the 2-of-3 owner Safe (SafeProxyFactory.createProxyWithNonce) unless it exists; its address must equal roles.owner
#   3. forge script DeploySystem (testnet profile: mocks, short timers, admin = the owner Safe, post-deploy check inside)
#   4. PostDeployCheck again from the written deployment file
#   5. hand the mock feeds' updater to the feed-mirror wallet (the deployer owns the mocks)
# Logs and the deployment land in TESTNET_DIR; the forge broadcast stays in contracts/broadcast (git-ignored) because the
# Sourcify step (script/verify-deployment.sh submit) resumes it.
set -euo pipefail
# shellcheck source=env.sh
source "$(dirname "$0")/env.sh"
mkdir -p "$TESTNET_DIR"/{logs,pids,env}
for bin in cast forge jq bun; do command -v "$bin" >/dev/null || { echo "deploy: $bin not found" >&2; exit 69; }; done
assert_testnet
CONFIG="${DEPLOY_CONFIG:?set DEPLOY_CONFIG to docs/runbooks/deploy/deploy-config.testnet.json}"
R="$TESTNET_RPC_URL"
DEPLOYER="$(addr deployer)"
[[ "$DEPLOYER" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "deploy: no deployer in $TESTNET_KEYS_DIR/addresses.txt" >&2; exit 1; }
echo "deploy: chain 46630 via $R; deployer $DEPLOYER ($(cast balance "$DEPLOYER" --ether --rpc-url "$R") ETH)"

# 1. Config copy with today's mainnet prices as the mock feeds' first answers.
cp "$CONFIG" "$TESTNET_DIR/deploy-config.json"
SRC="$(jq -r '.mirror.sourceRpc // empty' "$CONFIG")"
if [[ -n "$SRC" && "${SKIP_PRICE_REFRESH:-0}" != 1 ]]; then
  for name in $(jq -r '.stocks[].name' "$CONFIG"); do
    feed="$(jq -r --arg n "$name" '.mirror.feeds[$n] // empty' "$CONFIG")"
    [[ -n "$feed" ]] || continue
    answer="$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$SRC" | sed -n 2p | awk '{print $1}')"
    [[ "$answer" =~ ^[0-9]+$ ]] || { echo "deploy: could not read the mainnet $name feed" >&2; exit 1; }
    jq --arg n "$name" --argjson a "$answer" '(.stocks[] | select(.name == $n) | .mockPriceUsdE8) = $a' \
      "$TESTNET_DIR/deploy-config.json" >"$TESTNET_DIR/deploy-config.json.tmp" && mv "$TESTNET_DIR/deploy-config.json.tmp" "$TESTNET_DIR/deploy-config.json"
    echo "deploy: $name mock feed starts at $answer (mainnet answer, 8 dp)"
  done
fi
C="$TESTNET_DIR/deploy-config.json"

# 2. Owner Safe (2-of-3 SafeL2 1.4.1). CREATE2: the address depends only on the singleton, initializer and salt.
S="$(jq -r .testnetOwnerSafe.factory "$C")"
SINGLETON="$(jq -r .testnetOwnerSafe.singleton "$C")"
OWNERS="[$(jq -r '.testnetOwnerSafe.owners | join(",")' "$C")]"
THRESHOLD="$(jq -r .testnetOwnerSafe.threshold "$C")"
SALT="$(jq -r .testnetOwnerSafe.saltNonce "$C")"
FALLBACK="$(jq -r .testnetOwnerSafe.fallbackHandler "$C")"
ZERO=0x0000000000000000000000000000000000000000
INIT="$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "$OWNERS" "$THRESHOLD" $ZERO 0x "$FALLBACK" $ZERO 0 $ZERO)"
OWNER="$(jq -r .roles.owner "$C")"
if [[ "$(cast codesize "$OWNER" --rpc-url "$R")" == 0 ]]; then
  PREDICTED="$(cast call "$S" "createProxyWithNonce(address,bytes,uint256)(address)" "$SINGLETON" "$INIT" "$SALT" --from "$DEPLOYER" --rpc-url "$R")"
  [[ "$(echo "$PREDICTED" | tr A-F a-f)" == "$(echo "$OWNER" | tr A-F a-f)" ]] || { echo "deploy: the Safe would land at $PREDICTED, but roles.owner is $OWNER: fix the config" >&2; exit 1; }
  # shellcheck disable=SC2046
  cast send "$S" "createProxyWithNonce(address,bytes,uint256)" "$SINGLETON" "$INIT" "$SALT" --rpc-url "$R" --chain 46630 $(ks deployer) --json \
    >"$TESTNET_DIR/logs/owner-safe.json"
  echo "deploy: owner Safe created at $OWNER (tx $(jq -r .transactionHash "$TESTNET_DIR/logs/owner-safe.json"), status $(jq -r .status "$TESTNET_DIR/logs/owner-safe.json"))"
else
  echo "deploy: owner Safe $OWNER already exists"
fi
[[ "$(cast call "$OWNER" "getThreshold()(uint256)" --rpc-url "$R")" == "$THRESHOLD" ]] || { echo "deploy: owner Safe threshold is not $THRESHOLD" >&2; exit 1; }

# 3. The system. DeploySystem refuses any chain but 46630 for this profile and runs the post-deploy check itself.
(
  cd "$ROOT/contracts"
  # A broadcast left by the dry run (same chain id) must never be resumed against the real testnet: move it aside.
  if [[ -d broadcast/DeploySystem.s.sol/46630 || -f deployments/testnet.json ]]; then
    aside="$TESTNET_DIR/previous-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$aside"
    [[ -d broadcast/DeploySystem.s.sol/46630 ]] && mv broadcast/DeploySystem.s.sol/46630 "$aside/broadcast-46630"
    [[ -f deployments/testnet.json ]] && mv deployments/testnet.json "$aside/testnet.json"
    echo "deploy: moved an earlier 46630 broadcast/deployment aside to $aside"
  fi
  # shellcheck disable=SC2046
  DEPLOY_CONFIG_JSON="$(cat "$C")" DEPLOYMENT_OUT="deployments/testnet.json" \
    forge script script/DeploySystem.s.sol --rpc-url "$R" $(ks deployer) --sender "$DEPLOYER" --broadcast --slow \
    >"$TESTNET_DIR/logs/deploy.log" 2>&1 || { tail -40 "$TESTNET_DIR/logs/deploy.log" >&2; exit 1; }
  # 4. Independent read-only check from the deployment file.
  DEPLOYMENT_FILE=deployments/testnet.json DEPLOY_CONFIG_JSON="$(cat "$C")" \
    forge script script/PostDeployCheck.s.sol --rpc-url "$R" >"$TESTNET_DIR/logs/post-deploy-check.log" 2>&1 \
    || { tail -40 "$TESTNET_DIR/logs/post-deploy-check.log" >&2; exit 1; }
  grep -q "\[PASS\] every check" "$TESTNET_DIR/logs/post-deploy-check.log"
  cp deployments/testnet.json "$TESTNET_DIR/deployment.json"
  rm -rf "$TESTNET_DIR/broadcast-deploy" && cp -R broadcast/DeploySystem.s.sol/46630 "$TESTNET_DIR/broadcast-deploy"
)
grep -E "\[PASS\]|\[FAIL\]" "$TESTNET_DIR/logs/deploy.log" "$TESTNET_DIR/logs/post-deploy-check.log" | sed 's/^.*logs\//deploy: /'

# 5. The feed-mirror wallet becomes the mock feeds' updater (the keeper keeps its own nonce stream to itself).
MIRROR="$(addr feed-mirror)"
for feed in $(jq -r '.stocks[].feed' "$TESTNET_DIR/deployment.json"); do
  if [[ "$(cast call "$feed" "updater()(address)" --rpc-url "$R" | tr A-F a-f)" != "$(echo "$MIRROR" | tr A-F a-f)" ]]; then
    # shellcheck disable=SC2046
    cast send "$feed" "setUpdater(address)" "$MIRROR" --rpc-url "$R" --chain 46630 $(ks deployer) --json >>"$TESTNET_DIR/logs/feed-updater.jsonl"
  fi
done
echo "deploy: mock feeds' updater = feed-mirror $MIRROR"
echo "deploy: done. Deployment $TESTNET_DIR/deployment.json; deployer left $(cast balance "$DEPLOYER" --ether --rpc-url "$R") ETH"
