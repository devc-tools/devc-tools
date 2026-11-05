# devc web: uncommitted files in the Commits section

Asked for by the user on 2026-11-04. After [devc-web-git-changes](devc-web-git-changes.md) (the
`● n` count) and [devc-web-commit-diffs](archived/devc-web-commit-diffs.md) (a commit row's file
list and the read-only diff tile). A repo card's Commits section gets an **Uncommitted** row at the
top that expands to the working tree's changed files, and a click on one opens its diff against
`HEAD` in the diff tile.

This plan builds the diff tile's third content source, `DiffRef.changes`, which
[devc-show-local-diff](devc-show-local-diff.md) was going to add. That plan now only adds refs
other than `HEAD` and the `show --changes` command line on top of this one (it has been updated to
say so).

## Checklist

- [x] `devc/web/git_uncommitted.ts` (new): `readUncommittedFiles`, `readUncommittedDiff`,
      `readUncommittedFileAt`, run in the project's environment (see Contracts)
- [x] `devc/web/git_commit.ts`: export `DIFF_FLAGS` and `parseDiffTree` for reuse; `CommitFile`'s
      `status` gains `'conflicted'`; `CommitFile` gains `untracked?: true`
- [x] `devc/web/protocol.ts`: `uncommitted_files`, `uncommitted_diff`, `uncommitted_file_at`
      messages and their parsing
- [x] `devc/web/server.ts`: answer them through the project's running environment
- [x] `devc/web/static/lib/layout_state.js`: `DiffRef.changes`, `diffSource` → `'changes'`,
      `diffRefFromState`, `sameDiff`, `tileContent`, tile keys
- [x] `devc/web/static/lib/view.js`: carry `changes` wherever it carries `sha` (nothing to do: it
      carries no `sha`, and uses `layout_state.js`'s `sameDiff` and `diffKey`)
- [x] `devc/web/static/tiles.js`: the `'changes'` source: loading, title, header, Whole file, and
      the 15 s self-reload
- [x] `devc/web/static/menus.js`: **Reload** in a `'changes'` diff tile's menu (nothing to do: every
      diff tile's menu already has **Refresh**, which calls `tileArea.reload`; see the note below)
- [x] `devc/web/static/lib/pr_tree.js`: `statusLetter('conflicted')` → `U`
- [x] `devc/web/static/lib/commits.js`: pure helpers for the Uncommitted row and its file rows
- [x] `devc/web/static/cards.js`: the Uncommitted row, its open state, its list's reads, file rows
      and their menu
- [x] `devc/web/static/style.css`: the Uncommitted row's look and the `U` letter's color
- [x] `devc/README.md`: the Commits paragraph
- [x] Tests listed under Validation

## Contracts

### Where git runs

Like `git_changes.ts`, and unlike `git_commit.ts`: **in the project's environment**, through
`Environment.runLimited` (a container's own git under `docker exec`, a host project's directly),
never on the host in a container's repo. The host's mirror has no working tree, and `git status` /
`git diff` against a working tree run the repo's own config (see `git_changes.ts`'s header).
`cwd` is the repo's path in the environment, from `server.ts`'s `repoTarget` (its own problem
when the repo is not mounted there).

The server finds the environment as the running session whose `record.localFolder` is the
message's `localFolder`. None running → problem `the project is not running`. `root` must pass
`isProjectRepo`, as for `commit_*` (else reject `bad_request`, `unknown repo`).

Every git command starts `git --no-optional-locks -c core.quotePath=false`, and every one that
makes a diff adds `git_commit.ts`'s `DIFF_FLAGS` (`--no-ext-diff --no-textconv --no-color
--no-relative --src-prefix=a/ --dst-prefix=b/`). A path from the page is never passed to git: it
is looked up in a fresh listing first (as `readCommitDiff` does), and passed as
`:(literal)<path>` after `--`. Timeout 15 s per command. Live-mode gating is the same as
`commit_diff`'s.

### The base

`git rev-parse --verify -q HEAD^{commit}` → its full id. If that exits non-zero (an unborn branch),
the base is the empty tree: `git hash-object -t tree /dev/null` (it gives the SHA-1 or SHA-256 one
to match the repo). Answers carry the base as `base: string | null` (null for the empty tree).

### The listing

Three commands, merged:

1. `git diff <base> -z -M --raw --numstat <DIFF_FLAGS>`: tracked changes, staged or not, against
   the base. The output has the format `parseDiffTree` already parses; reuse it. The working-tree
   side's blob id is all zeros, so never diff by blob id here.
2. `git ls-files --others --exclude-standard -z`: untracked files, one per file (not the
   directory rollup `--untracked-files=normal` gives the `● n` count). Each is
   `{status: 'added', untracked: true, additions: 0, deletions: 0, binary: false, previousPath: null}`.
3. `git diff --name-only -z --diff-filter=U`: paths in conflict. Command 1 lists these as `M`
   (checked on git 2.4x); set their `status` to `'conflicted'`.

Sorted by path, cut at `MAX_COMMIT_FILES` (1000). Output cap 32 MiB on each, as
`git_commit.ts`'s `LIST_MAX_OUTPUT`; past it → problem `too many files changed to list`. A
non-zero exit → problem `git <subcommand>: <first stderr line>`.

```ts
// uncommitted_files → result
interface UncommittedFiles {
  base: string | null;
  files: CommitFile[]; // CommitFile from git_commit.ts, with status 'conflicted' and untracked?: true
  truncated: boolean;
}
```

### One file's diff

`uncommitted_diff {localFolder, root, path}`: lists again (all three commands), finds `path`
(absent → problem `<path> has no uncommitted changes`), then:

- tracked, not renamed: `git diff <base> <DIFF_FLAGS> -U3 -- :(literal)<path>`
- renamed: `git diff <base> -M <DIFF_FLAGS> -U3 -- :(literal)<previousPath> :(literal)<path>`
- untracked: `git diff --no-index <DIFF_FLAGS> -U3 -- /dev/null <path>`. Exit 1 means "differs" and
  is success; only exit ≥ 2 is a failure. (`--no-index` takes plain paths, not pathspecs.)
- binary: no command; `patch: null`.

`patchBody` (from `git_commit.ts`) strips git's header lines. Patch cap `MAX_COMMIT_PATCH` (1 MiB)
→ `tooLarge: true`, `patch: null`. The answer has the shape the tile already reads, with
`changes` in place of `commit` and no `pr`:

```ts
interface UncommittedDiff {
  available: true;
  changes: { base: string | null };
  file: CommitFile & { patch: string | null; tooLarge: boolean };
}
```

### The file's text, for Whole file

`uncommitted_file_at {localFolder, root, path}`: the working-tree file's text, read with the
environment's `env.files.read(<repo path>/<path>)` (the file viewer's read), only if `path` is in a
fresh listing and its status is not `removed`. Same answer shape as `commit_file_at`:
`{available: true, text}`, or `{available: false, message}`. `env.files.read` already refuses
files over `files.ts`'s `MAX_READ_BYTES` (2 MiB) and binary files by throwing `FilesError`; map its
codes: `too_large` → `file too large`, `binary` → `binary file`, `not_found` → `file not in the
working tree`. Any other error is a problem.

### Wire

```ts
| { type: 'uncommitted_files'; id: string; localFolder: string; root: string }
| { type: 'uncommitted_diff' | 'uncommitted_file_at'; id: string; localFolder: string; root: string; path: string }
```

`localFolder` and `root` are parsed as `commit_*`'s are (`folder(m)`, `absolute(m, 'root')`). A
problem answers `ok: false` with code `git_uncommitted_failed` and the problem as the message.

### The tile

- `DiffRef`: `{localFolder, root, path, sha?, changes?}`. This plan only ever sets
  `changes: 'HEAD'`; `devc-show-local-diff` adds other refs. A ref has `sha` or `changes`, never
  both. `diffRefFromState` drops a state with both, or with `changes` that is not a non-empty
  string. `diffSource` → `'changes'` when `changes` is set (checked before `sha`). `sameDiff`, the
  tile keys and `tileContent` compare and save `changes` as they do `sha`.
- Loads with `uncommitted_diff` (for `'changes'`) where it now picks `commit_diff`/`pr_diff`, and
  `readHead` uses `uncommitted_file_at`. Its `readHead` cache key is the base plus a load counter,
  not a sha: the working tree changes under the same base.
- Title: `<basename> · changes`. Header's first line: `Uncommitted · vs <short base>`, or
  `Uncommitted · new repo` when `base` is null.
- Has hunks / Whole file, Hide whitespace, split and Find, as a commit tile. No threads, Viewed,
  Since viewed, review, github.com link or Ask agent (those already check for `'pr'`).
- **Reload:** every diff tile's menu already has **Refresh** (`diffTileMenuItems`), which calls
  `tileArea.reload` → `refreshDiff`, so no item was added. (2026-11-05: this plan first said diff
  tiles had none; that was wrong.)
- **Auto reload:** there is no file-change signal to reuse. A `'changes'` tile reloads itself
  every `COMMITS_POLL_MS` (15 s) while `document.visibilityState === 'visible'`, and redraws only
  when the answer differs (JSON) from the one shown, as `loadCommits` does, so scroll and
  selection stay put. The timer stops when the tile closes. A load error (the file was committed
  or reverted) shows in the tile as other load errors do.

### The sidebar

In `commitSectionRows`, above everything else in an open Commits section:

- **When it shows:** the repo's `RepoView.changes` counts sum to more than zero (`staged`,
  `unstaged`, `untracked`, `conflicted`). Absent `changes` (environment not running, not read yet)
  or a `changesProblem` → no row.
- **The row:** class `row commit-row`, `data-state="uncommitted"`, a chevron, label
  `Uncommitted`, and on the right the file count once listed (`n files`, `1 file`, `1000+ files`
  when truncated). `data-tree-key` = `<card key>\nuncommitted`. A click toggles it.
- **Open state:** a `Set` of card keys, not saved (as `commitFilesOpen`). Starts closed.
- **Its list:** read with `uncommitted_files` when opened, then again on every Commits poll tick
  (`COMMITS_POLL_MS`) while open, and whenever the repo's `changes` object in a `projects` message
  differs (JSON) from the last one seen. A failed read keeps the last list and shows the error only
  when there is none. Keyed by `<localFolder>\n<root>`.
- **File rows:** as `commitFileRow`, `data-state="uncommitted"`, ref `{localFolder, root, path,
  changes: 'HEAD'}`, `data-tree-key` = `<card key>\nuncommitted\n<path>`. The stat is `diffStat`
  except: untracked → `new`; binary → `binary`. Status letter from `statusLetter` (`U` for
  conflicted). Same click, Ctrl/⌘-click, double-click and menu as a commit's file
  (`commitFileMenuItems`).
- Notes (`commitNote`, depth 2): `Loading…`, `Couldn't list files: <error>`, and the truncation
  note commit lists use.

## Gotchas

- `git diff HEAD --raw` reports a conflicted path as `M` with a zero blob; only
  `--diff-filter=U` without a base says it is unmerged (command 3).
- The `● n` count (`--untracked-files=normal`) counts an untracked directory once; the list shows
  each file in it. The two numbers can differ; leave both as they are.
- A path with a newline is safe only because every listing uses `-z`. Never split on `\n`.
- `git diff --no-index` exits 1 on a difference. Treat 0 and 1 as success.
- Keep this out of `GitChangesWatch`: the list is read only while a row is open, on demand.

## Validation

- [x] `cd devc && deno task check && deno task test` pass, with `web/git_uncommitted.ts` in
      `check`'s list.
- [x] `devc/tests/web_git_uncommitted_test.ts` (new), against temp repos, with a fake
      environment whose `runLimited` runs git in the temp dir (`env_host.ts`'s `hostRun`, as
      `web_git_fetch_test.ts` uses) and whose `files.read` reads it:
  - a modified tracked file, a staged new file, a deleted file, an untracked file inside an
    untracked directory, a staged rename (`git mv`), and a merge conflict are each listed with the
    right `status` (`modified`, `added`, `removed`, `added` + `untracked`, `renamed` with
    `previousPath`, `conflicted`) and stats.
  - an unborn branch with a staged file → `base: null`, the file `added`.
  - `uncommitted_diff` gives the expected patch for each kind above; the untracked one has every
    line added; the rename's patch shows only changed lines.
  - a path not in the listing → `<path> has no uncommitted changes`; a path containing a space,
    one with `é`, and one with `*` work.
  - `uncommitted_file_at` gives the working-tree text; a removed file → `available: false`; a
    file with a NUL byte → `binary file`.
  - a pure rename (`git mv` with no edit) gives an empty patch, not an error.
- [x] `devc/tests/web_layout_test.ts`: a layout with a `changes: 'HEAD'` diff tile round-trips; a
      state with both `sha` and `changes`, or an empty `changes`, is dropped; `sameDiff` tells a
      `changes` ref from a `sha` ref for the same path.
- [x] `devc/tests/web_commits_test.ts`: the Uncommitted row's label and file rows (count text,
      `new` for untracked, `U` for conflicted).
- [x] `devc/tests/web_server_test.ts` (where `commit_files` is tested): the three messages parse,
      and a relative `root` is refused. (The `the project is not running` answer has no test: no test
      drives a server's message handlers, as for `commit_*`; the browser check below covers the
      handler's happy path only through a proxy.)
- [x] Browser check (2026-11-05, headless Chromium against `devc web` from this checkout, a temp
      `HOME` with one host project; the host session couldn't start in this sandbox, so a Playwright
      socket proxy faked a running environment and its `changes`, and answered `uncommitted_*` with
      `git_uncommitted.ts`'s real output for the temp repo): the row shows `Uncommitted` / `3 files`,
      expands to `M a.ts +2 −1`, `D gone.txt +0 −1`, `A new.txt sub new`; each opens a
      `<name> · changes` tile headed `Uncommitted · vs <sha>`; Whole file fills from
      `uncommitted_file_at`; an open tile picks up a changed answer within 15 s; clearing `changes`
      removes the row and leaves the history; a page reload restores the tile; no page errors.
- [x] `deno fmt --check` on touched files, and `deno lint`, pass in `devc`.
- [ ] Manual (the user, on the Mac), for a host project and a container project:
  - Edit a tracked file and add a new file; open the card's Commits → an **Uncommitted** row,
    `2 files`; expand → both, `M` with `+a −d` and `A` with `new`.
  - Click each → a diff tile `<name> · changes` with the edit / all lines added; Whole file works.
  - Edit the file again → within 15 s the open tile shows the new edit; scroll position is kept.
  - The tile's menu's **Refresh** reads it again.
  - Commit both → the row goes away within one poll; the open tile's Refresh shows the "no
    uncommitted changes" error.
  - Stop the container → the row is gone; the rest of the Commits section stays.

## Relevant Files

- `devc/web/git_uncommitted.ts` (new)
- `devc/web/git_commit.ts`: exports, `CommitFile` fields
- `devc/web/git_changes.ts`: read only, for the trust rule and `runLimited` use
- `devc/web/protocol.ts`, `devc/web/server.ts`
- `devc/web/static/lib/layout_state.js`, `devc/web/static/lib/view.js`, `devc/web/static/tiles.js`
- `devc/web/static/lib/commits.js`, `devc/web/static/lib/pr_tree.js`, `devc/web/static/cards.js`
- `devc/web/static/style.css`
- `devc/deno.json`: add `web/git_uncommitted.ts` to `check`'s file list
- `devc/tests/web_git_uncommitted_test.ts` (new), `devc/tests/web_layout_test.ts`,
  `devc/tests/web_commits_test.ts`, `devc/tests/web_server_test.ts`
- `devc/README.md`: the Commits paragraph (around line 317)
- `.plans/devc-show-local-diff.md`: now builds on this plan's tile source
- `.plans/PLAN.md`
