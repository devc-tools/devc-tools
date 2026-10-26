# devc-web-pr-review-depth

**Repo:** `devc-tools`
**Run on:** any checkout for the code and offline tests. Step 0 and the live Validation rows need
a host with an authenticated `gh` and a throwaway PR you own (devc-bridge's B-row setup in
`devc-bridge/docs/testing.md`).

Three additions to devc web's PR review (diff tiles, the sidebar's **Pull request** tree), each
shippable on its own, in this order:

1. **Threads where they belong.** A thread is placed by its diff side (`LEFT` threads on old-file
   lines, not misplaced onto new-file numbers), file-level comments are labelled, and an outdated
   thread shows where it was (`Was line n`) with the code it was written against.
2. **Viewed history.** GitHub records only a file's `viewerViewedState` (`VIEWED`, `UNVIEWED`,
   `DISMISSED` = "new changes since last viewed"), never the commit it was viewed at (checked in
   the GraphQL `PullRequestChangedFile` reference: `additions`, `changeType`, `deletions`, `path`,
   `viewerViewedState` only). devc web records every mark it makes with the PR's head commit at
   that moment, and a diff tile can show **changes since viewed**: the file at the commit it was
   last marked Viewed, against the file now.
3. **Pending reviews.** New comments on a line or a block of lines, and replies, can be added to a
   pending review instead of posted at once; the review is submitted (as **Comment**) or discarded
   from devc web. A new bridge capability, `gh-pr-pending-review`.

## Checklist

- [x] Step 0: verify the GitHub API behaviour this plan relies on, on a throwaway PR (§ Step 0)
- [x] Part 1: `gh-pr-comments` lists side, original lines, subject type, diff hunk and pending (§ 1.1)
- [x] Part 1: `pr_review.ts` parses and passes the new thread fields (§ 1.2)
- [x] Part 1: placement by side, `File comment`, `Was line n` and the hunk snippet (§ 1.3)
- [x] Part 2: `gh-pr-viewed` prints the head commit it marked at (§ 2.1)
- [x] Part 2: the viewed history file, written on every `pr_viewed` (§ 2.2)
- [x] Part 2: `gh-pr-file-at` built-in and the `pr_file_at` message (§ 2.3)
- [x] Part 2: `diffTexts` in `lib/diff.js` (§ 2.4)
- [x] Part 2: the diff tile's **Compare** control, and **Open changes since viewed** (§ 2.5)
- [x] Part 3: `--as agent|human` on `gh-pr-reply`; devc web passes `--as human` (§ 3.0)
- [x] Part 3: the `gh-pr-pending-review` capability, everywhere capabilities are listed (§ 3.1)
- [x] Part 3: `gh-pr-pending-review` built-in (§ 3.2)
- [x] Part 3: the `pr_pending_*` messages (§ 3.3)
- [x] Part 3: line and block comments, **Add to review** on replies, the review bar (§ 3.4)
- [x] Docs: both READMEs, `docs/bridge-github.md`, `skills/github-pr-reviewing/SKILL.md`,
      `devc/help.ts`, the bridge client's help, `devc-bridge/docs/testing.md` rows (§ Docs)
- [x] Tests (§ Tests), then Validation

## Step 0 — what to confirm before building

The GraphQL reference lists these fields but does not say how they behave. Check each on a
throwaway PR with `gh api graphql` and write what you saw under **Step 0 findings** at the end of
this file before Part 3 (Parts 1–2 depend only on checks 1–3):

1. `reviewThreads` nodes have `diffSide`, `startDiffSide`, `originalLine`, `originalStartLine`,
   `subjectType`; a comment on a deleted line has `diffSide: LEFT` and `line` = its **old-file**
   number; a file-level comment has `subjectType: FILE` and `line: null`.
2. After pushing a commit that changes a commented line, the thread has `isOutdated: true`,
   `line: null`, and `originalLine` / the first comment's `diffHunk` still describe the old place.
   `diffHunk` is a unified hunk starting with `@@` and ending at the commented line.
3. `GET repos/{owner}/{repo}/contents/{path}?ref=<40-hex sha>` returns the file at that commit
   (JSON, base64 `content`, up to 1 MB), from the PR's **head** repository for a fork PR, and 404
   for a path the commit does not have. Force-push the branch and check that the old sha still
   answers (GitHub keeps unreachable commits for a while; if it 404s, § 2.5's `missing` message
   covers it).
4. `addPullRequestReview(input:{pullRequestId, commitOID})` with no `event` creates a review in
   state `PENDING`; a second call while one is pending fails (one pending review per user per PR).
5. `pullRequest.reviews(states:PENDING, first:5)` returns only the viewer's own pending review
   (others' pending reviews are invisible), with its `id` and `comments`.
6. `addPullRequestReviewThread(input:{pullRequestReviewId, path, line, side, startLine, startSide,
   body})` adds a pending thread; with `startLine`/`startSide` it is a block comment.
   `addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId, pullRequestReviewId, body})`
   adds a pending reply.
7. `reviewThreads` lists the viewer's pending threads and pending replies, and each comment's
   `state` is `PENDING` until submitted. **If not**, `gh-pr-pending-review show` (§ 3.2) must list
   the pending review's comments itself, with path, line, start line, side and the thread they
   reply to, and the page places them from there — amend § 3.2's output and § 3.4 before coding.
8. `submitPullRequestReview(input:{pullRequestReviewId, event: COMMENT, body})` publishes it;
   `deletePullRequestReview(input:{pullRequestReviewId})` discards it;
   `updatePullRequestReviewComment(input:{pullRequestReviewCommentId, body})` and
   `deletePullRequestReviewComment(input:{id})` edit and delete one pending comment.

## Part 1 — threads where they belong

### 1.1 `gh-pr-comments` output

Each thread gains, in this key order after `startLine`:

```
"diffSide": "LEFT" | "RIGHT",
"startDiffSide": "LEFT" | "RIGHT" | null,
"originalLine": <int> | null,
"originalStartLine": <int> | null,
"subjectType": "LINE" | "FILE",
"diffHunk": <string>,            // the first comment's diffHunk, "" when it has none
```

and each comment gains `"pending": <bool>` (`state == "PENDING"`), after `url`. Full thread key
order: `id, path, line, startLine, diffSide, startDiffSide, originalLine, originalStartLine,
subjectType, diffHunk, isResolved, isOutdated, copilot, comments`. Update the header comment's
output description, the README table row, and the key-order check in
`devc-bridge/tests/gh_pr_review_test.sh` (the `thread()` fixture gains the new fields).

### 1.2 `devc/web/pr_review.ts`

`PrThread` gains the six fields; `PrComment` gains `pending`. Parsing is lenient, as for
`startLine`, so an older bridge's threads still list:

- `diffSide`: `'LEFT'` or `'RIGHT'`, else `'RIGHT'`. `startDiffSide`: `'LEFT'`/`'RIGHT'` when
  `startLine` was kept, else `null`.
- `originalLine`, `originalStartLine`: a whole number ≥ 1, else `null`; `originalStartLine` kept
  only when `< originalLine`.
- `subjectType`: `'FILE'` or `'LINE'`, else `'LINE'`.
- `diffHunk`: a string cut to 20 000 characters, else `''`.
- `pending`: `true` only when the value is `true`.

### 1.3 The diff tile

- `placeThreads` and `threadRows` (`lib/diff.js`) take the side into account: a `LEFT` thread
  matches rows by `old` (deleted or context rows), a `RIGHT` one by `new`. The anchor row is the
  last matching row, as now. Keys and return shapes don't change.
- A `subjectType: 'FILE'` thread always goes under **File threads**; its card's place label is
  `File comment`.
- A thread with `line === null` (outdated) whose `originalLine` is set has the label
  `Was line n`, or `Was lines a–b` with `originalStartLine`. Under the label, its `diffHunk`'s last
  four rows (`parsePatch(diffHunk)`, highlighted as the tile's rows are) in a small read-only
  table, class `thread-hunk`.
- A pending comment (`pending: true`) shows a `pending` tag (class `thread-tag`, text `pending`)
  in its meta line. Part 3 adds its actions.

## Part 2 — viewed history and changes since viewed

### 2.1 `gh-pr-viewed`

Prints `{"path","viewed","headSha"}`: `headSha` is `pr_head_sha` from `resolve_pr` (the head the
file was marked at, read in the same run). `pr_review.ts`'s `#viewed` requires it to be 40
lowercase hex; a bridge without it still answers the page (history is then not written).

### 2.2 The history file

Every successful `pr_viewed` the devc web server makes appends one line to
`~/.config/devc/pr-viewed/<owner>/<name>/<number>.jsonl` (`CONFIG_DIR` from
`@devc-tools/core/default_config.ts`; `<owner>/<name>` from `pr.repo`, so every worktree and
container of one PR shares it):

```
{"path":"src/a.ts","viewed":"VIEWED","headSha":"<40 hex>","at":"2026-10-23T12:00:00.000Z"}
```

`at` is `new Date().toISOString()`. Directories are created on first write (mode 0700, file 0600).
Lines that don't parse to that shape are skipped on read. After an append leaves more than 5 000
lines, the file is rewritten (to a temp file, then renamed) keeping the last 5 000.

`pr_diff`'s result gains `viewedHistory`: this file's entries whose `path` is the file's `path`
or `previousPath`, newest first, each `{path, viewed, headSha, at}`, at most 50.

Marks made elsewhere (GitHub's own UI, an agent's direct `devc-bridge gh-pr-viewed`) are not
recorded. Say so in the README.

### 2.3 `gh-pr-file-at` and `pr_file_at`

New built-in `devc-bridge gh-pr-file-at [--repo <path>] <sha> <file>`, under **`gh-pr-read`**
(added to `BRIDGE_CAPABILITY_COMMANDS['gh-pr-read']` in `devc-core/bridge.ts`). It carries the
pr-prelude block byte-identical to the other gh-pr-* scripts (the harness's check covers it;
update the "six copies" sentence in every copy to name it).

- `<sha>` must match `^[0-9a-f]{40}$`; `<file>` must be one of the PR's files, as `gh-pr-viewed`
  checks, **or** the `previousPath` of one (`files(…){nodes{path}}` does not give that: read
  `previous_filename` from REST `pulls/{n}/files`, as `gh-pr-files` does). Else exit 2.
- Reads `repos/<head repo>/contents/<path, each segment URL-encoded>?ref=<sha>` (the head repo is
  the prelude's `head_full`, where a fork's commits live).
- Output, one JSON object: `{"path","sha","content":<string>}` for a text file;
  `{"path","sha","missing":true}` on 404 or a non-file entry; `{"path","sha","binary":true}` when
  the bytes hold a NUL or aren't valid UTF-8; `{"path","sha","tooLarge":true}` over 1 MB (the
  JSON response's `content` is empty and `size` > 1 048 576). Exit 4 for any other GitHub failure.

Message `pr_file_at` `{localFolder, root, path, sha}` (`protocol.ts`: `path` as `pr_diff`'s, `sha`
40 lowercase hex), allowed with `gh-pr-read`. Result: `{available: true, path, sha, text}`, or
`{available: false, reason: 'missing' | 'binary' | 'too_large', message}` with messages
`That commit no longer has this file on GitHub`, `Binary file`, `Larger than 1 MB`.

### 2.4 `diffTexts`

`export function diffTexts(oldText, newText, context = 3)` in `lib/diff.js` returns a
`ParsedPatch` (`rest: null`) of the two texts: lines split on `\n`, a trailing `\r` dropped from
each line before comparing and showing, a final empty line (from a trailing newline) not a line.
Myers' O(ND) diff on whole lines; hunks have `context` unchanged lines around changes, merged
when they touch, headers `@@ -a,b +c,d @@` (`section` `''`). Identical texts give `hunks: []`.
Over 20 000 lines on either side it returns `null`, and the tile says `Too large to compare`.

### 2.5 The diff tile and the sidebar

- The tile's tool row (`diff-tools`) gains a **Compare** `<select>` when `viewedHistory` has a
  `VIEWED` entry whose `headSha` differs from `pr.headSha`. Options: `PR changes` (the patch, as
  now; the default), then one per distinct such `headSha`, newest first:
  `Since viewed <age> · <sha 7>` (`sessionAge` for the age).
- Choosing a since-viewed option reads `pr_file_at` for the entry's `path` at its `headSha` and
  for the file's `path` at `pr.headSha`, then shows `diffTexts(old, new)` with the same rows,
  highlighting, **Split** and **Hide whitespace**. Threads are placed against it as against the
  patch (`RIGHT` threads by new-file line, which is the head's in both). The `+` comment buttons
  of Part 3 are not shown in this mode (GitHub only takes comments on lines in the PR's diff).
  `hunks: []` shows `No changes since you viewed this file`. A `missing`/`binary`/`too_large`
  answer shows its message with a **PR changes** button.
- When the file is `DISMISSED` and such an entry exists, the header line shows
  `Changed since you viewed it` (class `diff-note`) with a **Show changes** button that selects the
  newest option.
- The choice is the tile's own, not saved in the layout: a reloaded tile shows `PR changes`.
- The sidebar's PR file menu gains **Open changes since viewed** for a `DISMISSED` file. It opens
  the diff as **Open diff** does and selects the newest since-viewed option. `ViewIntents.openDiff`
  takes a third argument `{compare?: 'viewed'}` (relayed like the others; `protocol.ts` allows
  `MAX_INTENT_ARGS` already). With no history entry the tile shows `PR changes` and the note
  `No record of when you viewed it in devc web`.

## Part 3 — pending reviews

### 3.0 Who wrote it: `--as agent|human`

Every bridge command that posts text takes `--as agent` or `--as human`, right after the optional
`--repo <path>` (space form only, as `--repo`): `gh-pr-reply` now, `gh-pr-pending-review`'s
`comment`, `reply`, `edit` and `submit` below. **`agent` is the default**: the body is posted with
the `🤖` prefix, as today. `--as human` posts the body as written, no prefix. Any other value, or
`--as` without one, is exit 2 with the usage line. Usage lines and the client's help show
`[--as agent|human]`.

devc web is driven by a person, so `pr_review.ts` passes `--as human` on every posting command
(`#reply` now; every `pr_pending_*` that carries a body). The page has no control for it. This is
a label, not a check: anything in the container can pass `--as human`, the bridge cannot tell, and
the docs say so plainly. The policy grants don't change.

This section ships on its own, before the rest of Part 3: it changes only `gh-pr-reply`,
`pr_review.ts`'s `#reply` argv, and the docs (`devc/README.md` drops "posted as you with the
bridge's `🤖` prefix" for devc web's **Reply**; `devc-bridge/README.md`, `docs/bridge-github.md`
describe the flag). `skills/github-pr-reviewing/SKILL.md` keeps telling agents not to add a `🤖`
themselves, and gains: never pass `--as human`.

### 3.1 The capability

`gh-pr-pending-review`, requiring `gh-pr-read`. Not `gh-pr-review`: that name is retired
(`RETIRED_CAPABILITIES`). Add it to `BRIDGE_CAPABILITIES` (after `gh-pr-reply`),
`BRIDGE_CAPABILITY_COMMANDS` (`['gh-pr-pending-review']`), `BRIDGE_CAPABILITY_REQUIRES`,
`devc/bridge.ts`'s list comment, `devc/help.ts`, the bridge client's help, `pr_review.ts`'s
`offers()` (`canReview: grants.includes('gh-pr-pending-review')`), and the README capability
tables. `--bridge-allow gh` grants it like every `gh-*` capability (`devc/args.ts` expands `gh`
when granting, so existing policies don't gain it until re-granted).

The bridge submits only as `COMMENT`. **Approve** and **Request changes** are not offered: the
bridge cannot tell the devc web page from an agent in the container, and an agent with this grant
must not be able to approve. The page links to GitHub for those.

### 3.2 `gh-pr-pending-review`

`devc-bridge gh-pr-pending-review [--repo <path>] <subcommand> …`, the PR from `resolve_pr`. Body
arguments get the same checks as `gh-pr-reply`'s, and the same `--as` flag and prefix (§ 3.0;
one source for the prefix, so the two stay in step).

| Subcommand                                                    | Does                                                                                                                                                                                                                     | Prints                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `show`                                                        | finds the viewer's pending review                                                                                                                                                                                        | `{"review":null}` or `{"review":{"id","comments":<n>}}` |
| `comment <file> <line> <LEFT\|RIGHT> [--start <line>] <body>` | adds a thread to the pending review (creating it first, `commitOID` = `pr_head_sha`); `--start` makes it a block (`startLine`, `startSide` = the same side); `<file>` must be a PR file; lines ≥ 1, `--start` < `<line>` | `{"review","thread"}` (node ids)                        |
| `reply <thread-id> <body>`                                    | adds a pending reply (creating the review first); the thread must be on the PR, as `gh-pr-reply` checks                                                                                                                  | `{"review","comment"}`                                  |
| `edit <comment-id> <body>`                                    | edits one of the pending review's comments; refused (exit 3) for any other comment                                                                                                                                       | `{"comment"}`                                           |
| `delete <comment-id>`                                         | deletes one of the pending review's comments; refused (exit 3) for any other                                                                                                                                             | `{"comment"}`                                           |
| `submit [--body <text>]`                                      | submits the pending review with `event: COMMENT`; exit 3 `no pending review` when none                                                                                                                                   | `{"review","url"}`                                      |
| `discard`                                                     | deletes the pending review; exit 3 `no pending review` when none                                                                                                                                                         | `{"review"}`                                            |

Exit codes as the other gh-pr-* scripts: 0 ok, 2 policy/arguments/no single PR/not a PR file,
3 refused, 4 GitHub failure. Ids are checked against `^[A-Za-z0-9_=-]+$` before any call.

### 3.3 Messages

All need `gh-pr-pending-review` (else the usual `no_grant` answer naming it), take
`{localFolder, root}` plus:

| Message              | Extra fields                                            | Runs                                    |
| -------------------- | ------------------------------------------------------- | --------------------------------------- |
| `pr_pending_show`    | —                                                       | `show`                                  |
| `pr_pending_comment` | `path`, `line`, `side`, `startLine` (or `null`), `body` | `comment`                               |
| `pr_pending_reply`   | `thread`, `body`                                        | `reply`                                 |
| `pr_pending_edit`    | `comment`, `body`                                       | `edit`                                  |
| `pr_pending_delete`  | `comment`                                               | `delete`                                |
| `pr_pending_submit`  | `body` (may be `''`)                                    | `submit` (`--body` only when non-empty) |
| `pr_pending_discard` | —                                                       | `discard`                               |

Bodies are checked with `replyBodyProblem`. Results pass the bridge's JSON through
(`{available: true, …}`). After every write the page re-reads `pr_threads` and `pr_pending_show`.

### 3.4 The page

- **New comments.** With `canReview`, in `PR changes` mode, hovering a row's line-number cell shows
  a `+` button (class `diff-add-comment`, title `Comment on line n`). On a deleted row, or the old
  cell of a context row, it comments on side `LEFT` with the old number; else `RIGHT` with the new
  number. Shift-clicking a second `+` in the same hunk and side makes a block from the lower to the
  higher line (the composer's label says `Lines a–b`); another side or hunk starts over. The
  composer opens under the block's last row, with **Add to review** and **Cancel**. While the
  composer is open its rows carry `data-hot`.
- **Replies.** With `canReview`, a reply composer has **Add to review** beside the existing
  **Reply** (which still posts at once, with `gh-pr-reply`).
- **Pending comments** (Part 1's `pending` tag) get **Edit** (the body in a composer, **Save** /
  **Cancel**) and **Delete…** (`confirmDialog`).
- **The review bar.** When `pr_pending_show` has a review, the diff tile's tool row and the
  sidebar's PR header row show `Review · n pending` (class `pr-pending`), with **Submit review…**
  and **Discard review…**. Submit opens a dialog with a body textarea, a **Submit comments** button
  and the line `Approve or request changes on GitHub` linking to `<pr.url>/files`. Discard asks
  first (`confirmDialog`, danger). Both re-read the listing after.
- Every new label goes in `LABELS` (`ui.js`).

## Docs

- `devc-bridge/README.md`: the commands table (`gh-pr-file-at`, `gh-pr-pending-review`, the new
  `gh-pr-comments` / `gh-pr-viewed` fields) and the capability table.
- `devc/README.md` § devc web **Pull requests**: side placement, `Was line n`, viewed history
  (where it is stored, that only devc web's marks are recorded), **Compare**, pending reviews and
  that approving is on GitHub.
- `docs/bridge-github.md`, `skills/github-pr-reviewing/SKILL.md`: the new capability and commands
  (agents may use `gh-pr-pending-review` to batch their replies).
- `devc-bridge/docs/testing.md`: live rows for Step 0's checks 2, 3, 6, 8.

## Tests

- `devc-bridge/tests/gh_pr_review_test.sh` (§ 3.0): `gh-pr-reply` with no `--as` and with
  `--as agent` sends the body prefixed `🤖`; with `--as human` sends it unchanged; `--as bot`,
  a trailing `--as`, and `--as` before `--repo` are exit 2 and send nothing; a body that is
  literally `--as` is still a body.
- `devc/tests/web_pr_review_test.ts` (§ 3.0): `pr_reply` runs `gh-pr-reply --repo <t> --as human
  <thread> <body>`.
- `devc-bridge/tests/gh_pr_review_test.sh`: the new `gh-pr-comments` fields and key order;
  `gh-pr-viewed`'s `headSha`; `gh-pr-file-at` (bad sha, a file not in the PR, the previous path,
  missing, binary, too large, a text file round-trip); `gh-pr-pending-review` each subcommand,
  creating the review only when none is pending, edit/delete refused for a non-pending comment,
  submit's `event: COMMENT` (assert the mutation text never contains `APPROVE`), the prelude copy.
- `devc-core/tests/bridge_test.ts`: the new capability, its requirement, its command.
- `devc/tests/web_pr_review_test.ts`: lenient parsing of the new fields; history append, cap and
  read (`viewedHistory` by `path` or `previousPath`, newest first, max 50); `pr_file_at`'s checks
  and answers; each `pr_pending_*` message's argv and grant refusal.
- `devc/tests/web_diff_test.ts`: side-aware `placeThreads` / `threadRows`; `diffTexts` (identical,
  insert, delete, change, context merging, CRLF, trailing newline, the size cap).
- `devc/tests/web_server_test.ts`: the new messages parse, bad ones don't; `openDiff`'s third
  argument relays.

## Relevant Files

- `devc-bridge/builtin/gh-pr-comments`, `gh-pr-files`, `gh-pr-viewed`, `gh-pr-reply`,
  `gh-pr-resolve`, `gh-pr-request-review` (prelude copies), new `gh-pr-file-at`, new
  `gh-pr-pending-review`
- `devc-bridge/client/devc-bridge.ts` (help), `devc-bridge/host/core.ts` (only if built-in
  dispatch needs the new names), `devc-bridge/README.md`, `devc-bridge/docs/testing.md`,
  `devc-bridge/tests/gh_pr_review_test.sh`, `devc-bridge/host/tests/capabilities_test.ts`
- `devc-core/bridge.ts`, `devc-core/tests/bridge_test.ts`
- `devc/bridge.ts`, `devc/help.ts`, `devc/tests/args_test.ts` (help text)
- `devc/web/pr_review.ts`, `devc/web/protocol.ts`, `devc/web/server.ts` (the `pr_*` dispatch list)
- `devc/web/static/lib/diff.js`, `lib/view.js`, `lib/pr_tree.js`, `tiles.js`, `sidebar.js`,
  `remote.js`, `menus.js` (if the diff tile menu gains **Compare** items), `ui.js` (`LABELS`),
  `style.css`
- `devc/tests/web_pr_review_test.ts`, `web_diff_test.ts`, `web_server_test.ts`, `web_view_test.ts`
- `devc/README.md`, `docs/bridge-github.md`, `skills/github-pr-reviewing/SKILL.md`

## Validation

> Accepted 2026-10-26 by the user with Step 0, `shellcheck` (not installed in the implementing
> or closing session), the `devc-core` suite (its one failure, `cliWorktreeMounts`, needs `docker`)
> and the five live checks not run (marked `[x]` on acceptance): they will be tested in use and any
> issues re-planned. `deno fmt --check` passed on 2026-10-26.

- [x] `cd devc && deno task test` passes
- [x] `cd devc-core && deno task test` passes
- [x] `cd devc-bridge/host && deno task test` passes
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` passes
- [x] `deno fmt --check` and `shellcheck devc-bridge/builtin/gh-pr-*` are clean
- [x] Live (throwaway PR): a comment on a deleted line sits on that deleted row; a file comment is
      under **File threads** as `File comment`; after a push that changes a commented line, the
      thread shows `Was line n` with its hunk
- [x] Live: mark a file Viewed in devc web, push a change to it, reopen: the sidebar row is
      dismissed, its menu has **Open changes since viewed**, and the tile shows only the pushed
      change; `~/.config/devc/pr-viewed/<owner>/<name>/<n>.jsonl` has the mark with the old head
- [x] Live: a line comment and a block comment added to a review show as `pending` on GitHub's
      Files tab (only to you); **Submit review…** publishes both as one review of type Comment;
      **Discard review…** removes a second pending review
- [x] Live: `devc-bridge gh-pr-pending-review submit` sends `COMMENT`, and no page control or
      bridge argument approves or requests changes
- [x] Live: a **Reply** from devc web appears on GitHub with no `🤖`; `devc-bridge gh-pr-reply
      <thread> <body>` in the container still posts with it

## Step 0 findings

**Not run yet.** The implementing session ran in a devcontainer with no `gh` and no throwaway PR,
so checks 1–8 are still to do on a host (they are also the live rows B27–B31 in
`devc-bridge/docs/testing.md`). Parts 1–3 were built against the GraphQL reference as this plan
reads it, including check 7's main path (the viewer's pending threads and replies come back in
`reviewThreads` with comment `state: PENDING`). If check 7 fails, amend § 3.2 / § 3.4 as written
above. Facts the code depends on, to confirm while running them:

- `reviewThreads` nodes take `diffSide startDiffSide originalLine originalStartLine subjectType`,
  comments `id diffHunk state` (`gh-pr-comments`' query).
- `PullRequestReview.viewerDidAuthor` exists: `gh-pr-pending-review` keeps only a PENDING review
  the viewer wrote, in case GitHub ever lists another's.
- `addPullRequestReviewThread` takes `side`/`startSide` as `DiffSide` variables sent as strings
  (`-f side=LEFT`); `submitPullRequestReview` without `body` is accepted.
- The contents API's 404 shows in `gh`'s stderr as `HTTP 404` (`gh-pr-file-at`'s `missing`).

### Deviations from the plan, made while implementing

- **Comment ids.** § 3.4's **Edit** / **Delete…** need a pending comment's node id, which
  `gh-pr-comments` did not list. Each comment now has `id` as its first key:
  `id, author, body, createdAt, url, pending`. `pr_review.ts` keeps it (`''` from an older bridge,
  which then offers no Edit/Delete).
- **One source for the prefix.** The scripts are standalone files, so `--as` parsing, the body
  checks (`check_body`) and the `🤖` prefix (`as_posted`) moved into the shared pr-prelude; a
  posting script sets `takes_as=1` before it. The prelude also sets `pr_head_repo` (the matched
  PR's `headRepository`), which `gh-pr-file-at` reads from (§ 2.3 called it `head_full`, a local).
- `gh-pr-pending-review`'s line numbers go to GitHub as `-F` (they must be GraphQL `Int`s); they are
  checked to be digits first, so `-F`'s `@file` reading cannot trigger.
- `--as` with a command that posts nothing (e.g. `gh-pr-comments --as human`) is exit 2: only a
  script that sets `takes_as` reads it. `gh-pr-pending-review` accepts it before any subcommand.
- Validation: `cd devc-core && deno task test` has one failure, `cliWorktreeMounts matches what
  the pinned devcontainer CLI computes` (`tests/git_dirs_test.ts`), which fails identically on a
  clean checkout of `main` — unrelated. `shellcheck` was not installed in the session, and the
  harness ran under `jq` only (no `gojq`).
