# devc-desktop-pr-review

Review a GitHub pull request across devc-desktop and devc web:

- **devc-desktop's PR Review panel** (new, right of devc web) picks a PR and shows a tree of
  its changed files. Each file has a **Viewed** checkbox, which is GitHub's own Viewed state.
  The app's main process does all of this with `gh` on this machine.
- **Clicking a file opens its diff as a tile in devc web.** The panel hands the file's patch to
  devc web's server, and the server sends it to the page. This works with or without devc-bridge.
- **Review threads show in the diff tile when a container's bridge allows it.** devc web finds a
  running container whose bridge policy grants `gh-pr-review` and pins the PR's head repo and
  branch. It reads the threads with `devc-bridge gh-pr-comments` in that container, and posts
  replies (and Copilot-thread resolves, with `gh-pr-resolve`) through the same container's bridge.
- **devc web can ask the panel to show a repo's PRs** (a repo row's **Open PRs** item), over a
  one-way event stream that the app checks before acting.

```
┌──────────────────────────── devcd ──────────────────────────────────────┐
│ devc web                                           ┃ PR Review   ⟳ ↗ ✕ │
│ ┌ terminal ┐┌ app.ts · #123 ─────────────────────┐ ┃ owner/repo#123     │
│ │          ││ src/web/app.ts  M  +3 −1   ↗        │ ┃ Fix the widget     │
│ │          ││ @@ -10,6 +10,9 @@                   │ ┃ feature/x → main   │
│ │          ││ 10 10   const a = 1;               │ ┃ 3/14 viewed        │
│ │          ││    11 + const b = 2;               │ ┃ ▾ src/web     1/3  │
│ │          ││   ┌ 💬 copilot · 2h ─────────────┐ │ ┃   ☑ M app.ts       │
│ │          ││   │ Consider …                   │ │ ┃   ☐ A new.ts       │
│ │          ││   │ [Reply] [Resolve] [↗]        │ │ ┃ ▸ tests       0/4  │
│ └──────────┘└────────────────────────────────────┘ ┃   ☐ D old.md       │
├────────────────────────────────────────────────────┴────────────────────┤
│ HOST  (drawer, full width, unchanged)                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

Read `devc-desktop/README.md` ("Why devc web cannot reach it"), `devc-desktop/src/main/main.ts`,
`devc-bridge/builtin/gh-pr-comments`'s header, and `.claude/skills/devc-web/SKILL.md` if it
exists, first.

## Decisions

- **Who may run `gh` on this machine: only devc-desktop's main process, for the panel.** devc
  web's page can be driven by an agent in a container (`--live` code from a writable checkout,
  or the token). So devc web and its server never run `gh`. The panel is a bundled page with a
  preload, and the main process checks every IPC sender (`fromView`). The panel has one write:
  Viewed. It starts only from a click in the panel.
- **Writes that devc web makes go through the bridge.** Text typed in devc web passes through
  space an agent can control, so posting it must not widen what an agent can already do.
  `devc-bridge gh-pr-reply` / `gh-pr-resolve` in a container granted `gh-pr-review` /
  `gh-pr-resolve` is exactly that surface. The bridge's limits therefore carry over:
  - only the container's pinned PR;
  - replies get the bridge's `🤖` prefix, which is honest here;
  - no new threads, because the bridge has no command for it;
  - resolve only Copilot's threads.
    The compose box says all of this.
- **The diff needs no bridge.** The panel already has the patch (from host `gh`), so it hands it
  to devc web. **What this exposes:** once a file's patch is in devc web, any agent that can
  drive devc web's page can read it. That covers only the files you click, of PRs you open. The
  README says so.
- **Events from devc web only change what the panel shows.** devc web pushes typed events on
  `GET /desktop/events`, and the app drops anything it doesn't recognize. An event can open the
  panel and list a repo's PRs, but it never moves keyboard focus, never marks Viewed, and is rate
  limited. The repo it names is a hint, since a container can edit `.git/config`, so the panel
  labels it `from devc web`.
- **Later, not here:** the bridge serving thread _reads_ without a grant, with `--bridge-allow`
  only adding writes. That would make threads show for any container that pins the PR. This plan
  checks for `gh-pr-review` today. When that bridge change lands, only the check
  (`threadsGrant` below) changes.

## Concept boundaries

- **github.com only.** A PR ref is `https://github.com/<owner>/<repo>/pull/<n>` (anything after
  `<n>` is ignored) or `<owner>/<repo>#<n>`. Any other host: `Only github.com pull requests are
  supported`.
- **One PR in the panel at a time.** The last opened ref is saved as `reviewPr` in
  `desktop-state.json` and reopened the first time the panel opens after a launch.
- **No polling.** The panel loads data when it opens a PR, when you click Refresh, and when the
  panel is shown and its data is more than 60 s old. The diff tile lists threads when it opens,
  on its Refresh, and after each write.
- **Unified diff only**, from GitHub's per-file `patch`. No side-by-side view, no expanding
  context, no syntax highlighting. A file without a `patch` (binary, or too large for GitHub)
  shows `No diff available for this file` and the tile's Open on GitHub link.
- **Untrusted text.** PR titles, paths, patches and comment bodies are shown with
  `textContent` only (in the panel and in devc web). Bidi controls (U+202A–U+202E,
  U+2066–U+2069) and zero-width characters (U+200B–U+200F, U+2060, U+FEFF) in paths, patch
  lines and comments show as visible markers (`⟨U+202E⟩`, styled as a warning chip). This is the
  Trojan Source check. Comment bodies are plain text (`pre-wrap`), not rendered markdown.
- **Debug switches refuse the panel**, as they do the host terminal. While `debugReason` is not
  `null`, every `review:*` handler returns `{ok:false, error:<that reason>}`, and the app doesn't
  open `/desktop/events`.

## Contracts: devc-desktop

### Layout (`policy.ts`)

`layout(width, height, drawer, review)` returns `{ main, review, host }`. `review` is the
panel's width in px, or `null` when the panel is closed. The drawer, when open, spans the full
width at the bottom (unchanged). The area above it is split into `main` on the left and `review`
on the right. No two rectangles overlap.

- `REVIEW_MIN = 240`, `REVIEW_DEFAULT = 320` (px), `REVIEW_MAX_SHARE = 0.5` of the width.
  `clampReview(w, total)` works the same way as `clampDrawer`.
- A 6 px drag strip on the panel page's left edge sends `review:drag` with `dx`, the same way
  `host-term:drag` sends `dy`. `saveState` writes `{drawerHeight, reviewWidth, reviewPr}`.

### Menu

In the `devc web` menu, below **Host Terminal**: **PR Review**, `Cmd+Shift+G` on macOS and
`Ctrl+Shift+G` elsewhere (VS Code's Source Control toggle). It opens or closes the panel. The
page is loaded on first open, as `hostLoaded` does. Opening from the menu focuses the panel, and
closing focuses the main view. An **event** opening the panel does not move focus.

### `gh` (`src/main/gh.ts`, new)

- **Finding it:** `gh` on the app's `PATH`, else on the login shell's (`onPath`, `loginEnv` from
  `launch.ts`). The first hit is cached. A miss isn't cached, so every request looks again.
  Not found: `gh not found on the app's PATH or your login shell's PATH`.
- **Running it:** `execFile` (no shell), `cwd` set to the home folder, a 30 s timeout,
  `maxBuffer` 64 MiB. The environment is `childEnv(process.env, loginPath)` plus
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `NO_COLOR=1`, `CLICOLOR=0` and `GH_PAGER=`.
  Only `gh api` is run, and the repo is always written out in full.
- **Argument rule:** every string goes as `-f key=value`, a raw string. That includes the GraphQL
  `query`, paths, ids, cursors and search text. `-F` is only for integers the main process has
  validated (`number`): it reads `@file` and converts `true`/`null`.
- **gotcha:** any `-f`/`-F` switches `gh api` to POST. REST GETs put their parameters in the
  endpoint's query string and pass no fields.
- **gotcha:** `--paginate` prints one JSON document per page back to back, and `--slurp` needs
  gh ≥ 2.48. So pages are fetched by hand: REST with `&page=K`, GraphQL with an `$after`
  cursor. The `-f after=…` argument is **left out** when there is no cursor, because `-f` can't
  pass `null`.
- **Errors:** a non-zero exit, a timeout or JSON that doesn't parse gives `{ok:false, error}`.
  `error` is the last non-empty stderr line (cut to 300 characters), `gh timed out`, or
  `gh returned invalid JSON`. A GraphQL `errors` array gives `errors[0].message`. When gh isn't
  authenticated it exits 4, and its `gh auth login` message is shown as is.

### GitHub calls (`OWNER`, `NAME`, `N` are the validated ref parts)

1. **Search** (`review:search`): GraphQL `search(query:$q, type:ISSUE, first:30) { nodes { ...
   on PullRequest { number title isDraft updatedAt repository { nameWithOwner } author { login }
   headRefName } } }`. With no repo it runs twice:
   `is:pr is:open archived:false review-requested:@me sort:updated-desc` and
   `is:pr is:open archived:false author:@me sort:updated-desc`. For an event's repo it runs
   `repo:OWNER/NAME is:pr is:open sort:updated-desc`.
2. **Header and Viewed state**: GraphQL `repository(owner:$owner, name:$name) {
   pullRequest(number:$number) { id title url state isDraft headRefOid baseRefName headRefName
   headRepository { nameWithOwner } author { login } files(first:100, after:$after) { pageInfo
   { hasNextPage endCursor } nodes { path viewerViewedState } } } }`, with
   `-f owner -f name -F number`, repeated while `hasNextPage` is true.
   - `pullRequest: null` → `Pull request not found (or gh's token can't see it)`.
   - `headRepository: null` (the fork was deleted) → `headRepo: null`.
   - `author: null` → `ghost`.
3. **Files with patches**: REST `repos/OWNER/NAME/pulls/N/files?per_page=100&page=K` for K = 1,
   2, … until a page has fewer than 100 entries, or K = 30. A full page at K = 30 sets
   `filesTruncated`. Fields used: `filename`, `previous_filename`, `status`, `additions`,
   `deletions`, `patch`. Viewed state is joined by path from call 2 (missing → `UNVIEWED`).
4. **Viewed**: GraphQL `markFileAsViewed(input:{pullRequestId:$id, path:$path}) {
   clientMutationId }`, or `unmarkFileAsViewed`, with `-f id -f path`.
   `viewerViewedState: DISMISSED` (changed since you marked it) shows as not viewed, with a
   `changed since viewed` hint.

### Validation of what the panel page sends (main side)

| Value  | Rule                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR ref | after `trim()`: `^https://github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})/pull/([1-9][0-9]{0,9})(?:[/?#].*)?$` or `^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$`. A repo of `.` or `..` is refused. Another `https://` host gets the github.com message. Anything else: `Not a pull request: use https://github.com/owner/repo/pull/123 or owner/repo#123` |
| `path` | a `path` in the current model                                                                                                                                                                                                                                                                                                                                                                                         |
| URL    | `review:external` only opens an `https://github.com/` URL that is in the current model: the PR's `url`, or a search result's URL built by main                                                                                                                                                                                                                                                                        |

Writes always use the model's own ids, never values from the page.

### IPC (`src/preload/review.ts` exposes `window.prReview`)

`ipcMain.handle('review:<name>')`. If the sender isn't the review page, the handler throws
`refused`. Otherwise it resolves `{ok:true, …} | {ok:false, error}` and never throws, because
Electron wraps thrown errors as `Error invoking remote method …`.

| Channel           | Args                    | Result on `ok`                                                                                                                                  |
| ----------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `review:info`     | —                       | `{ghFound, refused: string \| null, lastRef: string \| null, toggle: string}`                                                                   |
| `review:search`   | —                       | `{requested: PrSummary[], mine: PrSummary[]}`                                                                                                   |
| `review:open`     | `ref`                   | `{model: PrModel}`. It becomes the current model and `reviewPr` is saved.                                                                       |
| `review:refresh`  | —                       | `{model}` (`No pull request open` without one)                                                                                                  |
| `review:current`  | —                       | `{model: PrModel \| null}`, plus `{hint: RepoHint \| null}`, the last event's repo list (for a page reload)                                     |
| `review:viewed`   | `path, viewed: boolean` | `{path, viewed: 'VIEWED' \| 'UNVIEWED'}`. The stored model is updated.                                                                          |
| `review:diff`     | `path`                  | `{delivered: number}`: main POSTs that file to `/desktop/review-diff`. `0` → the panel says `devc web isn't showing a page to open the diff in` |
| `review:external` | `url`                   | `{}`                                                                                                                                            |
| `review:drag`     | `dx` (`ipcMain.on`)     | none                                                                                                                                            |

Main pushes `review:hint` (`RepoHint`) to the page when a `show_prs` event arrives (below).

```ts
interface PrSummary {
  ref: string;
  title: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  headRef: string;
} // ref = "owner/repo#n"
interface RepoHint {
  owner: string;
  repo: string;
  branch: string;
  prs: PrSummary[];
  error: string | null;
} // from a show_prs event
interface PrModel {
  ref: string;
  owner: string;
  repo: string;
  number: number;
  id: string;
  title: string;
  url: string;
  author: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  headRepo: string | null;
  loadedAt: string;
  filesTruncated: boolean;
  files: {
    path: string;
    previousPath: string | null;
    status:
      | 'added'
      | 'removed'
      | 'modified'
      | 'renamed'
      | 'copied'
      | 'changed'
      | 'unchanged';
    additions: number;
    deletions: number;
    patch: string | null;
    viewed: 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
  }[];
}
```

The renderer never gets `patch`. `review:open`/`refresh`/`current` send the model with `patch`
left out, and main keeps it for `review:diff`.

### The panel page

- **No PR open:** a ref input (`Paste a PR URL or owner/repo#123`, Enter opens it), then two
  lists, **Review requested** and **Yours**. Each row shows `repo#n title`, the author, the age
  and a draft marker. Clicking a row opens that PR. When a `RepoHint` is present it shows first,
  as **from devc web: owner/repo @ branch**, with that repo's PRs and the ones whose `headRef`
  is `branch` at the top.
- **Header:** `owner/repo#n`, the title, `head → base`, `<viewed>/<n> viewed`, and the state
  when not OPEN. Buttons: Refresh (⟳), Open on GitHub (↗), and Change PR. A `filesTruncated` PR
  says `GitHub lists at most 3000 files`.
- **Tree** (`src/renderer/review_model.ts`, pure):
  - **Order and compaction:** folders first, then files, each sorted with
    `localeCompare(…, 'en')`. A chain of folders that each hold only one folder is compacted
    into one row (`src/web/lib`).
  - **File row:** the Viewed checkbox, a status letter (`A`, `D`, `R`, `C`, else `M`) in its
    color, the name, and `+a −d` dimmed. A rename's tooltip shows `old → new`.
  - **Folder row:** `viewed/total` of the files under it. A fully viewed folder is dimmed and
    starts collapsed.
  - **Mouse and keys:** clicking a file selects it and calls `review:diff`. ↑/↓ move, ←/→
    collapse or expand, Enter calls `review:diff`, and `v` toggles Viewed.
  - **What is kept:** folders' open state and the selection survive Refresh, and are kept in
    `sessionStorage` keyed by `ref`.
- A failed Viewed toggle puts the checkbox back and shows a toast. Read errors show as a banner
  with **Retry**.
- CSP as `host.html`'s, colors as `host.css`'s.

### Events from devc web (`src/main/signals.ts`, new; pure checks + the stream client)

- **The stream:** after devc web is ready, and when not `debugging`, main opens
  `GET <origin>/desktop/events` with `Authorization: Bearer <token>` and
  `Accept: text/event-stream`, using Node's `fetch`, as `/desktop/active-folder` does.
  - The stream is read as SSE (`data:` lines, an event per blank line; `:` comment lines
    ignored).
  - It reconnects after 1 s, doubling to at most 30 s. The delay resets after a stream has
    stayed up 60 s.
  - It is closed on restart and shutdown, and reopened with the new token.
- **Checks (`parseSignal`):** each event is JSON. An event that fails these checks is dropped
  without a word.
  - Only these shapes pass: `{"type":"show_prs","owner","repo","branch"}` and
    `{"type":"focus_repo","owner","repo","branch"}`. Extra fields are ignored.
  - `owner` and `repo` must match the PR-ref patterns.
  - `branch` must be 1–255 characters of `[A-Za-z0-9._/-]`, with no `..`, `//` or `@{`, no
    leading `/`, `-` or `.`, and no trailing `/`, `.` or `.lock`.
- **`show_prs`:** at most one is acted on per second. Later ones in that second are collapsed
  into the last.
  - Main runs search call 1 for the repo and builds a `RepoHint` (a failed search sets `error`).
  - When exactly one open PR has `headRef === branch`, main opens it, as `review:open` does.
    Otherwise it sends `review:hint` and the panel shows its list.
  - The panel opens if it was closed (`setVisible`), without focusing it.
- **`focus_repo`:** main keeps the latest one and shows it as a one-line suggestion in the
  panel's picker (`Focused in devc web: owner/repo @ branch`). It never navigates and never
  opens the panel.

## Contracts: devc web

### `POST /desktop/review-diff` (from the app only)

- **Access:** the existing `/desktop/` rules apply: any `Origin` → 403, and the token only as
  `Authorization: Bearer` → 401. Only `POST` is allowed (others → 405). A body over 8 MiB → 413.
  JSON that isn't a valid `ReviewDiffInput` → 400.
- **On success:** the server stores the diff under `ref + '\n' + path`, replacing any earlier
  one. It keeps at most 64, dropping the oldest. It then sends `review_diff {diff}` to **one**
  page: the socket that sent the latest `active_pane` message, when it is still open. Otherwise
  it sends to every connected page. Answer: `200 {"delivered": <number of pages>}`.

```ts
interface ReviewDiffInput {
  ref: string; // owner/repo#n (the PR-ref pattern)
  prUrl: string; // https://github.com/owner/repo/pull/n
  title: string; // ≤ 1024
  headRepo: string | null; // owner/repo
  headRef: string;
  headSha: string;
  baseRef: string; // ≤ 255 each; headSha 40 hex
  path: string;
  previousPath: string | null; // ≤ 4096, no \0
  status: string;
  additions: number;
  deletions: number;
  patch: string | null; // ≤ 4 MiB
}
// review_diff.diff = ReviewDiffInput + { fileUrl: string }
// fileUrl = prUrl + '/files#diff-' + sha256hex(path)   (GitHub's file anchor)
```

### Messages

| Message (page → server) | Fields                                | Server does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_review_diff`       | `id`, `ref`, `path`                   | `result {diff}` from the store, else `not_found` (for a tile restored after reload or restart)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `review_threads`        | `id`, `ref`, `path`                   | Not in the store → `not_found`. Then `threadsGrant` (below). No match → `result {available:false, reason:'no_grant', message}`. Otherwise it runs `devc-bridge gh-pr-comments --repo <target>` in that container (`dockerExecArgv(info, {cwd:'/', cmd:[…]})`, 60 s timeout, argv only). Non-zero exit → `result {available:false, reason:'bridge', message: <last stderr line, ≤ 300>}`. Output `pr.url` ≠ the diff's `prUrl` → `{available:false, reason:'other_pr', message:'The bridge reports a different PR: <url>'}`. Otherwise `result {available:true, container: <name>, canReply: true, canResolve: <grants include gh-pr-resolve>, threads}`, where `threads` are the validated ones whose `path` is the diff's `path`. The full listing is kept as that diff's last listing. |
| `review_reply`          | `id`, `ref`, `path`, `thread`, `body` | `threadsGrant` again. `thread` must be in the diff's last listing (else `not_found`). `body`: a string, non-empty after trim, ≤ 4000 UTF-8 bytes, no control characters but `\n` and `\t` (else `bad_request` with the rule). Runs `devc-bridge gh-pr-reply --repo <target> <thread> <body>`, all argv. Exit 0 → `result {}`. Exit 3 → `bad_request` with the bridge's message. Others → `bridge_failed` with the message.                                                                                                                                                                                                                                                                                                                                                               |
| `review_resolve`        | `id`, `ref`, `path`, `thread`         | As `review_reply`, plus: the grants include `gh-pr-resolve` and the thread's `copilot` is true (else `bad_request` `Only Copilot's threads can be resolved through the bridge`). Runs `devc-bridge gh-pr-resolve --repo <target> <thread>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `show_prs`              | `id`, `container`, `root`             | `root` must be one of that container's repo host paths (else `bad_request`). Reads its branch and upstream with `git_repo.ts` (as data, no git run in it). `gitHubRepoOf(url)` null → `bad_request` `Not a GitHub repo`. No branch (detached) → `bad_request` `No branch checked out`. Sends `{"type":"show_prs",owner,repo,branch}` on every `/desktop/events` stream. `result {delivered: <streams>}`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `active_repo`           | `container`, `root` (both or neither) | No reply. Resolves like `show_prs`, and when the result differs from the last one it sends `{"type":"focus_repo",…}`. Failures are dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`review_diff {diff}` is the one server → page push this plan adds.

**`threadsGrant(diff)`** is the first running container, by container name, whose bridge policy
meets all of these:

- the policy is read from the host-only `policy/<key>.conf` with `readPolicy`, using the key
  that `bridgeStatusLines` in `devc/bridge.ts` derives for the container;
- its `grants` include `gh-pr-review`;
- it has a pinned repo with `gitHubRepoOf(remote)` equal to the diff's `headRepo`
  (case-insensitive) and `branch === headRef`.

It returns that container and the pinned repo's `target`. `headRepo: null` never matches. The
`no_grant` message is
`Threads need a running container with --bridge-allow gh-pr-review on <headRepo> @ <headRef>`.

**`gh-pr-comments` output is the container's**, so it is untrusted. It is parsed defensively,
keeping only these fields:

```ts
interface BridgeThread {
  id: string;
  path: string;
  line: number | null;
  isOutdated: boolean;
  copilot: boolean;
  comments: { author: string; body: string; createdAt: string; url: string }[];
}
```

A thread or comment with a wrong type is dropped, and a `url` not starting `https://github.com/`
becomes `''`. The caps are 500 threads, 100 comments per thread and 65 536 characters per body.

**Gotchas**

- `gh-pr-comments` lists **unresolved** threads only, and gives no diff side. A thread with a
  `line` goes after the diff line with that **new-file** number (a `+` or context line). One
  whose line matches none, or whose `line` is `null`, goes in the **File threads** block above
  the first hunk. A thread on a deleted line can land on the wrong row. That is accepted until
  the bridge reports `diffSide`.
- The new messages carry `container` (`show_prs`, `active_repo`) or nothing per container
  (`get_review_diff`, `review_*`). Parser cases go in `protocol.ts`. The `container` ones also
  get `case`s in the per-container `switch` in `server.ts`'s `handle`, after the `localFolder` →
  `handleProject` check, as `list_sessions` does.
- Under `devc web --live` the installed server doesn't know the new messages or routes. Testing
  needs `--live-yolo`, or `desktopDevc: "devc2"`.

### The diff tile (devc web page)

- **Opening:** a `review_diff` push opens a tile of a new kind, `diff`, in the focused stack, or
  updates and activates the existing tile for the same `ref` + `path`. It doesn't take keyboard
  focus from the PR Review panel.
  - Title: `<basename> · #<n>`. Tooltip: `ref`, then path.
  - The saved layout keeps `{ref, path}`. A restored tile sends `get_review_diff`, and on
    `not_found` shows `This diff is gone. Click the file in devc-desktop's PR Review panel again.`
- **Header:** the path (`old → new` for a rename), the status letter, `+a −d`, `owner/repo#n`,
  Refresh threads (⟳), and Open on GitHub (↗, `fileUrl` through `window.open`, which
  devc-desktop hands to the system browser).
- **Body:**
  - first the **File threads** block, then each hunk: its header row, then rows of old number,
    new number and text, with add/delete backgrounds, and `\ No newline at end of file`
    dimmed with no numbers;
  - hunk headers are parsed with `/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/`, and the
    first line that is none of ``, `+`, `-` or `\` ends the parse, leaving the rest as raw text.
  - The pure parser and the thread placement live in `static/lib/diff.js`.
- **Threads:** when the tile opens it sends `review_threads`.
  - `available:false` → one dimmed line under the header with the `message`. `no_grant` is
    phrased as a hint, not an error.
  - `available:true` → cards after their lines. Each card shows its comments (author, age, body)
    and **Reply**, **Resolve** (only when `canResolve` and `copilot`), and **↗** (the first
    comment's `url`).
  - The header shows `threads via <container>'s bridge`.
- **Reply composer:** a `<textarea>`, **Reply** and **Cancel**. Ctrl/⌘+Enter sends, Escape
  cancels.
  - Note under it: `Posted as you through <container>'s devc-bridge, prefixed with 🤖. Max 4000
    bytes.`
  - While sending, the composer is disabled. On success it closes and the tile re-sends
    `review_threads`. On failure the text stays and the error shows under it.
  - A composer with text is kept across a Refresh. If its thread is gone, it says
    `This thread is resolved or gone` and keeps the text for copying.
- **Open PRs:** a repo row's menu (the menu with `Copy path`) gets **Open PRs**. It sends
  `show_prs`. `delivered: 0` shows a toast: `Open devc web in devc-desktop to review PRs`.
- **`active_repo`:** sent when the active tile's container and repo change. A tile with no repo
  sends `{}`.

## Checklist

Stages 1–5 each leave both apps working. Implement them in order.

**Stage 1: the panel, tree and Viewed (devc-desktop only)**

- [ ] `policy.ts`: `layout` with `review`, `REVIEW_*`, `clampReview`, `parsePrRef`,
      `isGithubUrl`
- [ ] `src/main/gh.ts` (new): lookup, runner, calls 1–4 and their parsers
- [ ] `src/renderer/review_model.ts` (new): tree build and compaction, folder counts, the
      bidi/zero-width marker split, age text
- [ ] `main.ts`: the review view (sandbox, contextIsolation, partition `review`,
      `preload-review.js`, `lockDownBundled`), relayout, the menu item, `review:info`/`search`/
      `open`/`refresh`/`current`/`viewed`/`external`/`drag`, debug refusal, state fields
- [ ] `src/preload/review.ts`, `src/renderer/review.html`/`review.ts`/`review.css` (new)
- [ ] `build.mjs`: bundle the preload and page, copy HTML and CSS
- [ ] Tests: `tests/policy.test.ts`, `tests/gh.test.ts` (new), `tests/review_model.test.ts` (new)

**Stage 2: diffs in devc web**

- [ ] `devc/web/pr_review.ts` (new): `ReviewDiffInput` validation, `fileUrl`, the 64-entry store,
      picking the target page
- [ ] `devc/web/server.ts`: `POST /desktop/review-diff`, `review_diff` push,
      `get_review_diff`. `protocol.ts`: the message types and parsers
- [ ] `devc/web/static/lib/diff.js` (new), `app.js`, `layout.js`, `style.css`: the `diff` tile
      and its restore
- [ ] devc-desktop: `review:diff` in `main.ts`, Enter/click in the tree
- [ ] `devc/deno.json`: `web/pr_review.ts` in the `check` task
- [ ] Tests: `devc/tests/web_pr_review_test.ts` (new), `devc/tests/web_pr_review_page_test.ts`
      (new), `web_server_test.ts` (auth on the new route)

**Stage 3: threads through the bridge (read)**

- [ ] `pr_review.ts`: `threadsGrant`, the `gh-pr-comments` run and defensive parse.
      `devc/bridge.ts`: export the container → bridge key derivation that `bridgeStatusLines`
      uses, if it isn't exported yet (no behavior change)
- [ ] `server.ts`/`protocol.ts`: `review_threads`
- [ ] `diff.js`/`app.js`: placement, File threads block, cards, the `available:false` line
- [ ] Tests: grant matching (grant missing, other branch, other repo, case-insensitive repo,
      `headRepo: null`, two matches → the first by name), parse of hostile output, placement

**Stage 4: replies and resolves through the bridge**

- [ ] `server.ts`/`protocol.ts`/`pr_review.ts`: `review_reply`, `review_resolve`
- [ ] `app.js`: composer, Resolve, re-listing
- [ ] Tests: argv exactly `devc-bridge gh-pr-reply --repo <target> <thread> <body>` with a body
      of `--repo x`, `@/etc/passwd` and one with `$(id)` passed through untouched; body rules;
      resolve refused for a non-Copilot thread and without `gh-pr-resolve`

**Stage 5: events from devc web to the panel**

- [ ] `server.ts`: `GET /desktop/events` (SSE, `/desktop/` auth, `GET` only, a `: ping` comment
      every 25 s, the stream set dropped on close), `show_prs`, `active_repo`
- [ ] `app.js`: **Open PRs** in the repo row menu, `active_repo` on active-tile change
- [ ] devc-desktop `src/main/signals.ts` (new): `parseSignal`, the stream reader, the
      reconnect, the rate limit. `main.ts`: `RepoHint`, `review:hint`, open-without-focus
- [ ] Tests: `devc-desktop/tests/signals.test.ts` (new), `web_server_test.ts` (events auth),
      `web_pr_review_test.ts` (`show_prs` resolution)

**Docs**

- [ ] `devc-desktop/README.md`: a fourth row in the views table. A **PR Review** section (gh
      lookup, refs, Viewed, diffs in devc web, events). The shortcut. In "Why devc web cannot
      reach it": devc web never gets `gh`, events only change what the panel shows, and an
      opened diff is readable by anything driving devc web's page. The `Layout` list.
- [ ] `devc/README.md`: devc web section, **PR diffs** (the diff tile, threads through the
      bridge and their limits, the 🤖 prefix, **Open PRs**). Security: the two new `/desktop/`
      routes.
- [ ] `devc-desktop/package.json`: `version` `0.2.0` → `0.3.0`

## Validation

- [ ] `(cd devc-desktop && npm ci && npm run check && npm test)` passes
- [ ] `(cd devc && deno task check && deno task test)` passes
- [ ] `deno fmt --check` passes for every touched file (from the repo root)
- [ ] `policy.test.ts`:
  - [ ] `layout` with the panel open and closed, with and without the drawer: no overlap, and the
        area is covered. `clampReview` at 100, 5000 and in a 300 px window.
  - [ ] `parsePrRef` accepts `https://github.com/a/b/pull/12`, `…/pull/12/files#diff-x` and
        `a/b#12`.
  - [ ] It refuses `https://ghe.example.com/a/b/pull/1` (github.com message), `a/..#1`, `a/b#0`,
        `a/b#12x`, `-a/b#1` and a 40-character owner.
- [ ] `gh.test.ts`, with a stub `gh`: a temp-dir script on `PATH` that logs its argv as JSON lines
      and answers from fixtures chosen by an env var.
  - [ ] Each call's argv is right, and REST GETs have no `-f`/`-F`.
  - [ ] Files paging stops at a short page, and a full page 30 sets `filesTruncated`. The first
        GraphQL call has no `-f after`, and a second files page is merged.
  - [ ] Each failure gives the expected `error`: GraphQL `errors`, exit 4 with a `gh auth login`
        line, invalid JSON, and a timeout (a sleeping stub against a 200 ms test timeout).
  - [ ] Missing `gh` gives the not-found message, and `gh` is found once it appears.
- [ ] `review_model.test.ts`:
  - [ ] Compaction: `a/b/c/x.ts`, `a/b/c/y.ts`, `a/z.ts` → `a` holding `b/c` and `z.ts`.
  - [ ] Sort order and folder viewed counts.
  - [ ] U+202E and U+200B become markers.
- [ ] `signals.test.ts`:
  - [ ] `parseSignal` accepts both types and ignores extra fields.
  - [ ] It drops unknown types, bad JSON and an owner of `-x`. It drops branches `a..b`, `/a`,
        `a.lock`, `a//b`, `a@{1}`, 256 characters, and one with a space or U+202E.
  - [ ] The SSE reader handles events split across chunks and `:` comments.
  - [ ] The rate limit acts on the last of three `show_prs` sent inside one second.
- [ ] `web_pr_review_test.ts`:
  - [ ] `ReviewDiffInput` refuses a bad ref, a non-github `prUrl`, a 4 MiB + 1 patch, a path with
        `\0`, and a non-40-hex `headSha`.
  - [ ] `fileUrl` for `src/a.ts` is the PR URL + `/files#diff-` + its SHA-256.
  - [ ] The store keeps 64 entries, replaces the same `ref`+`path`, and drops the oldest.
  - [ ] The target page is the latest `active_pane` socket, or all pages when that socket is
        closed.
  - [ ] `threadsGrant` cases (Stage 3).
  - [ ] The defensive parse drops wrong types and caps sizes.
  - [ ] Reply and resolve argv and refusals (Stage 4).
  - [ ] `show_prs` refuses an unknown `root` and a non-GitHub upstream, and emits the event for a
        GitHub one.
- [ ] `web_server_test.ts`: `POST /desktop/review-diff` and `GET /desktop/events` → 403 with any
      `Origin`, 401 without the bearer token or with it only in `?token=`, and 405 on the wrong
      method. The review-diff route gives 413 over 8 MiB. Existing routes are unchanged.
- [ ] Headless Chromium (Playwright, as devc-web-agent-sessions), panel: against
      `devc-desktop/build/renderer/review.html` with a fake `window.prReview`.
  - [ ] The picker shows both groups and a `RepoHint` group first. A bad ref shows its message.
  - [ ] The tree compacts folders and shows status letters and counts.
  - [ ] Viewed toggles update the counts, and a failing fake puts the checkbox back.
  - [ ] ↑/↓/←/→/Enter/`v` work, and a click calls `diff`.
  - [ ] A title `<img src=x onerror=alert(1)>` and a U+202E path create no element and no page
        error.
- [ ] Headless Chromium, devc web page with a fake WebSocket:
  - [ ] A `review_diff` push opens a `diff` tile with numbered hunks, and a second push for the
        same file reuses it.
  - [ ] A restored tile sends `get_review_diff` and shows the gone message on `not_found`.
  - [ ] `available:false` shows its line.
  - [ ] Threads land after their new-file line, and outdated ones in File threads.
  - [ ] Resolve shows only for Copilot threads with `canResolve`.
  - [ ] Reply sends `review_reply` and re-lists, and on failure keeps the text.
  - [ ] **Open PRs** sends `show_prs`, and `delivered: 0` shows the toast.
  - [ ] A comment body with HTML and U+202E shows as text and a marker.
- [ ] Linux, Xvfb (as devc-desktop-host-cd's Verify), with devc web from source
      (`desktopDevc: "devc2"`), a stub `docker` and the stub `gh`:
  - [ ] Ctrl+Shift+G opens the panel right of devc web, and the drawer goes under both.
  - [ ] The panel width persists across a relaunch, and the last PR reopens.
  - [ ] Clicking a file opens its diff tile in devc web while the panel keeps focus.
  - [ ] **Open PRs** on a repo row opens the panel on that repo's PRs, and keyboard focus doesn't
        move.
  - [ ] In devc web's DevTools console, `prReview`, `hostTerm`, `require` and `process` are
        `undefined`.
  - [ ] With `--remote-debugging-port=0`, the panel shows the refusal, the stub log shows no `gh`
        call, and the server sees no `/desktop/events` stream.
- [ ] macOS, by the user, with real `gh` and a container started with
      `--bridge-allow gh-pr-review,gh-pr-resolve` on a throwaway PR's branch:
  - [ ] Open the PR from **Yours** and see the tree.
  - [ ] Mark a file Viewed and see it on github.com, then unmark it.
  - [ ] Click a file and see its diff tile with Copilot's or a reviewer's threads.
  - [ ] Reply (`🤖` on github.com) and resolve a Copilot thread.
  - [ ] **Open PRs** on the repo row opens the panel on that PR.
  - [ ] Stop the container: the tile says threads need a grant, and the diff still shows.

## Relevant Files

| File                                              | Change                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `devc-desktop/src/main/policy.ts`                 | `layout` with the panel, `clampReview`, `REVIEW_*`, `parsePrRef`, `isGithubUrl`              |
| `devc-desktop/src/main/gh.ts` (new)               | `gh` lookup and runner, calls 1–4                                                            |
| `devc-desktop/src/main/signals.ts` (new)          | `parseSignal`, SSE reader, reconnect, rate limit                                             |
| `devc-desktop/src/main/launch.ts`                 | export what `gh.ts` reuses, if not exported yet (no behavior change)                         |
| `devc-desktop/src/main/main.ts`                   | review view, relayout, menu item, `review:*` IPC, `/desktop/review-diff` POST, events, state |
| `devc-desktop/src/preload/review.ts` (new)        | `window.prReview`                                                                            |
| `devc-desktop/src/renderer/review.html` (new)     | the panel page, CSP as `host.html`                                                           |
| `devc-desktop/src/renderer/review.ts` (new)       | picker, header, tree                                                                         |
| `devc-desktop/src/renderer/review.css` (new)      | its styles                                                                                   |
| `devc-desktop/src/renderer/review_model.ts` (new) | pure tree, counts, markers, age                                                              |
| `devc-desktop/build.mjs`                          | bundle the preload and page, copy HTML and CSS                                               |
| `devc-desktop/tests/policy.test.ts`               | layout and ref tests                                                                         |
| `devc-desktop/tests/gh.test.ts` (new)             | stub-`gh` tests                                                                              |
| `devc-desktop/tests/review_model.test.ts` (new)   | tree tests                                                                                   |
| `devc-desktop/tests/signals.test.ts` (new)        | event checks and stream tests                                                                |
| `devc-desktop/README.md`                          | views table, PR Review section, shortcut, threat model, layout                               |
| `devc-desktop/package.json`                       | version `0.3.0`                                                                              |
| `devc/web/pr_review.ts` (new)                     | diff input checks, store, `threadsGrant`, bridge runs and parsing, `show_prs` resolution     |
| `devc/web/protocol.ts`                            | new messages and parsers                                                                     |
| `devc/web/server.ts`                              | `/desktop/review-diff`, `/desktop/events`, message handlers, `review_diff` push              |
| `devc/bridge.ts`                                  | export the container → bridge key derivation (no behavior change)                            |
| `devc/web/static/lib/diff.js` (new)               | patch parser, thread placement, markers                                                      |
| `devc/web/static/app.js`                          | `diff` tile, threads, composer, **Open PRs**, `active_repo`                                  |
| `devc/web/static/layout.js`                       | the `diff` tile kind and its saved `{ref, path}`                                             |
| `devc/web/static/style.css`                       | diff tile styles                                                                             |
| `devc/deno.json`                                  | `web/pr_review.ts` in `check`                                                                |
| `devc/tests/web_pr_review_test.ts` (new)          | server-side tests                                                                            |
| `devc/tests/web_pr_review_page_test.ts` (new)     | page tests                                                                                   |
| `devc/tests/web_server_test.ts`                   | auth on the two new routes                                                                   |
| `devc/README.md`                                  | PR diffs section, `/desktop/` routes in Security                                             |
| `.plans/PLAN.md`                                  | Pending entry and Development Phases row                                                     |
