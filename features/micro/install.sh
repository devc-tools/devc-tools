#!/bin/sh
# micro Feature install — download micro's release tarball, verify it against the release's own
# SHA-256, and install the binary at /usr/local/bin/micro.
#
# Runs as root at image *build* time. Network is required: a failed download fails the build
# rather than leaving a container that looks fine until the editor is first opened.
set -e

die() {
  echo "micro: $*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId).
VERSION_OPT="${VERSION:-latest}"

# --- 1. validate `version` ---------------------------------------------------------------
#
# It is interpolated into a URL and a file name, so anything outside a conservative character
# set is rejected outright rather than trusted.
case "$VERSION_OPT" in
  *[!A-Za-z0-9_.-]*) die "version may not contain characters outside [A-Za-z0-9_.-]: $VERSION_OPT" ;;
esac

# --- 2. resolve the release tag ------------------------------------------------------------
#
# Overridable so an offline test harness can point both at a fixture instead of GitHub.
RELEASES_LATEST_URL="${MICRO_RELEASES_LATEST_URL:-https://github.com/micro-editor/micro/releases/latest}"
RELEASE_BASE="${MICRO_RELEASE_BASE:-https://github.com/micro-editor/micro/releases}"

if [ "$VERSION_OPT" = latest ]; then
  # Not the GitHub API: the redirect needs no auth and does not share the API's much lower
  # unauthenticated rate limit (the same choice as godot/install.sh).
  redirect_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES_LATEST_URL")" \
    || die "could not resolve the latest release from $RELEASES_LATEST_URL"
  TAG="${redirect_url##*/}"
  [ -n "$TAG" ] || die "could not read a release tag from $redirect_url"
  case "$TAG" in
    *[!A-Za-z0-9_.-]*) die "unexpected release tag from $redirect_url: $TAG" ;;
  esac
else
  TAG="v${VERSION_OPT#v}"
fi
# Tags are `v2.0.15`; asset names carry the bare version.
VER="${TAG#v}"

# --- 3. map architecture -------------------------------------------------------------------
#
# Both assets are statically linked (no PT_INTERP, checked against 2.0.15), so a musl base
# works too.
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) ARCH='linux64-static' ;;
  aarch64 | arm64) ARCH='linux-arm64' ;;
  *) die "unsupported architecture $machine (supported: x86_64, aarch64)" ;;
esac

# --- 4. download, verify, unpack -------------------------------------------------------------
#
# Confirmed against 2.0.15: micro-${VER}-${ARCH}.tar.gz unpacks to micro-${VER}/ holding
# `micro` beside its LICENSE, README and man page, and each asset has a `.sha` beside it:
# one line, `<sha256>  <asset name>`.
ASSET="micro-${VER}-${ARCH}.tar.gz"
URL="$RELEASE_BASE/download/$TAG/$ASSET"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # fetch <url> <dest>
  if have curl; then
    curl -fsSL -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    die 'need curl or wget to download the release'
  fi
}

fetch "$URL" "$TMP/$ASSET" || die "download failed: $URL"
fetch "$URL.sha" "$TMP/$ASSET.sha" || die "download failed: $URL.sha"

expected="$(cut -d ' ' -f 1 < "$TMP/$ASSET.sha")"
case "$expected" in
  '' | *[!0-9a-f]*) die "unreadable checksum in $URL.sha" ;;
esac
have sha256sum || die 'need sha256sum to verify the download'
actual="$(sha256sum "$TMP/$ASSET" | cut -d ' ' -f 1)"
[ "$actual" = "$expected" ] || die "checksum mismatch for $ASSET: expected $expected, got $actual"

tar -xzf "$TMP/$ASSET" -C "$TMP" || die "could not unpack $ASSET"
[ -f "$TMP/micro-$VER/micro" ] || die "$ASSET does not contain micro-$VER/micro"

# --- 5. install ------------------------------------------------------------------------------
#
# Staged beside the destination and renamed over it, so a build step that dies midway leaves
# no half-written binary. Overridable for the test harness.
BIN="${MICRO_BIN:-/usr/local/bin/micro}"
mkdir -p "$(dirname "$BIN")"
mv "$TMP/micro-$VER/micro" "$BIN.tmp.$$"
chmod 0755 "$BIN.tmp.$$"
mv -f "$BIN.tmp.$$" "$BIN"

echo "micro: $VER ($ARCH) installed at $BIN"
