# devc-show — agents show you a file or a PR diff in devc web

An agent running in a devc web terminal shows the person a file, or the file's diff in the branch's
open pull request, scrolled to and highlighting a line range. It is meant for walkthroughs: "step
me through these and show me each one". The file opens in the devc web page where the person is
talking to that agent, in one reused tile beside the agent's terminal, and keyboard focus stays in
the terminal.

- In a devcontainer: `devc-bridge show …` (a native bridge built-in).
- On this machine (host projects): `devc show …`.

Both take the same arguments, print the same output and use the same exit codes. Both write a
request file under `~/.config/devc/show/`. Every running devc web server watches that folder; the
servers agree on one page, and that server shows the target and writes the result.

The person can also open these targets themselves: terminal links gain line ranges
(`src/a.ts:40-58`) and a `pr:` form (`pr:src/a.ts:40`) that opens the file's PR diff at the line.

Local diffs (uncommitted work, or a branch compared with another ref) are a separate phase:
[devc-show-local-diff](devc-show-local-diff.md). In this phase `--diff` means the PR diff only.

## Checklist

- [ ] `devc-core/show_request.ts` (new): target parsing, the request/claim/result files, and the
      writer's wait (see Contracts)
- [ ] `devc-bridge/client/devc-bridge.ts`: every request also carries `cwd` and `pane`; usage line
      for `show`
- [ ] `devc-bridge/host/core.ts`: `show` is dispatched as an ungated native command (see
      Contracts); `warnShadowed` warns for `commands/show`
- [ ] `devc-bridge/host/show.ts` (new): the `show` handler
- [ ] `devc/show.ts` (new) and `devc/main.ts`: the `devc show` command
- [ ] `devc/web/show.ts` (new): watches the request folder, claims, picks the winner, resolves the
      target, writes the result
- [ ] `devc/web/server.ts`: tracks each view's last focus time; wires `show.ts` to the views and
      delivers the show to the winning view's `/main` page
- [ ] `devc/web/static/tiles.js` (+ `lib/view.js`, `protocol.ts` as needed): placement, line reveal
      and range highlight for file and diff tiles, without moving keyboard focus
- [ ] `devc/web/static/viewer.js`: range highlight in a file tile
- [ ] `devc/web/static/lib/links.js`: line ranges on file links, and `pr:` links (see Contracts)
- [ ] `devc/web/static/tiles.js` `openLink`: a range highlights; a `pr:` link opens the PR diff
      tile through the same reveal and highlight path as `show --diff`
- [ ] `skills/devc-show/SKILL.md` (new): helps an agent find the tools (see Contracts)
- [ ] Help and docs: `devc/help.ts`, `devc/README.md`, `devc-bridge/README.md`, bridge client usage
- [ ] Tests listed under Relevant Files

## Contracts

### Command line

```
devc-bridge show [--diff [--side LEFT|RIGHT]] <path>[:<line>[-<end>]]   # in a devcontainer
devc show        [--diff [--side LEFT|RIGHT]] <path>[:<line>[-<end>]]   # on this machine
```

- `<path>`: absolute, or relative to the caller's current folder. In a container it is a container
  path; on the host, a host path. It must be a file inside one of the project's repo folders
  (worktrees included), the same rule as the page's `locate_file`.
- Target suffix, matched on the **last** argument with
  `/^(.*?):(\d+)(?:-(\d+)|:\d+)?$/`:
  - `a.ts:40` → line 40; `a.ts:40-58` → lines 40–58; `a.ts:40:7` → line 40 (a trailing column, as
    compilers print it, is accepted and ignored).
  - No match → the whole argument is the path and no line is given (the tile opens at the top).
  - `line` and `end` must be ≥ 1 and `end` ≥ `line`; otherwise exit 2.
  - A line past the file's end is clamped to the last line by the page. It is not an error.
- `--diff`: show the file's diff in the open PR of the repo's current branch, in a diff tile.
  Line numbers count lines in the new version of the file (`RIGHT`), as `gh-pr-pending-review`
  does. `--side LEFT` counts lines in the old version (for deleted lines). `--side` without
  `--diff` is exit 2.
- Options come before the target; exactly one target argument.

### Output and exit codes

- Success: stdout is one line, `shown <repo-relative path>[:<line>[-<end>]]`, plus ` (PR #<n>)`
  for `--diff`, plus `\n`. Exit 0.
- Errors go to stderr, prefixed `show:` and a space.
  - `1` (bridge only): the shared token (`show needs a per-container token — the shared token has
    no capabilities`, from the existing refusal text).
  - `2`: wrong arguments; usage line
    `usage: show [--diff [--side LEFT|RIGHT]] <path>[:<line>[-<end>]]`. Also a relative path with
    no `cwd` in the request (an older bridge client): `pass an absolute path — this devc-bridge
    client is older than the host`.
  - `3`: a target the agent should fix: `<path> is not in this project's repos`, `<path> is not a
    file`, `no open pull request for <branch>` (with `--diff`), `<path> is not changed in PR #<n>`
    (with `--diff`).
  - `4`: host failure: the request folder unwritable, no devc container for the caller's workspace
    (bridge), or a server-side error.
  - `5`: nothing showed it: no devc web server running, or none has a page open, within 3 s.
    Message: `no devc web page is open to show it — give the person <path>[:<line>] instead`.

### Who may call it

- `devc-bridge show` is **not** a capability and needs no grant. It needs only a per-container
  token (any devc container has one), because it can only display files from the caller's own
  project on the person's own screen. `--bridge-allow show` stays an unknown capability.
- `show` is native: the bridge handles it in its own code and never resolves a script, in
  `builtinDir` or `commandsDir`. A user script `commands/show` is never run and `warnShadowed`
  warns about it.
- `devc show` on the host has no gate.

### What the bridge client sends

Every request gains two optional fields. Older hosts ignore them; other commands ignore them.

```json
{ "token": "…", "command": "show", "args": ["src/a.ts:40-58"], "cwd": "/workspaces/app", "pane": "w1:p3" }
```

- `cwd`: `Deno.cwd()`, always sent.
- `pane`: `$HERDR_PANE_ID` when it is set and non-empty, else omitted.

### The request folder: `~/.config/devc/show/`

This folder is the contract between separately built programs (the bridge, the `devc` CLI and
every devc web server), so every file here is versioned and its readers ignore unknown fields.
All files are written atomically (temp file in the same folder, then rename).

**Request** `<id>.json`, written by the caller (`id` from `crypto.randomUUID()`):

```json
{
  "version": 1,
  "id": "6f1c…",
  "createdAt": "2026-10-29T15:04:05.123Z",
  "from": { "kind": "container", "localFolder": "/Users/me/app" },
  "pane": "w1:p3",
  "target": { "kind": "file", "path": "/workspaces/app/src/a.ts", "line": 40, "end": 58 }
}
```

- `from`: `{"kind": "container", "localFolder": <host project folder>}` from the bridge, or
  `{"kind": "host", "herdrSession": <$HERDR_SESSION or null>}` from `devc show`.
- `pane`: the caller's `HERDR_PANE_ID`, or `null`.
- `target.kind`: `"file"` or `"diff"`. `path` is absolute, in the caller's namespace (relative paths
  are resolved by the writer). `line` and `end` are optional; `end` only with `line`. `side`
  (`"LEFT"` / `"RIGHT"`) only for `"diff"`, default `"RIGHT"`.

**Claim** `<id>.claim.<serverId>.json`, written by each server that has at least one view whose
`/main` page is connected (`serverId`: a UUID minted per server run):

```json
{ "version": 1, "showsPane": true, "focusedAt": 1761750245123 }
```

- `showsPane`: one of the server's views has a pane tile showing the caller's pane.
- `focusedAt`: the latest focus time (ms since epoch) of the server's best view: among views
  showing the pane when `showsPane`, else among all its views. A view's focus time is the last
  `page_state` with `focused: true` from any of its pages, or now while one is focused.

**Result** `<id>.result.json`, written by the winning server:

```json
{ "version": 1, "ok": true, "shown": "src/a.ts:40-58", "pr": 12 }
{ "version": 1, "ok": false, "exitCode": 3, "message": "src/b.ts is not changed in PR #12" }
```

`pr` only for diffs. `message` is printed after the `show: ` prefix.

### Picking the page

1. A server sees a new request (directory watch, plus a scan on start). It ignores requests whose
   `createdAt` is more than 5 s old, and requests it has already handled.
2. It writes its claim at once, then waits 250 ms from when it saw the request.
3. It reads every claim for the request and ranks them by `showsPane` (true first), then
   `focusedAt` (latest first), then `serverId` (smallest first). Only the top server continues.
   Every server applies the same rule to the same files, so exactly one acts.
4. The winner resolves the target (below). On an error it writes an `ok: false` result. Otherwise
   it shows the target in its chosen view and writes an `ok: true` result.

The pane a request names is identified by the project and the pane id: for `from.kind:
"container"`, the project at `from.localFolder`; for `"host"`, the host project whose Herdr session
is `herdrSession`. A `pane` in another project never counts as shown.

### Resolving the target (winning server)

- The project: `from.localFolder` for containers. For host requests, the host project whose Herdr
  session is `herdrSession`; with none, the project with a repo folder containing `target.path`
  (the longest match).
- The file: the same lookup `locate_file` does, from the project's environment and `target.path`.
  Not in a repo → exit 3; a directory or missing → exit 3.
- `--diff`: the repo's open PR for the current branch, through the same lookup the sidebar's PR
  tree uses (container: through the bridge; host: the host's `gh`). None → exit 3. The file must
  be among the PR's files (`pr_files`); else exit 3.
- A `target.kind` other than `"file"` or `"diff"` (a newer caller): exit 3, `this devc web is
  older than the caller — restart devc web`.

### The writer's wait

The caller (bridge handler or `devc show`) writes the request, then polls every 50 ms for
`<id>.result.json` for up to 3 s. A result → print it and exit with its code. No result → exit 5.
Either way it then removes `<id>.json`, `<id>.result.json` and every `<id>.claim.*.json`. Each
server also removes files in the folder older than 60 s when it starts and after each request it
handles.

### On the page

- **Placement**, in this order:
  1. A tile in the view already showing the target (the same file in a file tile, or the same
     `DiffRef` in a diff tile) comes forward.
  2. Else, when the caller's pane has a tile in the view: the view's most recently focused
     preview tile in a stack that does **not** contain the pane tile is replaced with the target.
     With none, a new preview tile opens split to the right of the pane tile.
  3. Else (the fallback view): the focused stack's preview tile, as a Files click does.
  A tile the person pins (keeps open) stops being a preview, so the next show opens a new one.
- **Focus**: the tile is revealed but keyboard focus stays where it was. The browser window is not
  raised.
- **Line**: the tile scrolls so the first line of the range is in view near the top, and the range
  is highlighted with a background band. The highlight goes away when the tile shows something
  else, when another show targets the tile, or when the person edits the file.
- **Diff tile**: lines are matched on the requested side. If the range is not inside the shown
  hunks, the tile switches to **Whole file** first. A deleted line asked for with `RIGHT` (or an
  added line with `LEFT`) is not found: the tile shows the diff at its top, unhighlighted.
- A show that arrives before the file or diff has loaded applies once it loads, as terminal links
  do today (`pendingLines`).

### Terminal links

Clicked by the person, so unlike `show` they open where the click was, the way terminal links do
today (the focused stack's preview tile), and take keyboard focus as a link click does.

- **Ranges on file links**: `src/a.ts:40-58` is now a link (today `PATH_RE` rejects it), opening
  at line 40 with 40–58 highlighted. `path:line` and `path:line:column` are unchanged.
- **`pr:` links**: `pr:<path>[:[L]<line>[-<end>]]`, e.g. `pr:src/a.ts:40`, `pr:src/a.ts:40-58`,
  `pr:src/a.ts:L12`. The path follows the file-link rules (`looksLikePath`, resolved from the
  pane's folder, inside the project's repos via `locate_file`). `L` means old-file lines (`LEFT`);
  without it, new-file lines (`RIGHT`). The whole token, `pr:` included, is the link.
  - Opens the repo's PR diff tile for that file at the line, highlighted, with the same rules as
    `show --diff` (outside the hunks → **Whole file**).
  - No open PR, or the file not in it → an error toast with the same text as `show`'s exit 3.
  - A `pr:` token whose rest isn't a path (`pr:foo`) is no link at all, not a file link to `pr`.
- Link kinds in `lib/links.js`: `file` gains an optional `end`; a new kind
  `{kind: 'pr', path, line?, end?, side: 'LEFT' | 'RIGHT'}`.

### The skill (`skills/devc-show/SKILL.md`)

Its job is discovery: an agent that wants to point the person at code learns that these tools
exist and how to call them. It does not prescribe a workflow (when to show, how to pace a
walkthrough, what to do with review comments).

- Frontmatter `name: devc-show`. The `description` says what the tools do and when they apply, so
  it triggers on intents like showing the person a file or a line, pointing at code in a PR diff,
  or giving a clickable link to a line, when running in a devc web terminal. It names
  `devc-bridge show`, `devc show` and `pr:` links as keywords.
- Body, reference only:
  - How to tell where the agent runs: `/run/devc-bridge/token` present → in a devcontainer, use
    `devc-bridge show`; else on the host, use `devc show`. `$HERDR_PANE_ID` set → in a Herdr pane
    devc web can see.
  - The command line, with an example of each target form, `--diff` and `--side`.
  - The output line and the exit codes, one line each; exit 5 means no page could show it.
  - The link forms the person can click: `path:line`, `path:line-end`, `pr:path:line`,
    `pr:path:Lline`.
- No rules about review comments, pending reviews or pacing.

## Implementation notes / gotchas

- `task-add` (`bridge-task-add.md`) is the first native built-in, but it is capability-gated via
  `grantRefusal`. `show` has no capability, so `capabilitiesForCommand('show')` is `[]` and today's
  `dispatch` would look for a script in `commandsDir`. Handle `show` before that lookup, after
  checking the caller has a key. Keep it out of `BRIDGE_CAPABILITY_COMMANDS` and
  `builtinCommandNames()`, so `capabilities_test.ts`'s materialized-scripts check is unchanged.
- The bridge handler gets the project folder the way `task-add` does: `listContainerFolders()`,
  then the first folder whose `projectKey` equals the caller's key.
- `openInPreview` and `openFile` move focus into the tile (`viewer.focus()`). Showing must not, so
  use a path that skips the focus calls.
- A view has a `/sidebar` page and a `/main` page (`views.ts`). Only `/main` has tiles, so a view
  without a connected `/main` member is not a candidate and makes no claim.
- `watchConfigFile` watches single files by name; the request folder needs its own directory
  watch. Deno's `watchFs` can report a rename as `create` or `modify` depending on platform:
  treat any event naming `<id>.json` as "maybe new" and dedupe by id.
- The 250 ms window and 3 s timeout are wall-clock across processes. Measure the window from when
  each server saw the request, not from `createdAt`, so clock skew between processes doesn't
  matter (they share a clock anyway).
- In `findLinks`, try the `pr:` form on each token before `PATH_RE`, so `pr:src/a.ts` never
  falls through to a file link.
- `HERDR_PANE_ID` uses the same ids as the page's pane tiles (`w1:p3`), so no mapping is needed.
- devc web is in the middle of `devc-web-host-environments`: resolve projects through the
  environment seam (`environment.ts`), never `docker` directly.

## Relevant Files

- `devc-core/show_request.ts` (new): `parseShowArgs`, request/claim/result types, readers that
  ignore unknown fields, `writeShowRequest`, `waitShowResult`, `cleanShowFiles`
- `devc-core/tests/show_request_test.ts` (new)
- `devc-bridge/client/devc-bridge.ts`: `cwd` and `pane` on every request; usage line
  `show [--diff [--side LEFT|RIGHT]] <path>[:<line>[-<end>]]   show a file in devc web`
- `devc-bridge/host/core.ts`: `Request` gains `cwd?` and `pane?`; ungated native dispatch of
  `show`; `warnShadowed`
- `devc-bridge/host/show.ts` (new): the handler
- `devc-bridge/host/tests/show_test.ts` (new)
- `devc-bridge/host/tests/capabilities_test.ts`: `show` with no policy file still runs; with the
  shared token → exit 1
- `devc-bridge/host/deno.json`: `check` lists the new files
- `devc/show.ts` (new): the `devc show` command
- `devc/main.ts`: dispatch `show`
- `devc/help.ts`: `devc show` in the command list and its `--help`
- `devc/tests/show_test.ts` (new): CLI argument handling and exit codes with a temp request folder
- `devc/tests/help_test.ts`: if it pins the command list
- `devc/web/show.ts` (new): watcher, claim, ranking (a pure function), resolve, result
- `devc/web/server.ts`: per-view focus time; wiring; delivery to `/main`
- `devc/web/protocol.ts`: the server→page message or intent that carries a show
- `devc/web/static/lib/view.js`: the `ViewIntents` doc, if the show travels as an intent
- `devc/web/static/tiles.js`: placement, no-focus open, reveal and highlight in file and diff tiles
- `devc/web/static/viewer.js`: `revealRange` (or an extended `revealLine`) with the highlight
- `devc/tests/web_show_test.ts` (new): ranking, stale-request skip, resolve errors
- `devc/tests/web_server_test.ts`: a request in a temp folder reaches a fake `/main` client
- `devc/web/static/lib/links.js`: ranges and `pr:` links
- `devc/tests/web_links_test.ts`: the cases under Validation
- `skills/devc-show/SKILL.md` (new)
- `devc/README.md`: `devc show` in Commands; a `devc web` subsection on agents showing files
- `devc-bridge/README.md`: the `show` built-in, ungated
- `.plans/PLAN.md`

## Validation

- [ ] `cd devc-core && deno test -A tests/show_request_test.ts`:
  - `a.ts:40` → line 40; `a.ts:40-58` → 40–58; `a.ts:40:7` → 40; `a.ts` → no line;
    `C:x` → path `C:x`; `a.ts:58-40` and `a.ts:0` → usage error
  - `--side LEFT` without `--diff` → usage error; two targets → usage error
  - A relative path resolves against `cwd`; with no `cwd` → the older-client error
  - A request round-trips; a reader keeps working when an unknown field is added
  - `waitShowResult` returns a written result; with none it returns "timed out" after the given
    timeout; files are cleaned either way
- [ ] `cd devc-bridge/host && deno test -A tests/show_test.ts` (temp request folder, injected
      container list, a fake server writing results):
  - Exit 0 prints `shown src/a.ts:40-58`; the request has `from.kind: "container"`, the injected
    `localFolder`, `pane` from the request, and the absolute path
  - No result within the timeout → 5; a result with `exitCode: 3` → 3 with its message
  - Shared token → 1; no policy file → still runs
  - A script `commands/show` exists → it is not run
- [ ] `cd devc && deno test -A tests/`:
  - Ranking: a claim with `showsPane` beats a later `focusedAt` without it; equal `showsPane` →
    latest `focusedAt`; full tie → smallest `serverId`
  - A request older than 5 s is ignored; a request is handled once
  - Resolve: a path outside the repos → 3; `--diff` with no PR → 3; a file not in the PR → 3
  - `devc show` with no server running → exit 5 within 3.5 s
  - Links: `a.ts:40-58` → file, line 40, end 58; `a.ts:40:7` unchanged; `pr:src/a.ts:40` → pr,
    RIGHT, line 40; `pr:src/a.ts:L12-14` → pr, LEFT, 12–14; `pr:src/a.ts` → pr, no line;
    `pr:foo` and `pr:` → no link; `see pr:src/a.ts:40.` → the link ends before the `.`
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` and `bash devc-bridge/tests/gh_push_test.sh`
      still pass
- [ ] `deno fmt --check`, `deno lint` and `deno task check` pass in `devc`, `devc-core`,
      `devc-bridge/host` and `devc-bridge/client`
- [ ] Manual, devcontainer (a GitHub repo with an open PR, devc web open with the agent's
      terminal in one tile):
  - In the agent's pane, `devc-bridge show src/<file>:10-20` → a preview tile opens to the right
    of the terminal at line 10 with 10–20 highlighted; typing still goes to the terminal
  - A second `show` of another file replaces that tile; showing the first file again brings its
    tile forward if still open
  - Pin the tile, then `show` again → a new preview tile; the pinned one stays
  - `devc-bridge show --diff <changed file>:<line>` → the PR diff tile, scrolled and highlighted;
    a line outside the hunks switches it to **Whole file**
  - `--diff` on an unchanged file → exit 3 naming the PR
- [ ] Manual, links: an agent prints `pr:<changed file>:<line>` and `<file>:10-20`; clicking each
      opens the diff tile / file tile at the line, highlighted. A `pr:` link to an unchanged file
      → a toast naming the PR
- [ ] Manual, skill: with the skill mounted, a fresh agent asked "show me where X is handled"
      (no tool named) runs `devc-bridge show` (container) or `devc show` (host) on its own
- [ ] Manual, two pages: the same terminal open in devc-desktop and in a browser tab (different
      servers) → the show lands only in the one focused last
- [ ] Manual, host project: in a host project's terminal, `devc show <file>:5` → shown beside it
- [ ] Manual: close every devc web page → `devc show` exits 5 within about 3 s
