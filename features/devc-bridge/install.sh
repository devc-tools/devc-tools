#!/bin/sh
# devc-bridge Feature install — fetch the Linux client from the matching devc-tools
# release and put it on PATH.
#
# The client is downloaded into an image layer, owned by root, rather than mounted from the
# host: a Feature cannot declare a read-only mount (its schema's Mount has no `readonly`,
# and the CLI re-serializes object mounts as `type=,src=,dst=`), so there is deliberately
# no shared host file for one container to rewrite out from under another.
#
# The *token* does cross by bind mount, but that mount is declared by the consumer's
# devcontainer.json, where the string form is in the published schema and `readonly` is
# real. This script has nothing to do with it.
#
# Runs as root at image *build* time. Network is required; a failed or unverifiable
# download fails the build rather than leaving a container that looks fine until the first
# `devc-bridge` call.
set -e

# Same default the fenced link block below re-derives, set once here so the download and
# the symlink cannot disagree. Overridable for the test harness.
BRIDGE_CLIENT="${BRIDGE_CLIENT:-/usr/local/share/devc-bridge/client/devc-bridge}"

# The devc-tools release this Feature downloads its client from. NOT this Feature's own
# version — the two are independent. Pinned deliberately, so the Feature ships a client that
# has been tested against this install.sh; bumping it is itself a Feature change. Repeated
# here rather than read from the manifest, which is JSON, because no `jq` is guaranteed in
# an arbitrary base image. See features/CONTRIBUTING.md.
DEVC_TOOLS_RELEASE='v0.1.0'

die() {
  echo "devc-bridge: $*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- what to fetch ---------------------------------------------------------------------

# `clientVersion` reaches us as $CLIENTVERSION: the CLI uppercases option names and strips
# non-word characters (getSafeId). Deliberately *not* named VERSION, and not named after
# this Feature either — what it selects is a devc-tools release, independent of the
# Feature's own version.
CLIENT_VERSION="${CLIENTVERSION:-}"
[ -n "$CLIENT_VERSION" ] || CLIENT_VERSION="$DEVC_TOOLS_RELEASE"
# Tags carry the `v`, asset filenames carry the bare version. Accept either spelling.
BARE_VERSION="${CLIENT_VERSION#v}"

# The container's own architecture is the right one: this runs inside the image being built,
# so there is nothing to reason about here.
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) arch='x86_64' ;;
  arm64 | aarch64) arch='aarch64' ;;
  *) die "unsupported architecture $machine (supported: x86_64, arm64/aarch64)" ;;
esac
TRIPLE="$arch-unknown-linux-gnu"
ASSET="devc-bridge-client-$BARE_VERSION-$TRIPLE.tar.gz"

RELEASE_BASE="${DEVC_RELEASE_BASE:-https://github.com/devc-tools/devc-tools/releases}"
URL_DIR="$RELEASE_BASE/download/v$BARE_VERSION"

# --- fetch + verify --------------------------------------------------------------------

fetch() { # fetch <url> <dest>
  if have curl; then
    curl -fsSL -o "$2" "$1" || die "download failed: $1"
  elif have wget; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die 'need curl or wget to download the client'
  fi
}

sha256_of() { # sha256_of <file>
  if have sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die 'need sha256sum or shasum to verify the download'
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch "$URL_DIR/checksums.txt" "$TMP/checksums.txt"
fetch "$URL_DIR/$ASSET" "$TMP/$ASSET"

# Unpacking an unverified binary onto PATH is the thing this script must not do casually.
# Nothing is written outside $TMP until the hash matches the release's own checksums.txt.
expected="$(awk -v n="$ASSET" '
  { name = $2; sub(/^\*/, "", name) }   # sha256sum -b writes *name
  name == n { print $1; exit }
' "$TMP/checksums.txt")"
[ -n "$expected" ] || die "checksums.txt has no entry for $ASSET"
actual="$(sha256_of "$TMP/$ASSET")"
[ "$expected" = "$actual" ] || die \
  "checksum mismatch for $ASSET (expected $expected, got $actual) — nothing was installed"

tar -xzf "$TMP/$ASSET" -C "$TMP" || die "could not unpack $ASSET"
[ -f "$TMP/devc-bridge" ] || die "$ASSET does not contain devc-bridge"

mkdir -p "$(dirname "$BRIDGE_CLIENT")"
# Same-directory rename, so a build step that dies midway leaves no half-written binary.
mv -f "$TMP/devc-bridge" "$BRIDGE_CLIENT.tmp.$$"
chmod 0755 "$BRIDGE_CLIENT.tmp.$$"
mv -f "$BRIDGE_CLIENT.tmp.$$" "$BRIDGE_CLIENT"

echo "devc-bridge: client $BARE_VERSION ($TRIPLE) installed at $BRIDGE_CLIENT"

# --- put it on PATH ----------------------------------------------------------------------
#
# Unconditional, so a developer can shadow the downloaded client: bind-mounting a locally
# built client *directory* over /usr/local/share/devc-bridge/client replaces the target
# live, and the link follows it. A guard here would break that.
#
# There is deliberately no guard against an existing non-symlink at the link path either:
# this runs at build time, so anything a project installs there afterwards still wins.
# devc:bridge-client-link (start)
set -e
BRIDGE_CLIENT="${BRIDGE_CLIENT:-/usr/local/share/devc-bridge/client/devc-bridge}"
BRIDGE_LINK="${BRIDGE_LINK:-/usr/local/bin/devc-bridge}"

mkdir -p "$(dirname "$BRIDGE_LINK")"
ln -sfn "$BRIDGE_CLIENT" "$BRIDGE_LINK"
# devc:bridge-client-link (end)
