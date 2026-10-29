#!/usr/bin/env bash
# Local / VPS CI: runs the same jobs, with the same commands, as .github/workflows/ci.yml. It is the CI for the
# private repository (private Actions minutes are not paid for; the workflow skips itself there) and the CI part of
# the release gate. On the public repository the same jobs run on GitHub's free hosted runners.
#
# Usage: scripts/ci-local.sh [--only job[,job...]] [--skip job[,job...]] [--deep] [--strict] [--list]
#   --only    run just these jobs (names as in ci.yml)
#   --skip    run everything except these jobs
#   --deep    also run invariants-deep (ci.yml runs it on pushes to main only; slow)
#   --strict  a skipped job (missing tool, wrong OS, no --deep) counts as a failure; the release gate uses this
#   --list    print the job names and exit
# Logs: $CI_LOCAL_LOGS (default .ci-local/logs/<timestamp>/<job>.log). Exit status: 0 only if no job failed.
#
# Tools: foundry (forge), bun, python3 (3.12 preferred), node, a Postgres install (the app tests start a throwaway
# cluster on a free port when TEST_DATABASE_URL is unset), docker or local semgrep/gitleaks. Slither needs Linux (it
# downloads the pinned solc-static-linux), so on macOS that job is skipped unless run on the VPS.
# No job reads a live chain: nothing here needs an RPC URL, and the fork tests skip themselves without one.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"
# Same 30 s per-test ceiling as ci.yml: Bun's 5 s default is a hang detector that a loaded machine can trip.
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-webstorage"

JOBS=(contracts invariants-deep coverage slither app vol-engine copy-lint deps docs web semgrep gitleaks)
ONLY="" SKIP="" DEEP=0 STRICT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --deep) DEEP=1; shift ;;
    --strict) STRICT=1; shift ;;
    --list) printf '%s\n' "${JOBS[@]}"; exit 0 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "ci-local: unknown argument $1" >&2; exit 2 ;;
  esac
done

# The script and the workflow must name the same jobs, or this stops being "the same CI".
workflow_jobs="$(awk '/^jobs:/{j=1;next} j&&/^  [a-z][a-z0-9-]*:$/{gsub(/[ :]/,"");print}' .github/workflows/ci.yml | sort | tr '\n' ' ')"
script_jobs="$(printf '%s\n' "${JOBS[@]}" | sort | tr '\n' ' ')"
if [ "$workflow_jobs" != "$script_jobs" ]; then
  echo "ci-local: job list differs from .github/workflows/ci.yml" >&2
  echo "  workflow: $workflow_jobs" >&2
  echo "  script:   $script_jobs" >&2
  exit 2
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
LOGS="${CI_LOCAL_LOGS:-$ROOT/.ci-local/logs/$STAMP}"
mkdir -p "$LOGS"
VENV="${CI_LOCAL_VENV:-$ROOT/.ci-local/venv}"

has() { command -v "$1" >/dev/null 2>&1; }
SKIP_REASON=""
skip() { SKIP_REASON="$1"; return 77; }

job_contracts() (
  set -euo pipefail
  has forge || { echo "forge not found" >&2; exit 1; }
  cd contracts
  forge build --sizes
  python3 script/ci/code-size.py
  script/ci/storage-layout.sh check
  # CI pins the fuzz seed so a green run is reproducible. A new seed is a different test: try one with FOUNDRY_FUZZ_SEED.
  FOUNDRY_FUZZ_SEED="${FOUNDRY_FUZZ_SEED:-0x5eed}" forge test -vv
  python3 script/ci/privileged-functions.py check
  script/ci/verify-deployment.test.sh
)

job_invariants-deep() {
  [ "$DEEP" = 1 ] || { skip "main-only job; pass --deep to run it"; return; }
  ( set -euo pipefail; contracts/script/ci/deep-invariants.sh )
}

job_coverage() (
  set -euo pipefail
  cd contracts
  forge coverage --ir-minimum --no-match-path 'test/fork/*' --no-match-test '[gG]as' --fuzz-seed 0x5eed \
    --report summary --report lcov --report-file lcov.info | tee coverage-summary.txt
)

job_slither() {
  [ "$(uname -s)" = Linux ] || { skip "slither downloads solc-static-linux; run on the VPS (Linux)"; return; }
  ( set -euo pipefail; contracts/script/ci/slither.sh )
}

job_app() (
  set -euo pipefail
  # The ABI-drift test in app/src/abi compares against contracts/out, so build the contracts first (it is a no-op
  # when the contracts job just ran). Without a fresh build that test passes vacuously or compares a stale build.
  (cd contracts && forge build >/dev/null)
  cd app
  bun install --frozen-lockfile
  bunx tsc --noEmit
  bun test --timeout 30000
)

job_vol-engine() (
  set -euo pipefail
  (cd contracts && forge build src/VolOracle.sol)
  if [ ! -x "$VENV/bin/python" ]; then
    py=python3; has python3.12 && py=python3.12
    "$py" -m venv "$VENV"
  fi
  cd vol-engine
  "$VENV/bin/python" -m pip install --quiet -e '.[dev]'
  "$VENV/bin/python" -m pytest -q
)

job_copy-lint() (
  set -euo pipefail
  cd app
  bun install --frozen-lockfile
  bun run lint:copy
)

job_deps() ( set -euo pipefail; .github/scripts/check-deps.sh )

job_docs() (
  set -euo pipefail
  .github/scripts/check-readme-deployment.test.sh
  .github/scripts/check-readme-deployment.py
)

job_web() (
  set -euo pipefail
  cd web
  npm test
  node scripts/verify-site.mjs
  npm run lint:copy
)

job_semgrep() {
  local args=(scan --config r/solidity --config p/typescript --config p/secrets --exclude contracts/lib --exclude node_modules
    --severity WARNING --severity ERROR --error --metrics off)
  if has docker && docker info >/dev/null 2>&1; then
    ( set -euo pipefail
      docker run --rm -v "$PWD:/src" -w /src \
        semgrep/semgrep@sha256:4372a1de903521f9f10f877b6caf15d150d17e1ca592582682c8d02b77cbd4f6 semgrep "${args[@]}" )
  elif has semgrep; then
    echo "ci-local: no docker; using local $(semgrep --version) (the workflow uses the pinned image)"
    ( set -euo pipefail; semgrep "${args[@]}" )
  else
    skip "neither docker nor semgrep is installed"
  fi
}

job_gitleaks() {
  local args=(git --no-banner --redact --config .githooks/gitleaks.toml .)
  if has docker && docker info >/dev/null 2>&1; then
    ( set -euo pipefail
      docker run --rm -v "$PWD:/repo" -w /repo \
        ghcr.io/gitleaks/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854 "${args[@]}" )
  elif has gitleaks; then
    echo "ci-local: no docker; using local gitleaks $(gitleaks version)"
    ( set -euo pipefail; gitleaks "${args[@]}" )
  else
    skip "neither docker nor gitleaks is installed"
  fi
}

wanted() {
  local j="$1"
  if [ -n "$ONLY" ]; then case ",$ONLY," in *",$j,"*) ;; *) return 1 ;; esac; fi
  if [ -n "$SKIP" ]; then case ",$SKIP," in *",$j,"*) return 1 ;; esac; fi
  return 0
}

declare -a RESULTS
failed=0 skipped=0 ran=0
for j in "${JOBS[@]}"; do
  wanted "$j" || continue
  log="$LOGS/$j.log"
  SKIP_REASON=""
  start=$SECONDS
  echo "== $j"
  "job_$j" >"$log" 2>&1
  rc=$?
  secs=$((SECONDS - start))
  if [ $rc -eq 77 ]; then
    skipped=$((skipped + 1))
    RESULTS+=("SKIP  $j  (${SKIP_REASON})")
    [ "$STRICT" = 1 ] && failed=$((failed + 1))
  elif [ $rc -eq 0 ]; then
    ran=$((ran + 1))
    RESULTS+=("PASS  $j  (${secs}s)")
  else
    ran=$((ran + 1)); failed=$((failed + 1))
    RESULTS+=("FAIL  $j  (${secs}s, exit $rc, log $log)")
    tail -n 25 "$log" | sed 's/^/   | /'
  fi
done

echo
echo "ci-local summary (logs in $LOGS)"
printf '  %s\n' "${RESULTS[@]}"
if [ "$failed" -gt 0 ]; then
  [ "$STRICT" = 1 ] && [ "$skipped" -gt 0 ] && echo "ci-local: --strict: $skipped skipped job(s) count as failures"
  echo "ci-local: FAILED"
  exit 1
fi
echo "ci-local: OK ($ran ran, $skipped skipped)"
