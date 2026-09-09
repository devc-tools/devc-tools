#!/bin/bash
# git-container-config offline harness — the hook's five steps, run against a temp HOME with
# GIT_CONFIG_GLOBAL pointed into it. No container, no root, no network: everything this Feature
# writes goes through `git config --global`, and GIT_CONFIG_GLOBAL (git >= 2.32) redirects that
# to one file per case that nothing else in this environment reads, with GIT_CONFIG_NOSYSTEM=1
# and an isolated HOME so a real /etc/gitconfig or ~/.gitconfig on the machine running this
# cannot leak in either direction.
#
#   bash features/git-container-config/test/git_config_test.sh
#
# The real install.sh installs the real post-create.sh into a temp SHARE_DIR with each case's
# options baked in, and the real installed hook is run — this cannot drift from what a container
# actually gets, the same shape node-nvmrc's and bash-config's offline harnesses use.
#
# The identity path is no longer an option: it is a fixed literal
# (/usr/local/share/devc-features/.../identity/gitconfig) install.sh copies through unbaked.
# setup() below rewrites that one line to point at this case's own temp SHARE/identity/gitconfig
# instead — created empty by the same install.sh run — the same technique devc's
# seed_link_test.sh uses to re-point SEED.
set -uo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A PATH naming only the real `git` binary, deliberately excluding whatever else shares its
# directory — this devcontainer has a real git-lfs installed right beside git, so a naive
# `$PATH` would make every "git-lfs absent" case false: the hook would find the real binary and
# actually run it. A symlink-only directory is what makes "absent from PATH" true regardless of
# what is installed on the machine running this harness.
GIT_REAL="$(command -v git)" || { echo "git-container-config: no git on PATH" >&2; exit 1; }
GIT_ONLY_BIN="$WORK/gitonly"
mkdir -p "$GIT_ONLY_BIN"
ln -s "$GIT_REAL" "$GIT_ONLY_BIN/git"

fails=0
check() { # check <desc> <condition-as-args...>
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc"; fails=$((fails + 1)); fi
}

# --- a git-lfs stub, put on PATH only by the cases that want one ----------------------------
#
# Just enough of `git lfs install [--skip-smudge]` to be observable through `git config`
# afterwards, without touching any real LFS state — it writes the same filter.lfs.* keys the
# real binary does and logs its own arguments.
BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/git-lfs" << 'GITLFS'
#!/bin/sh
echo "$*" >> "$GIT_LFS_LOG"
case " $* " in
  *' --skip-smudge '*)
    git config --global filter.lfs.smudge 'git-lfs smudge --skip -- %f'
    git config --global filter.lfs.process 'git-lfs filter-process --skip'
    ;;
  *)
    git config --global filter.lfs.smudge 'git-lfs smudge -- %f'
    git config --global filter.lfs.process 'git-lfs filter-process'
    ;;
esac
git config --global filter.lfs.clean 'git-lfs clean -- %f'
git config --global filter.lfs.required true
GITLFS
chmod +x "$BIN/git-lfs"

# --- harness -----------------------------------------------------------------------------

# setup <name> [VAR=value ...] — the real install.sh into a temp SHARE_DIR with this case's
# options baked in.
setup() {
  local name="$1"; shift
  SHARE="$WORK/$name/share"; H="$WORK/$name/home"; GITLFSLOG="$WORK/$name/lfs.log"
  rm -rf "${WORK:?}/$name"
  mkdir -p "$H"
  : > "$GITLFSLOG"
  env -u LFSFILTERS -u LFSSKIPSMUDGE -u WORKTREERELATIVEPATHS \
    -u SAFEDIRECTORY SHARE_DIR="$SHARE" "$@" \
    sh "$FEATURE_DIR/install.sh" > "$WORK/install.log" 2>&1
  # IDENTITY_INCLUDE_PATH is a fixed literal in the installed hook, not baked from an option —
  # re-point it at this case's own SHARE/identity/gitconfig (install.sh already created the
  # directory empty) so a case can place a file there without touching the real filesystem path.
  HOOK="$WORK/$name/hook.sh"
  IDENTITY="$SHARE/identity/gitconfig"
  sed -e "s#^IDENTITY_INCLUDE_PATH=.*#IDENTITY_INCLUDE_PATH=$IDENTITY#" \
    "$SHARE/post-create.sh" > "$HOOK"
  GC="$H/gitconfig"
}

# run_hook [WITH_LFS] [ENV=val ...] — the hook as the CLI runs it, as the remote user, with
# GIT_CONFIG_GLOBAL isolating every read and write to this case's own file. Pass WITH_LFS first
# to put the stub on PATH; omit it for the "git-lfs absent" cases. Runs with $H as its cwd,
# deliberately not this repo's own checkout — this file's post-create.sh reads user.email/name
# with no --global flag (by design; --global --get does not follow include.path), which means
# it resolves *local* scope too, and this repo's own working tree has a real local git identity
# that would otherwise leak into every case run from inside it.
run_hook() {
  local path="$GIT_ONLY_BIN"
  if [ "${1:-}" = WITH_LFS ]; then
    path="$BIN:$GIT_ONLY_BIN"
    shift
  fi
  # /bin/sh by absolute path, not `sh` looked up on the scoped PATH below — that PATH
  # deliberately names only `git` (plus the stub, for WITH_LFS), and a shell to interpret the
  # hook itself is not part of what each case is choosing to have on PATH.
  ( cd "$H" && env -i HOME="$H" PATH="$path" GIT_CONFIG_GLOBAL="$GC" GIT_CONFIG_NOSYSTEM=1 \
      GIT_LFS_LOG="$GITLFSLOG" "$@" /bin/sh "$HOOK" ) \
    > "$WORK/hook.out" 2> "$WORK/hook.err"
  status=$?
}

# --includes: `git config --file <path>` does NOT follow include.path by default (only
# --global/--system/--local do, implicitly) — --includes asks it to resolve the same way the
# hook's own bare `git config --global ...` calls do.
get() { git config --file "$GC" --includes --get "$1" 2> /dev/null || true; }
get_all_count() { git config --file "$GC" --includes --get-all "$1" 2> /dev/null | wc -l | tr -d ' '; }

echo "case 1: a bare run — no identity, no git-lfs on PATH — is the hostile default"
setup c1
run_hook
check "the hook exits 0" test "$status" -eq 0
check "worktree.useRelativePaths is set" test "$(get worktree.useRelativePaths)" = true
check "safe.directory is the wildcard default" test "$(get safe.directory)" = '*'
check "no include.path — nothing was mounted at the fixed identity path" test -z "$(get include.path)"
check "no LFS filter was set — nothing invoked git-lfs" test ! -s "$GITLFSLOG"
check "it warns about the missing git identity, on stderr" \
  grep -q 'no git identity found' "$WORK/hook.err"
check "it warns that git-lfs is not on PATH, on stderr" \
  grep -q 'git-lfs not on PATH' "$WORK/hook.err"
check "nothing at all was written to stdout" test ! -s "$WORK/hook.out"

echo "case 2: git-lfs on PATH — the filters land, with --skip-smudge by default"
setup c2
run_hook WITH_LFS
check "the hook exits 0" test "$status" -eq 0
check "git-lfs was invoked with --skip-repo --force --skip-smudge" \
  grep -qF -- '--force --skip-repo --skip-smudge' "$GITLFSLOG"
check "filter.lfs.clean is set" test -n "$(get filter.lfs.clean)"
check "filter.lfs.smudge carries --skip" bash -c "echo '$(get filter.lfs.smudge)' | grep -q -- --skip"
check "filter.lfs.process carries --skip" bash -c "echo '$(get filter.lfs.process)' | grep -q -- --skip"
check "no git-lfs warning this time" bash -c "! grep -q 'git-lfs not on PATH' '$WORK/hook.err'"
check "the other two settings still applied alongside it" \
  test "$(get worktree.useRelativePaths)" = true -a "$(get safe.directory)" = '*'

echo "case 3: lfsSkipSmudge=false — smudge stays materializing"
setup c3 LFSSKIPSMUDGE=false
run_hook WITH_LFS
check "the hook exits 0" test "$status" -eq 0
check "git-lfs was invoked WITHOUT --skip-smudge" \
  bash -c "! grep -q -- '--skip-smudge' '$GITLFSLOG'"
check "filter.lfs.smudge carries no --skip" bash -c "! echo '$(get filter.lfs.smudge)' | grep -q -- --skip"

echo "case 4: lfsFilters=false — git-lfs is never reached, even though it is on PATH"
setup c4 LFSFILTERS=false
run_hook WITH_LFS
check "the hook exits 0" test "$status" -eq 0
check "git-lfs was never invoked" test ! -s "$GITLFSLOG"
check "no filter.lfs.clean was set" test -z "$(get filter.lfs.clean)"
check "and no warning either — this is an opt-out, not a misconfiguration" \
  bash -c "! grep -q 'git-lfs' '$WORK/hook.err'"

echo "case 5: worktreeRelativePaths=false — the key is left unset, not set to false"
setup c5 WORKTREERELATIVEPATHS=false
run_hook
check "the hook exits 0" test "$status" -eq 0
check "worktree.useRelativePaths was never written" test -z "$(get worktree.useRelativePaths)"
check "and git config agrees the key does not exist" bash -c \
  "! git config --file '$GC' --get worktree.useRelativePaths > /dev/null 2>&1"

echo "case 6: safeDirectory=\"\" disables the setting entirely"
setup c6 SAFEDIRECTORY=
run_hook
check "the hook exits 0" test "$status" -eq 0
check "safe.directory was never written" test -z "$(get safe.directory)"

echo "case 7: a non-default safeDirectory is passed through as-is"
setup c7 'SAFEDIRECTORY=/workspaces/myproj'
run_hook
check "safe.directory is the scoped path, not the wildcard" \
  test "$(get safe.directory)" = /workspaces/myproj

echo "case 8: a file mounted at the fixed identity path — included first, no missing-identity warning"
setup c8
git config --file "$IDENTITY" user.name 'A. Committer'
git config --file "$IDENTITY" user.email 'a@example.com'
run_hook
check "the hook exits 0" test "$status" -eq 0
check "include.path names the identity file" test "$(get include.path)" = "$IDENTITY"
check "user.name resolves through the include" test "$(get user.name)" = 'A. Committer'
check "user.email resolves through the include too" test "$(get user.email)" = a@example.com
check "no missing-identity warning — one is present" \
  bash -c "! grep -q 'no git identity found' '$WORK/hook.err'"
check "the container-mandated settings still applied after the include" \
  test "$(get worktree.useRelativePaths)" = true -a "$(get safe.directory)" = '*'

echo "case 9: a name with '#' and '\"' survives the identity include, quoted the way git wrote it"
setup c9
git config --file "$IDENTITY" user.name 'Jane "JD" O'"'"'Brien #1'
run_hook
check "the odd name reads back exactly, through the include" \
  test "$(get user.name)" = 'Jane "JD" O'"'"'Brien #1'

echo "case 10: a second run is idempotent — no duplicate include.path, no duplicate safe.directory"
setup c10
git config --file "$IDENTITY" user.email 'again@example.com'
run_hook
check "the first run exits 0" test "$status" -eq 0
run_hook
check "the second run exits 0" test "$status" -eq 0
check "exactly one include.path value" test "$(get_all_count include.path)" -eq 1
check "exactly one safe.directory value" test "$(get_all_count safe.directory)" -eq 1
check "the include still resolves" test "$(get user.email)" = again@example.com

echo "case 11: five runs are still exactly one of each"
run_hook
run_hook
run_hook
check "still exactly one include.path value after five runs" \
  test "$(get_all_count include.path)" -eq 1
check "still exactly one safe.directory value after five runs" \
  test "$(get_all_count safe.directory)" -eq 1

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
