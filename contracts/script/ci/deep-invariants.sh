#!/usr/bin/env bash
# TEST-2: runs every stateful invariant test under the deep profile and refuses to pass unless that profile really
# makes at least 100,000 handler calls per invariant (runs x depth). Usage: contracts/script/ci/deep-invariants.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
MIN_CALLS=100000

read -r RUNS DEPTH < <(awk '
  /^\[/ { section = $0 }
  section == "[profile.deep.invariant]" && $1 == "runs"  { r = $3 }
  section == "[profile.deep.invariant]" && $1 == "depth" { d = $3 }
  END { print r, d }' foundry.toml)
if [ -z "${RUNS:-}" ] || [ -z "${DEPTH:-}" ]; then
  echo "deep-invariants: [profile.deep.invariant] runs/depth missing in foundry.toml" >&2; exit 1
fi
CALLS=$((RUNS * DEPTH))
if [ "$CALLS" -lt "$MIN_CALLS" ]; then
  echo "deep-invariants: deep profile makes only $CALLS calls per invariant (need >= $MIN_CALLS)" >&2; exit 1
fi
echo "deep-invariants: $RUNS runs x $DEPTH depth = $CALLS calls per invariant"
FOUNDRY_PROFILE=deep forge test --match-test 'invariant_' -vv
