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
D=(--local --repo "$T" --ref "$SHA")
run "refuses with neither flag nor env"        nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "" "${D[@]}"
run "refuses with env but no arming file var"  nz "arming file" "LEMNISCATE_ALLOW_REAL_DEPLOY=1" "${D[@]}"
run "refuses with env but file missing"        nz "arming file" "LEMNISCATE_ALLOW_REAL_DEPLOY=1 LEMNISCATE_ALLOW_FILE=$T/nope" "${D[@]}"
run "refuses with file but no env"             nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "LEMNISCATE_ALLOW_FILE=$T/armed" "${D[@]}"
run "refuses env=0"                            nz "LEMNISCATE_ALLOW_REAL_DEPLOY=1 is not set" "LEMNISCATE_ALLOW_REAL_DEPLOY=0 LEMNISCATE_ALLOW_FILE=$T/armed" "${D[@]}"
run "refuses a deploy with neither"            nz "real-deploy guard" "" --local --repo "$T" --ref "$SHA"
ARM="LEMNISCATE_ALLOW_REAL_DEPLOY=1 LEMNISCATE_ALLOW_FILE=$T/armed"
run "armed: refuses a host"                    nz "takes no host" "$ARM" --local somehost --check
run "--check refuses a host too"               nz "takes no host" "" --local somehost --check
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

# ---- review MUST-FIX 2: --local --check is read-only (no arming file) and works from the pinned copy, which is not a checkout
mkdir -p "$T/pinned" "$T/fakeroot/opt/lemniscate/releases"
cp "$DEPLOY" "$T/pinned/deploy.sh"
printf '#!/bin/bash\n# test stand-in for the server script: <base> <mode> [rel sha]\necho "server $2 base=$1"; [[ "$2" == check ]] && exit 0; exit 1\n' >"$T/fakeserver"; chmod +x "$T/fakeserver"
out="$(cd /; env -i PATH="$PATH" HOME="$HOME" DEPLOY_SH_TEST_ROOT="$T/fakeroot" DEPLOY_SH_TEST_SERVER="$T/fakeserver" bash "$T/pinned/deploy.sh" --local --check 2>&1)"; rc=$?
check "--local --check from a copy outside any checkout, no arming env: exit 0" [ "$rc" == 0 ]
check "  ... it reached the server check" grep -q "server check" <<<"$out"
if [[ "$(id -u)" != 0 ]]; then
  run "--check without arming goes to the server script (not refused by the guard)" 1 "connect as root" "" --local --check
fi
out="$(DEPLOY_SH_TEST_ROOT="$T/fakeroot" DEPLOY_SH_TEST_SERVER="$T/nope" bash "$DEPLOY" --local --check 2>&1)"; rc=$?
check "the test seam needs an executable stand-in" [ "$rc" != 0 ]

# ---- network profile: NETWORK=testnet in the server's lemniscate.env ships 46630.json and tells the server script so
mkdir -p "$T/tnroot/opt/lemniscate/releases" "$T/tnroot/etc/lemniscate" "$T/tndep"
printf 'NETWORK=testnet\nCHAIN_ID=46630\n' >"$T/tnroot/etc/lemniscate/lemniscate.env"
printf '{"chainId": 46630, "network": "testnet"}\n' >"$T/tndep/46630.json"
printf '#!/bin/bash\necho "server args: $*"; exit 0\n' >"$T/argserver"; chmod +x "$T/argserver"
out="$(umask 077; DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; stage_release "$2" "$3" "$4" "$5" 46630.json && echo staged' _ "$DEPLOY" "$T/queue.git" "$GSHA" "$T/releases/tn1" "$T/tndep" 2>&1)"
check "stage_release ships a named deployment file (46630.json)" [ -f "$T/releases/tn1/app/deployments/46630.json" -a ! -e "$T/releases/tn1/app/deployments/4663.json" ]
if [[ "$(id -u)" != 0 ]]; then
  out="$(env $ARM LEMNISCATE_DEPLOYMENTS_SRC="$T/tndep" DEPLOY_SH_TEST_ROOT="$T/tnroot" DEPLOY_SH_TEST_SERVER="$T/argserver" bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$GSHA" 2>&1)"; rc=$?
  check "testnet profile: --local reads NETWORK=testnet and deploys" [ "$rc" == 0 ]
  check "  ... the server script is told the network (testnet)" grep -Eq "server args: .* deploy [0-9TZ]+-[0-9a-f]{12} $GSHA testnet" <<<"$out"
  check "  ... and the release holds 46630.json" bash -c 'ls "$1"/opt/lemniscate/releases/*/app/deployments/46630.json >/dev/null' _ "$T/tnroot"
  out="$(env $ARM LEMNISCATE_DEPLOYMENTS_SRC="$T/dep" DEPLOY_SH_TEST_ROOT="$T/tnroot" DEPLOY_SH_TEST_SERVER="$T/argserver" bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$GSHA" 2>&1)"; rc=$?
  check "testnet profile without 46630.json: exit 75, nothing switched" [ "$rc" == 75 ]
  check "  ... names the missing testnet file" grep -q "no testnet deployment" <<<"$out"
  printf '{"chainId": 4663, "network": "mainnet"}\n' >"$T/tndep2.json"; mkdir -p "$T/tndep2"; cp "$T/tndep2.json" "$T/tndep2/46630.json"
  out="$(env $ARM LEMNISCATE_DEPLOYMENTS_SRC="$T/tndep2" DEPLOY_SH_TEST_ROOT="$T/tnroot" DEPLOY_SH_TEST_SERVER="$T/argserver" bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$GSHA" 2>&1)"; rc=$?
  check "testnet profile refuses a mainnet file named 46630.json: exit 75" [ "$rc" == 75 ]
  printf 'NETWORK=moon\n' >"$T/tnroot/etc/lemniscate/lemniscate.env"
  out="$(env $ARM LEMNISCATE_DEPLOYMENTS_SRC="$T/tndep" DEPLOY_SH_TEST_ROOT="$T/tnroot" DEPLOY_SH_TEST_SERVER="$T/argserver" bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$GSHA" 2>&1)"; rc=$?
  check "an unknown NETWORK is refused before anything: exit 75" [ "$rc" == 75 ]
  rm -f "$T/tnroot/etc/lemniscate/lemniscate.env"
  out="$(env $ARM LEMNISCATE_DEPLOYMENTS_SRC="$T/dep" DEPLOY_SH_TEST_ROOT="$T/tnroot" DEPLOY_SH_TEST_SERVER="$T/argserver" bash "$DEPLOY" --local --repo "$T/queue.git" --ref "$GSHA" 2>&1)"; rc=$?
  check "no lemniscate.env: mainnet profile (4663.json)" bash -c '[ "$1" == 0 ] && grep -q " mainnet$" <<<"$2"' _ "$rc" "$out"
fi
check "the server script: hedger only in the mainnet profile" bash -c 'DEPLOY_SH_SOURCE_ONLY=1; . "$1"; out="$(remote_script)"; grep -q "mainnet) NET=mainnet; CHAIN=4663; CORE=(indexer api keeper hedger vol-engine)" <<<"$out" && grep -q "testnet) CHAIN=46630; CORE=(indexer api keeper vol-engine)" <<<"$out"' _ "$DEPLOY"
check "the server script refuses a network the caller did not ask for" bash -c 'grep -q "this deploy was started for \$want_net" "$1"' _ "$DEPLOY"

# ---- review MUST-FIX 6: only .healthy releases are rolled back to or kept; failed / half-built ones are removed
B="$T/rel"; mkdir -p "$B/releases"
for r in 20261101T000000Z-aaaa 20261102T000000Z-bbbb 20261103T000000Z-cccc 20261104T000000Z-dddd 20261105T000000Z-eeee \
         20261106T000000Z-ffff 20261107T000000Z-gggg 20261108T000000Z-hhhh; do mkdir "$B/releases/$r"; done
for r in aaaa bbbb cccc dddd eeee hhhh; do for d in "$B"/releases/*-"$r"; do touch "$d/.healthy"; done; done   # ffff failed, gggg half-built
ln -s releases/20261108T000000Z-hhhh "$B/current"
touch "$B/releases/20261106T000000Z-ffff" "$B/releases/20261107T000000Z-gggg"   # newest by mtime: the old wrapper picked these
fns() { DEPLOY_SH_SOURCE_ONLY=1 bash -c '. "$1"; shift; "$@"' _ "$DEPLOY" "$@"; }
check "previous_healthy_release skips failed and half-built dirs" [ "$(fns previous_healthy_release "$B")" == 20261105T000000Z-eeee ]
mkdir "$B/releases/20261109T000000Z-iiii"
check "abandon_release removes a staged dir that never went live" bash -c 'DEPLOY_SH_SOURCE_ONLY=1; . "$1"; abandon_release "$2" 20261109T000000Z-iiii; [ ! -e "$2/releases/20261109T000000Z-iiii" ]' _ "$DEPLOY" "$B"
check "abandon_release never removes the current release" bash -c 'DEPLOY_SH_SOURCE_ONLY=1; . "$1"; abandon_release "$2" 20261108T000000Z-hhhh; [ -d "$2/releases/20261108T000000Z-hhhh" ]' _ "$DEPLOY" "$B"
fns prune_releases "$B" 5 20261105T000000Z-eeee
check "prune: failed and half-built gone, 5 healthy kept (current + previous + 3 newest others)" \
  [ "$(ls -1 "$B/releases" | tr '\n' ' ')" == "20261102T000000Z-bbbb 20261103T000000Z-cccc 20261104T000000Z-dddd 20261105T000000Z-eeee 20261108T000000Z-hhhh " ]
check "the server script marks a healthy release and prunes with the shared functions" bash -c 'grep -q "touch \"\$R/.healthy\"" "$1" && grep -q "prune_releases \"\$BASE\" 5" "$1" && grep -q "abandon_release /opt/lemniscate \"\$rel\"" "$1"' _ "$DEPLOY"
check "the server script is sent with the shared functions ahead of it" bash -c 'DEPLOY_SH_SOURCE_ONLY=1; . "$1"; out="$(remote_script)"; grep -q "^previous_healthy_release()" <<<"$out"' _ "$DEPLOY"
check "a migration lock timeout (exit 75 from migrate.ts) puts the link back and exits 75" bash -c 'grep -q "ExecMainStatus --value lemniscate-migrate.service" "$1"' _ "$DEPLOY"

n=$((n + 1))
if [[ -e "$T/ssh-called" ]]; then printf 'FAIL ssh was called:\n%s\n' "$(cat "$T/ssh-called")"; fail=$((fail + 1)); else echo "ok   ssh never called"; fi
if ((fail)); then printf '%s of %s failed\n' "$fail" "$n"; exit 1; fi
printf 'all %s passed\n' "$n"
