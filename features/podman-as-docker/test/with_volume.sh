#!/bin/bash
# Scenario: the Feature's own declared graphroot volume — no extra config, since the
# mount is unconditional. What is verifiable from *inside* the container: the mount is
# present, real (not overlay-on-overlay), owned correctly, and actually used for storage.
#
# What is NOT verifiable here: that the volume's name resolved `${devcontainerId}` rather
# than collapsing every project onto one shared graphroot — that needs a host-side
# `docker volume ls`, which this scenario script (running inside the built container) has
# no access to. That check lives in docs/manual-verification.md instead.
set -e

source dev-container-features-test-lib

GRAPHROOT=/var/lib/devc-features/podman-as-docker/storage

check "the graphroot is a mount point" bash -c \
  "findmnt --target $GRAPHROOT >/dev/null 2>&1 || mountpoint -q $GRAPHROOT"
check "owned by the remote user (the first-use root-owned repair)" bash -c \
  "[ \"\$(stat -c '%U' $GRAPHROOT)\" = \"\$(id -un)\" ]"
check "its backing filesystem is not overlay" bash -c \
  "! findmnt -no FSTYPE --target $GRAPHROOT 2>/dev/null | grep -qx overlay"

check "storage.conf points the graphroot at this mount" grep -qxF \
  "graphroot = \"$GRAPHROOT\"" "$HOME/.config/containers/storage.conf"
check "and chose overlay, not vfs" grep -qxF 'driver = "overlay"' \
  "$HOME/.config/containers/storage.conf"

check "docker pull actually writes into the mounted graphroot" bash -c "
  before=\$(du -s $GRAPHROOT 2>/dev/null | cut -f1)
  docker pull docker.io/library/busybox >/dev/null || exit 1
  after=\$(du -s $GRAPHROOT 2>/dev/null | cut -f1)
  [ \"\$after\" -gt \"\$before\" ]
"

reportResults
