#!/bin/bash
# Bumps the release version everywhere it has to move together, in one shot, so cutting a
# release stops being "grep for 0.1.1 and hope you got all four files."
#
# Touches exactly the files release.yml's Version guard and preflight-core-publish.sh's release
# preconditions check: the three binary VERSION consts (devc/help.ts, devc-bridge/host/version.ts,
# devc-bridge/client/version.ts) and devc/deno.json's "version" field. It does NOT touch
# devc-core/package.json or devc-core/deno.json — @devc-tools/core is versioned and published on
# its own schedule (see docs/maintainers/releasing.md) — and it does not touch anything under
# features/, which also move independently.
#
#   bash scripts/bump-version.sh 0.2.0
#   bash scripts/bump-version.sh 0.1.0-rc.1
#
# With no argument it shows the current version and prompts for the new one.
#
# It edits, formats and reports a diff; it does not commit, tag or push.
set -uo pipefail

cd "$(dirname "$0")/.."

# release.yml's first gate is `deno fmt --check` over the whole tree, and preflight-core-publish.sh
# repeats it — both after the bump is committed and likely pushed. Catch it here, before anything
# is edited, so the formatting fix lands ahead of the version bump.
if ! command -v deno > /dev/null 2>&1; then
  echo "error: deno is not on PATH — it is needed for the deno fmt --check release.yml runs" >&2
  exit 1
fi
if ! deno fmt --check > /dev/null 2>&1; then
  echo "error: deno fmt --check fails — run deno fmt, commit the result, then bump" >&2
  NO_COLOR=1 deno fmt --check 2>&1 | grep -E '^from ' >&2
  exit 1
fi

read_const() { sed -n "s/^export const VERSION = '\(.*\)';\$/\1/p" "$1" | head -1; }
read_json() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

current="$(read_const devc/help.ts)"
if [ -z "$current" ]; then
  echo "error: could not read the current VERSION from devc/help.ts" >&2
  exit 1
fi

new="${1:-}"
if [ -z "$new" ]; then
  if [ ! -t 0 ]; then
    echo "usage: bash scripts/bump-version.sh <new-version>" >&2
    echo "        e.g. bash scripts/bump-version.sh 0.2.0" >&2
    exit 2
  fi
  read -r -p "current version is $current; new version: " new
  if [ -z "$new" ]; then
    echo "error: no version given" >&2
    exit 2
  fi
fi

# Loose semver check — X.Y.Z with an optional -prerelease, same shape release.yml accepts.
case "$new" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "error: '$new' doesn't look like X.Y.Z (or X.Y.Z-suffix)" >&2
    exit 2
    ;;
esac

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

deno fmt devc/help.ts devc-bridge/host/version.ts devc-bridge/client/version.ts devc/deno.json \
  > /dev/null 2>&1 || true

echo
echo 'updated:'
git diff --stat -- devc/help.ts devc-bridge/host/version.ts devc-bridge/client/version.ts \
  devc/deno.json
# @devc-tools/core is reported, never bumped — it publishes on its own cadence, and a binary
# release never needs it (devc compiles devc-core from source). Only mention it when devc-core/
# actually changed since the last release tag, ignoring its own version files: otherwise every
# release would "suggest" a lockstep core bump that publishes nothing new.
core_v="$(read_json devc-core/package.json)"
last_tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2> /dev/null || true)"
core_changed=0
if [ -n "$last_tag" ] && ! git diff --quiet "$last_tag" HEAD -- devc-core \
  ':!devc-core/package.json' ':!devc-core/package-lock.json'; then
  core_changed=1
fi

echo
if [ "$core_changed" -eq 1 ]; then
  echo "devc-core/ changed since $last_tag (core is at $core_v). Only if you also want to"
  echo "publish @devc-tools/core this release:"
  echo "    bash scripts/bump-core-version.sh <x.y.z>"
  echo "Otherwise leave it — the binaries do not need it."
else
  echo "@devc-tools/core: unchanged since ${last_tag:-the last release} — leave it at $core_v."
fi

echo
echo 'Next (docs/maintainers/releasing.md):'
echo '  1. Review the diff, commit, push.'
echo '  2. On the host: bash scripts/preflight-core-publish.sh'
echo "  3. git tag v$new && git push origin v$new"
