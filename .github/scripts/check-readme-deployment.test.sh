#!/usr/bin/env bash
# Tests check-readme-deployment.py against fixture repositories.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
A=0x00000000000000000000000000000000000000e1
mk() { mkdir -p "$T/app/deployments"; printf '# R\n\n### Deployment\n\n%s\n\n### Services\n' "$1" >"$T/README.md"; }
run() { python3 "$HERE/check-readme-deployment.py" "$T" >/dev/null 2>&1; }
mk "Not deployed. After launch this lists them."; run || { echo "FAIL: undeployed README should pass" >&2; exit 1; }
mk "Not deployed. $A"; run && { echo "FAIL: address listed while undeployed" >&2; exit 1; }
printf '{"chainId":4663,"network":"mainnet","deployBlock":1234,"contracts":{"engine":"%s"}}' "$A" >"$T/app/deployments/4663.json"
mk "Not deployed."; run && { echo "FAIL: live deployment but README says Not deployed" >&2; exit 1; }
mk "Mainnet, block 1234. Engine $A"; run || { echo "FAIL: matching README should pass" >&2; exit 1; }
mk "Mainnet, block 1234."; run && { echo "FAIL: missing address should fail" >&2; exit 1; }
printf '{"chainId":31337,"network":"fork","deployBlock":9,"contracts":{"engine":"%s"}}' "$A" >"$T/app/deployments/4663.json"
mk "Not deployed."; run || { echo "FAIL: a fork file must not count as a deployment" >&2; exit 1; }
echo "check-readme-deployment.test: ok"
