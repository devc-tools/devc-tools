#!/bin/bash
# Cross-compile the container-side client straight into the dir devc bind-mounts read-only
# into every container (~/.config/devc-bridge/client). This is the *developer* path to that
# destination; the typical user gets the same binary in the same place from the release
# installer. Nothing builds it on the fly — `devc-bridge start` never compiles a client.
#
# Why a script rather than a plain `deno compile` task: a deno.json task cannot branch on
# the host architecture, and the target has to follow it — Docker Desktop runs containers
# matching the host by default. A container deliberately run under emulation on the other
# arch is out of scope; rebuild with DEVC_BRIDGE_CLIENT_TARGET set if you need that.
#
# The compile goes to a temp path in the *same* directory and is renamed into place, so a
# container reading through the live mount never sees a half-written binary.
set -e
cd "$(dirname "$0")"

DEST_DIR="${DEVC_BRIDGE_CLIENT_DIR:-$HOME/.config/devc-bridge/client}"
DEST="$DEST_DIR/devc-bridge"

if [ -z "${DEVC_BRIDGE_CLIENT_TARGET:-}" ]; then
  case "$(uname -m)" in
    arm64 | aarch64) DEVC_BRIDGE_CLIENT_TARGET=aarch64-unknown-linux-gnu ;;
    x86_64 | amd64) DEVC_BRIDGE_CLIENT_TARGET=x86_64-unknown-linux-gnu ;;
    *)
      echo "devc-bridge: unsupported host arch $(uname -m) — set DEVC_BRIDGE_CLIENT_TARGET" >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$DEST_DIR"
TMP="$DEST.tmp.$$"
trap 'rm -f "$TMP"' EXIT

# Stamps `git describe` for the client's `--version` (see ../../version-info/version_info.ts).
deno task build:info

deno compile \
  --include build_info.json \
  --allow-read \
  --allow-net \
  --allow-env=DEVC_BRIDGE_ADDR,DEVC_BRIDGE_TOKEN_FILE \
  --target "$DEVC_BRIDGE_CLIENT_TARGET" \
  --output "$TMP" \
  devc-bridge.ts

chmod 0755 "$TMP"
# Same-directory rename: atomic, so the mount flips from old to new with nothing in between.
mv -f "$TMP" "$DEST"

echo "devc-bridge: client installed at $DEST ($DEVC_BRIDGE_CLIENT_TARGET)"
