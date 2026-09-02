#!/bin/bash
# Scenario: the claim this Feature makes since 0.2.0 — nested podman with NO added capability.
# The scenario's runArgs carry only the seccomp profile and /dev/net/tun; the Feature declares
# systempaths=unconfined and apparmor=unconfined and nothing else. Private networking
# (slirp4netns) is on, so this also exercises the network path the old SYS_ADMIN grant used
# to cover. See docs/manual-verification.md §13.9 and devc-dev's rootless findings § Zero
# capabilities for the measurements behind every check here.
set -e

source dev-container-features-test-lib

check "the container's bounding set does NOT contain CAP_SYS_ADMIN" bash -c '
  bnd="$(grep CapBnd /proc/self/status | cut -f2)"
  capsh --decode="$bnd" | grep -qv cap_sys_admin || { echo "bounding set: $(capsh --decode="$bnd")"; exit 1; }
  ! capsh --decode="$bnd" | grep -q cap_sys_admin
'
check "  nor CAP_NET_ADMIN or CAP_SYS_PTRACE" bash -c '
  ! capsh --decode="$(grep CapBnd /proc/self/status | cut -f2)" | grep -qE "cap_net_admin|cap_sys_ptrace"
'
check "this process holds no capability at all" bash -c \
  "[ \"\$(grep CapEff /proc/self/status | cut -f2)\" = 0000000000000000 ]"
check "a seccomp filter IS active (the profile, not seccomp=unconfined)" bash -c \
  "grep -qE '^Seccomp:\s*2' /proc/self/status"

check "newuidmap carries cap_setuid as a file capability" bash -c \
  "getcap /usr/bin/newuidmap | grep -q cap_setuid"
check "  and is no longer setuid" bash -c "[ ! -u /usr/bin/newuidmap ]"
check "newgidmap carries cap_setgid" bash -c "getcap /usr/bin/newgidmap | grep -q cap_setgid"
check "the podman shim is ahead of /usr/bin on PATH" bash -c \
  "[ \"\$(command -v podman)\" = /usr/local/bin/podman ]"
check "/var/lib/cni exists" test -d /var/lib/cni

check "podman reports rootless" bash -c \
  "podman info --format '{{.Host.Security.Rootless}}' | grep -qx true"
check "netavark is the network backend (not CNI)" bash -c \
  "podman info --format '{{.Host.NetworkBackend}}' | grep -qx netavark"

check "docker run works, in a private network namespace" bash -c '
  ours="$(readlink /proc/self/ns/net)"
  theirs="$(docker run --rm alpine readlink /proc/self/ns/net)"
  [ "$ours" != "$theirs" ]
'
check "with real egress" bash -c \
  "docker run --rm alpine wget -qO- -T 10 https://example.com | grep -qi 'example domain'"
check "docker build works" bash -c '
  d="$(mktemp -d)"; printf "FROM alpine\nRUN echo built > /b\n" > "$d/Dockerfile"
  docker build -q -t devc-zero-caps-test "$d" > /dev/null && docker run --rm devc-zero-caps-test cat /b | grep -qx built
'
check "containers on a created network resolve each other by name" bash -c '
  docker network create zc-net > /dev/null
  docker run -d --name zc-srv --network zc-net nginx:alpine > /dev/null
  for i in 1 2 3 4 5 6 7 8; do
    docker run --rm --network zc-net alpine wget -qO- -T 5 http://zc-srv/ 2>/dev/null | grep -q nginx && break
    sleep 1
  done
  docker run --rm --network zc-net alpine wget -qO- -T 5 http://zc-srv/ | grep -q nginx
  rc=$?
  docker rm -f zc-srv > /dev/null; docker network rm zc-net > /dev/null
  exit $rc
'
check "the API socket serves the same podman" bash -c \
  "podman --url \"\$DOCKER_HOST\" info --format '{{.Host.Security.Rootless}}' | grep -qx true"

reportResults
