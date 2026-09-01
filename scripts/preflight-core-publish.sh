#!/bin/bash
# Everything that has to be true before cutting a release — and nothing that cannot be undone.
# It checks the release preconditions `release.yml` would refuse a tag over, runs the repo's
# guards, then builds and smoke-tests the real @devc-tools/core tarball, and finishes by
# printing the two commands left to run: the tag, then the npm publish.
#
# It never tags, never pushes and never publishes.
#
#   bash scripts/preflight-core-publish.sh
#
# Options:
#   --skip-install   reuse the existing devc-core/node_modules instead of running `npm ci`
#   --allow-container  run even inside the devcontainer (see below — you almost certainly
#                      do not want this)
#
# **Run this on the host, not in the devcontainer.** devc-core/node_modules is bind-mounted
# from the host, so it holds the host's platform-specific esbuild binary: running the build
# in a Linux container against a macOS install fails with "You installed esbuild for another
# platform", and `npm ci` in here would swap in linux-x64 binaries and break the host's own
# builds. The container guard below is the whole reason this check is worth scripting.
#
# What it does NOT cover: `git tag` / `git push`. Those are the release's irreversible,
# outward-facing half and stay a deliberate manual step (see README.md's Releasing section).
# This script only reports whether the versions a tag would have to match are consistent.
set -uo pipefail

cd "$(dirname "$0")/.."

skip_install=0
allow_container=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-install) skip_install=1; shift ;;
    --allow-container) allow_container=1; shift ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@" > /dev/null 2>&1; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}
die() { echo; echo "preflight: $*" >&2; exit 1; }

# --- 0. where are we running ---------------------------------------------------------------

echo 'environment'
if [ -f /.dockerenv ] && [ "$allow_container" -eq 0 ]; then
  echo '  FAIL running on the host (this is a container)'
  echo
  echo 'preflight: this looks like the devcontainer, and devc-core/node_modules is the' >&2
  echo 'preflight: host'"'"'s (platform-specific esbuild). Run this on the host instead.' >&2
  echo 'preflight: --allow-container overrides, if you know the install matches.' >&2
  exit 1
fi
if [ -f /.dockerenv ]; then
  echo '  ok   running in a container (--allow-container)'
else
  echo '  ok   running on the host'
fi

# --- 1. release preconditions ----------------------------------------------------------------
#
# The cheap checks, run first and hard-stopping on their own, so a version typo is reported in
# under a second rather than after the test suites and a full npm build. These are exactly the
# things `release.yml` will refuse a tag over, checked here while they are still free to fix.
#
# A publish that does not correspond to a pushed commit is the hardest thing to unpick later, so
# a dirty or unpushed tree is a hard stop rather than a warning.

echo
echo 'release preconditions'

tree_clean() { [ -z "$(git status --porcelain)" ]; }
check 'working tree is clean' tree_clean

# Best-effort: offline is not a reason to fail, but a stale origin/main would make the sync
# check below meaningless, so say which one this is.
if git fetch --quiet --tags 2> /dev/null; then
  echo '  ok   fetched origin'
else
  echo '  --   could not fetch origin (offline?) — the sync check below uses stale refs'
fi

in_sync() {
  local local_head upstream_head
  local_head="$(git rev-parse HEAD 2> /dev/null)"
  upstream_head="$(git rev-parse '@{upstream}' 2> /dev/null)" || return 1
  [ -n "$local_head" ] && [ "$local_head" = "$upstream_head" ]
}
check 'HEAD is level with its upstream (nothing unpushed)' in_sync

read_const() { sed -n "s/^export const VERSION = '\(.*\)';$/\1/p" "$1" | head -1; }
read_json() { sed -n '0,/"version"/s/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }

devc_v="$(read_const devc/help.ts)"
host_v="$(read_const devc-bridge/host/version.ts)"
client_v="$(read_const devc-bridge/client/version.ts)"
devc_json_v="$(read_json devc/deno.json)"
core_pkg_v="$(read_json devc-core/package.json)"
core_deno_v="$(read_json devc-core/deno.json)"

echo "       binaries    devc=$devc_v host=$host_v client=$client_v (devc/deno.json=$devc_json_v)"
echo "       devc-core   package.json=$core_pkg_v deno.json=$core_deno_v"

nonempty() { [ -n "$1" ]; }
binaries_agree() { [ "$devc_v" = "$host_v" ] && [ "$devc_v" = "$client_v" ]; }
devc_json_agrees() { [ -n "$devc_json_v" ] && [ "$devc_json_v" = "$devc_v" ]; }
core_agrees() { [ -n "$core_pkg_v" ] && [ "$core_pkg_v" = "$core_deno_v" ]; }
check 'every version string was readable' nonempty "$devc_v$host_v$client_v$core_pkg_v"
check 'the three binary VERSION consts agree (release.yml requires this of a tag)' binaries_agree
check 'devc/deno.json matches devc/help.ts' devc_json_agrees
check 'devc-core package.json and deno.json agree' core_agrees

if [ "$fails" -ne 0 ]; then
  die "$fails preconditions failed — fix these before anything else."
fi

# Informational, not a check: an existing tag is not an error, it just means step 1 of the
# closing instructions is already done.
TAG="v$devc_v"
tag_exists=0
if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null 2>&1; then
  tag_exists=1
  echo "  --   tag $TAG already exists locally"
fi

# --- 2. the repo's own guards -----------------------------------------------------------------
#
# workflow_guards_test.sh is the one that matters most here: it asserts devc-core/overlay.ts's
# DEVC_CONFIG_FEATURE pin still matches the devc-config Feature's own manifest version, which a
# Feature bump silently breaks.

echo
echo 'repository guards'
check 'tests/workflow_guards_test.sh' bash tests/workflow_guards_test.sh
check 'tests/features_test.sh' bash tests/features_test.sh

if [ "$fails" -ne 0 ]; then
  die "$fails check(s) failed — nothing was built."
fi

# --- 2. build and smoke-test the real tarball ------------------------------------------------
#
# Fail-fast from here: each step is expensive and depends on the one before it, so there is
# nothing to gain from carrying on to collect more failures.

cd devc-core

if [ "$skip_install" -eq 0 ]; then
  echo
  echo 'npm ci'
  npm ci || die 'npm ci failed'
else
  echo
  echo 'npm ci (skipped: --skip-install)'
fi

echo
echo 'npm run check'
npm run check || die 'tsc --noEmit failed'

echo
echo 'npm run portability-check'
# Catches a `Deno.` or `jsr:` reference that keeps every `deno test` green and only breaks the
# npm build.
npm run portability-check || die 'a Deno-only reference reached a module that ships to npm'

echo
echo 'npm run smoke'
# Runs `npm run build` itself, then packs the tarball and drives it from a scratch project with
# plain node — no Deno, no devcontainer CLI, no devc on PATH.
npm run smoke || die 'the packed tarball failed its scratch-project smoke run'

# --- 3. what actually ends up in the tarball -------------------------------------------------
#
# package.json's `files` is ["dist"], and there is no prepublishOnly hook — so `dist/` existing
# and holding the templates is the difference between a real publish and an empty one. The
# bundled default/ tree is what a `devc init` scaffolds from, so it is checked by content.

echo
echo 'tarball contents'
check 'dist/mod.js was built' test -f dist/mod.js
check 'dist/mod.d.ts was built' test -f dist/mod.d.ts
check 'dist/default/ was copied beside the bundle' test -d dist/default
check 'dist/default/ matches devc-core/default/' diff -r default dist/default

if [ "$fails" -ne 0 ]; then
  die "$fails check(s) failed after the build — do not publish."
fi

# --- 4. the steps left -------------------------------------------------------------------------
#
# Tag before npm publish, and the order is deliberate: the two are independent (devc imports
# devc-core from source — see devc/deno.json's "@devc-tools/core/" mapping — so building the
# binaries never needs the npm package), which leaves only the question of which step is
# recoverable. A tag and its release can be deleted and re-cut; an npm version cannot be
# republished at all. So the reversible half goes first, and npm is not spent until the release
# it corresponds to actually built.

cd ..

echo
echo '────────────────────────────────────────────────────────────────────────'
echo "  All preflight checks passed."
echo
echo '  This script tagged, pushed and published nothing. Remaining steps:'
echo
if [ "$tag_exists" -eq 1 ]; then
  echo "  1. Tag the release — ALREADY DONE, $TAG exists locally."
  echo "     If it is not on the remote yet:  git push origin $TAG"
else
  echo "  1. Tag the release (devc $devc_v):"
  echo
  echo "         git tag $TAG"
  echo "         git push origin $TAG"
  echo
  echo '     Wait for release.yml to go green before step 2 — a failed matrix'
  echo '     can be re-cut from a deleted tag, but an npm version cannot.'
fi
echo
echo "  2. Publish the library (@devc-tools/core@$core_pkg_v):"
echo
echo '         cd devc-core && npm publish --access public'
echo
echo '     --access public is required because the package is scoped; npm'
echo '     defaults a scoped package to restricted. Harmless if already public.'
echo '────────────────────────────────────────────────────────────────────────'
