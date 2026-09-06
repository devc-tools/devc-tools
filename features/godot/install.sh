#!/bin/sh
# godot Feature install — download the Godot engine binary and put it on PATH, and place the
# create-time script that repairs the declared .godot volume's ownership.
#
# Runs as root at image *build* time. Network is required — there is no "Godot is already
# installed" skip to design around here the way `agents` has one, since a Feature's install.sh
# runs exactly once per image build. A failed or unverifiable download fails the build rather
# than leaving a container that looks fine until Godot is first invoked.
set -e

die() {
  echo "godot: $*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId),
# and booleans arrive as the strings "true"/"false". `${VAR-default}` rather than `${VAR:-default}`
# for projectDir: an explicitly empty value means the workspace root and must not fall back to
# anything.
VERSION_OPT="${VERSION:-latest}"
INSTALL_DEPENDENCIES="${INSTALLDEPENDENCIES:-true}"
PROJECT_DIR_OPT="${PROJECTDIR-}"
FIX_GODOT_DIR_OWNERSHIP="${FIXGODOTDIROWNERSHIP:-true}"

# --- 1. validate `version` ---------------------------------------------------------------
#
# It is interpolated into a URL and a directory name (via TAG/BARE below), so anything outside
# a conservative character set is rejected outright rather than trusted.
case "$VERSION_OPT" in
  *[!A-Za-z0-9_.-]*) die "version may not contain characters outside [A-Za-z0-9_.-]: $VERSION_OPT" ;;
esac

# projectDir is pasted into a double-quoted shell assignment when it is baked into
# post-create.sh (see bake() below). Unvalidated, a value of
#   packages/app"; touch /tmp/PWNED; :"
# would bake to a line that runs that command — and pass a verify grep built from the same
# unescaped value. These are container paths; none of it is a real restriction, but a failed
# build is the only acceptable outcome for one of these characters.
case "$PROJECT_DIR_OPT" in
  *'"'*) die "projectDir may not contain a double quote: $PROJECT_DIR_OPT" ;;
  *'`'*) die "projectDir may not contain a backtick: $PROJECT_DIR_OPT" ;;
  *'$'*) die "projectDir may not contain a dollar sign: $PROJECT_DIR_OPT" ;;
  *'\'*) die "projectDir may not contain a backslash: $PROJECT_DIR_OPT" ;;
  *'
'*) die "projectDir may not contain a newline: $PROJECT_DIR_OPT" ;;
esac

# --- 2. resolve the release tag -----------------------------------------------------------
#
# Overridable so an offline test harness can point both at a fixture instead of GitHub.
RELEASES_LATEST_URL="${GODOT_RELEASES_LATEST_URL:-https://github.com/godotengine/godot/releases/latest}"
RELEASE_BASE="${GODOT_RELEASE_BASE:-https://github.com/godotengine/godot/releases}"

if [ "$VERSION_OPT" = latest ]; then
  # Deliberately not the GitHub API (api.github.com/.../releases/latest) — the redirect needs
  # no auth and does not share GitHub's much lower unauthenticated API rate limit, which every
  # image build on a shared CI runner would otherwise compete for.
  redirect_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASES_LATEST_URL")" \
    || die "could not resolve the latest release from $RELEASES_LATEST_URL"
  TAG="${redirect_url##*/}"
  [ -n "$TAG" ] || die "could not read a release tag from $redirect_url"
else
  # Strip a trailing -stable if present, then append it back — so 4.7.2 and 4.7.2-stable both
  # produce TAG=4.7.2-stable. Only 'stable' releases are ever selected.
  BARE="${VERSION_OPT%-stable}"
  TAG="${BARE}-stable"
fi
BARE="${TAG%-stable}"

# --- 3. map architecture -------------------------------------------------------------------
machine="$(uname -m)"
case "$machine" in
  x86_64 | amd64) ARCH='x86_64' ;;
  arm64 | aarch64) ARCH='arm64' ;;
  *) die "unsupported architecture $machine (supported: x86_64, arm64/aarch64)" ;;
esac

# --- 4. asset name ---------------------------------------------------------------------------
#
# Confirmed against the 4.7.2-stable release: Godot_v${TAG}_linux.${ARCH}.zip, which unzips to
# one flat file at the zip root, named Godot_v${TAG}_linux.${ARCH} (no extension).
ASSET="Godot_v${TAG}_linux.${ARCH}.zip"
UNZIPPED="Godot_v${TAG}_linux.${ARCH}"
URL_DIR="$RELEASE_BASE/download/$TAG"

# --- 5. download + verify --------------------------------------------------------------------

fetch() { # fetch <url> <dest>
  if have curl; then
    curl -fsSL -o "$2" "$1" || die "download failed: $1"
  elif have wget; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die 'need curl or wget to download the release asset'
  fi
}

sha512_of() { # sha512_of <file>
  if have sha512sum; then
    sha512sum "$1" | cut -d' ' -f1
  elif have shasum; then
    shasum -a 512 "$1" | cut -d' ' -f1
  else
    die 'need sha512sum or shasum to verify the download'
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch "$URL_DIR/SHA512-SUMS.txt" "$TMP/SHA512-SUMS.txt"
fetch "$URL_DIR/$ASSET" "$TMP/$ASSET"

# SHA512-SUMS.txt lists every asset in the release as "<sha512>  <filename>" (confirmed format,
# two-space separator, no `sha512sum -b`-style `*` prefix on the 4.7.2-stable release) — still
# strip a leading `*` defensively, the way devc-bridge/install.sh's checksums.txt parse already
# does, in case a future release changes that. Verify before unzipping: nothing partially
# installed.
expected="$(awk -v n="$ASSET" '
  { name = $2; sub(/^\*/, "", name) }
  name == n { print $1; exit }
' "$TMP/SHA512-SUMS.txt")"
[ -n "$expected" ] || die "SHA512-SUMS.txt has no entry for $ASSET"
actual="$(sha512_of "$TMP/$ASSET")"
[ "$expected" = "$actual" ] || die \
  "checksum mismatch for $ASSET (expected $expected, got $actual) — nothing was installed"

# --- 6. ensure unzip exists ------------------------------------------------------------------
#
# Unlike node-nvmrc's nvm (an optional prerequisite this Feature documents rather than
# installs), unzip is load-bearing for what this Feature *is* — install it rather than warn.
have unzip || {
  apt-get update && apt-get install -y --no-install-recommends unzip
}

mkdir -p "$TMP/extracted"
unzip -q "$TMP/$ASSET" -d "$TMP/extracted" || die "could not unpack $ASSET"
[ -f "$TMP/extracted/$UNZIPPED" ] || die "$ASSET does not contain $UNZIPPED"

# --- 7. install layout ------------------------------------------------------------------------
#
# Mirrors devc-bridge's namespace. /usr/local/share/devc-features/<id>/ is the Feature namespace,
# kept separate from devc's own /usr/local/share/devc/ so "did devc put this here, or a Feature?"
# stays answerable. Overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/godot}"
GODOT_BIN="$SHARE_DIR/bin/godot"
GODOT_LINK="${GODOT_LINK:-/usr/local/bin/godot}"

mkdir -p "$(dirname "$GODOT_BIN")"
# Same-directory rename, so a build step that dies midway leaves no half-written binary.
mv -f "$TMP/extracted/$UNZIPPED" "$GODOT_BIN.tmp.$$"
chmod 0755 "$GODOT_BIN.tmp.$$"
mv -f "$GODOT_BIN.tmp.$$" "$GODOT_BIN"

# Unconditional, so a developer can shadow the install by bind-mounting over
# /usr/local/share/devc-features/godot — the same unconditional symlink pattern as devc-bridge's
# BRIDGE_LINK.
mkdir -p "$(dirname "$GODOT_LINK")"
ln -sfn "$GODOT_BIN" "$GODOT_LINK"

# --- 8. installDependencies -------------------------------------------------------------------
#
# Not a general Godot-runtime-libraries installer — Godot's Linux binary is otherwise statically
# linked (confirmed with ldd: only libc/libm/libpthread/librt/libdl) and dlopens
# X11/Wayland/ALSA/PulseAudio only when not running --headless. fontconfig is the one shown to
# matter for headless import/export, missing from mcr.microsoft.com/devcontainers/base:ubuntu.
if [ "$INSTALL_DEPENDENCIES" = true ]; then
  apt-get update && apt-get install -y --no-install-recommends fontconfig
fi

echo "godot: $TAG ($ARCH) installed at $GODOT_LINK"

# --- 10. the create-time script ----------------------------------------------------------------
#
# The manifest's postCreateCommand takes no arguments, so the options have to cross into
# post-create.sh at build time. They are baked by rewriting its `VAR="${VAR:-default}"` lines,
# which keeps the file in the repo readable and runnable on its own.

bake() { # bake <file> <var> <value>
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: a `&` in a path is a
  # back-reference in a sed replacement and a `|` would end the expression.
  awk -v var="$2" -v line="$2=\"$3\"" '
    index($0, var "=") == 1 { print line; next }
                            { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename or a reformat upstream would otherwise leave the option silently unwired, with the
  # `${VAR:-default}` fallback quietly standing in for whatever the consumer asked for.
  grep -qxF "$2=\"$3\"" "$1" || die "could not bake $2 into $(basename "$1")"
}

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$SHARE_DIR"
cp "$FEATURE_DIR/post-create.sh" "$SHARE_DIR/post-create.sh"
bake "$SHARE_DIR/post-create.sh" PROJECT_DIR "$PROJECT_DIR_OPT"
bake "$SHARE_DIR/post-create.sh" FIX_GODOT_DIR_OWNERSHIP "$FIX_GODOT_DIR_OWNERSHIP"
chmod 0755 "$SHARE_DIR/post-create.sh"

echo "godot: create-time script installed at $SHARE_DIR/post-create.sh"
