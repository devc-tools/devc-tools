#!/bin/sh
# rootless-remap create-time guard — runs as the remote user.
#
# If install.sh remapped the remote user to uid 0, this user must now BE uid 0. If it is not,
# something renumbered the user after the image was built — the devcontainer CLI's
# updateRemoteUserUID step, if the placeholder that is supposed to make it a no-op did not take.
# That state fails green: writes appear to work and land as an unmapped subuid the developer
# cannot touch (devc-dev rootless findings, M-7). So this is the one create-time step in the
# collection that deliberately fails: an unbootable container is better than orphaned files.
set -u

SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/rootless-remap}"

if [ ! -e "$SHARE_DIR/remapped" ]; then
  exit 0
fi

if [ "$(id -u)" = 0 ]; then
  echo "rootless-remap: remote user is uid 0 ($(id -un)), home $HOME — the workspace is writable"
  exit 0
fi

echo "rootless-remap: this image was built on a rootless daemon and $(id -un) was remapped to uid 0," >&2
echo "rootless-remap: but the container runs it as uid $(id -u). The devcontainer CLI's updateRemoteUserUID" >&2
echo "rootless-remap: step renumbered it after the build; the placeholder user that should hold the host" >&2
echo "rootless-remap: uid was not enough here. Set \"updateRemoteUserUID\": false in devcontainer.json and" >&2
echo "rootless-remap: rebuild. Refusing to continue: files created now would be owned by an unmapped uid." >&2
exit 1
