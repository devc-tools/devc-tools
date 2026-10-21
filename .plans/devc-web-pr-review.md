# devc-web-pr-review

Review a GitHub pull request in devc web, entirely through the containers' devc-bridge. This
replaces the earlier `devc-desktop-pr-review` design, which had a devc-desktop panel running host
`gh`. **devc-desktop does not change.**

- **A Pull request row under each repo** of a running container lists the PR for that repo's
  pinned branch: its number, its title, and a tree of changed files. Each file has a **Viewed**
  checkbox, which is GitHub's own Viewed state.
- **Clicking a file opens its diff in a tile** (a new `diff` tile kind), with the PR's review
  review threads placed on their lines.
- **Replies, resolves and Viewed** go through the same container's bridge, each
  only when its grant is present.
- Every GitHub call is a `devc-bridge` command run in that container: `gh-pr-files`,
  `gh-pr-comments`, `gh-pr-viewed`, `gh-pr-reply` and `gh-pr-resolve`. devc web and its server
  never run `gh`.

```
┌ sidebar ───────────────────────┐┌ app.ts · #123 ─────────────────────────────┐
│ ▾ devc-tools (container)       ││ src/web/app.ts  M  +3 −1   #123  ⟳  ↗       │
│   ▸ Terminals                  ││ threads via devc-tools' bridge              │
│   ▸ Sessions                   ││ @@ -10,6 +10,9 @@                           │
│   ▾ tools/devc-tools           ││ 10 10   const a = 1;                        │
│     ▾ PR #123 Fix the… 3/14 ⟳  ││    11 + const b = 2;                        │
│       ▾ src/web          1/3   ││   ┌ 💬 copilot · 2h ───────────────────────┐ │
│         ☑ M app.ts             ││   │ Consider …                             │ │
│         ☐ A new.ts             ││   │ [Reply] [Resolve] [↗]                  │ │
│       ▸ tests            0/4   ││   └────────────────────────────────────────┘ │
│       ☐ D old.md               ││ 11 12   return a;                           │
│     ▸ src  …(files)            │└─────────────────────────────────────────────┘
```

**Depends on [bridge-read-tier-defaults](archived/bridge-read-tier-defaults.md)** (`gh-pr-read`,
`gh-pr-files`, `gh-pr-viewed`, `bridgeDefaultAllow`; done) **and
[bridge-pr-grant-split](archived/bridge-pr-grant-split.md)** (`gh-pr-reply`, the two resolve grants,
`gh-pr-comments --state`, `isResolved`). Implement those first. Grant names here are the split's.

Read `devc/web/server.ts`'s per-container `switch` in `handle` (`list_sessions` is the model),
`devc/web/static/layout.js`'s header, `devc/web/static/lib/layout_state.js` (`FileRef`), the
Files tree in `devc/web/static/lib/files.js`, `readPolicy` (`devc/bridge.ts`) and `projectKey`
(`devc-core/merged_config.ts`), both already exported,
and the output contracts of `gh-pr-files` and `gh-pr-comments` in `docs/bridge-github.md`
first.

## Decisions

- **devc web can do only what some container's bridge already allows.** An agent can drive devc
  web's page (`--live` code from a writable checkout, or the token). That page can already type
  into a terminal in every container, including one whose bridge holds review grants. Running
  those same bridge commands from devc web's server therefore adds no reach. Running host `gh`
  would add reach, which is why the server never does.
- **One PR per pinned repo.** The bridge resolves the PR from the policy's pinned remote and
  branch, so the row shows that PR. There is no picker and no arbitrary PR URL. A repo whose
  branch has no open PR says so.
- **Grants are read from the host-only policy on every message** (`policy/<key>.conf`,
  `readPolicy`, the key from `projectKey(localFolder)`), never cached and never taken from the
  container. Which commands the server offers (`canReply`, `resolveScope`, `canViewed`) comes from
  this read.
- **The bridge's output passes through the container**, so it is untrusted. A container could
  shadow `devc-bridge` on its own `PATH`. Every listing is parsed defensively with caps (below),
  and the UI says `via <container>'s bridge`.
- **No polling.** The PR row loads when it is opened and on its ⟳. A diff tile lists threads when
  it opens, on its ⟳, and after each write.

## Concept boundaries

- **The PR row:** shown under every repo row of a **running** container, and closed until opened.
  It is the repo's first child, before its files. Opening it sends `pr_files`.
- **Unified diff only**, from GitHub's per-file `patch`. No side-by-side view, no expanding
  context, no syntax highlighting. A file without a `patch` (binary, or too large for GitHub)
  shows `No diff available for this file` and the tile's ↗ link.
- **Untrusted text.** Titles, paths, patches and comment bodies are shown with `textContent`
  only. Bidi controls (U+202A–U+202E, U+2066–U+2069) and zero-width characters (U+200B–U+200F,
  U+2060, U+FEFF) in paths, patch lines and comments show as visible markers (`⟨U+202E⟩`, styled
  as a warning chip). This is the Trojan Source check. Comment bodies are plain text
  (`pre-wrap`), not rendered markdown.
- **Writes keep the bridge's limits:** only the pinned PR, replies carry the bridge's `🤖`
  prefix, and no new threads. Resolve follows the grant: any thread with `gh-pr-resolve`,
  Copilot's threads only with `gh-pr-resolve-copilot`.

## Contracts: server (`devc/web/pr_review.ts`, new; `server.ts`; `protocol.ts`)

### Messages (page → server)

All take `localFolder` and `root`, as `read_file` does. `root` is a repo's host folder, as in the
projects message's `repos[].folder`. A `root` that isn't one of that project's repos →
`bad_request` `unknown repo`. Replies use the existing `{id, ok, result}` /
`{id, ok:false, error:{code, message}}` shape.

**Lookup (every message):**

1. No running container for `localFolder` → `result {available:false, reason:'not_running', message:'Start the container to see its pull request'}`.
2. Read the policy. Find the line whose `repo` equals `root`, with trailing `/` dropped on both
   sides. None, or no policy, or a malformed one → `result {available:false, reason:'no_grant', message}`
   with the message
   `Needs a grant on this repo: devc up --bridge-allow gh-pr-read, or "bridgeDefaultAllow" in ~/.config/devc/config.json`.
3. The line's `target` is passed as `--repo <target>` to every bridge command.

**Bridge runs:** `dockerExecArgv(info, {cwd:'/', cmd:['devc-bridge', <command>, '--repo', <target>, …]})`,
argv only, never a shell. Timeout 120 s. Stdout is capped at 64 MiB: over the cap the process is
killed and the result is `bridge` `bridge output too large`. A non-zero exit →
`result {available:false, reason:'bridge', message: <last non-empty stderr line, ≤ 300 chars>}`.
Bridge exit 2 and 4 are both `bridge`. The message says which.

| Message      | Extra fields              | Grant needed                               | Server does                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr_files`   | —                         | `gh-pr-read`                               | Runs `gh-pr-files`. Parses it (below) and stores it as this repo's listing, keyed `localFolder + '\n' + root`, replacing the old one. At most 32 listings are kept, dropping the oldest. `result {available:true, container, pr, files /* without patch */, truncated, canViewed, canReply, resolveScope}`. `resolveScope` is `'any'` with `gh-pr-resolve`, else `'copilot'` with `gh-pr-resolve-copilot`, else `null`. |
| `pr_diff`    | `path`                    | as `pr_files`                              | With no stored listing, runs `pr_files`' fetch first. `path` not in the listing → `not_found` `This file is not in the pull request any more`. Otherwise `result {available:true, container, pr, file /* with patch */, fileUrl, canViewed, canReply, resolveScope}`. `fileUrl` = `pr.url + '/files#diff-' + sha256hex(path)`.                                                                                          |
| `pr_threads` | `path`                    | as `pr_files`                              | Runs `gh-pr-comments --state all`. Its `pr.url` ≠ the stored listing's → `result {available:false, reason:'other_pr', message:'The bridge reports a different PR: <url>'}`. Otherwise it stores the full thread listing for this repo and returns `result {available:true, container, threads}`, keeping only threads whose `path` is `path`.                                                                           |
| `pr_viewed`  | `path`, `viewed: boolean` | `gh-pr-viewed`                             | `path` must be in the stored listing (else `not_found`). Runs `gh-pr-viewed <viewed ? 'viewed' : 'unviewed'> <path>`. The output's `path` must equal `path` and its `viewed` must be `VIEWED`/`UNVIEWED` (else `bridge` `unexpected bridge output`). It updates the stored listing and returns `result {path, viewed}`.                                                                                                 |
| `pr_reply`   | `path`, `thread`, `body`  | `gh-pr-reply`                              | `thread` must be in the last thread listing (else `not_found`). `body` must be a string, non-empty after trim, ≤ 4000 UTF-8 bytes, with no control characters but `\n` and `\t` (else `bad_request` with the rule). Runs `gh-pr-reply <thread> <body>`. Exit 0 → `result {}`.                                                                                                                                           |
| `pr_resolve` | `path`, `thread`          | `gh-pr-resolve` or `gh-pr-resolve-copilot` | As `pr_reply`, plus: the thread must not be `isResolved` (else `bad_request` `Already resolved`), and with only `gh-pr-resolve-copilot` its `copilot` must be true (else `bad_request` `This container may resolve only Copilot's threads (gh-pr-resolve-copilot)`). Runs `gh-pr-resolve <thread>`.                                                                                                                     |

A grant missing for `pr_viewed`, `pr_reply` or `pr_resolve` → `bad_request`
`Needs --bridge-allow <cap> on this repo`. The page never shows those controls enabled without
the grant, so this is only a backstop.

- **gotcha:** these are per-container messages. Parser cases go in `protocol.ts`. Handler `case`s
  go in the per-container `switch` in `server.ts`'s `handle`, after the `localFolder` →
  `handleProject` check, as `list_sessions` does.
- **gotcha:** under `devc web --live` the installed server doesn't know the new messages. Testing
  needs `--live-yolo` or a source build.

### Defensive parse

`gh-pr-files` output keeps only these fields:

```ts
interface PrInfo {
  repo: string; // owner/name, the PR-ref name rules
  number: number; // 1..9_999_999_999
  url: string; // ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$
  headSha: string; // 40 hex
  title: string; // ≤ 1024, else cut
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string | null;
  baseRef: string;
  headRef: string; // ≤ 255 each
  changedFiles: number;
}
interface PrFile {
  path: string; // 1..4096, no \0 and no other control characters
  previousPath: string | null; // same rules
  status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged';
  additions: number;
  deletions: number; // non-negative integers
  patch: string | null; // ≤ 4 MiB, else null
  viewed: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
}
```

- A `pr` that fails any rule → `bridge` `unexpected bridge output`.
- A file that fails is dropped. An unknown `status` becomes `modified`, and an unknown `viewed`
  becomes `UNVIEWED`. At most 3000 files are kept. A duplicate `path` keeps the first.
- `gh-pr-comments` threads keep `{id, path, line, isResolved, isOutdated, copilot, comments:[{author, body, createdAt, url}]}`.
  `id` must match `^PRRT_[A-Za-z0-9_-]+$`. A wrong type drops the thread or comment. A `url` not
  starting `https://github.com/` becomes `''`. Caps: 500 threads, 100 comments per thread, and
  65 536 characters per body.

## Contracts: page

### The PR row (sidebar, `static/lib/pr_tree.js` new, pure; `app.js` renders)

- **Closed:** `Pull request`. **Open:** on `available:false`, one dimmed line with its
  `message`. `no_grant` and `not_running` are phrased as hints, not errors. On success, a header
  row and then the tree.
  - The header row reads `#<n> <title>` and `<viewed>/<total>`, plus the state when it isn't
    OPEN, and `draft`. Its hover buttons are ⟳ (re-send `pr_files`) and ↗ (`pr.url` via
    `window.open`). A `truncated` PR adds a line: `GitHub lists at most 3000 files`.
- **Tree:**
  - **Order and compaction:** folders first, then files, each sorted with
    `localeCompare(…, 'en')`. A chain of folders that each hold only one folder is compacted
    into one row (`src/web/lib`).
  - **File row:** the Viewed checkbox, a status letter (`A`, `D`, `R`, `C`, else `M`) in its
    color, the name, and `+a −d` dimmed. A rename's tooltip shows `old → new`. `DISMISSED` shows
    unchecked with a `changed since viewed` tooltip.
  - **Folder row:** `viewed/total` of the files under it. A fully viewed folder is dimmed and
    starts collapsed.
  - **The checkbox** is disabled unless `canViewed`, with the tooltip
    `Marking Viewed needs --bridge-allow gh-pr-viewed`. A toggle sends `pr_viewed` and updates
    the counts optimistically. On failure it puts the checkbox back and shows a toast with the
    message.
  - **Click** a file: it opens its diff the way a click in the Files tree opens a file (the
    same preview-tile rules; Ctrl/⌘-click opens a new tile).
  - **What is kept:** folders' open state is remembered per browser, keyed by
    `localFolder + root + pr.number`, as other sidebar rows are.

### The `diff` tile (`layout.js`, `layout_state.js`, `static/lib/diff.js` new, pure; `app.js`)

- **Component type `diff`**, state `{localFolder, root, path}` (a `DiffRef`, validated like
  `fileRefFromState`). Opening the same `DiffRef` again activates the existing tile.
  - Title: `<basename> · #<n>`. Tooltip: `<repo>#<n>`, then the path.
  - On mount (and on restore) it sends `pr_diff`. On `not_found` or `available:false` it shows
    the message and a **Retry**.
- **Header:** the path (`old → new` for a rename), the status letter, `+a −d`, `#<n>`, ⟳
  (re-send `pr_diff` then `pr_threads`), and ↗ (`fileUrl`). Under it: `threads via <container>'s bridge`.
- **Body:**
  - First a **File threads** block, then each hunk: its header row, then rows of old number, new
    number and text, with add/delete backgrounds. `\ No newline at end of file` is dimmed with no
    numbers.
  - Hunk headers are parsed with `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/`. The first
    line that starts with none of a space, `+`, `-` or `\` ends the parse, and the rest shows as raw
    text.
- **Threads:** sent as `pr_threads` after `pr_diff` succeeds.
  - **Resolved threads** come too (`--state all`). On their row, or in File threads, they fold
    into one dimmed `Resolved (n)` line, closed by default, and open to read-only cards with
    Reply when `canReply`. The header has a **Show resolved** toggle that opens every fold,
    remembered per browser.
  - **gotcha:** `gh-pr-comments` gives no diff side. A thread with a `line` goes after the diff row with that **new-file** number (a `+` or context
    row). One whose line matches none, or whose `line` is `null`, goes in **File threads**. A
    thread on a deleted line can land on the wrong row. That is accepted until the bridge reports
    a side.
  - A card shows each comment (author, age, body), then **Reply** (only when `canReply`),
    **Resolve** (on an unresolved thread, when `resolveScope` is `'any'`, or `'copilot'` and the
    thread's `copilot` is true), and **↗** (the first comment's `url`).
- **Reply composer:** a `<textarea>`, **Reply** and **Cancel**. Ctrl/⌘+Enter sends, Escape
  cancels.
  - Note under it: `Posted as you through <container>'s devc-bridge, prefixed with 🤖. Max 4000 bytes.`
  - While sending, the composer is disabled. On success it closes and the tile re-sends
    `pr_threads`. On failure the text stays and the error shows under it.
  - A composer with text is kept across ⟳. If its thread is gone, it says
    `This thread is resolved or gone` and keeps the text for copying.

## Checklist

**Stage 1: listing and tree**

- [ ] `devc/web/pr_review.ts` (new): the lookup and grant check, bridge runs with the timeout and
      cap, the `gh-pr-files` defensive parse, and the listing store
- [ ] `protocol.ts`, `server.ts`: `pr_files`
- [ ] `static/lib/pr_tree.js` (new): tree build and compaction, folder counts, and the
      bidi/zero-width marker split
- [ ] `app.js`, `style.css`: the PR row, header, tree, and disabled checkboxes
- [ ] `devc/deno.json`: `web/pr_review.ts` in the `check` task

**Stage 2: diff tiles**

- [ ] `pr_review.ts`, `protocol.ts`, `server.ts`: `pr_diff`, `fileUrl`
- [ ] `static/lib/diff.js` (new): patch parser
- [ ] `layout.js` (`COMPONENT_TYPES` gains `diff`), `layout_state.js` (`DiffRef`), `app.js`,
      `style.css`: the tile, its restore, and opening from the tree

**Stage 3: threads**

- [ ] `pr_review.ts`, `protocol.ts`, `server.ts`: `pr_threads`, the thread parse, and `other_pr`
- [ ] `diff.js`, `app.js`: placement, File threads, and cards

**Stage 4: writes**

- [ ] `pr_review.ts`, `protocol.ts`, `server.ts`: `pr_viewed`, `pr_reply`, `pr_resolve`
- [ ] `app.js`: the Viewed toggle, composer, Resolve, and re-listing

**Docs and plan cleanup**

- [ ] `devc/README.md`: a **Pull requests** bullet in the devc web section (the row, the diff
      tile, which grant enables what, the `🤖` prefix, and that everything goes through the
      container's bridge). Security: devc web runs no `gh`, and its PR reads and writes are
      bridge commands in the container.
- [ ] `docs/bridge-github.md`: a short note that devc web uses these commands, so a grant also
      enables them in devc web for that repo
- [ ] `.plans/PLAN.md`: this plan's entry replaces `devc-desktop-pr-review`'s

## Validation

- [ ] `(cd devc && deno task check && deno task test)` passes
- [ ] `deno fmt --check` passes for every touched file (from the repo root)
- [ ] `devc/tests/web_pr_review_test.ts` (new; temp home with policy files, and a stub
      `docker` that logs argv and answers from fixtures):
  - [ ] **Lookup:**
    - [ ] no policy → `no_grant`;
    - [ ] a line for another repo → `no_grant`;
    - [ ] `gh-push` only → `no_grant`;
    - [ ] `gh-pr-read` → runs, and `gh-pr-reply` without `gh-pr-read` (a malformed policy) →
          `no_grant`;
    - [ ] `resolveScope` is `any`, `copilot` and `null` for the three grant sets;
    - [ ] a trailing `/` on `root` matches;
    - [ ] a stopped container → `not_running`;
    - [ ] the policy is re-read per message (delete it between two `pr_files` → the second is
          `no_grant`).
  - [ ] **Argv:** exactly
        `docker exec … devc-bridge gh-pr-files --repo <target>`. A reply body of `--repo x`, one of
        `@/etc/passwd` and one of `$(id)` are each one argv element, passed through untouched.
  - [ ] **Parse:**
    - [ ] a bad `pr.url`, a 39-hex `headSha` → `unexpected bridge output`;
    - [ ] a file with `\0` in its path is dropped;
    - [ ] status `weird` → `modified`;
    - [ ] a 4 MiB + 1 patch → `null`;
    - [ ] 3001 files → 3000;
    - [ ] a thread id `x` is dropped;
    - [ ] bodies are capped.
  - [ ] **Limits:** a stub that sleeps past a 200 ms test timeout gives `bridge`, and one that
        writes 64 MiB + 1 gives `bridge output too large`.
  - [ ] **Writes:**
    - [ ] `pr_viewed` without `gh-pr-viewed` is refused, and a path not in the listing →
          `not_found`;
    - [ ] the body rules for `pr_reply` hold;
    - [ ] `pr_resolve` is refused with neither resolve grant, for a human's thread with only
          `gh-pr-resolve-copilot`, and for a resolved thread. It runs for a human's thread with
          `gh-pr-resolve`.
    - [ ] `pr_threads` runs `gh-pr-comments --state all`.
  - [ ] **Diff:** `fileUrl` for `src/a.ts` is the PR URL + `/files#diff-` + its SHA-256, and
        `pr_diff` with no stored listing fetches one.
- [ ] `devc/tests/web_pr_tree_test.ts` (new, pure): `a/b/c/x.ts`, `a/b/c/y.ts`, `a/z.ts`
      compact to `a` holding `b/c` and `z.ts`. Also sort order, folder counts, and U+202E and
      U+200B as markers.
- [ ] `devc/tests/web_diff_test.ts` (new, pure): hunk parse with numbering, the
      `\ No newline` row, raw text after a bad line, and thread placement (new-file line, `null`
      and unmatched → File threads).
- [ ] `web_server_test.ts`: the new messages parse, and a bad shape is `bad_request`.
- [ ] Headless Chromium (Playwright, as devc-web-agent-sessions), devc web page with a fake
      WebSocket:
  - [ ] Opening the PR row sends `pr_files`, then shows the header and a compacted tree.
        `no_grant` shows the hint line.
  - [ ] Checkboxes are disabled without `canViewed`. With it, a toggle sends `pr_viewed` and
        updates the counts, and a failing reply puts it back with a toast.
  - [ ] A file click opens a `diff` tile with numbered hunks, and a second click reuses it. A
        reload restores it by sending `pr_diff`.
  - [ ] Threads land after their new-file line, and unmatched ones in File threads. Resolve shows on
        every unresolved thread with `resolveScope:'any'`, only on Copilot's with `'copilot'`, and on
        none with `null`. Resolved threads fold into `Resolved (n)`, and **Show resolved** opens them. Reply hides without `canReply`.
  - [ ] Reply sends `pr_reply` and re-lists, and on failure keeps the text.
  - [ ] A title `<img src=x onerror=alert(1)>`, and a comment body with HTML and U+202E, show as
        text and a marker, with no new element and no page error.
- [ ] By the user, with real `gh` and a container started with
      `--bridge-allow gh-pr-read,gh-pr-reply,gh-pr-viewed,gh-pr-resolve` (or the same as
      `bridgeDefaultAllow`) on a throwaway PR's branch, in devc web from source
      (`--live-yolo`):
  - [ ] The repo's PR row shows the tree.
  - [ ] Mark a file Viewed and see it on github.com, then unmark it.
  - [ ] Click a file and see its diff tile with Copilot's or a reviewer's threads.
  - [ ] Reply (`🤖` on github.com), and resolve a human reviewer's thread. It then shows under
        `Resolved (1)`.
  - [ ] Re-run with `gh-pr-resolve-copilot` in place of `gh-pr-resolve`: Resolve shows only on
        Copilot's threads after ⟳.
  - [ ] Re-run `devc up --bridge-allow gh-pr-read`: Viewed checkboxes, Reply and Resolve are
        gone after ⟳.
  - [ ] `devc up --bridge-allow none`: the row shows the grant hint.

## Relevant Files

| File                                     | Change                                                                |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `devc/web/pr_review.ts` (new)            | lookup, grant check, bridge runs, parsing, listing store, write rules |
| `devc/web/protocol.ts`                   | the six messages and parsers                                          |
| `devc/web/server.ts`                     | handler cases                                                         |
| `devc/web/static/lib/pr_tree.js` (new)   | pure tree, counts, markers                                            |
| `devc/web/static/lib/diff.js` (new)      | patch parser, thread placement                                        |
| `devc/web/static/lib/layout_state.js`    | `DiffRef`                                                             |
| `devc/web/static/layout.js`              | the `diff` component type                                             |
| `devc/web/static/app.js`                 | PR row, tree, diff tile, threads, composer, Viewed                    |
| `devc/web/static/style.css`              | PR row and diff tile styles                                           |
| `devc/deno.json`                         | `web/pr_review.ts` in `check`                                         |
| `devc/tests/web_pr_review_test.ts` (new) | server tests                                                          |
| `devc/tests/web_pr_tree_test.ts` (new)   | tree tests                                                            |
| `devc/tests/web_diff_test.ts` (new)      | parser and placement tests                                            |
| `devc/tests/web_server_test.ts`          | message parse tests                                                   |
| `devc/README.md`                         | Pull requests bullet, Security note                                   |
| `docs/bridge-github.md`                  | devc web uses these commands                                          |
| `.plans/PLAN.md`                         | replace `devc-desktop-pr-review`'s entry and row                      |
