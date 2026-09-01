#!/bin/sh
# podman-as-docker create-time step — repair the graphroot's ownership, then write
# ~/.config/containers/storage.conf: the relocated graphroot path, and the storage driver
# actually decided at create time — a run-time fact the build-time install.sh cannot know,
# because the graphroot volume is not mounted until create time.
#
# install.sh copies this file to
# /usr/local/share/devc-features/podman-as-docker/post-create.sh at image build time and
# bakes STORAGE_DRIVER_OPT and GRAPHROOT_DIR into the two assignments below; the
# manifest's postCreateCommand names that copy. The devcontainer CLI runs it as the
# remote user.
#
# Every skip path here exits 0: a failing postCreateCommand aborts container creation,
# and no storage question is worth an unbootable container.
set -e

warn() {
  echo "podman-as-docker: $*" >&2
}

# --- baked by install.sh from the Feature's options ---------------------------------
STORAGE_DRIVER_OPT="${STORAGE_DRIVER_OPT:-auto}"
GRAPHROOT_DIR="${GRAPHROOT_DIR:-/var/lib/devc-features/podman-as-docker/storage}"
# --------------------------------------------------------------------------------------

mkdir -p "$GRAPHROOT_DIR" || {
  warn "could not create $GRAPHROOT_DIR — storage.conf not written"
  exit 0
}

# --- 1. ownership repair -----------------------------------------------------------------
# A volume mounted at $GRAPHROOT_DIR — the Feature's own declared mount in the normal
# case — arrives root-owned on first use, and rootless Podman cannot write there; it fails
# with a permission error naming the storage directory rather than the mount, so the cause
# is not obvious without this. Non-recursive: on a rebuild the volume is already
# populated, and a recursive chown over an image store is slow and pointless.
owner="$(stat -c '%U' "$GRAPHROOT_DIR" 2> /dev/null || true)"
if [ -n "$owner" ] && [ "$owner" != "$(id -un)" ]; then
  if command -v sudo > /dev/null 2>&1; then
    sudo -n chown "$(id -un)" "$GRAPHROOT_DIR" 2> /dev/null ||
      warn "$GRAPHROOT_DIR is owned by $owner and could not be repaired (no passwordless sudo)"
  else
    warn "$GRAPHROOT_DIR is owned by $owner and no sudo is available to fix it"
  fi
fi

# --- 2. decide the driver ------------------------------------------------------------
#
# The dividing line is not /dev/fuse, which turns out not to matter. It is whether
# $GRAPHROOT_DIR's *backing filesystem* is itself overlay. On a real filesystem
# (the normal case: the Feature's own volume, or any host bind), plain `overlay` works
# with no mount_program and no device — native kernel overlay. On an overlay backing (no
# volume present, graphroot sitting in the container's own writable layer), `overlay`
# does not merely get slow, it fails every container start outright
# (`exec ...: Invalid argument`) — and fuse-overlayfs does not rescue it either, so `vfs`
# is the only working driver there, not a nicer-to-avoid fallback.
backing_fstype() {
  if command -v findmnt > /dev/null 2>&1; then
    findmnt -no FSTYPE --target "$1" 2> /dev/null || true
  else
    stat -f -c %T "$1" 2> /dev/null || true
  fi
}

case "$STORAGE_DRIVER_OPT" in
  vfs)
    CHOSEN_DRIVER=vfs
    ;;
  overlay)
    CHOSEN_DRIVER=overlay
    fs="$(backing_fstype "$GRAPHROOT_DIR")"
    case "$fs" in
      overlay | overlayfs)
        warn "storageDriver is explicitly 'overlay' but $GRAPHROOT_DIR is itself backed" \
          "by overlayfs — this will fail every container start" \
          "(exec ...: Invalid argument). Mount a real volume there, or set" \
          "storageDriver to 'auto' or 'vfs'."
        ;;
    esac
    ;;
  *)
    fs="$(backing_fstype "$GRAPHROOT_DIR")"
    case "$fs" in
      overlay | overlayfs)
        CHOSEN_DRIVER=vfs
        echo "podman-as-docker: storageDriver=auto -> vfs ($GRAPHROOT_DIR is backed by" \
          "overlayfs — no real volume is mounted there; mount one for native overlay" \
          "storage and to survive a rebuild)"
        ;;
      *)
        CHOSEN_DRIVER=overlay
        echo "podman-as-docker: storageDriver=auto -> overlay ($GRAPHROOT_DIR is backed" \
          "by '$fs' — native kernel overlay, no device needed)"
        ;;
    esac
    ;;
esac

# --- 3. never rewrite storage.conf out from under existing images ------------------------
# Podman will not read images written under a different driver, and the failure is
# opaque. If the graphroot already holds something and the configured driver would
# change, leave the file alone.
STORAGE_CONF_DIR="$HOME/.config/containers"
STORAGE_CONF="$STORAGE_CONF_DIR/storage.conf"
EXISTING_DRIVER=""
[ -f "$STORAGE_CONF" ] &&
  EXISTING_DRIVER="$(sed -n 's/^driver = "\(.*\)"$/\1/p' "$STORAGE_CONF" | head -n1)"

GRAPHROOT_POPULATED=false
[ -n "$(ls -A "$GRAPHROOT_DIR" 2> /dev/null)" ] && GRAPHROOT_POPULATED=true

if [ -n "$EXISTING_DRIVER" ] && [ "$EXISTING_DRIVER" != "$CHOSEN_DRIVER" ] &&
  [ "$GRAPHROOT_POPULATED" = true ]; then
  warn "$GRAPHROOT_DIR already holds images under driver='$EXISTING_DRIVER'; leaving" \
    "storage.conf alone rather than switching to '$CHOSEN_DRIVER' — podman would not" \
    "read the existing images under the new driver."
  exit 0
fi

mkdir -p "$STORAGE_CONF_DIR" || {
  warn "could not create $STORAGE_CONF_DIR — storage.conf not written"
  exit 0
}
{
  echo '[storage]'
  echo "driver = \"$CHOSEN_DRIVER\""
  echo "graphroot = \"$GRAPHROOT_DIR\""
} > "$STORAGE_CONF" || {
  warn "could not write $STORAGE_CONF"
  exit 0
}
echo "podman-as-docker: $STORAGE_CONF written (driver=$CHOSEN_DRIVER graphroot=$GRAPHROOT_DIR)"
