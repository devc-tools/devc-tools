#!/usr/bin/env bash
# Offline harness for the pr-comments, pr-reply and pr-resolve recipes. A `gh` shim first on PATH
# stands in for GitHub: it logs every call (cwd and argv, one line each) and answers from fixture
# files this script writes per case, applying `--jq` with the real `jq` — so the harness needs `jq`,
# the recipes do not. Runs the recipes directly with the environment the bridge would give them
# (DEVC_BRIDGE_KEY, DEVC_BRIDGE_POLICY_DIR) and a throwaway $HOME.
#
#   bash devc-bridge/tests/pr_review_test.sh

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
RECIPES=$here/../recipes
command -v jq >/dev/null || {
  echo "pr_review_test: needs jq" >&2
  exit 1
}

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

root=$(mktemp -d "${TMPDIR:-/tmp}/pr-review-test.XXXXXX")
trap 'rm -rf "$root"' EXIT

# ── the gh shim ───────────────────────────────────────────────────────────────────────────

mkdir -p "$root/bin"
cat >"$root/bin/gh" <<'SHIM'
#!/usr/bin/env bash
# Log, then answer from $SHIM/fixtures. SHIM_AUTH_RC fails `auth status`; SHIM_SLEEP hangs with a
# grandchild holding stdout; SHIM_FAIL (a substring of the path or query) answers with an error.
{
  printf 'cwd=%s ' "$PWD"
  printf '%q ' "$@"
  echo
} >>"$SHIM/calls.log"
if [ -n "${SHIM_SLEEP:-}" ]; then
  sleep 30 &
  exec sleep 31
fi
if [ "$1" = auth ]; then exit "${SHIM_AUTH_RC:-0}"; fi
[ "$1" = api ] || {
  echo "shim: unexpected gh $1" >&2
  exit 99
}
shift
jqf='' path='' query='' owner='' name='' id='' body=''
while [ $# -gt 0 ]; do
  case $1 in
    --jq) jqf=$2 && shift 2 ;;
    --paginate) shift ;;
    -f | -F)
      k=${2%%=*} v=${2#*=}
      case $k in
        query) query=$v ;; owner) owner=$v ;; name) name=$v ;; id) id=$v ;; body) body=$v ;;
      esac
      shift 2
      ;;
    -*) echo "shim: unknown flag $1" >&2 && exit 99 ;;
    *) path=$1 && shift ;;
  esac
done
[ -z "$query" ] || printf '%s\n----\n' "$query" >>"$SHIM/queries.log"
if [ -n "${SHIM_FAIL:-}" ]; then
  case "$path $query" in *"$SHIM_FAIL"*) echo "HTTP 502: Bad Gateway" >&2 && exit 1 ;; esac
fi
F=$SHIM/fixtures
files=()
if [ "$path" = graphql ]; then
  case $query in
    *'pullRequests(headRefName'*)
      files=("$F/prs-$owner-$name.json")
      [ -f "${files[0]}" ] || echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' >"${files[0]}"
      ;;
    *reviewThreads*) files=("$F"/threads-*.json) ;;
    *'reviews(last'*) files=("$F/reviews.json") ;;
    *addPullRequestReviewThreadReply*)
      printf '%s' "$body" >"$SHIM/posted"
      files=("$F/reply.json")
      ;;
    *resolveReviewThread*)
      : >"$SHIM/resolved-$id"
      files=("$F/resolve.json")
      ;;
    *'node(id'*)
      [ -f "$F/node-$id.json" ] || {
        echo "GraphQL: Could not resolve to a node with the global id of '$id' (node)" >&2
        exit 1
      }
      files=("$F/node-$id.json")
      ;;
  esac
else
  case $path in
    repos/*/*/pulls/*/requested_reviewers) files=("$F/requested.json") ;;
    repos/*/*) r=${path#repos/} && files=("$F/repo-${r%%/*}-${r#*/}.json") ;;
  esac
fi
[ ${#files[@]} -gt 0 ] || {
  echo "shim: no route for $path" >&2
  exit 99
}
for f in "${files[@]}"; do
  [ -f "$f" ] || {
    echo "HTTP 404: Not Found ($f)" >&2
    exit 1
  }
  if [ -n "$jqf" ]; then jq -r "$jqf" "$f" || exit 1; else cat "$f"; fi
done
SHIM
chmod +x "$root/bin/gh"

# ── fixtures ──────────────────────────────────────────────────────────────────────────────

sha() { printf '%040d' "$1"; }

repo_fx() { # repo_fx <owner/name> [parent owner/name]
  local o=${1%%/*} n=${1#*/}
  if [ $# -gt 1 ]; then
    jq -n --arg f "$1" --arg p "$2" '{full_name: $f, fork: true, parent: {full_name: $p}}'
  else
    jq -n --arg f "$1" '{full_name: $f, fork: false}'
  fi >"$FX/repo-$o-$n.json"
}

prs_fx() { # prs_fx <base owner/name> [<head owner/name> <number>]… — the open PRs in base
  local base=$1 nodes='[]'
  shift
  while [ $# -gt 1 ]; do
    nodes=$(jq -c --arg h "$1" --argjson n "$2" --arg b "$base" --arg s "$(sha "$2")" \
      '. + [{id: "PR_\($n)", number: $n, url: "https://github.com/\($b)/pull/\($n)",
        headRefOid: $s, headRepository: {nameWithOwner: $h}, baseRepository: {nameWithOwner: $b}}]' \
      <<<"$nodes")
    shift 2
  done
  jq -n --argjson n "$nodes" '{data: {repository: {pullRequests: {nodes: $n}}}}' \
    >"$FX/prs-${base%%/*}-${base#*/}.json"
}

author() { # author copilot|human|none
  case $1 in
    copilot) echo '{"__typename":"Bot","login":"copilot-pull-request-reviewer"}' ;;
    human) echo '{"__typename":"User","login":"alice"}' ;;
    none) echo null ;;
  esac
}

thread() { # thread <id> <resolved> <copilot|human> <body> — one reviewThreads node
  jq -c -n --arg id "$1" --argjson r "$2" --argjson a "$(author "$3")" --arg b "$4" \
    '{id: $id, isResolved: $r, isOutdated: false, path: "src/x.ts", line: 3,
      comments: {nodes: [{author: $a, body: $b, createdAt: "2026-09-25T12:00:00Z",
        url: "https://github.com/c/\($id)"}]}}'
}

threads_page() { # threads_page <n> <node>… — page n of reviewThreads
  local n=$1
  shift
  printf '%s\n' "$@" | jq -s '{data: {repository: {pullRequest: {reviewThreads: {
    pageInfo: {hasNextPage: false, endCursor: null}, nodes: .}}}}}' >"$FX/threads-$n.json"
}

node_fx() { # node_fx <thread id> <PR node id> <resolved> <copilot|human>
  jq -n --arg p "$2" --argjson r "$3" --argjson a "$(author "$4")" \
    '{data: {node: {__typename: "PullRequestReviewThread", isResolved: $r, pullRequest: {id: $p},
      comments: {nodes: [{author: $a}]}}}}' >"$FX/node-$1.json"
}

reviews_fx() { # reviews_fx [<copilot|human> <commit n> <state>]…
  local nodes='[]'
  while [ $# -gt 2 ]; do
    nodes=$(jq -c --argjson a "$(author "$1")" --arg c "$(sha "$2")" --arg s "$3" \
      '. + [{author: $a, state: $s, submittedAt: "2026-09-25T12:00:00Z", commit: {oid: $c}}]' \
      <<<"$nodes")
    shift 3
  done
  jq -n --argjson n "$nodes" '{data: {repository: {pullRequest: {reviews: {nodes: $n}}}}}' \
    >"$FX/reviews.json"
}

requested_fx() { # requested_fx [bot login]…
  printf '%s\n' "$@" | jq -R 'select(. != "") | {login: ., type: "Bot"}' |
    jq -s '{users: ., teams: []}' >"$FX/requested.json"
}

TRICKY='she said "fix </script> this"
	tabbed \ back'

# fresh — a new world: head repo me/r, a fork of up/r, pinned on feat/pr-branch, with one open PR
# (up/r#7). Threads: c1 Copilot, h1 human, c2 Copilot resolved, and c4 Copilot on a second page
# with a body full of JSON-hostile characters. Copilot reviewed commits 1 then 2; nothing pending.
fresh() {
  W=$(mktemp -d "$root/case.XXXXXX")
  export HOME=$W/home SHIM=$W/shim
  FX=$SHIM/fixtures
  KEY=ws-1
  POLICY_DIR=$HOME/.config/devc-bridge/policy
  BRANCH=feat/pr-branch
  mkdir -p "$HOME" "$FX"
  pin git@github.com:me/r.git "$BRANCH"
  repo_fx me/r up/r
  prs_fx up/r me/r 7
  threads_page 1 "$(thread PRRT_c1 false copilot 'use const')" \
    "$(thread PRRT_h1 false human 'why?')" "$(thread PRRT_c2 true copilot 'done')"
  threads_page 2 "$(thread PRRT_c4 false copilot "$TRICKY")"
  node_fx PRRT_c1 PR_7 false copilot
  node_fx PRRT_h1 PR_7 false human
  node_fx PRRT_c2 PR_7 true copilot
  node_fx PRRT_x9 PR_99 false copilot
  reviews_fx copilot 1 COMMENTED copilot 2 COMMENTED human 2 APPROVED
  requested_fx
  echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"url":"https://github.com/up/r/pull/7#r1"}}}}' \
    >"$FX/reply.json"
  echo '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}' >"$FX/resolve.json"
}

pin() { # pin <remote> <branch>
  mkdir -p "$POLICY_DIR"
  printf '%s\t%s\t%s\n' /Users/you/code/r "$1" "$2" >"$POLICY_DIR/$KEY.conf"
}

# run <recipe> [args…] — as the bridge would; sets $rc, $out (stdout) and $err (stderr).
run() {
  local r=$1
  shift
  out=$(PATH=$root/bin:$PATH DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR \
    "$RECIPES/$r" "$@" 2>"$W/stderr")
  rc=$?
  err=$(cat "$W/stderr")
}
expect_rc() { # expect_rc <want> <desc>
  if [ "$rc" = "$1" ]; then ok "$2 (exit $rc)"; else
    bad "$2 — want exit $1, got $rc"
    printf '%s\n%s\n' "$out" "$err" | sed 's/^/         | /'
  fi
}
has_err() { case $err in *"$1"*) return 0 ;; esac; return 1; }
q() { jq -r "$1" <<<"$out"; } # q <filter> — over pr-comments' JSON
calls() { cat "$SHIM/calls.log" 2>/dev/null; }

# ── cases ─────────────────────────────────────────────────────────────────────────────────

echo "the shared prelude"
for r in pr-reply pr-resolve; do
  check "$r's pr-prelude is byte-identical to pr-comments'" cmp -s \
    <(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/pr-comments") \
    <(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/$r")
done
check "  … and the block is not empty" test \
  "$(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/pr-comments" | wc -l)" -gt 50

echo "the caller and its policy"
for r in pr-comments pr-reply pr-resolve; do
  case $r in pr-comments) args=() ;; pr-reply) args=(PRRT_c1 hi) ;; pr-resolve) args=(PRRT_c1) ;; esac
  fresh
  rm "$POLICY_DIR/$KEY.conf"
  run "$r" "${args[@]}"
  expect_rc 2 "$r: no policy"
  fresh
  out=$(PATH=$root/bin:$PATH DEVC_BRIDGE_KEY='' DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR \
    "$RECIPES/$r" "${args[@]}" 2>/dev/null)
  rc=$?
  expect_rc 2 "$r: the shared token"
  printf 'only\ttwo\n' >"$POLICY_DIR/$KEY.conf"
  run "$r" "${args[@]}"
  expect_rc 2 "$r: a malformed policy"
  check "  … and GitHub was never asked" test -z "$(calls)"
done

echo "arguments"
fresh
run pr-comments extra
expect_rc 2 "pr-comments with an argument"
run pr-reply PRRT_c1
expect_rc 2 "pr-reply with one argument"
run pr-reply PRRT_c1 a b
expect_rc 2 "pr-reply with three"
run pr-resolve
expect_rc 2 "pr-resolve with none"
run pr-resolve PRRT_c1 PRRT_h1
expect_rc 2 "pr-resolve with two"
run pr-resolve 'PR_7'
expect_rc 2 "a thread id that is not PRRT_…"
run pr-reply '--jq=.' hi
expect_rc 2 "a thread id shaped like a flag"
check "  … none of these reached GitHub" test -z "$(calls)"

echo "remote shapes"
for remote in git@github.com:o/r.git ssh://git@github.com/o/r https://github.com/o/r.git \
  git@github.com-alias:o/r.git; do
  fresh
  pin "$remote" "$BRANCH"
  repo_fx o/r
  prs_fx o/r o/r 3
  run pr-comments
  if [ "$rc" = 0 ] && [ "$(q .pr.repo)" = o/r ]; then ok "$remote → o/r"; else
    bad "$remote — exit $rc, repo $(q .pr.repo 2>/dev/null)"
    printf '%s\n' "$err" | sed 's/^/         | /'
  fi
done
for remote in git@gitlab.com:o/r.git 'git@github.com:../r.git' 'https://github.com:8443/o/r' \
  'git@github.com:o/r/extra.git' /srv/git/r.git; do
  fresh
  pin "$remote" "$BRANCH"
  run pr-comments
  expect_rc 2 "unsupported remote $remote"
done

echo "finding the PR"
fresh
run pr-comments
expect_rc 0 "fork: the PR is in the parent"
check "  … up/r#7" test "$(q '.pr | "\(.repo)#\(.number)"')" = 'up/r#7'
check "  … headSha" test "$(q .pr.headSha)" = "$(sha 7)"
fresh
prs_fx up/r other/r 5 me/r 7
run pr-comments
expect_rc 0 "fork: another fork's same-name branch is ignored"
check "  … still up/r#7" test "$(q .pr.number)" = 7
fresh
prs_fx up/r ME/R 7
run pr-comments
expect_rc 0 "the head repo is compared case-insensitively"
fresh
prs_fx up/r
prs_fx me/r me/r 2
run pr-comments
expect_rc 0 "fork: a PR inside the fork itself is found too"
check "  … me/r#2" test "$(q '.pr | "\(.repo)#\(.number)"')" = 'me/r#2'
fresh
repo_fx me/r
prs_fx me/r me/r 4
run pr-comments
expect_rc 0 "not a fork: a PR inside the same repo"
check "  … and no parent was searched" test -z "$(calls | grep 'owner=up')"
fresh
prs_fx up/r other/r 5
run pr-comments
expect_rc 2 "no open PR with that head"
check "  … says so" has_err "no open PR with head me/r:$BRANCH"
fresh
prs_fx me/r me/r 2
run pr-comments
expect_rc 2 "two matching PRs"
check "  … lists both" has_err "https://github.com/up/r/pull/7"
check "  … lists both" has_err "https://github.com/me/r/pull/2"

echo "pr-comments"
fresh
run pr-comments
expect_rc 0 "the default world"
check "  … is one valid JSON object" jq -e 'type == "object"' <<<"$out" >/dev/null
check "  … only unresolved threads, across both pages" test "$(q '[.threads[].id] | join(",")')" = PRRT_c1,PRRT_h1,PRRT_c4
check "  … copilot flags" test "$(q '[.threads[].copilot] | join(",")')" = true,false,true
check "  … a hostile body round-trips exactly" test "$(q '.threads[2].comments[0].body')" = "$TRICKY"
check "  … comment author" test "$(q '.threads[1].comments[0].author')" = alice
check "  … copilotReview is the later Copilot review" test "$(q .copilotReview.commit)" = "$(sha 2)"
check "  … not pending" test "$(q .copilotReview.pending)" = false
reviews_fx human 1 APPROVED
run pr-comments
check "no Copilot review → commit null" test "$(q .copilotReview.commit)" = null
check "  … state null" test "$(q .copilotReview.state)" = null
requested_fx 'copilot-pull-request-reviewer[bot]'
run pr-comments
check "Copilot requested → pending true" test "$(q .copilotReview.pending)" = true
reviews_fx copilot 1 COMMENTED copilot 3 PENDING
requested_fx
run pr-comments
check "a PENDING Copilot review is not the latest" test "$(q .copilotReview.commit)" = "$(sha 1)"

echo "pr-reply"
fresh
run pr-reply PRRT_h1 'thanks, fixed in abc123'
expect_rc 0 "a human reviewer's thread"
check "  … prints the comment url" test "$out" = "replied: https://github.com/up/r/pull/7#r1"
check "  … posted with the 🤖 prefix" test "$(cat "$SHIM/posted")" = "🤖 thanks, fixed in abc123"
fresh
run pr-reply PRRT_c2 'reopening'
expect_rc 0 "a resolved thread"
fresh
run pr-reply PRRT_x9 'hi'
expect_rc 2 "a thread on another PR"
check "  … names it" has_err "thread PRRT_x9 is not on https://github.com/up/r/pull/7"
check "  … nothing posted" test ! -e "$SHIM/posted"
run pr-reply PRRT_nope 'hi'
expect_rc 2 "a thread that does not exist"
check "  … nothing posted" test ! -e "$SHIM/posted"
fresh
run pr-reply PRRT_c1 "$(printf 'a%.0s' $(seq 4000))"
expect_rc 0 "a 4000-byte body"
fresh
run pr-reply PRRT_c1 "$(printf 'a%.0s' $(seq 4001))"
expect_rc 3 "a 4001-byte body"
check "  … says how long and what to do" has_err "body is 4001 bytes; the limit is 4000 — shorten it and retry"
run pr-reply PRRT_c1 "$(printf 'é%.0s' $(seq 2001))"
expect_rc 3 "the limit is bytes, not characters (2001 × é = 4002 bytes)"
run pr-reply PRRT_c1 $'  \n\t '
expect_rc 3 "a whitespace-only body"
check "  … body is empty" has_err "body is empty"
run pr-reply PRRT_c1 $'bell\x01'
expect_rc 3 "a control character"
run pr-reply PRRT_c1 $'crlf\r\n'
expect_rc 3 "a carriage return"
check "  … no exit 3 posted anything" test ! -e "$SHIM/posted"
check "  … or reached GitHub" test -z "$(calls)"
run pr-reply PRRT_c1 $'line one\n\tindented'
expect_rc 0 "newlines and tabs are fine"
check "  … and arrive intact" test "$(cat "$SHIM/posted")" = $'🤖 line one\n\tindented'

echo "pr-resolve"
fresh
run pr-resolve PRRT_c1
expect_rc 0 "a Copilot thread"
check "  … prints it" test "$out" = "resolved: PRRT_c1"
check "  … the mutation was sent" test -e "$SHIM/resolved-PRRT_c1"
run pr-resolve PRRT_h1
expect_rc 3 "a human reviewer's thread"
check "  … says to reply instead" has_err "reply instead"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_h1"
run pr-resolve PRRT_c2
expect_rc 0 "an already-resolved Copilot thread"
check "  … says so" test "$out" = "already resolved: PRRT_c2"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_c2"
run pr-resolve PRRT_x9
expect_rc 2 "a Copilot thread on another PR"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_x9"
node_fx PRRT_n1 PR_7 false none
run pr-resolve PRRT_n1
expect_rc 3 "a thread whose author was deleted (null) is not Copilot's"

echo "how gh is driven"
fresh
run pr-comments
run pr-reply PRRT_c1 "secret-body-text"
run pr-resolve PRRT_c1
check "every call ran from /" test -z "$(calls | grep -v '^cwd=/ ')"
check "only gh api and gh auth, never gh pr" test -z "$(calls | grep -Ev '^cwd=/ (api|auth) ')"
check "no container value inside a query string" test -z "$(grep -E 'PRRT_|secret-body|pr-branch' "$SHIM/queries.log")"
check "container values go as -f, never -F" test -z "$(calls | grep -E -- "-F (id|body|branch)=")"

echo "failures"
fresh
SHIM_AUTH_RC=1 run pr-comments
expect_rc 4 "gh not authenticated"
check "  … says what to do" has_err "gh auth login"
fresh
SHIM_FAIL=reviewThreads run pr-comments
expect_rc 4 "a GitHub error"
check "  … relays gh's message" has_err "HTTP 502"
fresh
out=$(PATH=/usr/bin:/bin DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR \
  "$RECIPES/pr-comments" 2>"$W/stderr")
rc=$?
err=$(cat "$W/stderr")
if command -v -p gh >/dev/null 2>&1 || [ -x /usr/bin/gh ] || [ -x /bin/gh ]; then
  ok "gh not installed — skipped, a real gh is on /usr/bin:/bin"
else
  expect_rc 4 "gh not installed"
  check "  … says so" has_err "gh is not installed"
fi

echo "hang-proofing"
fresh
start=$(date +%s)
SHIM_SLEEP=1 DEVC_BRIDGE_GH_TIMEOUT=2 run pr-comments
took=$(($(date +%s) - start))
expect_rc 4 "a hung gh"
check "  … returns within the timeout (${took}s)" test "$took" -lt 12
check "  … says it timed out" has_err "timed out after 2s"
sleep 1
check "  … leaves no process behind" test -z "$(pgrep -f 'sleep 3[01]$' || true)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
