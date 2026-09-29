#!/bin/bash
# Bumps @devc-tools/core's version everywhere it lives, in one shot, up to the point where the
# rest is yours: commit, push, preflight on the host, and the npm publish.
#
# Core's version is in four files, not two. `npm version` moves devc-core/package.json and
# package-lock.json, but devc/deno.lock and devc-bridge/host/deno.lock each record it too, under
# `workspace.links` ("npm:@devc-tools/core@<version>") — Deno treats ../devc-core/ as a linked
# npm package because it has a package.json. Bumped with `npm version` alone, both locks went
# stale three times, found only when a later build rewrote them. devc-core/deno.lock does not
# record core itself and is left alone.
#
# It does NOT touch the binaries' versions (that is scripts/bump-version.sh; core publishes on
# its own cadence) or anything under features/.
#
#   bash scripts/bump-core-version.sh 0.5.0
#   bash scripts/bump-core-version.sh 0.5.0-rc.1
#
# Runs on the host or in the devcontainer: nothing here touches node_modules (devc-core has no
# npm lifecycle scripts, and no deno.json sets nodeModulesDir). It edits, verifies and reports a
# diff; it never commits, tags, pushes or publishes.
set -uo pipefail

cd "$(dirname "$0")/.."

case "${1:-}" in
  # Prints the header block above — everything from line 2 until the first non-comment line.
  -h | --help)
    awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"
    exit 0
    ;;
esac

new="${1:-}"
if [ -z "$new" ]; then
  echo "usage: bash scripts/bump-core-version.sh <new-version>" >&2
  echo "        e.g. bash scripts/bump-core-version.sh 0.5.0" >&2
  exit 2
fi

# Loose semver check — X.Y.Z with an optional -prerelease, the same shape bump-version.sh accepts.
case "$new" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "error: '$new' doesn't look like X.Y.Z (or X.Y.Z-suffix)" >&2
    exit 2
    ;;
esac

die() {
  echo "error: $*" >&2
  exit 1
}

# POSIX BRE, portable to BSD sed: see the note on read_json in preflight-core-publish.sh.
read_json() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

current="$(read_json devc-core/package.json)"
[ -n "$current" ] || die "could not read the current version from devc-core/package.json"
if [ "$current" = "$new" ]; then
  echo "devc-core/package.json is already $new — nothing to do." >&2
  exit 1
fi

# Before editing anything: an npm version can never be republished, so a taken one is only worth
# finding out about now. Offline is a warning, not a stop — preflight checks again on the host.
if published="$(npm view @devc-tools/core versions --json 2> /dev/null)" && [ -n "$published" ]; then
  # grep -F: a version is full of dots, and as a regex `0.2.1` would also match `0x2y1`.
  if printf '%s' "$published" | tr -d ' \n' | grep -Fq "\"$new\""; then
    die "@devc-tools/core@$new is already published — npm versions cannot be reused"
  fi
else
  echo "warning: could not reach the npm registry — check $new is unpublished before publishing" >&2
fi

echo "bumping @devc-tools/core $current -> $new"

# npm version, not an editor: package-lock.json carries the version too.
(cd devc-core && npm version "$new" --no-git-tag-version > /dev/null) ||
  die "npm version $new failed in devc-core"

# `--entrypoint main.ts`, not a bare `deno install` (which also adds unrelated entries to
# devc-bridge/host/deno.lock) and not the deprecated `deno cache`: this form rewrites exactly the
# `links` line.
consumers="devc devc-bridge/host"
for d in $consumers; do
  (cd "$d" && deno install -q --frozen=false --entrypoint main.ts) ||
    die "deno install failed in $d"
done

for d in $consumers; do
  if ! grep -Fq "\"npm:@devc-tools/core@$new\"" "$d/deno.lock" ||
    ! (cd "$d" && deno check -q --frozen main.ts > /dev/null 2>&1); then
    die "$d/deno.lock still does not match @devc-tools/core@$new"
  fi
done

echo
echo 'updated:'
git diff --stat -- devc-core/package.json devc-core/package-lock.json devc/deno.lock \
  devc-bridge/host/deno.lock

echo
echo 'Next:'
echo '  1. Review the diff, commit, and push.'
echo '  2. On the host: bash scripts/preflight-core-publish.sh'
echo '  3. Publish (it prints this too): cd devc-core && npm publish --access public'
