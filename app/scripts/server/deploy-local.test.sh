#!/usr/bin/env bash
# Test for deploy.sh --local: the real-deploy guard and argument checks, the release dir mode (umask 022, 0755, from a
# bare repo), the retry helper, and exit 75 ("nothing switched") for failures before the switch. It never touches a
# server: every case either is refused before anything runs, or (armed, --check) stops at the first line of the server
# script ("connect as root") when not run as root, or at "not provisioned"; the cases that would get further are skipped
# when run as root or on a provisioned machine. No ssh is ever started (a fake ssh on PATH fails the test if it is called).
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
  if [[ "$want" == 0 && $rc -ne 0 ]] || [[ "$want" == nz && $rc -eq 0 ]] || [[ "$want" =~ ^[0-9]+$ && "$want" != 0 && $rc -ne "$want" ]] \
    || ! grep -Fq -- "$pat" <<<"$out"; then
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
  run "armed --check goes local and stops (not root), exit 1" 1 "connect as root" "$ARM" --local --check
  run "armed deploy of a missing commit: exit 75"            75 "no commit" "$ARM LEMNISCATE_DEPLOYMENTS_SRC=$T" --local --repo "$T" --ref "$SHA"
fi

# ---- a small repo (app/, vol-engine/, LICENSE, README.md) and its bare clone, as the release queue / ops mirror is
G="$T/src"; mkdir -p "$G/app/src" "$G/vol-engine"
git -C "$G" init -q
printf 'export const x = 1;\n' >"$G/app/src/x.ts"; printf 'x = 1\n' >"$G/vol-engine/x.py"; echo MIT >"$G/LICENSE"; echo readme >"$G/README.md"
git -C "$G" add -A && git -C "$G" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
GSHA="$(git -C "$G" rev-parse HEAD)"
git clone -q --bare "$G" "$T/queue.git"
mkdir "$T/dep"; printf '{"chainId": 4663, "network": "mainnet"}\n' >"$T/dep/4663.json"
mkdir "$T/releases"

# check <name> <command...>: the command must succeed
check() { local name="$1"; shift; n=$((n + 1)); if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fail=$((fail + 1)); fi; }
mode_of() { ls -ld "$1" | cut -c1-10; }

# A1: whatever umask the caller has (a sudo wrapper, UMask=0027 in a unit), the release is readable by every service user
out="$(umask 077; DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; umask; stage_release "$2" "$3" "$4" "$5" && echo staged' _ "$DEPLOY" "$T/queue.git" "$GSHA" "$T/releases/r1" "$T/dep" 2>&1)"
check "deploy.sh sets umask 022 over the caller's 077"                 grep -qx '0022' <<<"$out"
check "stage_release works from a BARE repo (git archive)"             grep -qx 'staged' <<<"$out"
check "release dir is drwxr-xr-x"                                      [ "$(mode_of "$T/releases/r1")" == drwxr-xr-x ]
check "app/ and app/deployments are drwxr-xr-x"                        [ "$(mode_of "$T/releases/r1/app")$(mode_of "$T/releases/r1/app/deployments")" == drwxr-xr-xdrwxr-xr-x ]
check "a shipped file and 4663.json are -rw-r--r--"                    [ "$(mode_of "$T/releases/r1/app/src/x.ts")$(mode_of "$T/releases/r1/app/deployments/4663.json")" == -rw-r--r---rw-r--r-- ]
check "the release holds the committed tree"                           [ -f "$T/releases/r1/vol-engine/x.py" -a -f "$T/releases/r1/LICENSE" ]
out="$(DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; stage_release "$2" "$3" "$4" "$5"' _ "$DEPLOY" "$T/queue.git" "$GSHA" "$T/releases/r1" "$T/dep" 2>&1)"; rc=$?
check "stage_release refuses an existing release dir"                  [ "$rc" != 0 ]

# A2: the retry helper (network steps) and the exit code for "nothing switched"
cat >"$T/flaky" <<'EOF'
#!/bin/bash
n=$(( $(cat "$1" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$1"; [ "$n" -ge "$2" ]
EOF
chmod +x "$T/flaky"
DEPLOY_RETRY_WAITS="0 0" DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; retry flaky "$2" "$3" 3' _ "$DEPLOY" "$T/flaky" "$T/count1" >/dev/null 2>&1; rc=$?
check "retry: fails twice, passes on the third try"                    [ "$rc" == 0 -a "$(cat "$T/count1")" == 3 ]
DEPLOY_RETRY_WAITS="0 0" DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; retry flaky "$2" "$3" 9' _ "$DEPLOY" "$T/flaky" "$T/count2" >/dev/null 2>&1; rc=$?
check "retry: gives up after 3 tries with the command's exit code"     [ "$rc" == 1 -a "$(cat "$T/count2")" == 3 ]
if [[ "$(id -u)" != 0 && ! -e /opt/lemniscate ]]; then
  # never on a server: these get as far as the upload or the first line of the server script
  run "armed deploy from a bare repo, not provisioned: exit 75"   75 "nothing switched" "$ARM LEMNISCATE_DEPLOYMENTS_SRC=$T/dep" --local --repo "$T/queue.git" --ref "$GSHA"
  out="$(DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; remote_script | bash -s -- deploy r1 "$2"' _ "$DEPLOY" "$GSHA" 2>&1)"; rc=$?
  check "server script, deploy mode, fails before the switch: exit 75" [ "$rc" == 75 ]
  check "  ... and says nothing was switched"                          grep -q "nothing switched" <<<"$out"
  out="$(DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; remote_script | bash -s -- check' _ "$DEPLOY" 2>&1)"; rc=$?
  check "server script, --check mode, failure: exit 1 (not 75)"        [ "$rc" == 1 ]
  # the switch itself is marked before the link moves: every failure path after it keeps exit 1
  check "SWITCHED=1 is set right before the link moves"                grep -B1 -A0 'point "releases/\$rel"$' "$DEPLOY" -q
  check "  (the line before point is SWITCHED=1)"                      [ "$(grep -B1 '^  point "releases/\$rel"$' "$DEPLOY" | head -1 | tr -d ' ')" == SWITCHED=1 ]
fi
n=$((n + 1))
if [[ -e "$T/ssh-called" ]]; then printf 'FAIL ssh was called:\n%s\n' "$(cat "$T/ssh-called")"; fail=$((fail + 1)); else echo "ok   ssh never called"; fi
if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
