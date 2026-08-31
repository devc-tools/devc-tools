#!/bin/bash
# Scenario: real (non-host) rootless networking. `rootlessNetworkCmd: "slirp4netns"` plus
# the one runArgs paste this Feature ever needs — `--device=/dev/net/tun` — the thing a
# Feature cannot grant on its own (§ Step 1 of the plan).
#
# This is the scenario that proves network-namespace isolation actually works, as opposed
# to the default scenario's `--network=host`, where the nested container shares the
# devcontainer's own network namespace.
set -e

source dev-container-features-test-lib

check "containers.conf.d set netns to private" grep -qxF 'netns = "private"' \
  /etc/containers/containers.conf.d/99-devc-podman-as-docker.conf
check "  and default_rootless_network_cmd to slirp4netns" grep -qxF \
  'default_rootless_network_cmd = "slirp4netns"' \
  /etc/containers/containers.conf.d/99-devc-podman-as-docker.conf

check "/dev/net/tun is present (the runArgs paste)" test -c /dev/net/tun

check "a container gets its own network namespace, not the devcontainer's" bash -c '
  ours="$(readlink /proc/self/ns/net)"
  theirs="$(docker run --rm alpine readlink /proc/self/ns/net)"
  [ "$ours" != "$theirs" ]
'

check "and still has real egress through it" bash -c \
  "docker run --rm alpine wget -qO- -T 10 https://example.com | grep -qi 'example domain'"

reportResults
