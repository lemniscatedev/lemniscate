#!/usr/bin/env bash
# Test for deploy.sh --local: the real-deploy guard and argument checks. It never touches a server: every case either is
# refused before anything runs, or (armed, --check) stops at the first line of the server script ("connect as root") when
# not run as root, or at "not provisioned". No ssh is ever started (a fake ssh on PATH fails the test if it is called).
#   bash app/scripts/server/deploy-local.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/deploy.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
printf '#!/bin/sh\necho "ssh was called: $*" >>"%s/ssh-called"\nexit 99\n' "$T" >"$T/bin/ssh"; chmod +x "$T/bin/ssh"
export PATH="$T/bin:$PATH"
unset LEMNISCATE_ALLOW_REAL_DEPLOY LEMNISCATE_ALLOW_FILE LEMNISCATE_DEPLOYMENTS_SRC
touch "$T/armed"
SHA=0123456789abcdef0123456789abcdef01234567
fail=0; n=0
# expect <name> <exit: 0|nonzero> <stderr/stdout substring> -- env... -- args...
run() { # name want_zero pattern envspec args...
  local name="$1" want="$2" pat="$3" envspec="$4"; shift 4
  local out rc
  # shellcheck disable=SC2086
  out="$(env $envspec bash "$DEPLOY" "$@" 2>&1)"; rc=$?
  n=$((n + 1))
  if [[ "$want" == 0 && $rc -ne 0 ]] || [[ "$want" != 0 && $rc -eq 0 ]] || ! grep -Fq -- "$pat" <<<"$out"; then
    printf 'FAIL %s (rc=%s, wanted %s, pattern "%s")\n%s\n' "$name" "$rc" "$want" "$pat" "$out"; fail=$((fail + 1))
  else printf 'ok   %s\n' "$name"; fi
}
run "refuses with neither flag nor env"        nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "" --local --check
run "refuses with env but no arming file var"  nz "arming file" "LEMNISCATE_ALLOW_REAL_DEPLOY=1" --local --check
run "refuses with env but file missing"        nz "arming file" "LEMNISCATE_ALLOW_REAL_DEPLOY=1 LEMNISCATE_ALLOW_FILE=$T/nope" --local --check
run "refuses with file but no env"             nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "LEMNISCATE_ALLOW_FILE=$T/armed" --local --check
run "refuses env=0"                            nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "LEMNISCATE_ALLOW_REAL_DEPLOY=0 LEMNISCATE_ALLOW_FILE=$T/armed" --local --check
run "refuses a deploy with neither"            nz "real-deploy guard" "" --local --repo "$T" --ref "$SHA"
ARM="LEMNISCATE_ALLOW_REAL_DEPLOY=1 LEMNISCATE_ALLOW_FILE=$T/armed"
run "armed: refuses a host"                    nz "takes no host" "$ARM" --local somehost --check
run "armed: refuses --provision"               nz "cannot --provision" "$ARM" --local --provision
run "armed: deploy needs --repo"               nz "needs --repo" "$ARM" --local --ref "$SHA"
run "armed: refuses a branch name as ref"      nz "40-hex" "$ARM" --local --repo "$T" --ref main
run "armed: refuses a short sha"               nz "40-hex" "$ARM" --local --repo "$T" --ref abc1234
run "--repo without --local is refused"        nz "only goes with --local" "" --repo "$T" somehost
if [[ "$(id -u)" != 0 ]]; then
  run "armed --check goes local and stops (not root)" nz "connect as root" "$ARM" --local --check
  run "armed deploy stops before any upload"          nz "no commit" "$ARM LEMNISCATE_DEPLOYMENTS_SRC=$T" --local --repo "$T" --ref "$SHA"
fi
n=$((n + 1))
if [[ -e "$T/ssh-called" ]]; then printf 'FAIL ssh was called:\n%s\n' "$(cat "$T/ssh-called")"; fail=$((fail + 1)); else echo "ok   ssh never called"; fi
if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
