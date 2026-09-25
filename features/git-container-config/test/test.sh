#!/bin/bash
# `devcontainer features test` default scenario — runs INSIDE a container built from this
# Feature with **no options** (`"git-container-config": {}`) and no git-lfs Feature enabled.
#
# That combination is the bare-`{}` case every Feature in this collection has to survive (see
# .plans/design/devc-feature-split.md), and it is also the hostile one for this Feature: no
# identity file is mounted in and git-lfs is not on PATH, so both of this Feature's warning
# paths fire and neither may fail create. The three container-scope settings still have to land,
# and land for the REMOTE USER, not root.
#
# test/scenarios.json covers the other two cases: git-lfs actually present, and an identity
# file actually in place.
set -e

source dev-container-features-test-lib

SHARE=/usr/local/share/devc-features/git-container-config

check "create-time script is installed" test -f "$SHARE/post-create.sh"
check "and is executable" test -x "$SHARE/post-create.sh"
check "and is owned by root" bash -c \
  "[ \"\$(stat -c '%U:%G' $SHARE/post-create.sh)\" = 'root:root' ]"

# The options cross into the create-time script at build time — the manifest's
# postCreateCommand takes no arguments — so "did the bake happen" is a real property, not an
# implementation detail. These are the defaults, since this scenario passes no options.
#
# The identity path is no longer baked from an option; this pair replaces the guarantee
# bake()'s own -qxF used to give it — nothing else catches a rename that silently un-wires it.
check "the hook names the same identity path install.sh creates" \
  grep -qxF 'IDENTITY_INCLUDE_PATH=/usr/local/share/devc-features/git-container-config/identity/gitconfig' \
  "$SHARE/post-create.sh"
check "the identity mount point was created, empty" test -d "$SHARE/identity"
check "lfsFilters baked true" \
  grep -qx 'LFS_FILTERS="true"' "$SHARE/post-create.sh"
check "lfsSkipSmudge baked true" \
  grep -qx 'LFS_SKIP_SMUDGE="true"' "$SHARE/post-create.sh"
check "worktreeRelativePaths baked true" \
  grep -qx 'WORKTREE_RELATIVE_PATHS="true"' "$SHARE/post-create.sh"
check "safeDirectory baked to the wildcard default" \
  grep -qxF 'SAFE_DIRECTORY="*"' "$SHARE/post-create.sh"

# --- the settings landed in the REMOTE USER's ~/.gitconfig, not /root/'s -------------------
#
# The hook already ran once for real (this image declares the postCreateCommand). This test
# script runs as the same remote user the hook ran as, so $HOME here is that user's home, and
# checking it is exactly checking "not /root".
check "HOME is not root's" bash -c "[ \"\$HOME\" != /root ]"
check "worktree.useRelativePaths is set for the remote user" bash -c \
  "[ \"\$(git config --global --get worktree.useRelativePaths)\" = true ]"
check "safe.directory is the wildcard default" bash -c \
  "[ \"\$(git config --global --get safe.directory)\" = '*' ]"
check "no include.path is set — nothing was mounted at the fixed identity path" bash -c \
  "[ -z \"\$(git config --global --get include.path || true)\" ]"

# --- no git-lfs on PATH in this scenario: warns, does not fail create ----------------------
check "git-lfs is not on PATH here" bash -c "! command -v git-lfs > /dev/null 2>&1"
check "no LFS filter was set" bash -c \
  "[ -z \"\$(git config --global --get filter.lfs.clean || true)\" ]"

# --- a manual re-run: the two warnings, and idempotence -------------------------------------
#
# Re-applying the same settings is safe (git config assignments are idempotent), so running the
# hook again by hand is how the warning paths and second-run idempotence are observed without a
# second `devcontainer up`.
before_safe="$(git config --global --get-all safe.directory | wc -l)"
err="$(bash "$SHARE/post-create.sh" 2>&1 > /dev/null)"
status=$?
check "a second run exits 0" test "$status" -eq 0
check "it warns about the missing git identity" bash -c \
  "printf '%s' \"\$1\" | grep -q 'no git identity found'" _ "$err"
check "it warns that git-lfs is not on PATH" bash -c \
  "printf '%s' \"\$1\" | grep -q 'git-lfs not on PATH'" _ "$err"
after_safe="$(git config --global --get-all safe.directory | wc -l)"
check "safe.directory did not accumulate a duplicate" test "$before_safe" -eq "$after_safe"
check "still exactly one safe.directory value" test "$after_safe" -eq 1

reportResults
