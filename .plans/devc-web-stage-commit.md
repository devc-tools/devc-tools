# devc web: stage, unstage and commit from the Uncommitted row

Asked for by the user on 2026-11-09. After
[devc-web-uncommitted-files](devc-web-uncommitted-files.md), which built a repo card's
**Uncommitted** row (one list of the working tree's changes against `HEAD`, staged or not). This
plan splits that list into **Staged** and **Changes**, lets the person stage and unstage files, and
commit what is staged, with a message typed in the row.

Out of scope: discarding changes, amending, partial (hunk) staging, `--no-verify`, pushing (the
card's ↑N already does it).

## Checklist

- [x] `devc/web/git_uncommitted.ts`: the split listing, stage-aware diffs and Whole file
- [x] `devc/web/git_stage.ts` (new): `stageFiles`, `unstageFiles`, `commitStaged` (see Contracts)
- [x] `devc/web/protocol.ts`: `stage_files`, `unstage_files`, `commit_staged`, and `stage` on
      `uncommitted_diff` / `uncommitted_file_at`
- [x] `devc/web/server.ts`: answer them through the project's running environment, one at a time
      per repo, then refresh the repo's marks
- [x] `devc/web/static/lib/layout_state.js`: `DiffRef.stage`
- [x] `devc/web/static/tiles.js`: titles and headers for a staged / unstaged diff; send `stage`
- [x] `devc/web/static/lib/commits.js`: pure helpers for the groups and the commit box's state
- [x] `devc/web/static/cards.js`: the commit box, the Staged and Changes groups, hover buttons and
      menu items
- [x] `devc/web/static/style.css`: the commit box and the group rows
- [x] `devc/deno.json`: `web/git_stage.ts` in `check`'s list
- [x] `devc/README.md`: the Commits paragraph
- [x] Tests listed under Validation

## Contracts

### Where git runs, and who may ask

As `git_uncommitted.ts`: **in the project's environment** (`Environment.runLimited`, via
`server.ts`'s `repoTarget`), never on the host in a container's repo. `root` must pass
`isProjectRepo` (else reject `bad_request`, `unknown repo`); no running environment → problem
`the project is not running`.

Allowed under `--live` and `--live-yolo`: a container's git does only what the container's own
agents can already do there, and `--live` has no host projects. Not refused while an agent is
working: git's own `index.lock` error is the answer if they collide.

Every command starts `git -c core.quotePath=false` (no `--no-optional-locks`: these write the
index). `runLimited` gets `env: {GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true'}` so nothing waits
on a terminal or an editor.

**One at a time per repo:** the server keeps the repo folders with a `stage_files`,
`unstage_files` or `commit_staged` running; another of the three for the same folder while one
runs → problem `busy: try again when the last one ends`.

After a success: `changesWatch.refreshEnvironment(<record id>)` (the `● n` count), and after a
commit also `gitWatch.refresh()` (↑N).

### The listing, split

`uncommitted_files`' answer changes shape (the page is its only reader):

```ts
interface UncommittedFiles {
  base: string | null; // unchanged
  staged: CommitFile[]; // index vs base
  unstaged: CommitFile[]; // working tree vs index, untracked and conflicted included
  truncated: boolean; // either list was cut at MAX_COMMIT_FILES
}
```

Commands (all with `-z`, cap and problems as now):

1. Staged: `git diff --cached <base tree> -z -M --raw --numstat <DIFF_FLAGS>`.
2. Unstaged tracked: `git diff -z --raw --numstat <DIFF_FLAGS>` (no base: index vs working tree).
3. Untracked: `git ls-files --others --exclude-standard -z` → `unstaged`, as now.
4. Conflicts: `git diff --name-only -z --diff-filter=U`.

Each is `parseDiffTree`d. **Then** every conflicted path is removed from both lists, and one entry
per conflicted path is added to `unstaged` with `status: 'conflicted'` and the stats of command
2's non-`U` line for that path (0/0 when none). Measured on git 2.52 (see Gotchas). Each list is
sorted by path and cut at 1000. A file both staged and edited again is in both lists.

`readUncommittedFiles`' list of what a path may be is now this split listing; the old merged
listing (command `git diff <base>` against the working tree) stays only for a diff with no
`stage` (below).

### One file's diff and Whole file

`uncommitted_diff` and `uncommitted_file_at` take an optional `stage: 'staged' | 'unstaged'`.
Absent is today's behavior exactly (HEAD vs working tree, the merged listing), kept for saved
layouts and for [devc-show-local-diff](devc-show-local-diff.md).

With `stage`, `path` must be in that list of a fresh split listing, else problem
`<path> has no staged changes` / `<path> has no unstaged changes`.

| `stage`    | file       | diff command                                                                                                    | Whole file text             |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `staged`   | renamed    | `git diff --cached <tree> -M <DIFF_FLAGS> -U3 -- :(literal)<previousPath> :(literal)<path>`                     | index blob                  |
| `staged`   | other      | `git diff --cached <tree> <DIFF_FLAGS> -U3 -- :(literal)<path>`                                                 | index blob                  |
| `unstaged` | untracked  | `git diff --no-index <DIFF_FLAGS> -U3 -- /dev/null <path>` (exit 0 or 1 is success)                             | working tree (`files.read`) |
| `unstaged` | conflicted | `git diff <tree> <DIFF_FLAGS> -U3 -- :(literal)<path>` (vs HEAD: `git diff` alone gives a combined `diff --cc`) | working tree                |
| `unstaged` | other      | `git diff <DIFF_FLAGS> -U3 -- :(literal)<path>`                                                                 | working tree                |

Binary files: no command, `patch: null`, as now. A removed file has no Whole file text
(`available: false`, `file not in the working tree` / `file not in the index`).

**Index blob:** `git cat-file blob :<path>` (never `git show`, which may textconv), `maxOutput`
`files.ts`'s `MAX_READ_BYTES` + 1. Past it → `{available: false, message: 'file too large'}`; a
NUL in the first 8000 characters → `binary file`. `:<path>` is a revision, not a pathspec; `path`
comes from git's own listing and the cwd is the repo root, so it resolves from the root.

The diff answer adds `stage` to `changes`: `changes: {base, stage?: 'staged' | 'unstaged'}`.

### Stage and unstage

```ts
| { type: 'stage_files' | 'unstage_files'; id: string; localFolder: string; root: string;
    paths: string[] | null } // null: everything
```

`paths`: an array of 1–1000 non-empty strings, or `null`. Each path must be in a fresh split
listing's `unstaged` (for `stage_files`) or `staged` (for `unstage_files`), else problem
`<path> has no unstaged changes` / `<path> has no staged changes`, and nothing runs.

- `stage_files`, paths: `git add -A -- :(literal)<p>…` (stages edits, new files, removals, and
  marks a conflicted path resolved). `null`: `git add -A -- :/`.
- `unstage_files`, paths: `git reset -q -- :(literal)<p>…`, adding a staged rename's
  `previousPath` beside its `path`. `null`: `git reset -q -- :/`. Both work on an unborn branch
  (checked on git 2.52).

Timeout 30 s. Answer `{ok: true, result: {}}`; a problem answers `ok: false`, code
`git_stage_failed`.

### Commit

```ts
| { type: 'commit_staged'; id: string; localFolder: string; root: string; message: string }
```

`message`: a string of at most 65 536 characters whose trimmed text is non-empty (else reject
`bad_request`, `empty commit message` / `commit message too long`). The server lists first: an
empty `staged` → problem `nothing staged to commit`.

Runs `git commit -m <message>` (an argv element, no shell; git's default cleanup for `-m`). Only
what is staged is committed (no `-a`). The repo's hooks (`pre-commit`, `commit-msg`) run as they
would for anyone committing there; there is no way to skip them from the page. Signing follows the
repo's config. Timeout 120 s (hooks). Output cap 1 MiB.

Success: `git rev-parse HEAD` → `{ok: true, result: {sha: <full id>, subject: <first line of
message, trimmed>}}`. Failure (non-zero exit, timeout): code `git_commit_failed`, message
`git commit:` + the last 20 non-empty lines of stderr then stdout joined by `\n` (hooks print
their reasons there; the first line is often not the reason), capped at 4096 characters from the
end; a timeout → `git commit: timed out after 120 s (a hook may be waiting)`.

### The diff tile

- `DiffRef` gains `stage?: 'staged' | 'unstaged'`, only beside `changes` (`diffRefFromState`
  drops a state with `stage` and no `changes`, or any other value). `diffKey`, `sameDiff`, tile keys
  and `tileContent` carry it as they carry `changes`.
- Title: `<basename> · staged` for `staged`; `<basename> · changes` for `unstaged` and no stage.
- Header's first line: `Staged · vs <short base>` (or `Staged · new repo`); `Unstaged · vs index`;
  no stage: unchanged (`Uncommitted · vs <short base>`).
- Loads send `stage`; Whole file sends it to `uncommitted_file_at`. The 15 s self-reload stays.
- A tile whose file was just staged or unstaged shows the "has no … changes" error on its next
  load, as a committed file's does now. It is not retargeted.

### The sidebar

An open **Uncommitted** row (count, open state and when it shows: unchanged) holds, in order:

1. **The commit box** (`data-tree-key` `<card key>\nuncommitted\ncommit-box`, depth 2): a
   `textarea` (`aria-label` and placeholder `Commit message`, 2 rows, growing with its text to 8)
   and a **Commit** button below it, right-aligned.
   - The draft is kept per `<localFolder>\n<root>` for the page's life (not saved), and the same
     textarea element is reused across renders so typing, the caret and focus survive them (as
     `newEntry`'s input does in `renderPass`).
   - Its `keydown` stops propagation (the tree's keys must not act). Escape blurs it. No key
     commits: only the button does (2026-11-09: the user does not want shortcuts added without
     asking unless they are standard; a Ctrl/⌘+Enter that was built first is gone).
   - **Commit** is disabled, with its `title` saying why, when: the list is not read yet
     (`Loading…`), `staged` is empty (`Nothing staged: stage files first`), the message is blank
     (`Type a commit message`), or a commit or stage runs (`Committing…` / `Staging…`).
     Otherwise `title` is `Commit <n> staged file(s)` and the label is `Commit (<n>)`.
   - While it runs the button says `Committing…`. Success: the draft is cleared, toast
     `Committed <7-char sha>: <subject>`, and the Uncommitted list and the Commits list read
     again at once. Failure: the draft stays, and the message shows below the box in a
     `pre.commit-error` (cleared on the next edit or commit).
2. **Staged** group, only when `staged` is non-empty: a header row (`data-tree-key`
   `<card key>\nuncommitted\nstaged`, depth 2, label `Staged`, count on the right) with one hover
   button **−** (`title` `Unstage all`, `unstage_files` with `null`), then a row per file, depth 3,
   as today's file rows (`changedFileRow`), ref `{…, changes: 'HEAD', stage: 'staged'}`,
   `data-tree-key` `<card key>\nuncommitted\nstaged\n<path>`, hover button **−** (`Unstage`).
3. **Changes** group, only when `unstaged` is non-empty: as Staged, `data-tree-key` `…\nunstaged`,
   label `Changes`, hover **+** (`Stage all`, `stage_files` with `null`); file rows ref
   `stage: 'unstaged'`, hover **+** (`Stage`).
4. The notes as now (`Loading…`, `Couldn't list files: …`, the truncation note).

Group headers do not collapse. File rows keep today's click, Ctrl/⌘-click, double-click and stat
(`new`, `binary`, `+a −d`, `U` for conflicted). Their menu (`commitFileMenuItems`) gains, first,
**Stage** or **Unstage** and a separator.

Hover buttons use `hoverActions` and `icon-btn` as other rows do; a click does not also open the
row's diff (`stopPropagation`). While a stage, unstage or commit runs for a repo, its group and
file buttons are disabled. After any of them, success or not, the Uncommitted list reads again at
once. A failure toasts `Couldn't stage: <problem>` / `Couldn't unstage: <problem>`.

Keyboard: the commit box's row is focusable like other rows; Enter on it focuses the textarea.
Enter on a file row opens its diff as now.

## Gotchas

- **Conflicts appear twice in raw output.** On git 2.52, during a conflict on `f`:
  `git diff --cached --raw` gives `:100644 000000 … U f`, and `git diff --raw` gives both
  `:000000 100644 … U f` and `:100644 100644 … M f`, with one numstat line per raw line. Parse
  first (the stat pairing relies on the counts matching), then drop and replace conflicted paths.
- `git diff --name-only --diff-filter=U` must have no base (as now).
- `git diff` with no base on a conflicted path gives `diff --cc`, which `patchBody` does not
  parse: diff conflicted files against `HEAD`.
- `runLimited` has no stdin: the message goes as `-m <message>`. `-m` with a multi-line string is
  fine (one argv element).
- `renderPass` rebuilds the cards' DOM: the textarea must be a kept element (like `fileRows` /
  `newEntry.input`), or every 15 s poll would drop the caret and focus mid-word.
- A path with a newline is safe only because every listing uses `-z`; `paths` from the page are
  matched against a listing, never passed through as typed.
- `git add -A -- <path>` on a removed path stages the removal (git ≥ 2.0).
- The `● n` count and the two lists can disagree (an untracked folder is one in the count); leave
  both.

## Validation

- [x] `cd devc && deno task check && deno task test` pass, with `web/git_stage.ts` in `check`'s
      list.
- [x] `devc/tests/web_git_uncommitted_test.ts`, against temp repos (fake environment as now):
  - a file staged then edited again is in both lists, with the staged and unstaged stats;
  - a staged new file, a staged removal and a staged rename are in `staged` only; an untracked
    file and an unstaged edit in `unstaged` only;
  - a merge conflict is one `conflicted` entry in `unstaged` and absent from `staged`;
  - `uncommitted_diff` with `stage: 'staged'` / `'unstaged'` gives the index-vs-HEAD and
    working-tree-vs-index patches for the staged-then-edited file; a conflicted file's diff is
    against HEAD; without `stage` the answer is unchanged from today;
  - `uncommitted_file_at` with `stage: 'staged'` returns the index text, which differs from the
    working tree's; a staged removal → `available: false`;
  - a path not in the requested list → `<path> has no staged changes` /
    `<path> has no unstaged changes`.
- [x] `devc/tests/web_git_stage_test.ts` (new), same fake environment:
  - staging a modified file, an untracked file, a removed file and a conflicted file each moves it
    to `staged` (the conflict is resolved); `null` stages everything;
  - unstaging a staged new file makes it untracked; a staged rename unstages to a removal plus an
    untracked file; `null` unstages everything; both work on an unborn branch;
  - a path not in the matching list is refused and nothing changes;
  - `commit_staged` commits only staged files (an unstaged edit stays), answers the new HEAD and
    the subject; nothing staged → `nothing staged to commit`; a `pre-commit` hook that prints
    `lint failed` and exits 1 → a problem containing `lint failed`, and HEAD unchanged;
  - a blank or over-long message is refused at parsing.
- [x] `devc/tests/web_server_test.ts`: the three new messages parse (paths array or null, at most
      1000), a relative `root` is refused, `stage` on `uncommitted_diff` must be one of the two
      values; and the per-repo busy check refuses a second operation while one runs (unit-test the
      helper that tracks it).
- [x] `devc/tests/web_layout_test.ts`: a `stage` ref round-trips; `stage` without `changes`, or
      another value, is dropped; `sameDiff` tells `staged` from `unstaged` from none.
- [x] `devc/tests/web_commits_test.ts`: the group rows (labels, counts, which group a
      staged-then-edited file lands in), and the Commit button's state and `title` for each case
      above.
- [x] Browser check (2026-11-09, headless Chromium against `devc web` from this checkout, a temp
      `HOME` with one host project whose Herdr session really ran here, no proxy): the row opened
      to `Changes 2` (`M a.ts +2 −1`, `A new.txt new`) with **Commit** off (`Nothing staged: stage
      files first`); new.txt's **+** moved it to `Staged`; a.ts staged then edited showed in both
      groups after a poll (`+2 −1` staged, `+1 −0` unstaged), opening `a.ts · staged` and
      `a.ts · changes` (`Unstaged · vs index`); a message typed across a 15 s poll kept its text and
      focus; Ctrl+Enter (since removed) committed (toast `Committed <sha>: …`, the commit in the Commits list, the
      unstaged edit left); with a failing `pre-commit`, **Stage all** then Commit showed the hook's
      output under the box and kept the message, HEAD unchanged; **Unstage all** moved it back; no
      page errors.
- [x] `deno fmt --check` on touched files, and `deno lint`, pass in `devc`.
- [ ] Manual (the user, on the Mac), for a host project and a container project:
  - 2026-11-09: the user reports staging and unstaging work; the rest below is not yet confirmed.
  - edit two files and add one; Uncommitted shows them under **Changes**; **+** one → it moves to
    **Staged**; edit it again → it is in both;
  - click it under Staged and under Changes → `· staged` / `· changes` tiles with the right diffs;
  - **Unstage all** → all back under Changes; **Stage all** → all under Staged;
  - commit with a message → toast with the sha, the commit in the Commits list, ↑N up by one;
  - a repo with a failing `pre-commit` hook → its output under the box, nothing committed.

## Relevant Files

- `devc/web/git_uncommitted.ts`, `devc/web/git_stage.ts` (new)
- `devc/web/git_commit.ts`: read only (`DIFF_FLAGS`, `parseDiffTree`, `patchBody`, caps)
- `devc/web/protocol.ts`, `devc/web/server.ts`
- `devc/web/static/lib/layout_state.js`, `devc/web/static/tiles.js`
- `devc/web/static/lib/commits.js`, `devc/web/static/cards.js`, `devc/web/static/style.css`
- `devc/deno.json`
- `devc/tests/web_git_uncommitted_test.ts`, `devc/tests/web_git_stage_test.ts` (new),
  `devc/tests/web_server_test.ts`, `devc/tests/web_layout_test.ts`,
  `devc/tests/web_commits_test.ts`
- `devc/README.md`: the Commits paragraph (around line 337)
- `.plans/PLAN.md`
