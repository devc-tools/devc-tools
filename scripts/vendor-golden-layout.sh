#!/bin/bash
# Re-fetches Golden Layout for `devc web` into devc/web/static/vendor/golden-layout/. This is the
# only way those files change: bump the pin below and run it.
#
#   bash scripts/vendor-golden-layout.sh
#
# The published `dist/esm/` is 33 modules with extensionless relative imports, which a browser
# cannot load without a bundler, so `golden-layout.mjs` is a `deno bundle` of `dist/esm/index.js`.
# The CSS, icons and LICENSE are copied unmodified; the dark theme's `../../img/` URLs resolve
# because `img/` sits beside `css/` as it does in the package.
set -euo pipefail

GOLDEN_LAYOUT_VERSION=2.6.0

cd "$(dirname "$0")/.."
dest=devc/web/static/vendor/golden-layout
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack --silent "golden-layout@$GOLDEN_LAYOUT_VERSION" >/dev/null)
tar -xzf "$work/golden-layout-$GOLDEN_LAYOUT_VERSION.tgz" -C "$work"
pkg="$work/package"

rm -rf "$dest"
mkdir -p "$dest/css/themes" "$dest/img"
# Run from inside $work with a relative entry point: the bundle's per-module comments name each
# source path relative to the cwd, and the temp dir's random name would make every run differ.
out="$PWD/$dest/golden-layout.mjs"
(cd "$work" && deno bundle --quiet --platform browser --format esm -o "$out" package/dist/esm/index.js)
cp "$pkg/dist/css/goldenlayout-base.css" "$dest/css/"
cp "$pkg/dist/css/themes/goldenlayout-dark-theme.css" "$dest/css/themes/"
cp "$pkg"/dist/img/*.png "$dest/img/"
cp "$pkg/LICENSE" "$dest/LICENSE"
cat >"$dest/VERSIONS" <<VERSIONS
golden-layout $GOLDEN_LAYOUT_VERSION
golden-layout.mjs is a \`deno bundle --platform browser --format esm\` of dist/esm/index.js
VERSIONS

echo "Vendored golden-layout $GOLDEN_LAYOUT_VERSION into $dest"
