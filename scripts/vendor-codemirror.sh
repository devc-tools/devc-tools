#!/bin/bash
# Rebuilds CodeMirror 6 for `devc web`'s file viewer: devc/web/static/vendor/codemirror/codemirror.mjs,
# one ES module bundled from scripts/codemirror-entry.js. That file holds the exact package pins
# (npm: specifiers); bump them there and in VERSIONS, then run this. It stays out of web/static/,
# whose every .js `deno compile --include` would follow into the devc binary, npm imports and all.
#
#   bash scripts/vendor-codemirror.sh
#
# Everything is bundled up front (no dynamic imports): the page has no build step. LICENSE is
# CodeMirror's MIT text, which covers every bundled package (all by the same author, all MIT).
set -euo pipefail

cd "$(dirname "$0")/.."
dest=devc/web/static/vendor/codemirror
# Run from scripts/ with a relative entry point, so nothing in the bundle names this checkout's
# path. --no-config/--no-lock: the npm packages stay out of deno.json and deno.lock.
(cd scripts && deno bundle --quiet --no-config --no-lock --platform browser --format esm \
  -o "../$dest/codemirror.mjs" codemirror-entry.js)
# The per-module comments name each source in the local deno cache; keep only the package path.
sed -i 's#^// .*/registry\.npmjs\.org/#// npm:#' "$dest/codemirror.mjs"

echo "Bundled CodeMirror into $dest/codemirror.mjs"
