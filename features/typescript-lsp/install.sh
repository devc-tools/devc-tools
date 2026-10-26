#!/bin/sh
# typescript-lsp Feature install — a private, pinned Node, vtsls from a committed lockfile, and
# the `devc-lsp-typescript` launcher with the options baked in.
#
# Runs as root at image *build* time. Nothing here touches the image's own Node (if any) or the
# workspace: the Node is private to this Feature, and the launcher only ever reads node_modules.
set -e

LC_ALL=C
export LC_ALL

die() {
  echo "typescript-lsp: $*" >&2
  exit 1
}

# Options reach install.sh uppercased with non-word characters stripped (the CLI's getSafeId).
SERVER_OPT="${SERVER:-auto}"
# `${SETTINGS:-{}}` would end at the first `}`, so the default is applied separately.
SETTINGS_OPT="${SETTINGS-}"
[ -n "$SETTINGS_OPT" ] || SETTINGS_OPT='{}'

# /usr/local/share/devc-features/<id>/ is the Feature namespace, kept separate from devc's own
# /usr/local/share/devc/. Both overridable for the test harness.
SHARE_DIR="${SHARE_DIR:-/usr/local/share/devc-features/typescript-lsp}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"
NODE_DIR="$SHARE_DIR/node"
VTSLS_DIR="$SHARE_DIR/vtsls"

# Pins, from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt — baked here, never fetched, so a
# tampered mirror can't vouch for its own tarball.
NODE_VERSION='24.22.1'
NODE_SHA256_X64='eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c'
NODE_SHA256_ARM64='33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'

FEATURE_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- 1. the options that need no Node to check -----------------------------------------------
#
# `settings` is checked as JSON once the private Node is in place (step 4), still before
# anything lands in BIN_DIR.
case "$SERVER_OPT" in
  auto | deno | workspace-typescript | vtsls) ;;
  *) die "server must be one of auto, deno, workspace-typescript, vtsls: $SERVER_OPT" ;;
esac

# --- 2. fetch tools -----------------------------------------------------------------------------

if ! command -v curl > /dev/null 2>&1; then
  command -v apt-get > /dev/null 2>&1 || die "curl is required"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends curl ca-certificates
fi
for _tool in tar gzip sha256sum; do
  command -v "$_tool" > /dev/null 2>&1 || die "$_tool is required"
done

# --- 3. private Node ------------------------------------------------------------------------------

case "$(uname -m)" in
  x86_64)
    NODE_ARCH=x64
    NODE_SHA256="$NODE_SHA256_X64"
    ;;
  aarch64 | arm64)
    NODE_ARCH=arm64
    NODE_SHA256="$NODE_SHA256_ARM64"
    ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
NODE_TGZ="$TMP/node.tar.gz"
curl -fsSL -o "$NODE_TGZ" \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.gz" ||
  die "could not download Node $NODE_VERSION"
_got="$(sha256sum "$NODE_TGZ" | cut -d' ' -f1)"
[ "$_got" = "$NODE_SHA256" ] || die "node checksum mismatch"

rm -rf "$NODE_DIR"
mkdir -p "$NODE_DIR"
tar -xzf "$NODE_TGZ" -C "$NODE_DIR" --strip-components=1
# C headers, for building native addons: nothing here builds any. About 70 MB.
rm -rf "$NODE_DIR/include"
NODE="$NODE_DIR/bin/node"

# --- 4. settings must be a JSON object ----------------------------------------------------------

printf '%s' "$SETTINGS_OPT" | "$NODE" -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    let v;
    try { v = JSON.parse(s); } catch { process.exit(1); }
    process.exit(typeof v === "object" && v !== null && !Array.isArray(v) ? 0 : 1);
  });
' || die "settings must be a JSON object: $SETTINGS_OPT"

# --- 5. vtsls, fully locked ---------------------------------------------------------------------
#
# npm ci from the committed lockfile, so vtsls's transitive dependencies can't drift between
# builds. To bump vtsls, change vtsls/package.json and regenerate the lock (README).

rm -rf "$VTSLS_DIR"
mkdir -p "$VTSLS_DIR"
cp "$FEATURE_DIR/vtsls/package.json" "$FEATURE_DIR/vtsls/package-lock.json" "$VTSLS_DIR/"
PATH="$NODE_DIR/bin:$PATH" npm ci --prefix "$VTSLS_DIR" --omit=dev --no-audit --no-fund

# --- 6. the launcher ------------------------------------------------------------------------------

# bake_js <file> <name> <value> — rewrites the line starting `const <name> =` to
# `const <name> = '<base64 of value>';`. base64 -w0: GNU base64 wraps at 76 characters
# otherwise, and a long value would break the one-line bake.
bake_js() {
  _b64="$(printf '%s' "$3" | base64 -w0)"
  _line="const $2 = '$_b64';"
  _bake_tmp="$1.bake.$$"
  # awk with the replacement passed as a -v value, rather than sed: base64's `/` and `+` would
  # need escaping in a sed expression.
  awk -v prefix="const $2 =" -v line="$_line" '
    index($0, prefix) == 1 { print line; next }
                           { print }
  ' "$1" > "$_bake_tmp"
  mv -f "$_bake_tmp" "$1"
  # A rename upstream would otherwise leave the option silently unwired.
  grep -qxF "$_line" "$1" || die "could not bake $2"
}

mkdir -p "$BIN_DIR"
LAUNCHER_TMP="$TMP/devc-lsp-typescript"
cp "$FEATURE_DIR/devc-lsp-typescript" "$LAUNCHER_TMP"
bake_js "$LAUNCHER_TMP" BAKED_SERVER "$SERVER_OPT"
bake_js "$LAUNCHER_TMP" BAKED_SETTINGS "$SETTINGS_OPT"
install -m 0755 "$LAUNCHER_TMP" "$BIN_DIR/devc-lsp-typescript"

# The launcher runs as the remote user.
chmod -R a+rX "$SHARE_DIR"

echo "typescript-lsp: Node $NODE_VERSION ($NODE_ARCH) and vtsls installed in $SHARE_DIR"
echo "typescript-lsp: devc-lsp-typescript installed at $BIN_DIR/devc-lsp-typescript (server=$SERVER_OPT)"
