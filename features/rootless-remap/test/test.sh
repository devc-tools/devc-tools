#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with no options. `devcontainer features test` only ever builds on the daemon it is
# pointed at, so this scenario proves the two things that hold on ANY daemon: the Feature
# installs, and on a rootful daemon (Docker Desktop, native Linux Docker, GitHub runners) it
# changes nothing. The rootless branch cannot be reached from a scenario; it is validated by
# hand on a rootless host — devc-tools docs/manual-verification.md §13.9.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/rootless-remap

check "the create-time guard is installed" test -f "$SHARE/post-create.sh"
check "and owned by root" bash -c "[ \"\$(stat -c '%U' $SHARE/post-create.sh)\" = root ]"

if awk '$1 == 0 && $2 == 0 && $3 == 4294967295 { f = 1 } END { exit !f }' /proc/self/uid_map; then
  check "rootful daemon: no remap marker was left" test ! -e "$SHARE/remapped"
  check "rootful daemon: the remote user is NOT uid 0" bash -c "[ \"\$(id -u)\" != 0 ]"
  check "rootful daemon: no placeholder user was added" bash -c "! getent passwd devc-uid-hold"
  check "rootful daemon: the guard exits 0 and says nothing" bash -c \
    "[ -z \"\$(bash $SHARE/post-create.sh 2>&1)\" ]"
else
  check "rootless daemon: the remap marker exists" test -e "$SHARE/remapped"
  check "rootless daemon: the remote user IS uid 0" bash -c "[ \"\$(id -u)\" = 0 ]"
  check "rootless daemon: and still has its own name and home" bash -c \
    "[ \"\$(id -un)\" != root ] && [ \"\$HOME\" != /root ]"
  check "rootless daemon: the placeholder holds the host uid" bash -c \
    "getent passwd devc-uid-hold | grep -q \":\$(awk '\$1 == 0 { print \$2; exit }' /proc/self/uid_map):\""
  check "rootless daemon: the guard exits 0" bash "$SHARE/post-create.sh"
fi

reportResults
