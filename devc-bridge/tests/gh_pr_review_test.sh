#!/usr/bin/env bash
# Offline harness for the gh-pr-comments, gh-pr-files, gh-pr-viewed, gh-pr-reply, gh-pr-resolve,
# gh-pr-request-review, gh-pr-file-at and gh-pr-pending-review built-ins. A `gh` shim first on PATH stands in for GitHub: it logs every call (cwd and argv, one
# line each) and
# answers from fixture files this script writes per case, applying `--jq` with the real `jq` — so the harness needs `jq`,
# the scripts do not. gh evaluates `--jq` with gojq, not jq: when `gojq` is on PATH the shim uses it
# instead (SHIM_JQ=jq forces jq), so run the harness both ways when you can. Runs the scripts directly with the environment the bridge would give them
# (DEVC_BRIDGE_KEY, DEVC_BRIDGE_POLICY_DIR) and a throwaway $HOME.
#
#   bash devc-bridge/tests/gh_pr_review_test.sh

# SC2016: `bash -c '…' _ "$x"` and literal expected text are single-quoted on purpose.
# shellcheck disable=SC2016
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
RECIPES=$here/../builtin
command -v jq >/dev/null || {
  echo "gh_pr_review_test: needs jq" >&2
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

root=$(mktemp -d "${TMPDIR:-/tmp}/gh-pr-review-test.XXXXXX")
trap 'rm -rf "$root"' EXIT

# ── the gh shim ───────────────────────────────────────────────────────────────────────────

mkdir -p "$root/bin"
cat >"$root/bin/gh" <<'SHIM'
#!/usr/bin/env bash
# Log, then answer from $SHIM/fixtures. SHIM_AUTH_RC fails `auth status`; SHIM_SLEEP hangs with a
# grandchild holding stdout; SHIM_FAIL (a substring of the path or query) answers with an error.
# Every `-X POST` is also logged to posts.log (path and its -f fields, one line), and every
# (un)markFileAsViewed mutation to viewed.log (`<mutation> <id> <path>`, one line). A mutation
# that posts a body writes it to `posted`.
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
jqf='' path='' query='' owner='' name='' id='' body='' fpath='' method=GET fields=''
while [ $# -gt 0 ]; do
  case $1 in
    --jq) jqf=$2 && shift 2 ;;
    --paginate) shift ;;
    -X) method=$2 && shift 2 ;;
    -f | -F)
      k=${2%%=*} v=${2#*=}
      case $k in
        query) query=$v ;; owner) owner=$v ;; name) name=$v ;; id) id=$v ;; body) body=$v ;;
        path) fpath=$v ;;
      esac
      fields+=" $2"
      shift 2
      ;;
    -*) echo "shim: unknown flag $1" >&2 && exit 99 ;;
    *) path=$1 && shift ;;
  esac
done
[ -z "$query" ] || printf '%s\n----\n' "$query" >>"$SHIM/queries.log"
[ "$method" = GET ] || printf '%s %s%s\n' "$method" "$path" "$fields" >>"$SHIM/posts.log"
if [ -n "${SHIM_FAIL:-}" ]; then
  case "$path $query" in *"$SHIM_FAIL"*) echo "HTTP 502: Bad Gateway" >&2 && exit 1 ;; esac
fi
F=$SHIM/fixtures
jqbin=${SHIM_JQ:-$(command -v gojq || echo jq)}
files=()
if [ "$path" = graphql ]; then
  case $query in
    *'pullRequests(headRefName'*)
      files=("$F/prs-$owner-$name.json")
      [ -f "${files[0]}" ] || echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}' >"${files[0]}"
      ;;
    *reviewThreads*) files=("$F"/threads-*.json) ;;
    *markFileAsViewed*)
      case $query in *unmarkFileAsViewed*) m=unmarkFileAsViewed ;; *) m=markFileAsViewed ;; esac
      printf '%s %s %s\n' "$m" "$id" "$fpath" >>"$SHIM/viewed.log"
      files=("$F/viewed.json")
      ;;
    *'files(first'*) files=("$F"/gqlfiles-*.json) ;;
    *'reviews(states:PENDING'*) files=("$F/pending.json") ;;
    *addPullRequestReviewThreadReply*)
      printf '%s' "$body" >"$SHIM/posted"
      files=("$F/reply.json")
      ;;
    *addPullRequestReviewThread*)
      printf '%s' "$body" >"$SHIM/posted"
      files=("$F/thread.json")
      ;;
    *addPullRequestReview*)
      : >"$SHIM/started"
      files=("$F/review.json")
      ;;
    *updatePullRequestReviewComment*)
      printf '%s' "$body" >"$SHIM/posted"
      files=("$F/edit.json")
      ;;
    *deletePullRequestReviewComment*)
      : >"$SHIM/deleted-$id"
      files=("$F/delcomment.json")
      ;;
    *submitPullRequestReview*)
      printf '%s' "$body" >"$SHIM/posted"
      : >"$SHIM/submitted"
      files=("$F/submit.json")
      ;;
    *deletePullRequestReview*)
      : >"$SHIM/discarded"
      files=("$F/discard.json")
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
elif [ "$method" = POST ]; then
  case $path in
    repos/*/*/pulls/*/requested_reviewers) files=("$F/request.json") ;;
  esac
elif [ "$method" = GET ]; then
  case $path in
    repos/*/*/pulls/*/files'?per_page=100')
      # restfiles-1.json, -2.json, …: one page each, as --paginate would fetch them.
      files=("$F"/restfiles-*.json)
      ;;
    repos/*/*/issues/*/timeline)
      # timeline.json is page 1, timeline-2.json (if any) page 2: --jq runs per page, as in gh.
      files=("$F/timeline.json")
      [ ! -f "$F/timeline-2.json" ] || files+=("$F/timeline-2.json")
      ;;
    # contents/<path>?ref=<sha> → contents/<owner>__<name>__contents__<path, / as __>?ref=<sha>.json
    repos/*/*/contents/*) c=${path#repos/} && files=("$F/contents/${c//\//__}.json") ;;
    repos/*/*/*) ;;
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
  if [ -n "$jqf" ]; then "$jqbin" -r "$jqf" "$f" || exit 1; else cat "$f"; fi
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
      startLine: null, diffSide: "RIGHT", startDiffSide: null, originalLine: 3,
      originalStartLine: null, subjectType: "LINE",
      comments: {nodes: [{id: "PRRC_\($id)", author: $a, body: $b, createdAt: "2026-09-25T12:00:00Z",
        url: "https://github.com/c/\($id)", diffHunk: "@@ -1,3 +1,3 @@\n a\n-b\n+c",
        state: "SUBMITTED"}]}}'
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

timeline_ev() { # timeline_ev <spec> — one timeline event, as GitHub's REST timeline sends it:
  #   copilot-requested | human-requested | human-reviewed | commit | team
  #   copilot-reviewed[:<commit n>[:<state>[:<body file in $FX> | :null]]] — default commit 2,
  #   state commented (lowercase, as the timeline has it), body "review of <n>"
  local n state body
  case $1 in
    copilot-requested) echo '{"event":"review_requested","requested_reviewer":{"login":"Copilot"}}' ;;
    human-requested) echo '{"event":"review_requested","requested_reviewer":{"login":"alice"}}' ;;
    copilot-reviewed*)
      IFS=: read -r _ n state body <<<"$1"
      n=${n:-2} state=${state:-commented}
      case $body in
        '') body=$(jq -n --arg b "review of $n" '$b') ;;
        null) body=null ;;
        *) body=$(jq -n --rawfile b "$FX/$body" '$b') ;;
      esac
      jq -c -n --arg c "$(sha "$n")" --arg s "$state" --argjson b "$body" \
        '{event: "reviewed", state: $s, user: {login: "Copilot"}, commit_id: $c,
          submitted_at: "2026-09-25T12:00:00Z", body: $b}'
      ;;
    human-reviewed) jq -c -n --arg c "$(sha 7)" \
      '{event: "reviewed", state: "approved", user: {login: "alice"}, commit_id: $c,
        submitted_at: "2026-09-25T12:00:00Z", body: ""}' ;;
    commit) echo '{"event":"committed","sha":"abc"}' ;;
    team) echo '{"event":"review_requested","requested_team":{"slug":"core"}}' ;;
  esac
}
timeline_fx() { # timeline_fx [-2] <event>… — the PR's issue timeline (page 2 with -2), oldest first
  local f=$FX/timeline.json
  [ "${1-}" != -2 ] || { f=$FX/timeline-2.json && shift; }
  local e
  for e in "$@"; do timeline_ev "$e"; done | jq -s . >"$f"
}

ZWSP=$'\xe2\x80\x8b' # U+200B ZERO WIDTH SPACE, as Copilot puts in a path after a `/`

# ccr_body <n> — a Copilot overview modelled on the measured shape: a Resolved (2) section of links,
# then "Previously missed (<n>)" holding three nested findings (so <n> ≠ 3 is a count mismatch), one
# path carrying a U+200B. Full of JSON- and printf-hostile characters.
ccr_body() {
  sev() { printf '<picture><img alt="%s severity" src="https://x/%s.svg"></picture>' "$1" "$1"; }
  cat <<BODY
<!-- ccr-overview-v2 -->
## Copilot review overview
### 🔵 Needs a closer look
Parsing is "mostly" fine — but see 100%s \\ edge cases.
**Review effort:** Balanced
**Findings:** None
<details><summary>Resolved since last review (2)</summary>

- [one](https://github.com/up/r/pull/7#discussion_r1)
- [two](https://github.com/up/r/pull/7#discussion_r2)
</details>
<details>
<summary>Previously missed ($1)</summary>
In code that hasn't changed since last review
<details>
<summary>$(sev Medium) Guard the "empty" input</summary>

\`src/${ZWSP}stats.py:11\`

An empty list reaches \`mean()\` — divide by zero; use \`%s\` \\ carefully.
</details>
<details>
<summary>$(sev Medium) Close the file</summary>

\`src/io.py:53\`

The handle leaks.
</details>
<details>
<summary>$(sev Low) Name the constant</summary>

\`src/io.py:50\`

Magic number.
</details>
</details>
BODY
}

TRICKY='she said "fix </script> this"
	tabbed \ back'

# fresh — a new world: head repo me/r, a fork of up/r, pinned on feat/pr-branch, with one open PR
# (up/r#7). Threads: c1 Copilot, h1 human, c2 Copilot resolved, and c4 Copilot on a second page
# with a body full of JSON-hostile characters. Copilot reviewed commits 1 then 2 (the head is 7);
# nothing pending.
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
  timeline_fx commit copilot-requested copilot-reviewed:1 team commit copilot-requested \
    copilot-reviewed:2 human-reviewed
  echo '{"url":"https://api.github.com/repos/up/r/pulls/7","requested_reviewers":[]}' \
    >"$FX/request.json"
  echo '{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"PRRC_reply","url":"https://github.com/up/r/pull/7#r1"}}}}' \
    >"$FX/reply.json"
  pending_fx
  echo '{"data":{"addPullRequestReview":{"pullRequestReview":{"id":"PRR_new"}}}}' >"$FX/review.json"
  echo '{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_new"}}}}' >"$FX/thread.json"
  echo '{"data":{"updatePullRequestReviewComment":{"pullRequestReviewComment":{"id":"PRRC_p1"}}}}' \
    >"$FX/edit.json"
  echo '{"data":{"deletePullRequestReviewComment":{"pullRequestReview":{"id":"PRR_p"}}}}' \
    >"$FX/delcomment.json"
  echo '{"data":{"submitPullRequestReview":{"pullRequestReview":{"id":"PRR_p","url":"https://github.com/up/r/pull/7#pullrequestreview-1"}}}}' \
    >"$FX/submit.json"
  echo '{"data":{"deletePullRequestReview":{"pullRequestReview":{"id":"PRR_p"}}}}' >"$FX/discard.json"
  mkdir -p "$FX/contents"
  echo '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}' >"$FX/resolve.json"
  echo '{"data":{"markFileAsViewed":{"clientMutationId":null}}}' >"$FX/viewed.json"
  files_fx
}

PATCH_TRICKY='@@ -1,2 +1,3 @@
-const a = "x";
+const a = "y\t%s";
+	tabbed \ back </script>'

# pending_fx [<review id> <comment id>…] — the PR's PENDING reviews: none, or the viewer's with
# those comments; someone else's pending review is listed too (GitHub hides it; the script must
# not pick it).
pending_fx() {
  local nodes='[{"id":"PRR_other","viewerDidAuthor":false,"comments":{"totalCount":1,"nodes":[{"id":"PRRC_other"}]}}]'
  if [ $# -gt 0 ]; then
    nodes=$(printf '%s\n' "${@:2}" | jq -R . | jq -s -c --arg id "$1" --argjson o "$nodes" \
      '[map(select(. != "")) as $c | {id: $id, viewerDidAuthor: true,
        comments: {totalCount: ($c | length), nodes: ($c | map({id: .}))}}] + $o')
  fi
  jq -n --argjson n "$nodes" '{data: {repository: {pullRequest: {reviews: {nodes: $n}}}}}' \
    >"$FX/pending.json"
}

# contents_fx <path as encoded in the URL> <sha n> <json> — the contents API's answer for up/r's
# head repo me/r.
contents_fx() {
  printf '%s\n' "$3" >"$FX/contents/me__r__contents__${1//\//__}?ref=$(sha "$2").json"
}

# gqlfiles_page <n> <changedFiles> <path>:<state>… — page n of the PR's GraphQL files, with the
# header fields every page carries.
gqlfiles_page() {
  local n=$1 changed=$2
  shift 2
  local e
  for e in "$@"; do jq -c -n --arg p "${e%:*}" --arg v "${e##*:}" '{path: $p, viewerViewedState: $v}'; done |
    jq -s --argjson c "$changed" '{data: {repository: {pullRequest: {title: "Fix \"it\" — all of it",
      state: "OPEN", isDraft: false, baseRefName: "main", headRefName: "feat/pr-branch",
      changedFiles: $c, author: {login: "alice"},
      files: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: .}}}}}' >"$FX/gqlfiles-$n.json"
}

# files_fx — the PR's changed files, over two pages of each API. REST (in its order): src/a.ts,
# docs/b.md (patch full of JSON-hostile characters), then on page 2 img.png (no patch), new/c.ts
# renamed from old/c.ts, and src/missing.ts, which no GraphQL page lists.
files_fx() {
  rm -f "$FX"/gqlfiles-*.json "$FX"/restfiles-*.json
  gqlfiles_page 1 5 src/a.ts:VIEWED docs/b.md:UNVIEWED
  gqlfiles_page 2 5 img.png:DISMISSED new/c.ts:VIEWED
  jq -n --arg p "$PATCH_TRICKY" '[
    {filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b",
      sha: "x", blob_url: "u"},
    {filename: "docs/b.md", status: "modified", additions: 2, deletions: 1, patch: $p}]' \
    >"$FX/restfiles-1.json"
  jq -n '[
    {filename: "img.png", status: "added", additions: 0, deletions: 0},
    {filename: "new/c.ts", previous_filename: "old/c.ts", status: "renamed", additions: 0,
      deletions: 0, patch: ""},
    {filename: "src/missing.ts", status: "removed", additions: 0, deletions: 4, patch: "@@ -1,4 +0,0 @@"}]' \
    >"$FX/restfiles-2.json"
}

# The review loop's grants plus gh-pr-viewed: resolving is Copilot-only unless a case pins
# gh-pr-resolve.
ALL_PR=gh-pr-read,gh-pr-reply,gh-pr-pending-review,gh-pr-viewed,gh-pr-resolve-copilot,gh-pr-request-review
pin() { # pin <remote> <branch> [grants, default $ALL_PR] — one line, container path /workspaces/r
  mkdir -p "$POLICY_DIR"
  printf '%s\t%s\t%s\t%s\t%s\n' /Users/you/code/r "$1" "$2" "${3:-$ALL_PR}" /workspaces/r \
    >"$POLICY_DIR/$KEY.conf"
}
pin_more() { # pin_more <repo> <remote> <branch> <grants> <target> — append a policy line
  printf '%s\t%s\t%s\t%s\t%s\n' "$@" >>"$POLICY_DIR/$KEY.conf"
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
q() { jq -r "$1" <<<"$out"; } # q <filter> — over gh-pr-comments' JSON
calls() { cat "$SHIM/calls.log" 2>/dev/null; }
posts() { cat "$SHIM/posts.log" 2>/dev/null; }

# ── cases ─────────────────────────────────────────────────────────────────────────────────

echo "the shared prelude"
for r in gh-pr-files gh-pr-viewed gh-pr-reply gh-pr-resolve gh-pr-request-review gh-pr-file-at \
  gh-pr-pending-review; do
  check "$r's pr-prelude is byte-identical to gh-pr-comments'" cmp -s \
    <(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/gh-pr-comments") \
    <(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/$r")
done
check "  … and the block is not empty" test \
  "$(sed -n '/^# ── BEGIN pr-prelude ──$/,/^# ── END pr-prelude ──$/p' "$RECIPES/gh-pr-comments" | wc -l)" -gt 50

echo "the caller and its policy"
for r in gh-pr-comments gh-pr-files gh-pr-viewed gh-pr-reply gh-pr-resolve gh-pr-request-review \
  gh-pr-file-at gh-pr-pending-review; do
  case $r in
    gh-pr-comments | gh-pr-files | gh-pr-request-review) args=() ;; gh-pr-reply) args=(PRRT_c1 hi) ;;
    gh-pr-resolve) args=(PRRT_c1) ;; gh-pr-viewed) args=(viewed src/a.ts) ;;
    gh-pr-file-at) args=("$(sha 3)" src/a.ts) ;; gh-pr-pending-review) args=(show) ;;
  esac
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
  printf '%s\t%s\t%s\n' /Users/you/code/r git@github.com:me/r.git "$BRANCH" >"$POLICY_DIR/$KEY.conf"
  run "$r" "${args[@]}"
  expect_rc 2 "$r: a three-field (pre-grants) policy"
  printf '%s\t%s\t%s\t%s\n' /Users/you/code/r git@github.com:me/r.git "$BRANCH" "$ALL_PR" \
    >"$POLICY_DIR/$KEY.conf"
  run "$r" "${args[@]}"
  expect_rc 2 "$r: a four-field (v1) policy"
  check "  … is malformed" has_err "line 1: want 5 tab-separated fields, found 4"
  pin git@github.com:me/r.git "$BRANCH" gh-push
  run "$r" "${args[@]}"
  expect_rc 2 "$r: a policy granting only gh-push"
  check "  … says which grant is missing" has_err "this container was not granted gh-pr-"
  check "  … and GitHub was never asked" test -z "$(calls)"
done
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read,gh-pr-reply
run gh-pr-resolve PRRT_c1
expect_rc 2 "gh-pr-resolve with gh-pr-reply but neither resolve grant"
check "  … names both" has_err "this container was not granted gh-pr-resolve or gh-pr-resolve-copilot"
run gh-pr-reply PRRT_c1 hi
expect_rc 0 "  … while gh-pr-reply still works"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read,gh-pr-resolve
run gh-pr-reply PRRT_c1 hi
expect_rc 2 "gh-pr-reply with gh-pr-read,gh-pr-resolve but not gh-pr-reply"
check "  … says so" has_err "this container was not granted gh-pr-reply"
check "  … and GitHub was never asked" test -z "$(calls)"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read,gh-pr-reply
run gh-pr-request-review
expect_rc 2 "gh-pr-request-review with gh-pr-read,gh-pr-reply but not gh-pr-request-review"
check "  … says so" has_err "this container was not granted gh-pr-request-review"
check "  … and GitHub was never asked" test -z "$(calls)"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read,gh-pr-request-review
run gh-pr-request-review
expect_rc 0 "gh-pr-request-review with gh-pr-read,gh-pr-request-review (no reply or resolve)"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read
run gh-pr-comments
expect_rc 0 "gh-pr-comments with only gh-pr-read"
for grants in gh-push gh-push,gh-pr-reply,gh-pr-resolve; do
  fresh
  pin git@github.com:me/r.git "$BRANCH" "$grants"
  run gh-pr-comments
  expect_rc 2 "gh-pr-comments with $grants but not gh-pr-read"
  check "  … names gh-pr-read alone" test "$err" = "gh-pr-comments: this container was not granted gh-pr-read"
done
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-reply,gh-pr-resolve,gh-pr-request-review
run gh-pr-files
expect_rc 2 "gh-pr-files without gh-pr-read"
check "  … says so" has_err "this container was not granted gh-pr-read"
check "  … and GitHub was never asked" test -z "$(calls)"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read
run gh-pr-viewed viewed src/a.ts
expect_rc 2 "gh-pr-viewed with gh-pr-read but not gh-pr-viewed"
check "  … says so" has_err "this container was not granted gh-pr-viewed"
check "  … and GitHub was never asked" test -z "$(calls)"
run gh-pr-files
expect_rc 0 "  … while gh-pr-files still works"


echo "arguments"
fresh
run gh-pr-comments extra
expect_rc 2 "gh-pr-comments with an argument"
run gh-pr-reply PRRT_c1
expect_rc 2 "gh-pr-reply with one argument"
run gh-pr-reply PRRT_c1 a b
expect_rc 2 "gh-pr-reply with three"
run gh-pr-resolve
expect_rc 2 "gh-pr-resolve with none"
run gh-pr-resolve PRRT_c1 PRRT_h1
expect_rc 2 "gh-pr-resolve with two"
run gh-pr-request-review extra
expect_rc 2 "gh-pr-request-review with an argument"
check "  … prints its usage" has_err "usage: gh-pr-request-review"
run gh-pr-resolve 'PR_7'
expect_rc 2 "a thread id that is not PRRT_…"
run gh-pr-reply '--jq=.' hi
expect_rc 2 "a thread id shaped like a flag"
check "  … none of these reached GitHub" test -z "$(calls)"

run gh-pr-reply --repo
expect_rc 2 "gh-pr-reply --repo with no value"
check "  … prints the usage" has_err "usage: gh-pr-reply [--repo <path>] [--as agent|human] <thread-id> <body>"
run gh-pr-resolve --repo /workspaces/r
expect_rc 2 "gh-pr-resolve --repo <path> and no thread"
check "  … prints the usage" has_err "usage: gh-pr-resolve [--repo <path>] <thread-id>"
run gh-pr-comments --repo=/workspaces/r
expect_rc 2 "--repo=<path> is not accepted"
check "  … prints the usage" has_err "usage: gh-pr-comments [--repo <path>] [--state unresolved|resolved|all]"
for a in "--state bogus" "--state" "--state=all" "--state all extra" "--state Unresolved" \
  "--state unresolved --state all" "all"; do
  read -ra args <<<"$a"
  run gh-pr-comments "${args[@]}"
  expect_rc 2 "gh-pr-comments $a"
  check "  … prints the usage" has_err "usage: gh-pr-comments [--repo <path>] [--state unresolved|resolved|all]"
done
run gh-pr-comments --state ''
expect_rc 2 "gh-pr-comments --state ''"
run gh-pr-comments --state all --repo /workspaces/r
expect_rc 2 "--repo after --state is not accepted"
check "  … none of these reached GitHub either" test -z "$(calls)"
run gh-pr-reply PRRT_c1 --repo
expect_rc 0 "gh-pr-reply <thread> --repo: --repo after the thread is the body"
check "  … and was posted as one" test "$(cat "$SHIM/posted")" = $'\xf0\x9f\xa4\x96 --repo'
fresh
run gh-pr-reply --repo /workspaces/r/ PRRT_c1 hi
expect_rc 0 "one pinned repo, named with --repo (and a trailing slash)"

echo "multiple pinned repos"
# fresh's me/r at /workspaces/r, then me/s (no fork, PR me/s#9, thread s1) at /workspaces/tools/s.
multi() {
  fresh
  pin_more /Users/you/code/s git@github.com:me/s.git feat/s "$ALL_PR" /workspaces/tools/s
  repo_fx me/s
  prs_fx me/s me/s 9
  node_fx PRRT_s1 PR_9 false copilot
}
for r in gh-pr-comments gh-pr-files gh-pr-viewed gh-pr-reply gh-pr-resolve gh-pr-request-review \
  gh-pr-file-at gh-pr-pending-review; do
  case $r in
    gh-pr-comments | gh-pr-files | gh-pr-request-review) args=() ;; gh-pr-reply) args=(PRRT_c1 hi) ;;
    gh-pr-resolve) args=(PRRT_c1) ;; gh-pr-viewed) args=(viewed src/a.ts) ;;
    gh-pr-file-at) args=("$(sha 3)" src/a.ts) ;; gh-pr-pending-review) args=(show) ;;
  esac
  multi
  run "$r" "${args[@]}"
  expect_rc 2 "$r: two pinned repos and no --repo"
  check "  … says to pass --repo, listing both" \
    has_err "$r: this container has 2 pinned repos — pass --repo <path>, one of: /workspaces/r, /workspaces/tools/s"
  check "  … and GitHub was never asked" test -z "$(calls)"
  run "$r" --repo /nope "${args[@]}"
  expect_rc 2 "$r: --repo naming no pinned repo"
  check "  … says so" has_err "$r: no pinned repo at /nope — pinned: /workspaces/r, /workspaces/tools/s"
done
multi
run gh-pr-reply --repo /workspaces/r PRRT_c1 hi
expect_rc 0 "gh-pr-reply --repo /workspaces/r replies on me/r's PR"
check "  … through up/r#7" test "$out" = "replied: https://github.com/up/r/pull/7#r1"
check "  … and never looked at me/s" bash -c '! grep -q "me/s\|name=s " "$1"' _ "$SHIM/calls.log"
multi
run gh-pr-reply --repo /workspaces/tools/s PRRT_s1 hi
expect_rc 0 "gh-pr-reply --repo /workspaces/tools/s replies on me/s's PR"
check "  … looking its PR up in me/s" grep -q "repos/me/s " "$SHIM/calls.log"
check "  … on branch feat/s" grep -q "branch=feat/s " "$SHIM/calls.log"
run gh-pr-reply --repo /workspaces/tools/s PRRT_c1 hi
expect_rc 2 "  … and a thread on me/r's PR is not on it"
check "  … says so" has_err "thread PRRT_c1 is not on https://github.com/me/s/pull/9"
run gh-pr-comments --repo /workspaces/r
expect_rc 0 "gh-pr-comments --repo /workspaces/r"
check "  … reads up/r#7" test "$(q .pr.number)" = 7

echo "per-line grants"
# fresh's me/r at /workspaces/r granting only gh-push, then me/s at /workspaces/tools/s granting
# the PR read and reply: each script enforces the line --repo selected.
split() {
  fresh
  pin git@github.com:me/r.git "$BRANCH" "${1:-gh-push}"
  pin_more /Users/you/code/s git@github.com:me/s.git feat/s "${2:-gh-pr-read,gh-pr-reply}" /workspaces/tools/s
  repo_fx me/s
  prs_fx me/s me/s 9
  node_fx PRRT_s1 PR_9 false copilot
  node_fx PRRT_s2 PR_9 false human
}
split
run gh-pr-reply --repo /workspaces/r PRRT_c1 hi
expect_rc 2 "gh-pr-reply on line 1, which grants only gh-push"
check "  … names the grant and the target" test "$err" = \
  "gh-pr-reply: this container was not granted gh-pr-reply for /workspaces/r"
check "  … and GitHub was never asked" test -z "$(calls)"
run gh-pr-comments --repo /workspaces/r
expect_rc 2 "gh-pr-comments on line 1"
check "  … names gh-pr-read and the target" test "$err" = \
  "gh-pr-comments: this container was not granted gh-pr-read for /workspaces/r"
run gh-pr-reply --repo /workspaces/tools/s PRRT_s1 hi
expect_rc 0 "gh-pr-reply on line 2, which grants it"
check "  … replies, looking its PR up in me/s" grep -q "repos/me/s " "$SHIM/calls.log"
check "  … and posts it" test "$(cat "$SHIM/posted")" = "🤖 hi"
run gh-pr-resolve --repo /workspaces/tools/s PRRT_s1
expect_rc 2 "gh-pr-resolve on line 2, which grants neither resolve"
check "  … names both and the target" has_err \
  "this container was not granted gh-pr-resolve or gh-pr-resolve-copilot for /workspaces/tools/s"
# The resolve scope is the selected line's: line 1 any thread, line 2 Copilot's only.
split gh-pr-read,gh-pr-resolve gh-pr-read,gh-pr-resolve-copilot
run gh-pr-resolve --repo /workspaces/tools/s PRRT_s2
expect_rc 3 "a human thread on the Copilot-only line, while line 1 resolves any"
check "  … the Copilot-only refusal" has_err "was not started by Copilot — this container has gh-pr-resolve-copilot"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_s2"
run gh-pr-resolve --repo /workspaces/tools/s PRRT_s1
expect_rc 0 "  … a Copilot thread there resolves"
run gh-pr-resolve --repo /workspaces/r PRRT_h1
expect_rc 0 "a human thread on the any-thread line"
check "  … the mutation was sent" test -e "$SHIM/resolved-PRRT_h1"
split gh-pr-read,gh-pr-resolve-copilot gh-pr-read,gh-pr-resolve
run gh-pr-resolve --repo /workspaces/tools/s PRRT_s2
expect_rc 0 "the scopes swapped: the human thread on line 2 resolves"
run gh-pr-resolve --repo /workspaces/r PRRT_h1
expect_rc 3 "  … and the one on line 1 does not"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read
run gh-pr-reply PRRT_c1 hi
expect_rc 2 "a one-line policy without gh-pr-reply"
check "  … keeps today's refusal, byte for byte" test "$err" = \
  "gh-pr-reply: this container was not granted gh-pr-reply"

echo "remote shapes"
for remote in git@github.com:o/r.git ssh://git@github.com/o/r https://github.com/o/r.git \
  git@github.com-alias:o/r.git; do
  fresh
  pin "$remote" "$BRANCH"
  repo_fx o/r
  prs_fx o/r o/r 3
  run gh-pr-comments
  if [ "$rc" = 0 ] && [ "$(q .pr.repo)" = o/r ]; then ok "$remote → o/r"; else
    bad "$remote — exit $rc, repo $(q .pr.repo 2>/dev/null)"
    printf '%s\n' "$err" | sed 's/^/         | /'
  fi
done
for remote in git@gitlab.com:o/r.git 'git@github.com:../r.git' 'https://github.com:8443/o/r' \
  'git@github.com:o/r/extra.git' https://github.com/o /srv/git/r.git; do
  fresh
  pin "$remote" "$BRANCH"
  run gh-pr-comments
  expect_rc 2 "unsupported remote $remote"
done

echo "finding the PR"
fresh
run gh-pr-comments
expect_rc 0 "fork: the PR is in the parent"
check "  … up/r#7" test "$(q '.pr | "\(.repo)#\(.number)"')" = 'up/r#7'
check "  … headSha" test "$(q .pr.headSha)" = "$(sha 7)"
fresh
prs_fx up/r other/r 5 me/r 7
run gh-pr-comments
expect_rc 0 "fork: another fork's same-name branch is ignored"
check "  … still up/r#7" test "$(q .pr.number)" = 7
fresh
prs_fx up/r ME/R 7
run gh-pr-comments
expect_rc 0 "the head repo is compared case-insensitively"
fresh
prs_fx up/r
prs_fx me/r me/r 2
run gh-pr-comments
expect_rc 0 "fork: a PR inside the fork itself is found too"
check "  … me/r#2" test "$(q '.pr | "\(.repo)#\(.number)"')" = 'me/r#2'
fresh
repo_fx me/r
prs_fx me/r me/r 4
run gh-pr-comments
expect_rc 0 "not a fork: a PR inside the same repo"
check "  … and no parent was searched" test -z "$(calls | grep 'owner=up')"
fresh
prs_fx up/r other/r 5
run gh-pr-comments
expect_rc 2 "no open PR with that head"
check "  … says so" has_err "no open PR with head me/r:$BRANCH"
fresh
prs_fx me/r me/r 2
run gh-pr-comments
expect_rc 2 "two matching PRs"
check "  … lists both" has_err "https://github.com/up/r/pull/7"
check "  … lists both" has_err "https://github.com/me/r/pull/2"

echo "gh-pr-comments"
fresh
run gh-pr-comments
expect_rc 0 "the default world"
check "  … is one valid JSON object" jq -e 'type == "object"' <<<"$out" >/dev/null
check "  … every thread by default, resolved too, across both pages" \
  test "$(q '[.threads[].id] | join(",")')" = PRRT_c1,PRRT_h1,PRRT_c2,PRRT_c4
check "  … isResolved on each" test "$(q '[.threads[].isResolved] | join(",")')" = false,false,true,false
check "  … isResolved is a boolean" test "$(q '[.threads[].isResolved | type] | unique | join(",")')" = boolean
check "  … thread key order" test "$(jq -c '.threads[0] | keys_unsorted' <<<"$out")" = \
  '["id","path","line","startLine","diffSide","startDiffSide","originalLine","originalStartLine","subjectType","diffHunk","isResolved","isOutdated","copilot","comments"]'
check "  … comment key order" test "$(jq -c '.threads[0].comments[0] | keys_unsorted' <<<"$out")" = \
  '["id","author","body","createdAt","url","pending"]'
check "  … the comment's node id" test "$(q '.threads[0].comments[0].id')" = PRRC_PRRT_c1
check "  … side, original line, subject type and hunk" test \
  "$(jq -c '.threads[0] | [.diffSide, .startDiffSide, .originalLine, .originalStartLine, .subjectType, .diffHunk]' <<<"$out")" = \
  '["RIGHT",null,3,null,"LINE","@@ -1,3 +1,3 @@\n a\n-b\n+c"]'
check "  … a submitted comment is not pending" test "$(q '.threads[0].comments[0].pending')" = false
check "  … copilot flags" test "$(q '[.threads[].copilot] | join(",")')" = true,false,true,true
check "  … a hostile body round-trips exactly" test "$(q '.threads[3].comments[0].body')" = "$TRICKY"
check "  … comment author" test "$(q '.threads[1].comments[0].author')" = alice
all_out=$out
run gh-pr-comments --state all
expect_rc 0 "--state all"
check "  … is the default's output" test "$out" = "$all_out"
run gh-pr-comments --state unresolved
expect_rc 0 "--state unresolved"
check "  … keeps the unresolved threads" test "$(q '[.threads[].id] | join(",")')" = PRRT_c1,PRRT_h1,PRRT_c4
check "  … each isResolved false" test "$(q '[.threads[].isResolved] | join(",")')" = false,false,false
check "  … copilotReview unchanged" test "$(q .copilotReview.commit)" = "$(sha 2)"
run gh-pr-comments --state resolved
expect_rc 0 "--state resolved"
check "  … keeps the resolved thread" test "$(q '[.threads[].id] | join(",")')" = PRRT_c2
check "  … isResolved true" test "$(q '.threads[0].isResolved')" = true
run gh-pr-comments --repo /workspaces/r --state resolved
expect_rc 0 "--repo <path> --state resolved"
check "  … the same thread" test "$(q '[.threads[].id] | join(",")')" = PRRT_c2
fresh
rm "$FX"/threads-*.json
threads_page 1 "$(thread PRRT_h1 true human 'why?')" "$(thread PRRT_c1 false copilot 'use const')"
run gh-pr-comments
check "one resolved and one unresolved thread: both listed by default" \
  test "$(q '[.threads[] | "\(.id)=\(.isResolved)"] | join(",")')" = PRRT_h1=true,PRRT_c1=false
run gh-pr-comments --state unresolved
check "  … --state unresolved keeps the unresolved one" test "$(q '[.threads[].id] | join(",")')" = PRRT_c1
run gh-pr-comments --state resolved
check "  … --state resolved keeps the resolved one" test "$(q '[.threads[].id] | join(",")')" = PRRT_h1
check "  … copilotReview is the later Copilot review" test "$(q .copilotReview.commit)" = "$(sha 2)"
check "  … not pending" test "$(q .copilotReview.pending)" = false
check "  … read from the timeline, not REST requested_reviewers" \
  test -z "$(calls | grep requested_reviewers)"
timeline_fx commit human-requested human-reviewed
run gh-pr-comments
check "no Copilot review → commit null" test "$(q .copilotReview.commit)" = null
check "  … state null" test "$(q .copilotReview.state)" = null
timeline_fx copilot-requested copilot-reviewed commit copilot-requested
run gh-pr-comments
check "timeline ends in a Copilot request → pending true" test "$(q .copilotReview.pending)" = true
timeline_fx copilot-requested commit team human-requested
run gh-pr-comments
check "  … other events after it do not change that" test "$(q .copilotReview.pending)" = true
timeline_fx copilot-requested copilot-reviewed
run gh-pr-comments
check "timeline ends in a Copilot review → pending false" test "$(q .copilotReview.pending)" = false
timeline_fx commit team human-requested human-reviewed
run gh-pr-comments
check "no Copilot events → pending false" test "$(q .copilotReview.pending)" = false
timeline_fx
run gh-pr-comments
check "an empty timeline → pending false" test "$(q .copilotReview.pending)" = false
timeline_fx copilot-requested copilot-reviewed human-requested
run gh-pr-comments
check "a non-Copilot request after Copilot's review → pending false" \
  test "$(q .copilotReview.pending)" = false
timeline_fx copilot-reviewed copilot-requested
timeline_fx -2 commit copilot-reviewed commit
run gh-pr-comments
check "paginated: a review on page 2 after a request on page 1 → pending false" \
  test "$(q .copilotReview.pending)" = false
timeline_fx copilot-requested copilot-reviewed
timeline_fx -2 copilot-requested commit
run gh-pr-comments
check "paginated: a request on page 2 → pending true" test "$(q .copilotReview.pending)" = true
fresh
timeline_fx copilot-requested copilot-reviewed:1 copilot-requested copilot-reviewed:3:pending
run gh-pr-comments
check "a pending Copilot review event is skipped: not the latest" \
  test "$(q .copilotReview.commit)" = "$(sha 1)"
check "  … and the request before it is still pending" test "$(q .copilotReview.pending)" = true

echo "gh-pr-comments: Copilot's review, from the timeline"
fresh
ccr_body 3 >"$FX/body-ccr"
timeline_fx copilot-requested copilot-reviewed:1:commented:body-ccr commit copilot-requested
run gh-pr-comments
expect_rc 0 "timeline ends in a request after an earlier review"
check "  … pending true" test "$(q .copilotReview.pending)" = true
check "  … commit is the earlier review's" test "$(q .copilotReview.commit)" = "$(sha 1)"
check "  … and so is body" cmp -s <(jq -j .copilotReview.body <<<"$out") "$FX/body-ccr"
timeline_fx copilot-requested copilot-reviewed:1 copilot-requested copilot-reviewed:7:commented:body-ccr
run gh-pr-comments
expect_rc 0 "timeline ends in a Copilot review of the head"
check "  … pending false" test "$(q .copilotReview.pending)" = false
check "  … commit == headSha" test "$(q .copilotReview.commit)" = "$(q .pr.headSha)"
check "  … state upper-cased to COMMENTED" test "$(q .copilotReview.state)" = COMMENTED
check "  … submittedAt verbatim" test "$(q .copilotReview.submittedAt)" = 2026-09-25T12:00:00Z
check "  … body byte-equal to the fixture (nested <details>, quotes, \\, %s, —, U+200B)" \
  cmp -s <(jq -j .copilotReview.body <<<"$out") "$FX/body-ccr"
check "  … body still holds the U+200B" test "$(jq -j .copilotReview.body <<<"$out" | grep -c "$ZWSP")" = 1
check "  … copilotReview key order" test "$(jq -c '.copilotReview | keys_unsorted' <<<"$out")" = \
  '["commit","state","submittedAt","body","findings","pending"]'
check "  … findings: 3 entries" test "$(q '.copilotReview.findings | length')" = 3
check "  … all from Previously missed, none from Resolved" \
  test "$(q '[.copilotReview.findings[].section] | unique | join(",")')" = "Previously missed"
check "  … severities" test "$(q '[.copilotReview.findings[].severity] | join(",")')" = medium,medium,low
check "  … titles" test "$(q '.copilotReview.findings[0].title')" = 'Guard the "empty" input'
check "  … paths, with no U+200B" \
  test "$(q '[.copilotReview.findings[].path] | join(",")')" = src/stats.py,src/io.py,src/io.py
check "  … (grep -c finds no U+200B)" \
  test "$(q '.copilotReview.findings[].path' | grep -c "$ZWSP")" = 0
check "  … line is a number" test "$(q '[.copilotReview.findings[].line | type] | unique | join(",")')" = number
check "  … lines" test "$(q '[.copilotReview.findings[].line] | join(",")')" = 11,53,50
check "  … text: the explanation, path span and tags removed, trimmed" \
  test "$(q '.copilotReview.findings[0].text')" = 'An empty list reaches `mean()` — divide by zero; use `%s` \ carefully.'
check "  … finding key order" test "$(jq -c '.copilotReview.findings[0] | keys_unsorted' <<<"$out")" = \
  '["section","severity","title","path","line","text"]'
check "  … the other fields are unchanged" test "$(q '[.threads[].id] | join(",")')" = PRRT_c1,PRRT_h1,PRRT_c2,PRRT_c4
ccr_body 4 >"$FX/body-ccr"
timeline_fx copilot-reviewed:7:commented:body-ccr
run gh-pr-comments
expect_rc 0 "a section count that does not match its findings"
check "  … findings null" test "$(q .copilotReview.findings)" = null
check "  … body still verbatim" cmp -s <(jq -j .copilotReview.body <<<"$out") "$FX/body-ccr"
ccr_body 3 | sed 1d >"$FX/body-plain"
timeline_fx copilot-reviewed:7:commented:body-plain
run gh-pr-comments
check "a body without the ccr-overview-v2 marker → findings null" \
  test "$(q .copilotReview.findings)" = null
check "  … body verbatim" cmp -s <(jq -j .copilotReview.body <<<"$out") "$FX/body-plain"
printf '%s\n' '<!-- ccr-overview-v2 -->' '## Copilot review overview' \
  '<details><summary>Resolved since last review (2)</summary>' '- one' '- two' '</details>' \
  >"$FX/body-resolved"
timeline_fx copilot-reviewed:7:commented:body-resolved
run gh-pr-comments
check "a marked body whose only section is Resolved since last review → findings []" \
  test "$(jq -c .copilotReview.findings <<<"$out")" = '[]'
ccr_body 3 | sed '$d' >"$FX/body-unclosed"
timeline_fx copilot-reviewed:7:commented:body-unclosed
run gh-pr-comments
expect_rc 0 "a body with an unclosed <details>"
check "  … findings null" test "$(q .copilotReview.findings)" = null
printf '%s\n' '<!-- ccr-overview-v2 -->' '</details><details>' >"$FX/body-stray"
timeline_fx copilot-reviewed:7:commented:body-stray
run gh-pr-comments
expect_rc 0 "a body with a stray </details>"
check "  … findings null" test "$(q .copilotReview.findings)" = null
# A top-level <details> that isn't a `<name> (<n>)` section is an unknown format, never skipped:
# skipping it could turn open findings into [] ("no open findings").
ccr_body 3 | sed 's|<summary>Previously missed (3)</summary>|<p>Previously missed</p>|' >"$FX/body-nosummary"
ccr_body 3 | sed 's|Previously missed (3)|Previously missed|' >"$FX/body-nocount"
ccr_body 3 | sed 's|Previously missed (3)|Previously missed (3 comments)|' >"$FX/body-oddcount"
for shape in nosummary:"with no <summary>" nocount:"whose summary has no count" \
  oddcount:"whose count is not a bare number"; do
  timeline_fx copilot-reviewed:7:commented:body-"${shape%%:*}"
  run gh-pr-comments
  expect_rc 0 "a top-level <details> ${shape#*:}"
  check "  … findings null" test "$(q .copilotReview.findings)" = null
  check "  … body verbatim" cmp -s <(jq -j .copilotReview.body <<<"$out") "$FX/body-${shape%%:*}"
done
timeline_fx copilot-reviewed:7:commented:null
run gh-pr-comments
expect_rc 0 "a review whose body is null"
check "  … body \"\"" test "$(jq -c .copilotReview.body <<<"$out")" = '""'
check "  … findings null" test "$(q .copilotReview.findings)" = null
timeline_fx commit human-requested human-reviewed
run gh-pr-comments
expect_rc 0 "no Copilot events"
check "  … commit, state, submittedAt, body, findings all null; pending false" \
  test "$(jq -c '.copilotReview' <<<"$out")" = \
  '{"commit":null,"state":null,"submittedAt":null,"body":null,"findings":null,"pending":false}'
timeline_fx copilot-requested copilot-reviewed:1
timeline_fx -2 commit copilot-requested copilot-reviewed:7:commented:body-ccr
run gh-pr-comments
check "the head's review on page 2 is found" test "$(q .copilotReview.commit)" = "$(sha 7)"
check "  … pending false" test "$(q .copilotReview.pending)" = false
timeline_fx copilot-reviewed:7:commented
run gh-pr-comments
check "a review of a plain (non-overview) body → findings null" test "$(q .copilotReview.findings)" = null
jq -c -n '{event: "reviewed", state: "commented", user: {login: "Copilot"}, commit_id: "nope",
  submitted_at: "2026-09-25T12:00:00Z", body: ""}' | jq -s . >"$FX/timeline.json"
rm -f "$FX/timeline-2.json"
run gh-pr-comments
expect_rc 4 "a review commit that is not 40 hex"
check "  … the GraphQL reviews query is never sent" test -z "$(grep -F 'reviews(last' "$SHIM/queries.log")"

echo "gh-pr-reply"
fresh
run gh-pr-reply PRRT_h1 'thanks, fixed in abc123'
expect_rc 0 "a human reviewer's thread"
check "  … prints the comment url" test "$out" = "replied: https://github.com/up/r/pull/7#r1"
check "  … posted with the 🤖 prefix" test "$(cat "$SHIM/posted")" = "🤖 thanks, fixed in abc123"
fresh
run gh-pr-reply PRRT_c2 'reopening'
expect_rc 0 "a resolved thread"
fresh
run gh-pr-reply PRRT_x9 'hi'
expect_rc 2 "a thread on another PR"
check "  … names it" has_err "thread PRRT_x9 is not on https://github.com/up/r/pull/7"
check "  … nothing posted" test ! -e "$SHIM/posted"
run gh-pr-reply PRRT_nope 'hi'
expect_rc 2 "a thread that does not exist"
check "  … nothing posted" test ! -e "$SHIM/posted"
fresh
run gh-pr-reply PRRT_c1 "$(printf 'a%.0s' $(seq 4000))"
expect_rc 0 "a 4000-byte body"
fresh
run gh-pr-reply PRRT_c1 "$(printf 'a%.0s' $(seq 4001))"
expect_rc 3 "a 4001-byte body"
check "  … says how long and what to do" has_err "body is 4001 bytes; the limit is 4000 — shorten it and retry"
run gh-pr-reply PRRT_c1 "$(printf 'é%.0s' $(seq 2001))"
expect_rc 3 "the limit is bytes, not characters (2001 × é = 4002 bytes)"
run gh-pr-reply PRRT_c1 $'  \n\t '
expect_rc 3 "a whitespace-only body"
check "  … body is empty" has_err "body is empty"
run gh-pr-reply PRRT_c1 $'bell\x01'
expect_rc 3 "a control character"
run gh-pr-reply PRRT_c1 $'crlf\r\n'
expect_rc 3 "a carriage return"
check "  … no exit 3 posted anything" test ! -e "$SHIM/posted"
check "  … or reached GitHub" test -z "$(calls)"
run gh-pr-reply PRRT_c1 $'line one\n\tindented'
expect_rc 0 "newlines and tabs are fine"
check "  … and arrive intact" test "$(cat "$SHIM/posted")" = $'🤖 line one\n\tindented'

echo "gh-pr-resolve"
fresh
run gh-pr-resolve PRRT_c1
expect_rc 0 "a Copilot thread"
check "  … prints it" test "$out" = "resolved: PRRT_c1"
check "  … the mutation was sent" test -e "$SHIM/resolved-PRRT_c1"
run gh-pr-resolve PRRT_h1
expect_rc 3 "a human reviewer's thread, with gh-pr-resolve-copilot only"
check "  … the exact refusal" test "$err" = \
  "gh-pr-resolve: refused: thread PRRT_h1 was not started by Copilot — this container has gh-pr-resolve-copilot, which resolves only Copilot's threads; reply instead"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_h1"
for grants in gh-pr-read,gh-pr-resolve gh-pr-read,gh-pr-resolve,gh-pr-resolve-copilot; do
  fresh
  pin git@github.com:me/r.git "$BRANCH" "$grants"
  run gh-pr-resolve PRRT_h1
  expect_rc 0 "a human reviewer's thread, with $grants"
  check "  … prints it" test "$out" = "resolved: PRRT_h1"
  check "  … the mutation was sent" test -e "$SHIM/resolved-PRRT_h1"
  run gh-pr-resolve PRRT_c1
  expect_rc 0 "  … and a Copilot thread"
  run gh-pr-resolve PRRT_c2
  expect_rc 0 "  … an already-resolved thread"
  check "  … says so" test "$out" = "already resolved: PRRT_c2"
  node_fx PRRT_n1 PR_7 false none
  run gh-pr-resolve PRRT_n1
  expect_rc 0 "  … a thread whose author was deleted"
  run gh-pr-resolve PRRT_x9
  expect_rc 2 "  … but never a thread on another PR"
  check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_x9"
done
fresh
run gh-pr-resolve PRRT_c2
expect_rc 0 "an already-resolved Copilot thread"
check "  … says so" test "$out" = "already resolved: PRRT_c2"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_c2"
run gh-pr-resolve PRRT_x9
expect_rc 2 "a Copilot thread on another PR"
check "  … no mutation" test ! -e "$SHIM/resolved-PRRT_x9"
node_fx PRRT_n1 PR_7 false none
run gh-pr-resolve PRRT_n1
expect_rc 3 "a thread whose author was deleted (null) is not Copilot's"

echo "gh-pr-request-review"
fresh
run gh-pr-request-review
expect_rc 0 "Copilot's latest review is older than the head"
check "  … prints what it requested" \
  test "$out" = "requested: Copilot review of $(sha 7 | cut -c1-12) on https://github.com/up/r/pull/7"
check "  … exactly one POST, to the PR's requested_reviewers, naming the bot" test "$(posts)" = \
  "POST repos/up/r/pulls/7/requested_reviewers reviewers[]=copilot-pull-request-reviewer[bot]"
fresh
timeline_fx commit human-reviewed
run gh-pr-request-review
expect_rc 0 "no Copilot review yet"
check "  … requests one" test "$(posts | wc -l | tr -d ' ')" = 1
fresh
timeline_fx copilot-reviewed commit copilot-requested
run gh-pr-request-review
expect_rc 0 "a Copilot review is already pending"
check "  … says so" test "$out" = "pending: Copilot is already reviewing https://github.com/up/r/pull/7"
check "  … no POST" test -z "$(posts)"
fresh
timeline_fx copilot-reviewed:1 copilot-requested copilot-reviewed:7
run gh-pr-request-review
expect_rc 0 "Copilot's latest review is of the head"
check "  … says so" test "$out" = \
  "up to date: Copilot already reviewed $(sha 7 | cut -c1-12) on https://github.com/up/r/pull/7"
check "  … no POST" test -z "$(posts)"
fresh
timeline_fx copilot-requested copilot-reviewed:7 copilot-reviewed:8:PENDING
run gh-pr-request-review
expect_rc 0 "a PENDING (draft) Copilot review does not count as the latest"
check "  … still up to date" test "${out%% *}" = up
fresh
SHIM_FAIL=requested_reviewers run gh-pr-request-review
expect_rc 4 "the request failing"
check "  … relays gh's message" has_err "HTTP 502"
check "  … prints nothing on stdout" test -z "$out"
fresh
SHIM_FAIL=timeline run gh-pr-request-review
expect_rc 4 "the timeline read failing"
check "  … no POST" test -z "$(posts)"

echo "gh-pr-files"
fresh
run gh-pr-files
expect_rc 0 "two pages of each API"
want_pr='{"repo":"up/r","number":7,"url":"https://github.com/up/r/pull/7","headSha":"'"$(sha 7)"'","title":"Fix \"it\" — all of it","state":"OPEN","isDraft":false,"author":"alice","baseRef":"main","headRef":"feat/pr-branch","changedFiles":5}'
check "  … pr: every field, in contract order" test "$(jq -c .pr <<<"$out")" = "$want_pr"
check "  … pr is emitted verbatim in that order" test "${out:0:6}" = '{"pr":'
check "  … top-level key order" test "$(jq -c keys_unsorted <<<"$out")" = '["pr","files","truncated"]'
check "  … files in REST order, across both pages" \
  test "$(q '[.files[].path] | join(",")')" = src/a.ts,docs/b.md,img.png,new/c.ts,src/missing.ts
check "  … viewed joined from both GraphQL pages" \
  test "$(q '[.files[].viewed] | join(",")')" = VIEWED,UNVIEWED,DISMISSED,VIEWED,UNVIEWED
check "  … a path no GraphQL page lists is UNVIEWED" test "$(q '.files[4].viewed')" = UNVIEWED
check "  … file key order" test "$(jq -c '.files[0] | keys_unsorted' <<<"$out")" = \
  '["path","previousPath","status","additions","deletions","patch","viewed"]'
check "  … a file, exactly" test "$(jq -c '.files[0]' <<<"$out")" = \
  '{"path":"src/a.ts","previousPath":null,"status":"modified","additions":3,"deletions":1,"patch":"@@ -1 +1 @@\n-a\n+b","viewed":"VIEWED"}'
check "  … a hostile patch round-trips exactly" test "$(q '.files[1].patch')" = "$PATCH_TRICKY"
check "  … no patch is null" test "$(jq -c '.files[2].patch' <<<"$out")" = null
check "  … a rename keeps previousPath" test "$(q '.files[3].previousPath')" = old/c.ts
check "  … truncated false when every file is listed" test "$(q .truncated)" = false
check "  … one line on stdout" test "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1
check "  … no container value in a query string" test -z "$(grep -E 'pr-branch' "$SHIM/queries.log")"
fresh
gqlfiles_page 1 5 src/a.ts:VIEWED
rm -f "$FX/gqlfiles-2.json"
jq -n '{data: {repository: {pullRequest: {title: "t", state: "OPEN", isDraft: true,
  baseRefName: "main", headRefName: "x", changedFiles: 5, author: null,
  files: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: []}}}}}' >"$FX/gqlfiles-1.json"
run gh-pr-files
expect_rc 0 "a deleted author, a draft, and no Viewed state at all"
check "  … author null" test "$(jq -c .pr.author <<<"$out")" = null
check "  … isDraft true" test "$(q .pr.isDraft)" = true
check "  … every file UNVIEWED" test "$(q '[.files[].viewed] | unique | join(",")')" = UNVIEWED
fresh
gqlfiles_page 1 3001
rm -f "$FX"/gqlfiles-2.json "$FX"/restfiles-*.json
jq -n '[range(3000) | {filename: "f/\(.)", status: "added", additions: 1, deletions: 0,
  patch: "@@ -0,0 +1 @@"}]' >"$FX/restfiles-1.json"
run gh-pr-files
expect_rc 0 "changedFiles 3001, 3000 listed"
check "  … truncated true" test "$(q .truncated)" = true
check "  … all 3000 listed" test "$(q '.files | length')" = 3000
fresh
files_fx
jq -n '[]' >"$FX/restfiles-1.json"
rm -f "$FX/restfiles-2.json"
gqlfiles_page 1 0
rm -f "$FX/gqlfiles-2.json"
run gh-pr-files
expect_rc 0 "a PR with no files"
check "  … files []" test "$(jq -c .files <<<"$out")" = '[]'
check "  … truncated false" test "$(q .truncated)" = false
fresh
run gh-pr-files extra
expect_rc 2 "gh-pr-files with an argument"
check "  … prints its usage" has_err "usage: gh-pr-files [--repo <path>]"
run gh-pr-files --repo /workspaces/r extra
expect_rc 2 "gh-pr-files with an argument after --repo <path>"
fresh
run gh-pr-files --repo /workspaces/r
expect_rc 0 "gh-pr-files --repo <path>"
fresh
SHIM_FAIL=files run gh-pr-files
expect_rc 4 "a GitHub error"
check "  … relays gh's message" has_err "HTTP 502"
check "  … prints nothing on stdout" test -z "$out"

echo "gh-pr-viewed"
viewed_log() { cat "$SHIM/viewed.log" 2>/dev/null; }
fresh
run gh-pr-viewed viewed src/a.ts
expect_rc 0 "viewed src/a.ts"
check "  … prints the result, with the head it was marked at" test "$out" = \
  '{"path":"src/a.ts","viewed":"VIEWED","headSha":"'"$(sha 7)"'"}'
check "  … sends markFileAsViewed with the PR's id and that path" \
  test "$(viewed_log)" = "markFileAsViewed PR_7 src/a.ts"
check "  … the path goes as -f, never in the query" test -z "$(grep -F 'src/a.ts' "$SHIM/queries.log")"
check "  … the id goes as -f" grep -qF -- "-f id=PR_7 -f path=src/a.ts" "$SHIM/calls.log"
fresh
run gh-pr-viewed unviewed new/c.ts
expect_rc 0 "unviewed a file on the second GraphQL page"
check "  … prints the result" test "$out" = \
  '{"path":"new/c.ts","viewed":"UNVIEWED","headSha":"'"$(sha 7)"'"}'
check "  … sends unmarkFileAsViewed" test "$(viewed_log)" = "unmarkFileAsViewed PR_7 new/c.ts"
fresh
gqlfiles_page 2 5 'a "quoted" \ path.ts:VIEWED'
run gh-pr-viewed viewed 'a "quoted" \ path.ts'
expect_rc 0 "a path with quotes and a backslash"
check "  … JSON-encoded" test "$(q .path)" = 'a "quoted" \ path.ts'
fresh
run gh-pr-viewed viewed src/missing.ts
expect_rc 2 "a path GraphQL does not list"
check "  … says so" has_err "src/missing.ts is not a file in https://github.com/up/r/pull/7"
check "  … no mutation" test -z "$(viewed_log)"
run gh-pr-viewed viewed src/a
expect_rc 2 "a prefix of a path is not that path"
run gh-pr-viewed viewed 'src/a.t.'
expect_rc 2 "a path is matched exactly, not as a pattern"
check "  … no mutation" test -z "$(viewed_log)"
fresh
run gh-pr-viewed viewed $'src/a.ts\nsrc/a.ts'
expect_rc 2 "a path with a newline"
check "  … prints the usage" has_err "usage: gh-pr-viewed [--repo <path>] <viewed|unviewed> <file>"
run gh-pr-viewed viewed src/a.ts extra
expect_rc 2 "a third argument"
run gh-pr-viewed seen src/a.ts
expect_rc 2 "seen in place of viewed"
run gh-pr-viewed viewed ''
expect_rc 2 "an empty path"
run gh-pr-viewed viewed "$(printf 'a%.0s' $(seq 4097))"
expect_rc 2 "a 4097-byte path"
run gh-pr-viewed viewed
expect_rc 2 "no path"
check "  … none of these reached GitHub" test -z "$(calls)"
check "  … or sent a mutation" test -z "$(viewed_log)"
fresh
run gh-pr-viewed --repo /workspaces/r viewed src/a.ts
expect_rc 0 "gh-pr-viewed --repo <path>"
fresh
SHIM_FAIL=markFileAsViewed run gh-pr-viewed viewed src/a.ts
expect_rc 4 "the mutation failing"
check "  … relays gh's message" has_err "HTTP 502"
check "  … prints nothing on stdout" test -z "$out"

echo "--as agent|human"
fresh
run gh-pr-reply --as agent PRRT_c1 hi
expect_rc 0 "gh-pr-reply --as agent"
check "  … posts with the 🤖 prefix" test "$(cat "$SHIM/posted")" = "🤖 hi"
fresh
run gh-pr-reply --as human PRRT_c1 hi
expect_rc 0 "gh-pr-reply --as human"
check "  … posts the body as written" test "$(cat "$SHIM/posted")" = "hi"
fresh
run gh-pr-reply --repo /workspaces/r --as human PRRT_c1 hi
expect_rc 0 "--repo <path> --as human"
check "  … as written" test "$(cat "$SHIM/posted")" = "hi"
fresh
for a in "--as bot PRRT_c1 hi" "--as" "PRRT_c1 hi --as" "--as human --repo /workspaces/r PRRT_c1 hi" \
  "--as=human PRRT_c1 hi" "--as Human PRRT_c1 hi"; do
  read -ra args <<<"$a"
  run gh-pr-reply "${args[@]}"
  expect_rc 2 "gh-pr-reply $a"
done
check "  … prints the usage" has_err "usage: gh-pr-reply [--repo <path>] [--as agent|human] <thread-id> <body>"
check "  … none of these posted" test ! -e "$SHIM/posted"
check "  … or reached GitHub" test -z "$(calls)"
run gh-pr-reply PRRT_c1 --as
expect_rc 0 "a body that is literally --as"
check "  … is a body" test "$(cat "$SHIM/posted")" = "🤖 --as"
fresh
run gh-pr-comments --as human
expect_rc 2 "a command that posts nothing takes no --as"

echo "gh-pr-comments: sides, file comments, outdated and pending"
fresh
rm "$FX"/threads-*.json
left=$(thread PRRT_l1 false human 'old line' | jq -c '.line = 5 | .diffSide = "LEFT" | .originalLine = 5')
filec=$(thread PRRT_f1 false human 'whole file' | jq -c '.line = null | .originalLine = null |
  .subjectType = "FILE" | .comments.nodes[0].diffHunk = null')
outd=$(thread PRRT_o1 false human 'moved' | jq -c '.line = null | .isOutdated = true |
  .originalLine = 9 | .originalStartLine = 7 | .startDiffSide = "RIGHT"')
pend=$(thread PRRT_p1 false human 'draft' | jq -c '.comments.nodes[0].state = "PENDING"')
threads_page 1 "$left" "$filec" "$outd" "$pend"
run gh-pr-comments
expect_rc 0 "four kinds of thread"
check "  … a LEFT thread keeps its side and old-file line" \
  test "$(q '.threads[0] | "\(.diffSide) \(.line)"')" = "LEFT 5"
check "  … a file comment is FILE with no line" \
  test "$(q '.threads[1] | "\(.subjectType) \(.line)"')" = "FILE null"
check "  … a comment with no hunk has diffHunk \"\"" test "$(jq -c '.threads[1].diffHunk' <<<"$out")" = '""'
check "  … an outdated thread keeps where it was" \
  test "$(q '.threads[2] | "\(.line) \(.originalStartLine)-\(.originalLine) \(.startDiffSide)"')" = "null 7-9 RIGHT"
check "  … its hunk" test "$(q '.threads[2].diffHunk')" = $'@@ -1,3 +1,3 @@\n a\n-b\n+c'
check "  … a PENDING comment is pending" test "$(q '.threads[3].comments[0].pending')" = true
check "  … others are not" test "$(q '[.threads[0:3][].comments[].pending] | unique | join(",")')" = false

echo "gh-pr-file-at"
b64() { printf '%s' "$1" | base64 | tr -d '\n' | fold -w 60; } # GitHub wraps its base64
filejson() { # filejson <bytes> — a contents API file answer
  jq -n --arg c "$(b64 "$1")" --argjson s "$(printf '%s' "$1" | wc -c)" \
    '{type: "file", encoding: "base64", size: $s, content: $c, path: "x"}'
}
fresh
TEXT=$'line "one" \\ \t%s\r\nline two </script>\n\n'
contents_fx src/a.ts 3 "$(filejson "$TEXT")"
run gh-pr-file-at "$(sha 3)" src/a.ts
expect_rc 0 "a text file"
check "  … path, sha, content in that order" test "$(jq -c keys_unsorted <<<"$out")" = '["path","sha","content"]'
check "  … the content round-trips exactly (quotes, \\, tab, CRLF, trailing newlines)" \
  cmp -s <(jq -j .content <<<"$out") <(printf '%s' "$TEXT")
check "  … sha" test "$(q .sha)" = "$(sha 3)"
check "  … read from the head repo me/r, not the base up/r" \
  grep -qF "repos/me/r/contents/src/a.ts\?ref=$(sha 3)" "$SHIM/calls.log" # %q escapes ?
check "  … one line on stdout" test "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1
contents_fx old/c.ts 3 "$(filejson 'before')"
run gh-pr-file-at "$(sha 3)" old/c.ts
expect_rc 0 "the path a renamed file had"
check "  … its content" test "$(q .content)" = before
contents_fx src/empty.ts 3 "$(filejson '')"
jq '. + [{filename: "src/empty.ts", status: "added", additions: 0, deletions: 0}]' \
  "$FX/restfiles-2.json" >"$FX/r2" && mv "$FX/r2" "$FX/restfiles-2.json"
run gh-pr-file-at "$(sha 3)" src/empty.ts
expect_rc 0 "an empty file"
check "  … content \"\"" test "$(jq -c .content <<<"$out")" = '""'
run gh-pr-file-at "$(sha 4)" src/a.ts
expect_rc 0 "a commit that has no such file (404)"
check "  … missing" test "$out" = '{"path":"src/a.ts","sha":"'"$(sha 4)"'","missing":true}'
contents_fx src/a.ts 5 '[{"type":"file","name":"x"}]'
run gh-pr-file-at "$(sha 5)" src/a.ts
expect_rc 0 "a directory at that path"
check "  … missing" test "$(q .missing)" = true
contents_fx src/a.ts 6 '{"type":"submodule","size":0}'
run gh-pr-file-at "$(sha 6)" src/a.ts
check "a submodule → missing" test "$(q .missing)" = true
contents_fx src/a.ts 8 "$(filejson $'nul\x01' | jq --arg c "$(printf 'a\000b' | base64)" '.content = $c')"
run gh-pr-file-at "$(sha 8)" src/a.ts
expect_rc 0 "bytes holding a NUL"
check "  … binary" test "$out" = '{"path":"src/a.ts","sha":"'"$(sha 8)"'","binary":true}'
contents_fx src/a.ts 9 "$(filejson x | jq --arg c "$(printf 'caf\351' | base64)" '.content = $c')"
run gh-pr-file-at "$(sha 9)" src/a.ts
check "bytes that are not UTF-8 → binary" test "$(q .binary)" = true
contents_fx src/a.ts 1 '{"type":"file","encoding":"none","size":2000000,"content":""}'
run gh-pr-file-at "$(sha 1)" src/a.ts
expect_rc 0 "over 1 MB"
check "  … tooLarge" test "$out" = '{"path":"src/a.ts","sha":"'"$(sha 1)"'","tooLarge":true}'
fresh
jq -n '[{filename: "dir/a b é#?.ts", status: "added", additions: 1, deletions: 0}]' >"$FX/restfiles-3.json"
contents_fx 'dir/a%20b%20%C3%A9%23%3F.ts' 3 "$(filejson 'ok')"
run gh-pr-file-at "$(sha 3)" 'dir/a b é#?.ts'
expect_rc 0 "a path with a space, é, # and ?"
check "  … each segment percent-encoded, / kept" \
  grep -qF "repos/me/r/contents/dir/a%20b%20%C3%A9%23%3F.ts\?ref=$(sha 3)" "$SHIM/calls.log"
check "  … the path printed as given" test "$(q .path)" = 'dir/a b é#?.ts'
fresh
for a in "$(sha 3 | cut -c1-39) src/a.ts" "$(sha 3 | tr 0 A) src/a.ts" "HEAD src/a.ts" \
  "$(sha 3)" "$(sha 3) src/a.ts extra"; do
  read -ra args <<<"$a"
  run gh-pr-file-at "${args[@]}"
  expect_rc 2 "gh-pr-file-at $a"
done
run gh-pr-file-at "$(sha 3)" $'src/a.ts\nx'
expect_rc 2 "a path with a newline"
check "  … none of these reached GitHub" test -z "$(calls)"
run gh-pr-file-at "$(sha 3)" src/nope.ts
expect_rc 2 "a file not in the PR"
check "  … says so" has_err "src/nope.ts is not a file in https://github.com/up/r/pull/7"
check "  … and never read its contents" test -z "$(calls | grep contents)"
run gh-pr-file-at "$(sha 3)" src/a
expect_rc 2 "a prefix of a path is not that path"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-push
run gh-pr-file-at "$(sha 3)" src/a.ts
expect_rc 2 "without gh-pr-read"
fresh
contents_fx src/a.ts 3 "$(filejson x)"
SHIM_FAIL=contents run gh-pr-file-at "$(sha 3)" src/a.ts
expect_rc 4 "a GitHub error other than 404"
check "  … relays gh's message" has_err "HTTP 502"
check "  … prints nothing on stdout" test -z "$out"

echo "gh-pr-pending-review"
fresh
run gh-pr-pending-review show
expect_rc 0 "show with no pending review of yours (someone else's is listed)"
check "  … review null" test "$out" = '{"review":null}'
pending_fx PRR_p PRRC_p1 PRRC_p2
run gh-pr-pending-review show
expect_rc 0 "show with yours"
check "  … its id and comment count" test "$out" = '{"review":{"id":"PRR_p","comments":2}}'
fresh
run gh-pr-pending-review comment src/a.ts 3 RIGHT 'use const'
expect_rc 0 "comment with no pending review"
check "  … starts one" test -e "$SHIM/started"
check "  … at the PR's head, on the PR" grep -qF -- "-f id=PR_7 -f commit=$(sha 7)" "$SHIM/calls.log"
check "  … prints the review and thread" test "$out" = '{"review":"PRR_new","thread":"PRRT_new"}'
check "  … posted with the 🤖 prefix" test "$(cat "$SHIM/posted")" = "🤖 use const"
check "  … line, side and path as variables" \
  grep -qF -- "-f review=PRR_new -f path=src/a.ts -F line=3 -f side=RIGHT" "$SHIM/calls.log"
check "  … no startLine" test -z "$(grep -F 'startLine' "$SHIM/queries.log")"
fresh
pending_fx PRR_p PRRC_p1
run gh-pr-pending-review --as human comment src/a.ts 3 LEFT --start 1 'block'
expect_rc 0 "--as human, a block on the LEFT side, with a review pending"
check "  … does not start another" test ! -e "$SHIM/started"
check "  … adds to the pending one" grep -qF -- "-f review=PRR_p" "$SHIM/calls.log"
check "  … startLine and startSide" grep -qF 'startLine:$start,startSide:$side' "$SHIM/queries.log"
check "  … start 1, side LEFT" grep -qF -- "-F line=3 -f side=LEFT -F start=1" "$SHIM/calls.log"
check "  … posted as written" test "$(cat "$SHIM/posted")" = "block"
fresh
for a in "comment src/a.ts 3 MIDDLE x" "comment src/a.ts 0 RIGHT x" "comment src/a.ts 3x RIGHT x" \
  "comment src/a.ts 3 RIGHT --start 3 x" "comment src/a.ts 3 RIGHT --start 4 x" \
  "comment src/a.ts 3 RIGHT" "comment src/a.ts 3 RIGHT x y" "reply PR_7 x" "edit bad/id x" \
  "delete" "submit extra" "submit --body" "discard now" "approve" "" "show extra"; do
  read -ra args <<<"$a"
  run gh-pr-pending-review "${args[@]}"
  expect_rc 2 "gh-pr-pending-review $a"
done
check "  … prints the usage" has_err "usage: gh-pr-pending-review"
check "  … none of these reached GitHub" test -z "$(calls)"
run gh-pr-pending-review comment src/a.ts 3 RIGHT $'  \n'
expect_rc 3 "a blank comment"
run gh-pr-pending-review reply PRRT_c1 "$(printf 'a%.0s' $(seq 4001))"
expect_rc 3 "a 4001-byte reply"
run gh-pr-pending-review submit --body $'bell\x01'
expect_rc 3 "a review body with a control character"
check "  … none reached GitHub" test -z "$(calls)"
run gh-pr-pending-review comment src/nope.ts 3 RIGHT x
expect_rc 2 "a file not in the PR"
check "  … no review started" test ! -e "$SHIM/started"
fresh
run gh-pr-pending-review reply PRRT_h1 'agreed'
expect_rc 0 "reply to a thread on the PR"
check "  … starts a review" test -e "$SHIM/started"
check "  … prints the review and the comment" test "$out" = '{"review":"PRR_new","comment":"PRRC_reply"}'
check "  … the reply names the review" grep -qF -- "-f thread=PRRT_h1 -f review=PRR_new" "$SHIM/calls.log"
check "  … prefixed" test "$(cat "$SHIM/posted")" = "🤖 agreed"
fresh
run gh-pr-pending-review reply PRRT_x9 'x'
expect_rc 2 "reply to a thread on another PR"
check "  … nothing posted" test ! -e "$SHIM/posted"
check "  … no review started" test ! -e "$SHIM/started"
fresh
pending_fx PRR_p PRRC_p1
run gh-pr-pending-review edit PRRC_p1 'better'
expect_rc 0 "edit a pending comment"
check "  … prints it" test "$out" = '{"comment":"PRRC_p1"}'
check "  … posted" test "$(cat "$SHIM/posted")" = "🤖 better"
fresh
pending_fx PRR_p PRRC_p1
run gh-pr-pending-review edit PRRC_other 'x'
expect_rc 3 "edit someone else's pending comment"
check "  … refused" has_err "refused: PRRC_other is not a comment in your pending review"
check "  … nothing posted" test ! -e "$SHIM/posted"
run gh-pr-pending-review edit PRRC_submitted 'x'
expect_rc 3 "edit a comment that is not pending"
run gh-pr-pending-review delete PRRC_submitted
expect_rc 3 "delete a comment that is not pending"
check "  … no deletion" test -z "$(ls "$SHIM" | grep deleted-)"
run gh-pr-pending-review delete PRRC_p1
expect_rc 0 "delete a pending comment"
check "  … prints it" test "$out" = '{"comment":"PRRC_p1"}'
check "  … deleted" test -e "$SHIM/deleted-PRRC_p1"
fresh
run gh-pr-pending-review submit
expect_rc 3 "submit with no pending review"
check "  … says so" has_err "no pending review on https://github.com/up/r/pull/7"
run gh-pr-pending-review discard
expect_rc 3 "discard with no pending review"
check "  … says so" has_err "no pending review"
check "  … neither sent a mutation" test ! -e "$SHIM/submitted" -a ! -e "$SHIM/discarded"
pending_fx PRR_p PRRC_p1
run gh-pr-pending-review submit
expect_rc 0 "submit"
check "  … prints the review and its url" \
  test "$out" = '{"review":"PRR_p","url":"https://github.com/up/r/pull/7#pullrequestreview-1"}'
check "  … as COMMENT" grep -qF 'event:COMMENT' "$SHIM/queries.log"
check "  … with no body" test "$(cat "$SHIM/posted")" = ""
fresh
pending_fx PRR_p PRRC_p1
run gh-pr-pending-review --as human submit --body 'looks good'
expect_rc 0 "submit --as human --body"
check "  … the body as written" test "$(cat "$SHIM/posted")" = "looks good"
run gh-pr-pending-review discard
expect_rc 0 "discard"
check "  … prints the review" test "$out" = '{"review":"PRR_p"}'
check "  … deleted it" test -e "$SHIM/discarded"
check "no query ever approves or requests changes" \
  test -z "$(grep -E 'APPROVE|REQUEST_CHANGES|DISMISS' "$SHIM/queries.log")"
fresh
pin git@github.com:me/r.git "$BRANCH" gh-pr-read,gh-pr-reply
run gh-pr-pending-review show
expect_rc 2 "without gh-pr-pending-review"
check "  … says so" has_err "this container was not granted gh-pr-pending-review"
check "  … and GitHub was never asked" test -z "$(calls)"

echo "how gh is driven"
fresh
run gh-pr-files
run gh-pr-viewed viewed src/a.ts
run gh-pr-comments
run gh-pr-reply PRRT_c1 "secret-body-text"
run gh-pr-resolve PRRT_c1
run gh-pr-request-review
contents_fx src/a.ts 3 '{"type":"file","size":1,"content":"eA=="}'
run gh-pr-file-at "$(sha 3)" src/a.ts
run gh-pr-pending-review comment src/a.ts 3 RIGHT "secret-body-text"
run gh-pr-pending-review reply PRRT_c1 "secret-body-text"
check "every call ran from /" test -z "$(calls | grep -v '^cwd=/ ')"
check "only gh api and gh auth, never gh pr" test -z "$(calls | grep -Ev '^cwd=/ (api|auth) ')"
check "no container value inside a query string" test -z "$(grep -E 'PRRT_|secret-body|pr-branch' "$SHIM/queries.log")"
check "container values go as -f, never -F" test -z "$(calls | grep -E -- "-F (id|body|branch)=")"

echo "failures"
fresh
SHIM_AUTH_RC=1 run gh-pr-comments
expect_rc 4 "gh not authenticated"
check "  … says what to do" has_err "gh auth login"
fresh
SHIM_FAIL=reviewThreads run gh-pr-comments
expect_rc 4 "a GitHub error"
check "  … relays gh's message" has_err "HTTP 502"
fresh
out=$(PATH=/usr/bin:/bin DEVC_BRIDGE_KEY=$KEY DEVC_BRIDGE_POLICY_DIR=$POLICY_DIR \
  "$RECIPES/gh-pr-comments" 2>"$W/stderr")
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
SHIM_SLEEP=1 DEVC_BRIDGE_GH_TIMEOUT=2 run gh-pr-comments
took=$(($(date +%s) - start))
expect_rc 4 "a hung gh"
check "  … returns within the timeout (${took}s)" test "$took" -lt 12
check "  … says it timed out" has_err "timed out after 2s"
sleep 1
check "  … leaves no process behind" test -z "$(pgrep -f 'sleep 3[01]$' || true)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
