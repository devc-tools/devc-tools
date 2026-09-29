#!/usr/bin/env bash
# Offline harness for the gh-push and gh-doctor built-ins. Every pin is a GitHub remote
# (`git@github.com:acme/widget.git`), the only kind they accept; a `git` shim on the scripts' PATH
# points its HTTPS URL at a local bare repo and a `gh` shim answers `auth status` and
# `auth git-credential`, so nothing here touches a network. Runs the scripts directly with the
# environment the bridge would give them (DEVC_BRIDGE_KEY, DEVC_BRIDGE_POLICY_DIR) and a throwaway
# $HOME.
#
#   bash devc-bridge/tests/gh_push_test.sh
#
# The bridge-side half — that the server sets DEVC_BRIDGE_KEY from the caller's token — is
# `host/tests/keys_test.ts`.

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
PUSH=$here/../builtin/gh-push
DOCTOR=$here/../builtin/gh-doctor
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

root=$(mktemp -d "${TMPDIR:-/tmp}/gh-push-test.XXXXXX")
trap 'rm -rf "$root"' EXIT

# ── fixture ───────────────────────────────────────────────────────────────────────────────

# The GitHub pin every case uses, and the HTTPS URL gh-push reaches it by.
GH_PIN=git@github.com:acme/widget.git
GH_URL=https://github.com/acme/widget.git

# fresh [default-branch] — a new world: $HOME, a bare $REMOTE whose HEAD is the default branch, a
# working $REPO cloned from it on branch `feat` with one new commit, the git and gh shims in
# $W/ghbin, and a policy pinning feat to $GH_PIN.
fresh() {
  local base=${1:-main}
  W=$(mktemp -d "$root/case.XXXXXX")
  export HOME=$W/home
  mkdir -p "$HOME"
  git config --global user.name tester
  git config --global user.email tester@example.invalid
  git config --global init.defaultBranch "$base"
  git config --global protocol.file.allow always
  REMOTE=$W/widget.git
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
  shims
  pin "$REPO" "$GH_PIN" feat
}

# shims — $W/ghbin/git logs every call (with the config-isolation env) to $W/git.log, then runs the
# real git with any https://github.com/acme/<name>.git argument pointed at the local bare
# $W/<name>.git — the only way to exercise the transport offline. For a network call, SHIM_LS_FAIL
# makes it fail as GitHub would and SHIM_HANG makes it hang with a grandchild holding stdout.
# $W/ghbin/gh answers `auth git-credential get`, and `auth status` with SHIM_AUTH_RC.
shims() {
  mkdir -p "$W/ghbin"
  cat >"$W/ghbin/git" <<EOF
#!/usr/bin/env bash
{
  printf 'GIT_CONFIG_GLOBAL=%s GIT_CONFIG_NOSYSTEM=%s ' "\${GIT_CONFIG_GLOBAL-}" "\${GIT_CONFIG_NOSYSTEM-}"
  printf '%s ' "\$@"
  echo
} >>"$W/git.log"
args=()
net=no
for a in "\$@"; do
  case \$a in
    https://github.com/acme/*.git) args+=("$W/\${a#https://github.com/acme/}") net=yes ;;
    *) args+=("\$a") ;;
  esac
done
if [ "\$net" = yes ] && [ -n "\${SHIM_HANG-}" ]; then
  # A transport that never answers (30s, so a regression fails the timing check rather than
  # wedging the harness), with a grandchild holding stdout — killing git alone would hang.
  sleep 30 &
  exec sleep 31
fi
if [ "\$net" = yes ] && [ -n "\${SHIM_LS_FAIL-}" ]; then
  echo 'remote: Repository not found.' >&2
  exit 128
fi
exec "$REAL_GIT" "\${args[@]}"
EOF
  cat >"$W/ghbin/gh" <<'EOF'
#!/bin/sh
if [ "$1 $2 $3" = "auth git-credential get" ]; then
  echo username=x-access-token
  echo password=shim-token
  exit 0
fi
[ "$1" = auth ] && exit "${SHIM_AUTH_RC:-0}"
exit 99
EOF
  chmod +x "$W/ghbin/git" "$W/ghbin/gh"
  : >"$W/git.log"
}

pin() { # pin <repo> <remote> <branch> [grants, default gh-push]
  mkdir -p "$POLICY_DIR"
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-gh-push}" >"$POLICY_DIR/$KEY.conf"
}

# push [args…] — run the recipe as the bridge would; sets $rc and $out (stdout+stderr).
push() {
  out=$(PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" "$@" 2>&1)
  rc=$?
}
doctor() { # doctor — as run by hand on the host, where DEVC_BRIDGE_KEY is unset
  out=$(PATH=$W/ghbin:$PATH env -u DEVC_BRIDGE_KEY DEVC_BRIDGE_POLICY_DIR="$POLICY_DIR" "$DOCTOR" 2>&1)
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
G=$'\t'gh-push
for bad_line in \
  "$REPO"$'\t'"$GH_PIN" \
  "$REPO"$'\t'"$GH_PIN"$'\t'feat \
  "$REPO"$'\t'"$GH_PIN"$'\t'feat"$G"$'\t'x \
  "$REPO"$'\t\t'feat"$G" \
  "relative/repo"$'\t'"$GH_PIN"$'\t'feat"$G" \
  "$REPO"$'\t'"-u/evil"$'\t'feat"$G" \
  "$REPO"$'\t'"$GH_PIN"$'\t'"bad..ref$G" \
  "$REPO"$'\t'"$GH_PIN"$'\t'feat$'\t' \
  "$REPO"$'\t'"$GH_PIN"$'\t'feat$'\t'"GIT PUSH" \
  "$REPO"$'\t'"$GH_PIN"$'\t'feat"$G"$'\n'"$REPO"$'\t'"$GH_PIN"$'\t'main"$G"; do
  printf '%s\n' "$bad_line" >"$POLICY_DIR/$KEY.conf"
  push
  expect_rc 2 "malformed policy: $(printf '%s' "$bad_line" | sed "s|$W|W|g" | tr '\t\n' '|/')"
done
check "  … and the remote never moved" test "$(remote_ref refs/heads/feat)" = none
fresh
pin "$REPO" "$GH_PIN" feat gh-pr-review,gh-pr-resolve
push
expect_rc 2 "a policy that does not grant gh-push"
check "  … says so" has "this container was not granted gh-push"
check "  … and nothing was touched" test ! -e "$MIRROR"
pin "$REPO" "$GH_PIN" feat gh-push,gh-pr-review
push
expect_rc 0 "gh-push among other grants"
fresh
push extra
expect_rc 2 "an argument is rejected, not ignored"
push --force
expect_rc 2 "a flag-shaped argument is rejected"
check "  … and nothing was pushed" test "$(remote_ref refs/heads/feat)" = none
out=$(PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY='' DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
expect_rc 2 "the shared legacy token (empty key) cannot push"
out=$(PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY=../ws-1 DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
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
pin "$REPO" "$GH_PIN" refs/tags/v1
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
    "$REAL_GIT" -C "$REPO" -c user.name=racer -c user.email=racer@example.invalid commit -q -m raced >/dev/null 2>&1
    break
  fi
done
exec "$W/ghbin/git" "\$@"
EOF
chmod +x "$W/shim/git"
out=$(PATH=$W/shim:$W/ghbin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
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
pin "$REPO" "git@github.com:acme/other.git" feat
push
expect_rc 2 "policy remote differs from the mirror's origin"
check "  … nothing reached the other remote" test -z "$(git --git-dir="$W/other.git" for-each-ref)"
pin "$REPO" "$GH_PIN" feat
git --git-dir="$MIRROR" config remote.origin.url "git@github.com:acme/other.git"
push
expect_rc 2 "mirror origin rewritten under the policy"

echo "the pinned repo"
fresh
pin "$REPO" "$GH_PIN" nosuch
push
expect_rc 2 "a branch the repo does not have"
pin "$W/nowhere" "$GH_PIN" feat
push
expect_rc 2 "a repo path that does not exist"
pin "$REPO" "$GH_PIN" feat
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
pin "$WT" "$GH_PIN" wt
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

echo "gh-doctor"
doctor
expect_rc 0 "a healthy policy"
check "  … names the pin" has "wt"
echo "gitdir: $W/secret/.git" >"$WT/.git"
doctor
expect_rc 1 "a repointed worktree pointer"
check "  … is reported" has "REPOINTED"
printf '%s\n' "$saved" >"$WT/.git"
pin "$REPO" "$GH_PIN" feat
git -C "$REPO" worktree add -q -b wt2 "$W/repo.worktrees/wt2"
echo "gitdir: $W/secret/.git" >"$W/repo.worktrees/wt2/.git"
doctor
expect_rc 1 "a repointed sibling under <repo>.worktrees/"
check "  … is reported" has "repo.worktrees/wt2"
out=$(PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$DOCTOR" other-key 2>&1)
rc=$?
expect_rc 2 "through the bridge, another key's report is refused"
pin "$REPO" "$GH_PIN" feat gh-push,gh-pr-review
doctor
check "the policy line shows the grants" has "policy    gh-push, gh-pr-review for feat → "
pin "$REPO" "$GH_PIN" feat gh-pr-review
out=$(PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$DOCTOR" 2>&1)
rc=$?
expect_rc 2 "through the bridge, a container not granted gh-push is refused"
check "  … says so" has "this container was not granted gh-push"
printf '%s\t%s\t%s\n' "$REPO" "$GH_PIN" feat >"$POLICY_DIR/$KEY.conf"
doctor
expect_rc 1 "a three-field (pre-grants) policy"
check "  … is reported MALFORMED" has "MALFORMED"

echo "GitHub only"
for remote in "$REMOTE" "file://$REMOTE" "ssh://git@gitlab.com/acme/widget.git" \
  "git@gitlab.com:acme/widget.git" "https://github.com/acme"; do
  fresh
  pin "$REPO" "$remote" feat
  push
  expect_rc 2 "gh-push on a ${remote/#$W/W} pin"
  check "  … says so" has "gh-push: unsupported remote $remote — only github.com"
  check "  … and nothing was touched" test ! -e "$MIRROR"
  check "  … and no network git ran" bash -c '! grep -qE " (init|ls-remote|fetch|push) " "$1"' _ "$W/git.log"
  doctor
  expect_rc 1 "gh-doctor on that pin"
  check "  … reports it" has "transport FAILED: unsupported remote $remote — only github.com"
done

echo "parse_remote: devc-core's shape table, against every script's copy"
# The rows of GITHUB_REMOTE_SHAPES in devc-core/tests/bridge_test.ts, one `['<url>', <bool>],` per
# line — the one table devc's grant-time check (isGitHubRemote) is tested against.
shapes=$(sed -nE "/^const GITHUB_REMOTE_SHAPES/,/^];/s/^  \['(.*)', (true|false)\],\$/\1|\2/p" \
  "$here/../../devc-core/tests/bridge_test.ts")
check "the table has rows" test "$(printf '%s\n' "$shapes" | grep -c .)" -ge 10
for script in "$here"/../builtin/gh-*; do
  fns=$(sed -n '/^parse_remote() {/,/^}/p; /^valid_name() {/,/^}/p' "$script")
  mismatches=$(
    eval "$fns"
    while IFS="|" read -r url want; do
      if parse_remote "$url"; then got=true; else got=false; fi
      [ "$got" = "$want" ] || printf '%s ' "$url: want $want, got $got;"
    done <<<"$shapes"
  )
  check "${script##*/} accepts exactly the table's GitHub remotes${mismatches:+ — $mismatches}" \
    test -z "$mismatches"
done

echo "gh-doctor transport"
fresh
doctor
expect_rc 0 "a reachable remote"
check "  … probes via gh" has "transport ok (git ls-remote reached $GH_URL via gh credentials)"
check "  … has no ssh agent section" bash -c '! grep -q "ssh agent:" <<<"$1"' _ "$out"
out=$(SHIM_LS_FAIL=1 PATH=$W/ghbin:$PATH env -u DEVC_BRIDGE_KEY DEVC_BRIDGE_POLICY_DIR="$POLICY_DIR" "$DOCTOR" 2>&1)
rc=$?
expect_rc 1 "a remote that refuses"
check "  … is reported FAILED" has "transport FAILED: git ls-remote exited 128: remote: Repository not found."
check "  … points at gh auth" has "GitHub remotes use gh's credentials over HTTPS"
check "  … never mentions SSH" bash -c '! grep -qiE "ssh|BatchMode" <<<"$1"' _ "$out"
out=$(SHIM_AUTH_RC=1 PATH=$W/ghbin:$PATH env -u DEVC_BRIDGE_KEY DEVC_BRIDGE_POLICY_DIR="$POLICY_DIR" "$DOCTOR" 2>&1)
rc=$?
expect_rc 1 "gh-doctor with gh not logged in"
check "  … says so" has "transport FAILED: gh is not authenticated for github.com"
start=$(date +%s)
out=$(SHIM_HANG=1 PATH=$W/ghbin:$PATH DEVC_BRIDGE_GIT_TIMEOUT=2 env -u DEVC_BRIDGE_KEY \
  DEVC_BRIDGE_POLICY_DIR="$POLICY_DIR" "$DOCTOR" 2>&1)
rc=$?
took=$(($(date +%s) - start))
expect_rc 1 "a hung transport"
check "  … returns within the timeout (${took}s)" test "$took" -lt 15
check "  … says it timed out" has "transport TIMED OUT after 2s"
sleep 1
check "  … leaves no process behind" test -z "$(pgrep -f 'sleep 3[01]$' || true)"

echo "GitHub transport (gh's credential over HTTPS)"
fresh
# The file transport never asks for a credential, so prove the helper string itself works: git must
# run it through the shell and read gh's answer.
cred=$(printf 'protocol=https\nhost=github.com\n\n' | GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  "$REAL_GIT" -c credential.helper= -c "credential.helper=!'$W/ghbin/gh' auth git-credential" \
  credential fill 2>&1)
check "the gh credential helper string answers git" test "${cred#*password=}" != "$cred"
# The logged ls-remote/fetch/push subcommands, minus the one fetch *from the agent's repo*.
net_calls() { grep -E ' (ls-remote|fetch|push) ' "$W/git.log" | grep -vF -e "-- $REPO " || true; }
push
expect_rc 0 "a GitHub remote pushes"
check "  … names the policy remote" has "pushed: feat at $(repo_ref feat | cut -c1-12) to $GH_PIN"
check "  … the remote has the commit" test "$(remote_ref refs/heads/feat)" = "$(repo_ref feat)"
check "  … three network calls" test "$(net_calls | wc -l)" -eq 3
check "  … all to the HTTPS URL" test -z "$(net_calls | grep -v " -- $GH_URL " || true)"
check "  … all with gh as the only credential helper" \
  test -z "$(net_calls | grep -vF -e "-c credential.helper= -c credential.helper=!'$W/ghbin/gh' auth git-credential " || true)"
check "  … all without user or system git config" \
  test -z "$(net_calls | grep -v '^GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 ' || true)"
check "  … never over SSH" test -z "$(grep -F 'git@github.com:' "$W/git.log" | grep -v 'config remote.origin.url' || true)"
check "  … the mirror keeps the policy remote" \
  test "$(git config --file "$MIRROR/config" remote.origin.url)" = "$GH_PIN"
push
expect_rc 0 "a second push"
check "  … is up to date" has "up to date: feat is already"
commit_file more.txt more
: >"$W/git.log"
out=$(SHIM_AUTH_RC=1 PATH=$W/ghbin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR "$PUSH" 2>&1)
rc=$?
expect_rc 4 "gh not logged in"
check "  … says what to do" has "gh-push: gh is not authenticated in the bridge's environment — run gh auth login on the host"
check "  … makes no network call" test -z "$(net_calls || true)"
if command -v -p gh >/dev/null 2>&1 || [ -x /usr/bin/gh ] || [ -x /bin/gh ]; then
  ok "gh not installed — skipped, a real gh is on /usr/bin:/bin"
else
  rm "$W/ghbin/gh"
  push
  expect_rc 4 "gh not installed"
  check "  … says so" has "gh is not installed on the host"
  shims
fi

echo "hang-proofing"
fresh
start=$(date +%s)
out=$(SHIM_HANG=1 PATH=$W/ghbin:$PATH DEVC_BRIDGE_GIT_TIMEOUT=2 DEVC_BRIDGE_KEY=$KEY \
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
