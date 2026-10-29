#!/usr/bin/env bash
# Runs Slither on each deployable contract with solc 0.8.28 and the build's via-IR settings.
# Fails on any High-impact finding. Usage: contracts/script/ci/slither.sh (needs python3 + pip).
# Sources are copied to a temporary directory without foundry.toml, so crytic-compile uses solc directly
# (its Foundry integration does not read the current forge build-info format).
set -euo pipefail

SLITHER_VERSION="0.11.3"
SOLC_VERSION="0.8.28"
# solc-static-linux from the Solidity GitHub release; same hash as binaries.soliditylang.org/linux-amd64/list.json.
SOLC_URL="https://github.com/ethereum/solidity/releases/download/v${SOLC_VERSION}/solc-static-linux"
SOLC_SHA256="9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -m pip install --quiet --user "slither-analyzer==${SLITHER_VERSION}"
export PATH="$HOME/.local/bin:$PATH"

# Fetch the pinned compiler directly (solc-select's version list endpoint rejects some CI runners).
SOLC="$WORK/solc"
python3 - "$SOLC_URL" "$SOLC" "$SOLC_SHA256" <<'PY'
import hashlib, os, sys, urllib.request
url, path, expected = sys.argv[1:]
data = urllib.request.urlopen(url, timeout=120).read()
actual = hashlib.sha256(data).hexdigest()
if actual != expected:
    sys.exit(f"solc checksum mismatch: {actual} != {expected}")
with open(path, "wb") as f:
    f.write(data)
os.chmod(path, 0o755)
PY
"$SOLC" --version | tail -1

cp -r "$ROOT/src" "$ROOT/lib" "$WORK/"
cd "$WORK"
REMAPS="@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/ @openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/"
status=0
# Every contract DeploySystem.s.sol deploys (todo 10 R6).
for target in src/LemniscateEngine.sol src/WriterPool.sol src/MarketHours.sol src/PriceGuard.sol src/VolOracle.sol \
  src/SeriesRegistry.sol src/OptionTokenFactory.sol src/Reserve.sol src/FeeRouter.sol src/AgentRouter.sol \
  src/UniswapV3HedgeAdapter.sol src/UniswapV3TwapReference.sol src/OptionToken.sol; do
  echo "::group::slither $target"
  out="$WORK/$(basename "$target" .sol).json"
  slither "$target" --solc "$SOLC" --solc-remaps "$REMAPS" --solc-args "--via-ir --optimize --evm-version cancun" \
    --filter-paths "lib/" --exclude-informational --exclude-optimization --json "$out" || true
  # Fails on any High finding not listed, by detector + file + exact flagged expression, in slither-allow.json.
  if ! python3 "$ROOT/script/ci/slither-high.py" "$out" "$ROOT/script/ci/slither-allow.json"; then
    status=1
  fi
  echo "::endgroup::"
done
exit "$status"
