# devc web: a commit's changed files and their diffs

Written 2026-11-01. Follows the repo card's Commits section (`59a1507`), which had no plan of its
own: see `devc/web/git_history.ts` and `devc/web/static/lib/commits.js`.

A commit row in the Commits section expands to the files that commit changed. A click on a file
opens its diff in the diff tile, as the Pull request list does.

## Checklist

- [x] `devc/web/git_history.ts`: export the mirror lookup `readCommitHistory` uses (Contracts).
- [x] `devc/web/git_commit.ts`: the three reads and their parsers; add it to `deno.json`'s `check`.
- [x] `devc/web/protocol.ts`, `devc/web/server.ts`: `commit_files`, `commit_diff`, `commit_file_at`.
- [x] `devc/web/static/lib/layout_state.js`, `lib/view.js`, `tiles.js`: `DiffRef.sha` and
      `diffSource`, through every comparison, key and saved layout.
- [x] `devc/web/static/tiles.js`, `menus.js`: the commit form of the diff tile, with no PR parts.
- [x] `devc/web/static/cards.js`, `lib/commits.js`, `style.css`: expandable commit rows, file rows.
- [x] Tests (Validation), `devc/README.md`, the message table in `.plans/archived/devc-web.md`.
- [x] Added on 2026-11-04 at the user's request: the split view's separator drags to resize the two
      sides (see "Resizable split" below).
- [ ] Manual (the user, with `--live-yolo` or an updated `devc`): the checks under Validation.

## Decisions

- **Read from the host's mirror**, as the Commits section is. So no bridge grant, a stopped container
  works, and no git runs in the repo (`git_status.ts`'s header). Don't add a path through
  `Environment.run`.
- **Files and patches are separate reads.** Listing is on expand, a patch on opening its file.
  Patches in this repo's last 300 commits have a median of about 14 KB and a maximum of 3.5 MB.
- **A merge compares with its first parent**, so it shows what it brought into the branch. A root
  commit compares with nothing: every file is added.
- **One file per tile**, as PR diffs are. No whole-commit view.
- **A commit diff is a `DiffRef` with a `sha`**, not a new tile kind. Opening, revealing, preview
  tabs, back and forward, and the sidebar's tile rows then work through the existing paths.
- **This plan builds the diff tile's non-PR path.** There is one `diff` tile kind, and `DiffRef` says
  where its content comes from (`diffSource`). `devc-show-local-diff` comes after this and adds a
  third source, `changes`, to the same path, so build for a source being one of several.
- **Commit tiles are read-only and leave out:** Viewed, threads, comments, pending reviews, Compare
  since viewed, language server hover and go to definition, and Ask agent. The agent's diff context
  (`diff: true`) means the PR diff, so it would mislead. Whole file, Hide whitespace, split view and
  Find stay.
- **Which commits expand:** all three groups, to pull, local only and pushed. The mirror has them all.
- **Expanded rows aren't saved.** They last until the page reloads: unlike the section's own open
  state, hashes go stale with a rebase.
- **The protocol version stays 1.** These messages only add to it, like `git_history`. Bumping it
  would blank the Containers section of any existing devc-desktop build.

## Existing touchpoints

| File                                  | Role                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `devc/web/git_history.ts`             | `readCommitHistory` finds the folder's mirror; the lookup becomes shared.          |
| `devc/web/git_status.ts`              | `run`, `runCapped`, `locate`, `mirrorFor`, `MirrorOpts`, `GitProblem`. Reuse them. |
| `devc/web/protocol.ts`                | Parsing beside `git_history`.                                                      |
| `devc/web/server.ts`                  | Handlers beside `gitHistoryFor`, with its `isProjectRepo` check.                   |
| `devc/web/static/lib/layout_state.js` | `DiffRef`, `diffRefFromState`, `sameDiff`, `tileContent`.                          |
| `devc/web/static/lib/view.js`         | The tile key at about line 243; `tileShowingDiff` goes through `sameDiff`.         |
| `devc/web/static/tiles.js`            | See "The diff tile" below.                                                         |
| `devc/web/static/menus.js`            | `diffTileMenuItems`: Ask agent goes for a commit diff.                             |
| `devc/web/static/cards.js`            | `commitSectionRows`; `prFileRow` is the model for a file row.                      |
| `devc/web/static/lib/commits.js`      | `commitRows`; pure helpers for the new rows go here.                               |
| `devc/web/static/lib/pr_tree.js`      | `statusLetter`, `splitMarkers` (`markedText`). Reuse them.                         |
| `devc/web/static/lib/diff.js`         | `parsePatch`, `fillPatch`. They need no change.                                    |

## Contracts

### Server reads: `devc/web/git_commit.ts`

```ts
export interface CommitFile {
  path: string;
  /** The old path of a rename; otherwise null. */
  previousPath: string | null;
  /** The strings `statusLetter` already reads. A type change counts as `modified`. */
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitFiles {
  hash: string;
  /** In path order, at most MAX_COMMIT_FILES (1000). */
  files: CommitFile[];
  truncated: boolean;
}

/** What a diff tile needs. `available` and `file` have the shape `pr_diff` answers with; no `pr`. */
export interface CommitDiff {
  available: true;
  commit: {
    hash: string;
    subject: string;
    author: string;
    time: number;
    /** What it is compared with; null for a root commit. */
    parent: string | null;
  };
  file: CommitFile & {
    /** Starts at the first `@@` line. Null for a binary file, or one past MAX_COMMIT_PATCH. */
    patch: string | null;
    tooLarge: boolean;
  };
}

/** The same shape as a `pr_file_at` answer, so `readHead` handles both. */
export type CommitFileAt =
  | { available: true; text: string }
  | { available: false; message: string };

export const MAX_COMMIT_FILES = 1000;
export const MAX_COMMIT_PATCH = 1024 * 1024;
/** The same limit as `pr_review.ts`'s MAX_FILE_CHARS. */
export const MAX_COMMIT_TEXT = 4 * 1024 * 1024;

export function readCommitFiles(
  folder: string,
  sha: string,
  opts?: MirrorOpts,
): Promise<CommitFiles | GitProblem>;

export function readCommitDiff(
  folder: string,
  sha: string,
  path: string,
  opts?: MirrorOpts,
): Promise<CommitDiff | GitProblem>;

export function readCommitFileAt(
  folder: string,
  sha: string,
  path: string,
  opts?: MirrorOpts,
): Promise<CommitFileAt | GitProblem>;
```

All three never throw. Constraints a reader wouldn't otherwise know:

- **Run only in the mirror**, through `run` or `runCapped`, with `--no-ext-diff --no-textconv` on any
  command that makes a diff. The host's global git config still applies there, so don't rely on
  defaults. These reads fetch nothing, so they never reach a
  remote.
- **Rename detection needs both paths.** Limiting `diff-tree -M` to the new path alone reports an
  add. `readCommitDiff` finds `previousPath` itself by listing the commit, never from the page, and
  passes both as pathspecs.
- **Paths are literal:** use `--literal-pathspecs` and `--`. Parse with `-z`, so a path holding a
  newline survives.
- **`patch` must start at the first `@@`.** `parsePatch` treats anything else as raw text, so strip
  git's `diff --git`, `index`, `---` and `+++` lines.
- **A commit missing from the mirror** gives `{problem: 'this commit is no longer available'}`. It can
  happen to a reopened tile: after a branch switch to another remote's mirror, or a rebase followed
  by git's own cleanup. A path the commit didn't change gives
  `{problem: '<path> is not changed in this commit'}`.
- **Text at a commit:** `cat-file blob <sha>:<path>`, capped at `MAX_COMMIT_TEXT`. A NUL byte gives
  `{available: false, message: 'binary file'}`. Past the cap, `{available: false, message: 'file too large'}`.

`git_history.ts` exports the lookup, and `readCommitHistory` uses it too:

```ts
/** The mirror a folder's Commits section reads, created if missing. A no-upstream repo's included. */
export function historyMirror(
  at: Located,
  folder: string,
  opts: MirrorOpts,
): Promise<string | null>;
```

### Messages

| Message          | Fields                                     | Answer (`result`) |
| ---------------- | ------------------------------------------ | ----------------- |
| `commit_files`   | `id`, `localFolder`, `root`, `sha`         | `CommitFiles`     |
| `commit_diff`    | `id`, `localFolder`, `root`, `sha`, `path` | `CommitDiff`      |
| `commit_file_at` | `id`, `localFolder`, `root`, `sha`, `path` | `CommitFileAt`    |

- The fields match `DiffRef`, so the tile can send `{type: 'commit_diff', ...ref}`. This is `root`, as
  `pr_diff` has it, not `git_history`'s `folder`.
- `sha` must match `/^([0-9a-f]{40}|[0-9a-f]{64})$/`. `protocol.ts`
  answers anything else with `bad_request`, which also keeps revision syntax and options out of argv.
- `root` must pass `isProjectRepo`, or `bad_request` with `unknown repo`, as `gitHistoryFor` does.
- A `GitProblem` is answered with `fail(c, id, 'git_commit_failed', new Error(problem))`.
- Allowed under `--live`: they run nothing on the host but git in a mirror.

### Page: `DiffRef`

```js
/** @typedef {{localFolder: string, root: string, path: string, sha?: string}} DiffRef */
```

With `sha`, the ref names `path` as that commit changed it; without, as today, the file in the PR.

`layout_state.js` exports the one test of where a diff's content comes from:

```js
/**
 * @param {DiffRef} ref
 * @returns {'pr' | 'commit'} `devc-show-local-diff` adds `'changes'`.
 */
export function diffSource(ref);
```

- `sameDiff` compares `sha` too. The copy in `tiles.js` (about line 1398) changes with it.
- `tileContent` saves `sha` only when set, and `diffRefFromState` restores it. A saved `sha` of the
  wrong form drops the tile, as a missing `path` does. A saved layout without one still loads.
- The keys in `view.js` (about line 243) and `tiles.js` `diffScrollKey` (about line 3954) include it,
  so two commits' tiles for one file don't share a key or a scroll position.

### The diff tile: `tiles.js`

A commit diff is `diffSource(view.tile.diff) === 'commit'`. Branch on the source, never on `sha` being
set, and let each check say which source it means: the PR-only parts ask for `'pr'`, so a later source
gets none of them without further edits.

- `loadDiff`: sends `commit_diff`, and doesn't call `loadThreads` or `loadPending`.
- `readHead`: uses `ref.sha` and `commit_file_at` instead of `pr.headSha` and `pr_file_at`.
- `syncDiffLanguage`: `wanted` is false.
- `diffTileTitle`: `<basename> · <short sha>`. `setDiffTitle`'s tooltip: the short sha and subject,
  then the path.
- `diffHeader`: the short sha, its title the author, date and subject, where a PR's `#n` goes. A
  merge's compared-with parent is in that title.
- `askButton` and `diffTextMenuItems`: no Ask agent. In `menus.js`, `diffTileMenuItems` follows.
- A null `patch`: with `binary`, the message a binary PR file gets. With `tooLarge`, a new
  `LABELS` line saying the diff is too large to show, and Whole file isn't offered.

Check that nothing else reaches for `view.data.pr` unguarded: `sinceOptions`, `offersWholeFile`, the
`+` comment markers. A diff with no `pr` must draw no review controls and throw nothing.

### Page: rows: `cards.js`

- A commit row gets a chevron, and a click toggles its files. The row keeps its rail, subject and
  short hash, and `treeRow` or the existing arrow-key handling should apply to it.
- Under an open commit: `Loading…`, the error, `No files changed` for an empty commit, or one row per
  file. `truncated` adds a note row giving the limit.
- A file row: status letter, file name, dim folder and stat, using `statusLetter`, `markedText` and
  `diffStat`, with no Viewed checkbox. A renamed file's title gives both paths.
- Clicks match `prFileRow`: a click opens `tileArea.openDiff(ref, 'preview')`, Ctrl/⌘-click uses
  `'stack'`, a double-click keeps it open. Its menu has **Open diff** and **Open diff to the right**,
  and **Open file** unless the status is `removed`. Open file shows today's copy, not the commit's.
- A commit's file list never changes, so it is read once per `root` and `sha`. Keep at most 50 lists.
- The section's 15 s poll must not collapse open commits, nor re-read their lists.
- File names and subjects are the repo's: text, never HTML (`markedText` also marks invisible
  characters, which matters in paths).

## Concept boundaries

- **`devc-show-local-diff`** (not built) shares this tile and `DiffRef`, as the `'changes'` source.
  Its content differs: working-tree changes, read in the environment, which move as files are edited.
  `sha` is a fixed commit read from the mirror, so a commit diff has no reload-on-change, and its reads
  must not grow an environment path to serve both.
- **`pr_file_at` and `commit_file_at`** look alike. `pr_file_at` is a bridge command and needs a grant.
  `commit_file_at` reads the mirror.
- **`readHead` and `view.head`** mean "the PR head" today. For a commit diff they hold the file at
  that commit. Update their comments.
- **`CommitFile` and `PrFile`** share field names, but `PrFile` has `viewed`, and `CommitFile` has
  `binary`. Don't pass a `CommitFile` to something that reads Viewed counts (`buildPrTree`).
- **`git_commit.ts`, not `git_changes.ts`.** `git_changes.ts` is the working tree's changes to commit,
  read in the environment.
- **The existing `commits` names** (`commitsOpen`, `commitLists`, `commitRows`) are the section and its
  list. Name the new state for files: `commitFilesOpen`, `commitFileLists`.
- **`cardHistoryOpen`** is past sessions, not git history.

## .gitignore

Nothing to add.

## Resizable split

Asked for alongside this plan, for every diff tile (PR and commit alike). The split view's separator
(the new side's number column's left edge) drags left and right; a double-click evens the sides.
The left side's share of the text width is per browser (`devc-web-pr-diff-split-share-v1` in
`localStorage`), applies to every split diff tile at once, and stays between 0.15 and 0.85
(`splitShare`, `dragSplitShare` in `lib/diff.js`).

## Implementation notes

- A rename's patch compares the commit's two blobs (`git diff <old blob> <new blob>`), not
  `diff-tree` with both paths: one path holding both a rename's source and a new file would
  otherwise give two file sections. Other files use `diff-tree -p` with one `:(literal)` pathspec,
  and no rename detection.
- `readCommitFileAt` answers `{available: false, message: 'file not in this commit'}` for a path the
  commit's tree lacks (a removed file).
- A commit diff tile's header shows its short sha where a PR's `#n` goes; its tooltip gives the
  author, date, subject and the compared-with parent.

## Validation

- [x] `cd devc && deno task check && deno task test`, and `deno fmt --check` for the touched files.
- [x] `tests/web_git_commit_test.ts`, against real temporary repos:
  - modified, added, removed, renamed, type-changed and binary files, and a path holding a newline;
  - a root commit, a merge compared with its first parent, and an empty commit;
  - a patch that starts at `@@`, and a rename whose patch shows only the changed lines;
  - past `MAX_COMMIT_FILES` (`truncated`), past `MAX_COMMIT_PATCH` (`tooLarge`), binary and oversize text;
  - a missing commit, and a path the commit didn't change;
  - a commit on the upstream the repo hasn't fetched, read from the mirror;
  - the repo's hooks, `core.fsmonitor` and a `textconv` it configures don't run, with the control
    `git_status`'s test uses.
- [x] `tests/web_server_test.ts`: all three messages parse, and a short, uppercase or option-like `sha`, or
      a missing field, gives `bad_request`.
- [x] `tests/web_layout_test.ts` (or its neighbour): `sha` round-trips through a saved layout, `sameDiff`
      tells two commits apart, a ref without `sha` behaves as before, a malformed `sha` is dropped, and
      `diffSource` gives `'pr'` and `'commit'`.
- [x] `tests/web_commits_test.ts`: the new pure helpers.
- [x] A PR diff tile is unchanged: the existing diff tests pass with no edits to their expectations.
- [x] A browser check with a fake socket (the `devc-web` skill's "Testing without the user's tab"): expand
      a commit, open a file, tell two commits' tiles for one file apart, reload and find the tile again,
      and see no review controls and no thrown errors.
- [x] `tests/web_diff_test.ts`: `splitShare` and `dragSplitShare`; in the browser check, a drag moves
      the separator and is kept across a re-render, and a double-click evens the sides.
- [ ] Manual, by the user:
  - expand a commit on a container project, running and stopped, and on a host project;
  - open a diff, then Whole file, Hide whitespace, split view and Find;
  - the PR list's diffs still work, including comments and Viewed;
  - in devc-desktop, the same from `/sidebar` and from the Containers pane;
  - drag a split diff's separator, in a PR diff and a commit diff, and reload.
