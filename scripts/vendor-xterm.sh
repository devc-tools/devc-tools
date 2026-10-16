#!/bin/bash
# Re-fetches the xterm.js files `devc web` serves, unmodified, into devc/web/static/vendor/xterm/.
# This is the only way those files change: bump the two pins below and run it.
#
#   bash scripts/vendor-xterm.sh
#
# `npm pack` downloads the published tarballs without installing anything. The page imports
# `xterm.mjs` and `addon-fit.mjs` as plain ES modules, so no build step follows. Their trailing
# `sourceMappingURL` comments are left alone (the maps are not vendored; only devtools asks).
set -euo pipefail

XTERM_VERSION=6.0.0
ADDON_FIT_VERSION=0.11.0

cd "$(dirname "$0")/.."
dest=devc/web/static/vendor/xterm
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack --silent "@xterm/xterm@$XTERM_VERSION" "@xterm/addon-fit@$ADDON_FIT_VERSION" >/dev/null)
mkdir -p "$work/xterm" "$work/fit"
tar -xzf "$work/xterm-xterm-$XTERM_VERSION.tgz" -C "$work/xterm"
tar -xzf "$work/xterm-addon-fit-$ADDON_FIT_VERSION.tgz" -C "$work/fit"

rm -rf "$dest"
mkdir -p "$dest"
cp "$work/xterm/package/lib/xterm.mjs" "$dest/xterm.mjs"
cp "$work/xterm/package/css/xterm.css" "$dest/xterm.css"
cp "$work/fit/package/lib/addon-fit.mjs" "$dest/addon-fit.mjs"
# Both packages are MIT with different copyright lines; one LICENSE carries both texts.
{
  echo "@xterm/xterm $XTERM_VERSION"
  echo
  cat "$work/xterm/package/LICENSE"
  echo
  echo "@xterm/addon-fit $ADDON_FIT_VERSION"
  echo
  cat "$work/fit/package/LICENSE"
} >"$dest/LICENSE"
cat >"$dest/VERSIONS" <<VERSIONS
@xterm/xterm $XTERM_VERSION
@xterm/addon-fit $ADDON_FIT_VERSION
VERSIONS

echo "Vendored @xterm/xterm $XTERM_VERSION and @xterm/addon-fit $ADDON_FIT_VERSION into $dest"
