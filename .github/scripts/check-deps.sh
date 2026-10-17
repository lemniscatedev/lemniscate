#!/usr/bin/env bash
# DEPS-1/2/3: dependency hygiene gate.
#   1. every dependency in a package.json is an exact version (no ^ ~ > < * x ranges, latest, tags or URLs);
#   2. CI and deploy scripts only install from a lockfile (bun install --frozen-lockfile, npm ci);
#   3. bunfig.toml sets a minimumReleaseAge and web/.npmrc sets min-release-age.
# Usage: .github/scripts/check-deps.sh [repo-root]
set -euo pipefail
ROOT="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
fail=0
bad() { echo "check-deps: $*" >&2; fail=1; }

# 1. exact pins
while IFS= read -r file; do
  out="$(python3 - "$file" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1]))
exact = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?$")
for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
    for name, spec in (data.get(section) or {}).items():
        if not exact.match(str(spec)):
            print(f"{section}.{name} = {spec}")
PY
)"
  if [ -n "$out" ]; then bad "$file has non-exact versions:"; printf '    %s\n' "${out//$'\n'/$'\n'    }" >&2; fi
done < <(find "$ROOT" -name package.json -not -path '*/node_modules/*' -not -path "$ROOT/contracts/lib/*")

# 2. frozen installs only
while IFS= read -r line; do
  case "$line" in
    *"bun install"*) [[ "$line" == *"--frozen-lockfile"* ]] || bad "bun install without --frozen-lockfile: $line" ;;
    *"npm install"*|*"yarn install"*) bad "use npm ci / a frozen lockfile install: $line" ;;
  esac
done < <(grep -rnE '^[^#]*(bun install|npm install|npm i |yarn install|pnpm install)' "$ROOT/.github" "$ROOT/app/scripts" 2>/dev/null | grep -v 'check-deps.sh' | grep -vE ':[0-9]+:\s*(#|echo|log |die )' | grep -vE '^[^:]*:[0-9]+:\s*#' || true)

# 3. release-age guards
grep -qE '^\s*minimumReleaseAge\s*=\s*[1-9][0-9]*' "$ROOT/app/bunfig.toml" || bad "app/bunfig.toml has no minimumReleaseAge"
if [ -f "$ROOT/web/package.json" ]; then
  grep -qE '^\s*min-release-age\s*=\s*[1-9]' "$ROOT/web/.npmrc" 2>/dev/null || bad "web/.npmrc has no min-release-age"
fi

[ "$fail" -eq 0 ] && echo "check-deps: ok"
exit "$fail"
