#!/bin/bash
# Vendors Mermaid for `devc web`'s rendered Markdown (`rendered-view.js`): the package's own
# prebuilt, minified ES module build, unmodified, into devc/web/static/vendor/mermaid/. The entry
# (mermaid.esm.min.mjs) loads its diagram chunks with relative dynamic imports, so the page loads
# it only when a document has a diagram, and then only that diagram type's chunks. No source maps.
# Bump the version here and in VERSIONS, then run this:
#
#   bash scripts/vendor-mermaid.sh
#
# The bundle imports nothing outside itself and uses no eval, so it runs under the page's CSP.
set -euo pipefail

version=12.3.0

cd "$(dirname "$0")/.."
dest=devc/web/static/vendor/mermaid
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

(cd "$tmp" && npm pack --silent "mermaid@$version" >/dev/null && tar -xzf "mermaid-$version.tgz")
dist="$tmp/package/dist"

rm -rf "$dest"
mkdir -p "$dest/chunks/mermaid.esm.min"
cp "$dist/mermaid.esm.min.mjs" "$dest/"
cp "$dist"/chunks/mermaid.esm.min/*.mjs "$dest/chunks/mermaid.esm.min/"
cp "$tmp/package/LICENSE" "$dest/LICENSE"
# The build's trailing source map comments name files not vendored.
find "$dest" -name '*.mjs' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} +
echo "mermaid $version (dist/mermaid.esm.min.mjs and its chunks, unmodified but for source map comments)" \
  >"$dest/VERSIONS"

echo "Vendored mermaid $version into $dest"
