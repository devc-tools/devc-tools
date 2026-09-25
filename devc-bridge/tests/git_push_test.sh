#!/usr/bin/env bash
# Offline harness for the git-push and git-doctor recipes: a local bare repo stands in for the
# remote, so nothing here touches a network. Runs the recipes directly with the environment the
# bridge would give them (DEVC_BRIDGE_KEY, DEVC_BRIDGE_POLICY_DIR) and a throwaway $HOME.
#
#   bash devc-bridge/tests/git_push_test.sh
#
# The bridge-side half — that the server sets DEVC_BRIDGE_KEY from the caller's token — is
# `host/tests/keys_test.ts`.

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
PUSH=$here/../recipes/git-push
DOCTOR=$here/../recipes/git-doctor
REAL_GIT=$(command -v git)

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  echo "  ok   $*"
}
bad() {
  fail=$((fail + 1))
  echo "  FAIL $*"
}
check() { # check <desc> <command…>
  local desc=$1
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

root=$(mktemp -d "${TMPDIR:-/tmp}/git-push-test.XXXXXX")
trap 'rm -rf "$root"' EXIT

# ── fixture ───────────────────────────────────────────────────────────────────────────────

# fresh [default-branch] — a new world: $HOME, a bare $REMOTE whose HEAD is the default branch, a
# working $REPO cloned from it on branch `feat` with one new commit, and a policy pinning feat.
fresh() {
  local base=${1:-main}
  W=$(mktemp -d "$root/case.XXXXXX")
  export HOME=$W/home
  mkdir -p "$HOME"
  git config --global user.name tester
  git config --global user.email tester@example.invalid
  git config --global init.defaultBranch "$base"
  git config --global protocol.file.allow always
  REMOTE=$W/remote.git
  REPO=$W/repo
  KEY=ws-1
  POLICY_DIR=$HOME/.config/devc-bridge/policy
  MIRROR=$HOME/.local/state/devc-bridge/git/$KEY.git
  MARK=$W/marks
  mkdir -p "$MARK"
  git init -q --bare "$REMOTE"
  git init -q "$W/seed"
  mkdir -p "$W/seed/.github/workflows"
  echo 'on: push' >"$W/seed/.github/workflows/ci.yml"
  echo seed >"$W/seed/README"
  git -C "$W/seed" add -A
  git -C "$W/seed" commit -q -m seed
  git -C "$W/seed" push -q "$REMOTE" "HEAD:refs/heads/$base"
  git clone -q "$REMOTE" "$REPO"
  git -C "$REPO" checkout -q -b feat
  echo work >"$REPO/work.txt"
  git -C "$REPO" add work.txt
  git -C "$REPO" commit -q -m work
  pin "$REPO" "$REMOTE" feat
}

pin() { # pin <repo> <remote> <branch>
  mkdir -p "$POLICY_DIR"
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >"$POLICY_DIR/$KEY.conf"
}

# push [args…] — run the recipe as the bridge would; sets $rc and $out (stdout+stderr).
push() {
  out=$(DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" "$@" 2>&1)
  rc=$?
}
doctor() { # doctor — as run by hand on the host, where DEVC_BRIDGE_KEY is unset
  out=$(env -u DEVC_BRIDGE_KEY DEVC_BRIDGE_POLICY_DIR="$POLICY_DIR" "$DOCTOR" 2>&1)
  rc=$?
}

remote_ref() { git --git-dir="$REMOTE" rev-parse -q --verify "$1" 2>/dev/null || echo none; }
repo_ref() { git -C "$REPO" rev-parse "$1"; }
remote_refs() { git --git-dir="$REMOTE" for-each-ref --format='%(refname)' | sort | tr '\n' ' '; }
expect_rc() { # expect_rc <want> <desc>
  if [ "$rc" = "$1" ]; then ok "$2 (exit $rc)"; else
    bad "$2 — want exit $1, got $rc"
    printf '%s\n' "$out" | sed 's/^/         | /'
  fi
}
has() { case $out in *"$1"*) return 0 ;; esac; return 1; }

commit_file() { # commit_file <path> <content>
  mkdir -p "$REPO/$(dirname "$1")"
  printf '%s\n' "$2" >"$REPO/$1"
  git -C "$REPO" add -- "$1"
  git -C "$REPO" commit -q -m "add $1"
}

# ── cases ─────────────────────────────────────────────────────────────────────────────────

echo "safety property"
fresh
cat >"$REPO/.git/hooks/pre-push" <<EOF
#!/bin/sh
touch "$MARK/pre-push"
EOF
chmod +x "$REPO/.git/hooks/pre-push"
cat >"$W/payload" <<EOF
#!/bin/sh
touch "$MARK/\$(basename "\$0")"
EOF
chmod +x "$W/payload"
for name in fsmonitor packobjects alternaterefs; do cp "$W/payload" "$W/$name"; done
git -C "$REPO" config core.fsmonitor "$W/fsmonitor"
git -C "$REPO" config uploadpack.packObjectsHook "$W/packobjects"
git -C "$REPO" config core.alternateRefsCommand "$W/alternaterefs"
# The hazard, shown: git run *in* the repo executes what the agent planted.
git init -q --bare "$W/scratch.git"
git -C "$REPO" push -q "$W/scratch.git" feat 2>/dev/null
git -C "$REPO" status >/dev/null 2>&1
check "git -C <repo> push runs a planted pre-push hook" test -e "$MARK/pre-push"
check "git -C <repo> status runs a planted core.fsmonitor" test -e "$MARK/fsmonitor"
rm -f "$MARK"/*
push
expect_rc 0 "the mirror path publishes"
check "  … and runs none of the four payloads" test -z "$(ls "$MARK")"
check "  … and the remote holds the repo's branch" \
  test "$(remote_ref refs/heads/feat)" = "$(repo_ref feat)"

echo "policy and caller"
fresh
rm "$POLICY_DIR/$KEY.conf"
push
expect_rc 2 "no policy file"
check "  … and no mirror was created (nothing touched)" test ! -e "$MIRROR"
for bad_line in \
  "$REPO"$'\t'"$REMOTE" \
  "$REPO"$'\t'"$REMOTE"$'\t'feat$'\t'x \
  "$REPO"$'\t\t'feat \
  "relative/repo"$'\t'"$REMOTE"$'\t'feat \
  "$REPO"$'\t'"-u/evil"$'\t'feat \
  "$REPO"$'\t'"$REMOTE"$'\t'"bad..ref" \
  "$REPO"$'\t'"$REMOTE"$'\t'feat$'\n'"$REPO"$'\t'"$REMOTE"$'\t'main; do
  printf '%s\n' "$bad_line" >"$POLICY_DIR/$KEY.conf"
  push
  expect_rc 2 "malformed policy: $(printf '%s' "$bad_line" | sed "s|$W|W|g" | tr '\t\n' '|/')"
done
check "  … and the remote never moved" test "$(remote_ref refs/heads/feat)" = none
fresh
push extra
expect_rc 2 "an argument is rejected, not ignored"
push --force
expect_rc 2 "a flag-shaped argument is rejected"
check "  … and nothing was pushed" test "$(remote_ref refs/heads/feat)" = none
out=$(DEVC_BRIDGE_KEY='' DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
expect_rc 2 "the shared legacy token (empty key) cannot push"
out=$(DEVC_BRIDGE_KEY=../ws-1 DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
expect_rc 2 "a key with a path separator is refused"

echo "a valid push"
fresh
push
expect_rc 0 "valid policy pushes"
sha=$(repo_ref feat)
check "  … remote branch is at the repo's SHA" test "$(remote_ref refs/heads/feat)" = "$sha"
check "  … output names the branch" has "feat"
check "  … output names the short SHA" has "${sha:0:12}"
check "  … output names the repo" has "$REPO"
push
expect_rc 0 "a second run with nothing new"
check "  … reports up to date" has "up to date"
check "  … staged under refs/staging/, not refs/heads/" \
  test "$(git --git-dir="$MIRROR" for-each-ref --format='%(refname)' refs/heads | wc -l | tr -d ' ')" = 0

echo "only the pinned branch moves"
fresh
git -C "$REPO" tag v9.9.9
git -C "$REPO" tag -a -m annotated v9.9.8
git -C "$REPO" checkout -q -b other
echo other >"$REPO/other.txt"
git -C "$REPO" add other.txt
git -C "$REPO" commit -q -m other
before_main=$(remote_ref refs/heads/main)
push
expect_rc 0 "push with another branch checked out"
check "  … refs on the remote are exactly main + feat" \
  test "$(remote_refs)" = "refs/heads/feat refs/heads/main "
check "  … main did not move" test "$(remote_ref refs/heads/main)" = "$before_main"
check "  … feat is the pinned branch's commit, not the checkout's" \
  test "$(remote_ref refs/heads/feat)" = "$(repo_ref feat)"

echo "a tag cannot be produced"
fresh
git -C "$REPO" branch refs/tags/v1 feat 2>/dev/null || git -C "$REPO" update-ref refs/heads/refs/tags/v1 feat
pin "$REPO" "$REMOTE" refs/tags/v1
push
check "  a branch named like a tag lands under refs/heads/" \
  test "$(git --git-dir="$REMOTE" for-each-ref --format='%(refname)' refs/tags | wc -l | tr -d ' ')" = 0

echo "content policy"
fresh
commit_file .github/workflows/evil.yml 'on: push'
push
expect_rc 3 "a branch adding a workflow is refused"
check "  … remote unchanged" test "$(remote_ref refs/heads/feat)" = none
fresh
git -C "$REPO" mv .github/workflows/ci.yml moved.yml
git -C "$REPO" commit -q -m move
push
expect_rc 3 "a branch renaming a workflow away is refused"
fresh
printf 'version https://git-lfs.github.com/spec/v1\noid sha256:%064d\nsize 12\n' 0 >"$REPO/big.bin"
git -C "$REPO" add big.bin
git -C "$REPO" commit -q -m lfs
push
expect_rc 3 "a branch adding an LFS pointer is refused"
check "  … remote unchanged" test "$(remote_ref refs/heads/feat)" = none

echo "default branch is read, not assumed"
fresh master
push
expect_rc 0 "a master-default remote publishes"
check "  … the mirror diffed against master" \
  git --git-dir="$MIRROR" rev-parse -q --verify --quiet refs/remotes/origin/master >/dev/null
commit_file .github/workflows/evil.yml 'on: push'
push
expect_rc 3 "  … and the workflow policy still runs against master"
check "  … naming master" has "master"

echo "TOCTOU"
fresh
inspected=$(repo_ref feat)
mkdir -p "$W/shim"
cat >"$W/shim/git" <<EOF
#!/bin/sh
# On the push, move the pinned branch first — the agent racing the check.
for a in "\$@"; do
  if [ "\$a" = push ]; then
    echo raced >"$REPO/raced.txt"
    "$REAL_GIT" -C "$REPO" add raced.txt >/dev/null 2>&1
    "$REAL_GIT" -C "$REPO" commit -q -m raced >/dev/null 2>&1
    break
  fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$W/shim/git"
out=$(PATH=$W/shim:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
expect_rc 0 "push while the branch moves underneath"
check "  … the branch really did move" test "$(repo_ref feat)" != "$inspected"
check "  … the remote got the inspected SHA" test "$(remote_ref refs/heads/feat)" = "$inspected"

echo "mirror"
fresh
push
expect_rc 0 "first push creates the mirror"
commit_file more.txt more
rm -rf "$MIRROR"
push
expect_rc 0 "deleting the mirror and re-running"
check "  … published the new commit" test "$(remote_ref refs/heads/feat)" = "$(repo_ref feat)"
git init -q --bare "$W/other.git"
pin "$REPO" "$W/other.git" feat
push
expect_rc 2 "policy remote differs from the mirror's origin"
check "  … nothing reached the other remote" test -z "$(git --git-dir="$W/other.git" for-each-ref)"
pin "$REPO" "$REMOTE" feat
git --git-dir="$MIRROR" config remote.origin.url "$W/other.git"
push
expect_rc 2 "mirror origin rewritten under the policy"

echo "the pinned repo"
fresh
pin "$REPO" "$REMOTE" nosuch
push
expect_rc 2 "a branch the repo does not have"
pin "$W/nowhere" "$REMOTE" feat
push
expect_rc 2 "a repo path that does not exist"
pin "$REPO" "$REMOTE" feat
echo ../../other/.git >"$REPO/.git/commondir"
push
expect_rc 2 "a primary repo with a planted commondir"
rm "$REPO/.git/commondir"

echo "linked worktree"
fresh
git -C "$REPO" worktree add -q -b wt "$W/repo.worktrees/wt"
WT=$W/repo.worktrees/wt
echo wt >"$WT/wt.txt"
git -C "$WT" add wt.txt
git -C "$WT" commit -q -m wt
pin "$WT" "$REMOTE" wt
push
expect_rc 0 "a linked worktree publishes"
check "  … at the worktree's commit" test "$(remote_ref refs/heads/wt)" = "$(git -C "$WT" rev-parse wt)"
git init -q "$W/secret"
echo secret >"$W/secret/s.txt"
git -C "$W/secret" add s.txt
git -C "$W/secret" commit -q -m secret
git -C "$W/secret" branch wt
saved=$(cat "$WT/.git")
echo "gitdir: $W/secret/.git" >"$WT/.git"
push
expect_rc 2 "a worktree pointer redirected at another repo"
mkdir -p "$W/secret/.git/worktrees/wt"
echo "gitdir: $W/secret/.git/worktrees/wt" >"$WT/.git"
push
expect_rc 2 "  … or at a worktrees/<name> dir that does not point back"
printf '%s\n' "$saved" >"$WT/.git"
wtdir=${saved#gitdir: }
echo "$W/secret/.git" >"$wtdir/commondir"
push
expect_rc 2 "a worktree whose commondir was redirected"
echo ../.. >"$wtdir/commondir"

echo "git-doctor"
doctor
expect_rc 0 "a healthy policy"
check "  … names the pin" has "wt"
echo "gitdir: $W/secret/.git" >"$WT/.git"
doctor
expect_rc 1 "a repointed worktree pointer"
check "  … is reported" has "REPOINTED"
printf '%s\n' "$saved" >"$WT/.git"
pin "$REPO" "$REMOTE" feat
git -C "$REPO" worktree add -q -b wt2 "$W/repo.worktrees/wt2"
echo "gitdir: $W/secret/.git" >"$W/repo.worktrees/wt2/.git"
doctor
expect_rc 1 "a repointed sibling under <repo>.worktrees/"
check "  … is reported" has "repo.worktrees/wt2"
out=$(DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$DOCTOR" other-key 2>&1)
rc=$?
expect_rc 2 "through the bridge, another key's report is refused"

echo "hang-proofing"
fresh
mkdir -p "$W/shim"
cat >"$W/shim/ssh" <<'EOF'
#!/bin/sh
# A transport that never answers, with a grandchild holding stdout — killing git alone would hang
# (for 30s, so that a regression fails the timing check below rather than wedging the harness).
sleep 30 &
exec sleep 31
EOF
chmod +x "$W/shim/ssh"
pin "$REPO" "ssh://git.example.invalid/x.git" feat
start=$(date +%s)
out=$(PATH=$W/shim:$PATH DEVC_BRIDGE_GIT_TIMEOUT=2 DEVC_BRIDGE_KEY=$KEY \
  DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
took=$(($(date +%s) - start))
expect_rc 4 "a hung transport"
check "  … returns within the timeout (${took}s)" test "$took" -lt 15
check "  … says it timed out" has "timed out"
sleep 1
check "  … leaves no process behind" test -z "$(pgrep -f 'sleep 3[01]$' || true)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
