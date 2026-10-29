#!/usr/bin/env bash
# Sends gas ETH from the FUNDER's wallet to the wallets in mainnet-addresses.json. The funder is whoever pays for the
# launch (the launch team's wallet or Kal's); its keystore and password file are named on the command line or in env.
# Run by the funder, never by an agent.
#
# Usage: fund-bots.sh <addresses.json> <name> <eth> [<name> <eth> ...]
#   e.g. fund-bots.sh ~/.../mainnet-addresses.json keeper 0.002 hedger 0.002 vol-signer 0.001
# Env: FUNDER_KEYSTORE (path to the funder's encrypted keystore file, required), FUNDER_PASSWORD_FILE (required),
#      RPC_URL (default the free public RPC), CAST (default ~/.foundry/bin/cast).
# Armed flag (same as the contract deploy scripts): refuses unless LEMNISCATE_ALLOW_REAL_DEPLOY=1 AND the file named by
#      LEMNISCATE_ALLOW_FILE exists. Refuses unless the RPC answers chain id 4663. Prints one line per transfer; each must say status 1.
set -euo pipefail
C="${CAST:-$HOME/.foundry/bin/cast}"
R="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
KS="${FUNDER_KEYSTORE:?set FUNDER_KEYSTORE=<path to the funder keystore file>}"
PW="${FUNDER_PASSWORD_FILE:?set FUNDER_PASSWORD_FILE=<path to its password file>}"
[[ "${LEMNISCATE_ALLOW_REAL_DEPLOY:-}" == 1 ]] || { echo "fund-bots: refusing to send on a real chain: set LEMNISCATE_ALLOW_REAL_DEPLOY=1 (the funder's own command only)" >&2; exit 1; }
[[ -n "${LEMNISCATE_ALLOW_FILE:-}" && -e "$LEMNISCATE_ALLOW_FILE" ]] || { echo "fund-bots: refusing to send on a real chain: LEMNISCATE_ALLOW_FILE must name an existing arming file" >&2; exit 1; }
[[ $# -ge 3 ]] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
A="$1"; shift
[[ -r "$A" && -r "$KS" && -r "$PW" ]] || { echo "fund-bots: cannot read the addresses file, keystore or password file" >&2; exit 1; }
[[ "$("$C" chain-id --rpc-url "$R")" == 4663 ]] || { echo "fund-bots: $R is not Robinhood Chain mainnet 4663" >&2; exit 1; }
while [[ $# -ge 2 ]]; do
  name="$1"; eth="$2"; shift 2
  [[ "$name" =~ ^[a-z][a-z0-9-]*$ && "$eth" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "fund-bots: bad name or amount: $name $eth" >&2; exit 1; }
  to="$(jq -r --arg n "$name" '.[$n] // empty' "$A")"
  [[ "$to" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "fund-bots: no address for $name" >&2; exit 1; }
  out="$("$C" send "$to" --value "${eth}ether" --keystore "$KS" --password-file "$PW" --rpc-url "$R" --chain 4663 --json)"
  echo "$name $eth ETH -> $(jq -r '.transactionHash + " status " + .status' <<<"$out")"
done
