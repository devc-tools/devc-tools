#!/bin/bash
# install.sh end to end, offline — both branches of the probe, the passwd rewrite, the
# placeholder, the subordinate ranges, and every skip path.
#
#   bash features/rootless-remap/test/install_options_test.sh
#
# No Docker, no root: every file install.sh reads or writes is redirected into a temp
# directory (UID_MAP_FILE, GID_MAP_FILE, PASSWD_FILE, GROUP_FILE, SUBUID_FILE, SUBGID_FILE,
# SHARE_DIR), and the recursive chown of the home directory is turned off (CHOWN_HOME=false).
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$FEATURE_DIR/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

printf '         0          0 4294967295\n' > "$WORK/uid_map.identity"
printf '         0       1000          1\n         1     100000      65536\n' > "$WORK/uid_map.rootless"
printf '         0       1000          1\n         1     100000      65536\n' > "$WORK/gid_map.rootless"

PASSWD_SEED='root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
vscode:x:1000:1000::/home/vscode:/bin/bash
'
GROUP_SEED='root:x:0:
vscode:x:1000:
'
export PASSWD_SEED GROUP_SEED

# run_install <name> <uid_map fixture> [VAR=value ...] — sets $passwd, $group, $subuid,
# $subgid, $share, $status, $log.
run_install() {
  local name="$1" uidmap="$2"; shift 2
  passwd="$WORK/$name.passwd"; group="$WORK/$name.group"
  subuid="$WORK/$name.subuid"; subgid="$WORK/$name.subgid"
  share="$WORK/$name.share"; log="$WORK/$name.log"
  printf '%s' "$PASSWD_SEED" > "$passwd"; printf '%s' "$GROUP_SEED" > "$group"
  printf 'vscode:100000:65536\n' > "$subuid"; printf 'vscode:100000:65536\n' > "$subgid"
  env -u _REMOTE_USER \
    UID_MAP_FILE="$uidmap" GID_MAP_FILE="$WORK/gid_map.rootless" \
    PASSWD_FILE="$passwd" GROUP_FILE="$group" SUBUID_FILE="$subuid" SUBGID_FILE="$subgid" \
    SHARE_DIR="$share" CHOWN_HOME=false \
    "$@" sh "$INSTALL" > "$log" 2>&1
  status=$?
}

echo "case 1: rootful daemon (identity map) — installs the guard, changes nothing else"
run_install c1 "$WORK/uid_map.identity" _REMOTE_USER=vscode
check "install.sh succeeds" test "$status" -eq 0
check "post-create.sh is installed and executable" test -x "$share/post-create.sh"
check "it says it did nothing" grep -q 'rootful daemon' "$log"
check "no remap marker" test ! -e "$share/remapped"
check "passwd is untouched" bash -c "[ \"\$(cat '$passwd')\" = \"\$(printf '%s' \"\$PASSWD_SEED\")\" ]"
check "subuid is untouched" grep -qxF 'vscode:100000:65536' "$subuid"

echo "case 2: rootless daemon — the remote user becomes uid 0 and keeps its name and home"
run_install c2 "$WORK/uid_map.rootless" _REMOTE_USER=vscode
check "install.sh succeeds" test "$status" -eq 0
check "it names the host uid" grep -q 'container uid 0 is host uid 1000' "$log"
check "vscode is now uid 0, gid 0, same home and shell" grep -qxF 'vscode:x:0:0::/home/vscode:/bin/bash' "$passwd"
check "  and is the FIRST entry, so getpwuid(0) answers vscode" bash -c "head -1 '$passwd' | grep -q '^vscode:'"
check "  root's own entry is still there" grep -qxF 'root:x:0:0:root:/root:/bin/bash' "$passwd"
check "  no other line was disturbed" grep -qxF 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin' "$passwd"
check "the placeholder holds host uid 1000" bash -c "grep -q '^devc-uid-hold:x:1000:1000:' '$passwd'"
check "  with a nologin shell and no home" bash -c "grep '^devc-uid-hold:' '$passwd' | grep -q ':/nonexistent:/usr/sbin/nologin$'"
check "  gid 1000 already has a group, so none is added" bash -c \
  "grep -q ':x:1000:' '$group' && ! grep -q '^devc-uid-hold:' '$group'"
check "subuid: vscode (now uid 0) gets the whole outer range, the 100000 line is gone" bash -c \
  "grep -qxF 'vscode:1:65535' '$subuid' && ! grep -q '100000' '$subuid'"
check "subuid: the placeholder (holder of uid 1000) gets the range minus 1000, as two lines" bash -c \
  "grep -qxF 'devc-uid-hold:1:999' '$subuid' && grep -qxF 'devc-uid-hold:1001:64535' '$subuid'"
check "subgid mirrors it" bash -c "grep -qxF 'vscode:1:65535' '$subgid' && grep -qxF 'devc-uid-hold:1001:64535' '$subgid'"
check "the remap marker exists" test -e "$share/remapped"

echo "case 2b: an image with no uid/gid 1000 at all — the placeholder brings both"
run_install c2b "$WORK/uid_map.rootless" _REMOTE_USER=vscode
printf 'root:x:0:0:root:/root:/bin/bash\nvscode:x:1001:1001::/home/vscode:/bin/bash\n' > "$passwd"
printf 'root:x:0:\nvscode:x:1001:\n' > "$group"
env -u _REMOTE_USER UID_MAP_FILE="$WORK/uid_map.rootless" GID_MAP_FILE="$WORK/gid_map.rootless" \
  PASSWD_FILE="$passwd" GROUP_FILE="$group" SUBUID_FILE="$subuid" SUBGID_FILE="$subgid" \
  SHARE_DIR="$share" CHOWN_HOME=false _REMOTE_USER=vscode sh "$INSTALL" > "$WORK/c2b.log" 2>&1
check "install.sh succeeds" test $? -eq 0
check "the placeholder user is added at uid 1000" grep -q '^devc-uid-hold:x:1000:1000:' "$passwd"
check "  and a matching group at gid 1000" grep -qxF 'devc-uid-hold:x:1000:' "$group"
check "  subuid covers vscode and the placeholder" bash -c \
  "grep -qxF 'vscode:1:65535' '$subuid' && grep -qxF 'devc-uid-hold:1:999' '$subuid'"

echo "case 3: running twice is idempotent"
run_install c3 "$WORK/uid_map.rootless" _REMOTE_USER=vscode
cp "$passwd" "$WORK/c3.passwd.once"; cp "$subuid" "$WORK/c3.subuid.once"
env -u _REMOTE_USER UID_MAP_FILE="$WORK/uid_map.rootless" GID_MAP_FILE="$WORK/gid_map.rootless" \
  PASSWD_FILE="$passwd" GROUP_FILE="$group" SUBUID_FILE="$subuid" SUBGID_FILE="$subgid" \
  SHARE_DIR="$share" CHOWN_HOME=false _REMOTE_USER=vscode sh "$INSTALL" > "$WORK/c3b.log" 2>&1
check "second run succeeds" test $? -eq 0
check "  and says vscode is already uid 0" grep -q 'already uid 0' "$WORK/c3b.log"
check "  passwd unchanged by the second run" cmp -s "$passwd" "$WORK/c3.passwd.once"
check "  subuid has no duplicate lines" bash -c "[ \"\$(grep -c '^vscode:' '$subuid')\" -eq 1 ] && [ \"\$(grep -c '^devc-uid-hold:' '$subuid')\" -eq 2 ]"

echo "case 4: skip paths"
run_install c4a "$WORK/uid_map.rootless"
check "no _REMOTE_USER: succeeds and says so" bash -c "[ $status -eq 0 ] && grep -q '_REMOTE_USER is unset' '$log'"
check "  passwd untouched" bash -c "[ \"\$(cat '$passwd')\" = \"\$(printf '%s' \"\$PASSWD_SEED\")\" ]"
run_install c4b "$WORK/uid_map.rootless" _REMOTE_USER=root
check "remote user root: succeeds and says so" bash -c "[ $status -eq 0 ] && grep -q 'already root' '$log'"
run_install c4c "$WORK/uid_map.rootless" _REMOTE_USER=nobody-here
check "an unknown remote user fails the build" test "$status" -ne 0
check "  naming it" grep -q 'nobody-here is not in' "$log"

echo "case 5: the guard"
GUARD="$FEATURE_DIR/post-create.sh"
run_install c5 "$WORK/uid_map.rootless" _REMOTE_USER=vscode
check "with no marker the guard is silent and exits 0" bash -c \
  "[ -z \"\$(SHARE_DIR='$WORK/nowhere' sh '$GUARD' 2>&1)\" ]"
check "with the marker and a non-zero uid it fails, naming updateRemoteUserUID" bash -c \
  "! SHARE_DIR='$share' sh '$GUARD' > '$WORK/c5.guard.log' 2>&1 && grep -q 'updateRemoteUserUID' '$WORK/c5.guard.log'"

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
