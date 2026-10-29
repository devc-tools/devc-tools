# devc-show-local-diff — `show --changes`: diffs of local work

After [devc-show](devc-show.md). An agent shows a file's **local** diff: its uncommitted changes,
or everything the branch changed against another ref, with or without a pull request. This adds a
new kind of tile, a local diff tile, beside the PR diff tile, and a `--changes` option to
`devc-bridge show` / `devc show`. `--diff` keeps meaning the PR diff.

## Checklist

- [ ] `devc-core/show_request.ts`: `--changes [<ref>]` parsing and `target.kind: "changes"` (see
      Contracts)
- [ ] `devc-bridge/client/devc-bridge.ts`, `devc/help.ts`: usage lines gain `--changes`
- [ ] `devc/web/protocol.ts`, `devc/web/server.ts`: a `local_diff` request that answers a file's
      unified diff and both sides' text (see Contracts)
- [ ] `devc/web/show.ts`: resolve `"changes"` targets
- [ ] `devc/web/static/lib/layout_state.js`: a `LocalDiffRef` tile state that round-trips through
      the saved layout
- [ ] `devc/web/static/tiles.js`: the local diff tile (rendering, Whole file, reload, reveal and
      highlight), reusing the PR diff tile's rendering without its PR parts
- [ ] `devc/web/static/lib/view.js`: `tileShowingLocalDiff`, and `TileState.kind` gains
      `'local-diff'`
- [ ] `skills/devc-show/SKILL.md`, `devc/README.md`, `devc-bridge/README.md`: `--changes`
- [ ] Tests listed under Relevant Files

## Contracts

### Command line

```
show [--diff [--side LEFT|RIGHT] | --changes [<ref>] [--side LEFT|RIGHT]] <path>[:<line>[-<end>]]
```

- `--changes` without a ref: the file's uncommitted changes (working tree against `HEAD`).
- `--changes <ref>`: the working tree against `git merge-base <ref> HEAD`. So `--changes main`
  shows everything the branch changed since it left `main`, committed or not, and `--changes HEAD`
  equals the bare form. `<ref>` is any name `git rev-parse --verify <ref>^{commit}` accepts.
- Parsing: `--changes` takes the next argument as `<ref>` only when another argument follows it
  (the last argument is always the target). So `show --changes a.ts:4` has no ref and
  `show --changes main a.ts:4` has ref `main`.
- `--diff` and `--changes` together → exit 2. `--side` applies to either; line numbers count lines
  in the working-tree version (`RIGHT`) by default, as in `--diff`.
- Success output: `shown <path>[:<line>[-<end>]] (changes since <ref or HEAD>)`.
- Exit 3 (target errors) adds: `unknown ref <ref>`, `<path> has no changes since <ref or HEAD>`.
  A file that is new (untracked, or added since the base) is a valid target: everything is an
  added line. A file deleted in the working tree is valid: everything is a deleted line, and
  `RIGHT` lines are not found.

### Request target

```json
{ "kind": "changes", "path": "/workspaces/app/src/a.ts", "ref": "main", "line": 40, "end": 58, "side": "RIGHT" }
```

`ref` is omitted for the bare form. `request.version` stays 1: an older devc web that doesn't know
`"changes"` answers `ok: false`, exit 3, `this devc web is older than the caller — restart devc web`.
Phase 1's resolver must already reject unknown `target.kind` this way; add that to phase 1's code
if it does not.

### The local diff

- The server computes it in the repo's environment (container or host), from the repo root:
  - base: `git rev-parse --verify <ref or HEAD>^{commit}`, then for a ref,
    `git merge-base <that> HEAD`.
  - patch: `git diff --no-color --no-ext-diff -U3 <base> -- <path>`. For an untracked file (not
    in `git ls-files`), `git diff --no-index --no-color -U3 /dev/null <path>` (exit 1 means
    "differs" and is success).
  - old text: `git show <base>:<path>` (empty when the path is absent at base); new text: the
    working-tree file (empty when deleted).
- The tile shows `base` as a short sha in its header, beside the ref as asked.
- Binary files: the tile says `Binary file — no text diff`, as the PR diff tile does.

### The tile

- **Ref** (saved with the layout): `{localFolder, root, path, ref: string | null}`. The base is
  re-resolved every time the tile loads, so a saved tile shows today's diff.
- **Title**: `<basename> · changes` for the bare form, `<basename> · since <ref>` otherwise.
- **Same as the PR diff tile**: the hunk/Whole file toggle, the side-by-side/unified choice,
  syntax colours, word-level change spans, Find.
- **Not in it**: threads, comments, **Viewed**, **Since viewed**, the github.com link, Ask agent's
  PR context. The tile's menu has **Reload** and **Open file**.
- **Reload**: the menu's **Reload**, and automatically when the tile comes forward after its file
  changed on disk (the same change signal file tiles use for reloads).
- `show` placement, focus, reveal, highlight and `pendingLines` behaviour are phase 1's, with the
  local diff ref in place of the `DiffRef`. Two local diff tiles are the same target when
  `localFolder`, `root`, `path` and `ref` all match.

## Implementation notes / gotchas

- Run git with `-c core.quotePath=false` and pass the path after `--`, relative to the repo root,
  so names with spaces or non-ASCII characters work.
- `git merge-base` can print nothing and exit 1 (unrelated histories): exit 3 with
  `<ref> shares no history with HEAD`.
- The PR diff tile's renderer takes a parsed patch plus the head text for **Whole file**
  (`devc-web-diff-whole-file`). Feed it the local patch and the working-tree text; keep the PR-only
  parts (threads, viewed state, `pr` header) behind the tile kind so the renderer isn't forked.
- A layout saved by a newer devc web with a local diff tile, opened by an older one, must not
  break the layout: check how `diffRefFromState` treats an unknown shape (it returns `null` for a
  non-PR state) and that the tile then shows as an empty tile, not an error.

## Relevant Files

- `devc-core/show_request.ts`, `devc-core/tests/show_request_test.ts`
- `devc-bridge/client/devc-bridge.ts`: usage line
- `devc/help.ts`, `devc/tests/help_test.ts` (if it pins usage text)
- `devc/web/show.ts`, `devc/tests/web_show_test.ts`
- `devc/web/protocol.ts`, `devc/web/server.ts`: `local_diff`
- `devc/web/git_repo.ts`: the git invocations (or wherever repo git commands live by then)
- `devc/tests/web_local_diff_test.ts` (new): the git commands against temp repos
- `devc/web/static/lib/layout_state.js`, `devc/tests/web_layout_state_test.ts`
- `devc/web/static/lib/view.js`
- `devc/web/static/tiles.js`
- `skills/devc-show/SKILL.md`: the `--changes` form
- `devc/README.md`, `devc-bridge/README.md`
- `.plans/PLAN.md`

## Validation

- [ ] `cd devc-core && deno test -A tests/show_request_test.ts`: `--changes a.ts` → no ref;
      `--changes main a.ts:4` → ref `main`, line 4; `--diff --changes a.ts` → usage error
- [ ] `cd devc && deno test -A tests/web_local_diff_test.ts` (temp git repos):
  - An edited tracked file → the patch, old text from `HEAD`, new text from disk
  - `ref` = a branch the repo forked from, with one commit and one uncommitted edit since → both
    in the patch
  - An untracked file → all lines added; a deleted file → all lines removed
  - Unknown ref → exit 3 `unknown ref`; no changes → exit 3 `has no changes`; unrelated history →
    exit 3 `shares no history`
  - A path with a space and one with `é` work
- [ ] `cd devc && deno test -A tests/`: a layout with a local diff tile round-trips; an older
      `"changes"` target is refused with the restart message (phase 1 resolver test)
- [ ] `deno fmt --check`, `deno lint` and `deno task check` pass in `devc`, `devc-core`,
      `devc-bridge/client`
- [ ] Manual (a repo on a branch with one commit and an uncommitted edit, no PR):
  - `devc-bridge show --changes <file>:<line>` → a local diff tile beside the terminal with only
    the uncommitted edit, the line highlighted, focus still in the terminal
  - `devc-bridge show --changes main <file>` → a second tile titled `· since main` with both
    changes; the first tile stays (different target)
  - Edit the file, bring the tile forward → it shows the edit
  - Reload the page → both tiles come back and re-read their diffs
