#!/bin/bash
# Bumps the release version everywhere it has to move together, in one shot, so cutting a
# release stops being "grep for 0.1.1 and hope you got all four files."
#
# Touches exactly the files release.yml's Version guard and preflight-core-publish.sh's release
# preconditions check: the three binary VERSION consts (devc/help.ts, devc-bridge/host/version.ts,
# devc-bridge/client/version.ts) and devc/deno.json's "version" field. It does NOT touch
# devc-core/package.json or devc-core/deno.json — @devc-tools/core is versioned and published on
# its own schedule (see README.md's Releasing section) — and it does not touch anything under
# features/, which also move independently.
#
#   bash scripts/bump-version.sh 0.2.0
#   bash scripts/bump-version.sh 0.1.0-rc.1
#
# It edits, formats and reports a diff; it does not commit, tag or push.
set -uo pipefail

cd "$(dirname "$0")/.."

new="${1:-}"
if [ -z "$new" ]; then
  echo "usage: bash scripts/bump-version.sh <new-version>" >&2
  echo "        e.g. bash scripts/bump-version.sh 0.2.0" >&2
  exit 2
fi

# Loose semver check — X.Y.Z with an optional -prerelease, same shape release.yml accepts.
case "$new" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "error: '$new' doesn't look like X.Y.Z (or X.Y.Z-suffix)" >&2
    exit 2
    ;;
esac

read_const() { sed -n "s/^export const VERSION = '\(.*\)';\$/\1/p" "$1" | head -1; }
read_json() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

current="$(read_const devc/help.ts)"
if [ -z "$current" ]; then
  echo "error: could not read the current VERSION from devc/help.ts" >&2
  exit 1
fi

if [ "$current" = "$new" ]; then
  echo "devc/help.ts is already $new — nothing to do." >&2
  exit 1
fi

echo "bumping $current -> $new"

files_const="devc/help.ts devc-bridge/host/version.ts devc-bridge/client/version.ts"
for f in $files_const; do
  before="$(read_const "$f")"
  if [ "$before" != "$current" ]; then
    echo "error: $f is at '$before', expected '$current' — versions already disagree, fix that first" >&2
    exit 1
  fi
  # POSIX BRE, portable to BSD sed too (this script has no host/container restriction of its
  # own, but there's no reason to require GNU sed when the substitution doesn't need it).
  sed -i.bak "s/^export const VERSION = '$current';\$/export const VERSION = '$new';/" "$f"
  rm -f "$f.bak"
done

before_json="$(read_json devc/deno.json)"
if [ "$before_json" != "$current" ]; then
  echo "error: devc/deno.json is at '$before_json', expected '$current' — fix that first" >&2
  exit 1
fi
sed -i.bak "s/\"version\": \"$current\"/\"version\": \"$new\"/" devc/deno.json
rm -f devc/deno.json.bak

if command -v deno > /dev/null 2>&1; then
  deno fmt devc/help.ts devc-bridge/host/version.ts devc-bridge/client/version.ts devc/deno.json \
    > /dev/null 2>&1 || true
fi

echo
echo 'updated:'
git diff --stat -- devc/help.ts devc-bridge/host/version.ts devc-bridge/client/version.ts \
  devc/deno.json
echo
echo "Next: review the diff, commit, then run scripts/preflight-core-publish.sh on the host"
echo "before tagging (see README.md's Releasing section)."
