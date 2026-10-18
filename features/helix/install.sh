#!/bin/sh
# helix Feature install — download Helix's release tarball, install `hx` and its runtime
# (grammars, queries, themes) under /usr/local/lib/helix, and put `hx` on PATH.
#
# Runs as root at image *build* time. Network is required: a failed download fails the build
# rather than leaving a container that looks fine until `hx` is first run. Helix's releases
# publish no checksums file, so the download is trusted on HTTPS alone (godot and devc-bridge
# verify theirs because their releases do publish one).
set -e

die() {
  echo "helix: $*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId).
VERSION_OPT="${VERSION:-latest}"

# --- 1. validate `version` ---------------------------------------------------------------
#
# It is interpolated into a URL and a directory name, so anything outside a conservative
# character set is rejected outright rather than trusted.
case "$VERSION_OPT" in
  *[!A-Za-z0-9_.-]*) die "version may not contain characters outside [A-Za-z0-9_.-]: $VERSION_OPT" ;;
esac

# --- 2. refuse a musl base ------------------------------------------------------------------
#
# The release's Linux binary links glibc (ldd: libc, libm, libgcc_s), so on Alpine it would
# install and then fail to start. Fail the build instead, where the cause is visible.
for _ld in /lib/ld-musl-*; do
  [ -e "$_ld" ] && die "the Helix release binary needs glibc; this image is musl-based ($_ld)"
done

# --- 3. resolve the release tag -----------------------------------------------------------
#
# Overridable so an offline test harness can point both at a fixture instead of GitHub.
RELEASES_LATEST_URL="${HELIX_RELEASES_LATEST_URL:-https://github.com/helix-editor/helix/releases/latest}"
RELEASE_BASE="${HELIX_RELEASE_BASE:-https://github.com/helix-editor/helix/releases}"

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
  TAG="$VERSION_OPT"
fi

# --- 4. map architecture -------------------------------------------------------------------
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) ARCH='x86_64-linux' ;;
  aarch64 | arm64) ARCH='aarch64-linux' ;;
  *) die "unsupported architecture $machine (supported: x86_64, aarch64)" ;;
esac

# --- 5. download + unpack ------------------------------------------------------------------
#
# Confirmed against 25.07.1: helix-${TAG}-${ARCH}.tar.xz unpacks to one directory of the same
# name holding `hx`, `runtime/`, `contrib/`, LICENSE and README.md.
NAME="helix-${TAG}-${ARCH}"
ASSET="$NAME.tar.xz"
URL="$RELEASE_BASE/download/$TAG/$ASSET"

# xz is load-bearing for what this Feature is: install it rather than warn.
have xz || {
  apt-get update && apt-get install -y --no-install-recommends xz-utils
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if have curl; then
  curl -fsSL -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"
elif have wget; then
  wget -q -O "$TMP/$ASSET" "$URL" || die "download failed: $URL"
else
  die 'need curl or wget to download the release'
fi

tar -xJf "$TMP/$ASSET" -C "$TMP" || die "could not unpack $ASSET"
[ -f "$TMP/$NAME/hx" ] || die "$ASSET does not contain $NAME/hx"
[ -d "$TMP/$NAME/runtime" ] || die "$ASSET does not contain $NAME/runtime"

# --- 6. install layout -------------------------------------------------------------------------
#
# The tarball's own layout, kept together: `hx` finds `runtime/` beside itself too, though the
# manifest's HELIX_RUNTIME names it explicitly. Overridable for the test harness.
PREFIX="${HELIX_PREFIX:-/usr/local/lib/helix}"
HX_LINK="${HELIX_LINK:-/usr/local/bin/hx}"

# Staged beside the destination and swapped in, so a build step that dies midway leaves no
# half-written install.
mkdir -p "$(dirname "$PREFIX")"
rm -rf "$PREFIX.tmp.$$"
mkdir -p "$PREFIX.tmp.$$"
mv "$TMP/$NAME/hx" "$TMP/$NAME/runtime" "$PREFIX.tmp.$$/"
chmod 0755 "$PREFIX.tmp.$$/hx"
rm -rf "$PREFIX"
mv "$PREFIX.tmp.$$" "$PREFIX"

mkdir -p "$(dirname "$HX_LINK")"
ln -sfn "$PREFIX/hx" "$HX_LINK"

echo "helix: $TAG ($ARCH) installed at $HX_LINK"
