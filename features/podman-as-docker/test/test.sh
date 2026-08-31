#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"podman-as-docker": {}`) and **no consumer runArgs**.
#
# That combination is the point of this file, and it is a stronger claim than most
# Features' bare-{} case: per the plan's § Step 1, both things that gate a working
# `docker run` — capAdd:["SYS_ADMIN"]+securityOpt:["systempaths=unconfined"], and a
# real-filesystem volume at the graphroot — are unconditional Feature declarations, not a
# runArgs paste. So this scenario is also the proof the Feature does anything at all:
# `docker run` has to actually work here, with zero extra flags.
#
# Unlike every other Feature in this collection, this one CANNOT tolerate the test
# command's own default base image — `ubuntu:focal` (20.04) does not carry a `podman`
# package at all (it predates Ubuntu's own packaging of it), so `install.sh` fails the
# build there, correctly (a failed install fails the build, same as every other Feature
# here). Run this scenario with an explicit, podman-carrying base image:
#
#   bash features/podman-as-docker/test/run-features-test.sh \
#     --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/podman-as-docker
SOCK_DIR=/run/devc-features/podman-as-docker
GRAPHROOT=/var/lib/devc-features/podman-as-docker/storage

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "start-time script is installed" test -f "$SHARE/post-start.sh"
check "both are owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ] &&
   [ \"\$(stat -c '%U:%G' $SHARE/post-start.sh)\" = 'root:root' ]"

check "docker is on PATH" bash -c "command -v docker"
check "docker --version names podman, not a real Docker Engine" bash -c \
  "docker --version | grep -qi podman"
check "the podman-docker emulation banner is silenced on stderr" bash -c \
  "[ -z \"\$(docker --version 2>&1 >/dev/null)\" ]"
check "/etc/containers/nodocker exists (silenceEmulationNotice defaults true)" \
  test -e /etc/containers/nodocker

check "subuid has a range for the remote user" bash -c \
  "grep -q \"^\$(id -un):\" /etc/subuid"
check "subgid has a range for the remote user" bash -c \
  "grep -q \"^\$(id -un):\" /etc/subgid"

check "registries.conf.d resolves docker.io unqualified" test -f \
  /etc/containers/registries.conf.d/99-devc-podman-as-docker.conf
check "containers.conf.d defaults netns to host" grep -qxF 'netns = "host"' \
  /etc/containers/containers.conf.d/99-devc-podman-as-docker.conf

check "the graphroot volume is mounted (this Feature's own declared mount)" bash -c \
  "findmnt --target $GRAPHROOT >/dev/null 2>&1 || mountpoint -q $GRAPHROOT"
check "and owned by the remote user (the create-time ownership repair)" bash -c \
  "[ \"\$(stat -c '%U' $GRAPHROOT)\" = \"\$(id -un)\" ]"

check "storage.conf was written at create time" test -f "$HOME/.config/containers/storage.conf"
check "and chose overlay — the graphroot is a real filesystem, not the container's own" \
  grep -qxF 'driver = "overlay"' "$HOME/.config/containers/storage.conf"

# --- the whole point: docker run works with zero runArgs ---------------------------------
check "docker run --rm alpine true succeeds with no runArgs at all" \
  docker run --rm docker.io/library/alpine true
check "podman confirms native overlay — no /dev/fuse, no mount_program" bash -c \
  "podman info --format '{{.Store.GraphDriverName}}' | grep -qx overlay"
check "a bare image name resolves via the registries drop-in" \
  docker run --rm ubuntu true

check "the API socket exists after start (dockerApiSocket defaults true)" \
  test -S "$SOCK_DIR/podman.sock"
check "and DOCKER_HOST names it" bash -c \
  "[ \"\$DOCKER_HOST\" = \"unix://$SOCK_DIR/podman.sock\" ]"
check "docker -H \$DOCKER_HOST ps works" bash -c "docker -H \"\$DOCKER_HOST\" ps"

reportResults
