# devc-web-file-palette

## Checklist

- [x] `devc/web/file_index.ts` (new): the repo file walk (`.gitignore`-aware, capped) and its ignore matcher, with tests in `devc/tests/web_file_index_test.ts` (new)
- [x] `devc/web/protocol.ts`: `find_files` client message (type + `parseClientMessage` case), with a parse test in `devc/tests/web_server_test.ts`
- [x] `devc/web/server.ts`: `find_files` handled beside `list_dir` (same project / repo checks), replying `{files, truncated}`
- [x] `devc/deno.json`: `web/file_index.ts` added to the `check` task's file list
- [x] `devc/web/static/lib/palette.js` (new, pure): shortcut predicate, matcher + ranking, empty-query list, recents parse/update, with tests in `devc/tests/web_palette_test.ts` (new)
- [x] `devc/web/static/palette.js` (new): the palette dialog, mounted with a `TileArea`
- [x] `devc/web/static/app.js`: mount the palette (`/` only)
- [x] `devc/web/static/style.css`: palette styles (tokens only, both themes)
- [x] `devc/tests/web_page_split_test.ts`: `palette.js` imports neither `tiles.js` nor `sidebar.js`
- [x] `devc/README.md`: a **Find a file** bullet in the `devc web` section

**⌘P** (on a Mac) or **Ctrl+Alt+P** (elsewhere) opens a palette over devc web that finds a file
in the focused tile's repo by fuzzy name and opens it in a file tile. It works on the combined
page `/` (browser and devc-desktop), while a terminal or file tile has focus. The split pages
`/main` and `/sidebar` do not get it: they exist for the VS Code embedding, where VS Code is
likely to take ⌘P before the webview sees it.

The palette has one source in this plan: files. It is called a palette (CSS class, module name)
because commands are the obvious next source; adding them is **out of scope** — no `>` prefix,
no command registry.

## Concept boundaries

- **Scope is one repo: the focused tile's.** Take the view's tiles (`tileArea.state().tiles`),
  most recently focused first (`focusSeq` descending). For each: `tileRepo(tile)` (`client.js`);
  its `repo` → use it; no `repo` but a `localFolder` → that project's first repo
  (`projectRepos(localFolder)[0]`); neither (an empty tile) → try the next tile. Nothing found →
  the palette opens with the message `No repo to search: focus a terminal or file in a repo
  first.` and no input. The scope is fixed when the palette opens.
  Tradeoff noted: a project with several repos searches one at a time (focus a tile in another
  to switch). Searching all of a project's repos would list every worktree's copy of each file.
- **Repo files only.** Files are listed from the repo folder **on the host**, as `list_dir` and
  `read_file` already read them, so a repo of a stopped project works too. Container-only files
  (the Files node's `container: true` rows) are not searched.
- **The host never runs git in a repo** (see `git_status.ts`'s header): the listing is a Deno FS
  walk with devc's own `.gitignore` matcher, not `git ls-files`.
- **Opening** goes through `tileArea.openFile(fileRef, where)` with
  `{localFolder, root, path}` (no `view`: the default view by extension, as the sidebar does).
- **Not in scope:** commands, `path:line` jumping, searching file contents, multiple repos,
  a configurable shortcut, the split pages `/main` and `/sidebar`.

## Contracts

### Shortcut

`isPaletteShortcut(e, isMac)` in `static/lib/palette.js`, in the style of `isZenShortcut`
(matched on `code`, since a Mac's Option changes `key`):

| platform | keys                         | matches                                                                  |
| -------- | ---------------------------- | ------------------------------------------------------------------------ |
| Mac      | ⌘P                           | `code === 'KeyP' && metaKey && !ctrlKey && !altKey && !shiftKey`         |
| other    | Ctrl+Alt+P                   | `code === 'KeyP' && ctrlKey && altKey && !metaKey && !shiftKey`          |

- Off a Mac it is **not** Ctrl+P: Ctrl+P belongs to the terminals (readline's previous-history),
  the same reason Cmd+B has no off-Mac twin. Ctrl+Alt+P follows Ctrl+Alt+N / Ctrl+Alt+Z.
- Listen on `document`, `keydown`, **capture phase**; `preventDefault()` + `stopPropagation()`
  (stops the browser's Print dialog and keeps xterm.js / CodeMirror from seeing the key);
  ignore `e.repeat`. Pressed while the palette is open: closes it.
- devc-desktop needs no change: its menu has no ⌘P accelerator (`devc-desktop/src/main/main.ts`
  menu: ⌘R, ⌘J, ⌘Q, edit roles, ⌥⌘I), so the page receives the key.
- Not on `/main` or `/sidebar` (the VS Code embedding's pages): VS Code may take ⌘P for its own
  Quick Open before the webview sees it, so the palette is not mounted there.

### Client → server: `find_files`

```json
{ "type": "find_files", "id": "ff-3", "localFolder": "/Users/me/src/proj", "root": "/Users/me/src/proj" }
```

Parsed like `list_dir` (`str(m,'id')`, `folder(m)`, `absolute(m,'root')`; no `path`). Server
checks, in order, exactly as `list_dir`: `isListedProject(localFolder)` else reject
`bad_request` `unknown project`; `isProjectRepo(...)` else reject `bad_request` `unknown repo`.

Reply: `{ "id": "ff-3", "ok": true, "result": { "files": ["README.md", "src/a.ts"], "truncated": false } }`

- `files`: paths relative to `root`, `/`-separated, no leading `./`, sorted by UTF-16 code unit
  (`a < b` comparison, not `localeCompare`).
- Failure: the root itself unreadable or missing → `fail(c, id, <FilesError code>, e)` as
  `list_dir` does; anything else → code `list_failed`.
- No server-side cache: every request walks again.

### The walk: `listRepoFiles(root)` in `devc/web/file_index.ts`

Returns `Promise<{ files: string[]; truncated: boolean }>`.

- Depth-first from `root` with `Deno.readDir`; entries in each directory visited in code-unit
  order (so truncation is deterministic).
- **Never listed or entered:** any entry named `.git` (directory or file, at any depth).
- **A directory below `root` that contains a `.git` entry is not entered** (a worktree, submodule
  or nested repo: another repo's files). `root` itself is entered.
- **Symlinks:** never followed into directories. A symlink is listed when `Deno.stat` (following)
  says it is a file; a link to a directory, a broken link or a loop is left out.
- **Ignored entries** (below) are neither listed nor entered. An ignored directory's contents
  cannot be re-included by a `!` rule, as in git.
- A subdirectory that cannot be read (permission, vanished) is skipped silently.
- Caps: `MAX_FIND_FILES = 50_000` files listed, `MAX_FIND_VISITED = 500_000` directory entries
  read. Either reached → stop, `truncated: true`.

### Ignore rules (pure, exported from `file_index.ts` for tests)

Sources, lowest precedence first; within all of them the **last matching rule wins**:

1. `<root>/.git/info/exclude`, only when `<root>/.git` is a directory (a worktree's `.git` is a
   file: its exclude is not read). Its rules are relative to `root`.
2. `.gitignore` of each directory from `root` down to the entry's parent, outer first. Each
   file's rules are relative to the directory holding it.

Global excludes (`core.excludesFile`) are not read. Reading these files is reading data; no git
runs.

Line syntax (a subset of gitignore(5), everything else in it is out of scope):

- Lines split on `\n`, a trailing `\r` dropped. Blank lines and lines starting with `#` are
  skipped. `\#` and `\!` at the start are a literal `#` / `!`.
- Trailing spaces are dropped unless escaped (`\ `).
- Leading `!` negates (re-includes).
- Trailing `/`: matches directories only; the `/` is then removed before the rules below.
- A pattern with a `/` at the start or in the middle is **anchored**: matched against the path
  relative to the `.gitignore`'s directory (a leading `/` removed). Otherwise it matches the
  entry's **basename** at any depth below that directory.
- `*` any run of non-`/` characters; `?` one non-`/` character; `[...]` a class (`[!...]` and
  `[^...]` negate, ranges allowed); `\x` a literal `x`.
- `**`: leading `**/` matches in any directory; trailing `/**` matches everything inside;
  `/**/` matches zero or more directories. `**` elsewhere acts as `*`.
- An unparseable pattern (an unclosed `[`) is skipped.

| `.gitignore` in | lines                    | path tested       | dir | ignored |
| --------------- | ------------------------ | ----------------- | --- | ------- |
| root            | `node_modules/`          | `node_modules`    | yes | yes     |
| root            | `node_modules/`          | `a/node_modules`  | yes | yes     |
| root            | `node_modules/`          | `node_modules`    | no  | no      |
| root            | `/build`                 | `build`           | yes | yes     |
| root            | `/build`                 | `a/build`         | yes | no      |
| root            | `*.log`                  | `a/b/x.log`       | no  | yes     |
| root            | `*.log` / `!keep.log`    | `keep.log`        | no  | no      |
| root            | `docs/*.md`              | `docs/a.md`       | no  | yes     |
| root            | `docs/*.md`              | `docs/x/a.md`     | no  | no      |
| root            | `**/tmp`                 | `a/b/tmp`         | yes | yes     |
| root            | `a/**/z`                 | `a/z`             | no  | yes     |
| root            | `a/**/z`                 | `a/b/c/z`         | no  | yes     |
| root            | `logs/**`                | `logs/x/y.txt`    | no  | yes     |
| root            | `[ab].txt`               | `a.txt`           | no  | yes     |
| root            | `[ab].txt`               | `c.txt`           | no  | no      |
| root            | `\#notes`                | `#notes`          | no  | yes     |
| root            | `# notes`                | `# notes`         | no  | no      |
| root            | `foo   ` (trailing ws)   | `foo`             | no  | yes     |
| `sub/`          | `*.gen.ts`               | `sub/x.gen.ts`    | no  | yes     |
| `sub/`          | `*.gen.ts`               | `x.gen.ts`        | no  | no      |
| `sub/`          | `/out`                   | `sub/out`         | yes | yes     |
| `sub/`          | `/out`                   | `sub/a/out`       | yes | no      |
| root + `sub/`   | root `*.md`, sub `!a.md` | `sub/a.md`        | no  | no      |

Walk tests (temp directories): `.git` dir and file both absent from the output; a nested folder
with a `.git` file is not entered; a symlink to a file listed, to a directory not; an ignored
directory with a `!`-re-included file inside stays out; `.git/info/exclude` applies; output
sorted; a cap lowered through an optional parameter (`{maxFiles}`) gives `truncated: true` and
exactly that many files.

### Matching and ranking: `static/lib/palette.js` (pure)

`rankFiles(query, files, limit)` → `{ path, positions }[]`, at most `limit` (the palette passes
**50**). `positions`: indices into `path` of the matched characters, for highlighting.

- The query is lower-cased and all whitespace removed; empty → `[]` (the caller shows the
  empty-query list instead). Matching is case-insensitive against `path.toLowerCase()`.
- A file matches when the query is a subsequence of its path. Each match falls in the first
  tier that holds (`base` = the part after the last `/`):
  1. `base` equals the query
  2. `base` starts with the query
  3. the query is a substring of `base`
  4. the query is a subsequence of `base`
  5. the query is a substring of the path
  6. the query is a subsequence of the path
- Order: tier ascending, then path length ascending, then path in code-unit order.
- `positions`: tiers 1–3 and 5, the first occurrence; tiers 4 and 6, the greedy leftmost match.
  For tiers 1–4 the indices are offset by `base`'s start in `path`.

| query     | files                                                                                   | result order                                                                                     |
| --------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `server`  | `web/static/server_util.js`, `web/server.ts`, `server`, `docs/observer.md`, `servers/x.ts` | `server`, `web/server.ts`, `web/static/server_util.js`, `docs/observer.md`, `servers/x.ts`       |
| `wst`     | `web/static/tiles.js`, `west.md`, `a/wast.ts`                                           | `west.md`, `a/wast.ts`, `web/static/tiles.js`                                                    |
| `Web/Ser` | `web/sidebar.js`, `devc/web/server.ts`                                                  | `devc/web/server.ts`, `web/sidebar.js`                                                           |
| `s r v`   | `web/server.ts`                                                                         | `web/server.ts`, positions `[4, 6, 7]`                                                           |
| `zzz`     | `web/server.ts`                                                                         | (none)                                                                                           |

Performance: ranking runs on every `input` event with no debounce; it must stay a single pass
over `files` with no per-file allocation for non-matches (check the subsequence first, then
classify).

### Empty query and recents

- Recents: `localStorage` key `devc-web-palette-recent-v1`, JSON `{ [root]: string[] }`, paths
  newest first, at most 20 per root, at most 50 roots (opening in a new root drops the root
  whose list was least recently updated: keep insertion order of keys, delete + re-add on
  update, drop from the front). Parsed by a tolerant `parseRecents(text)` (bad JSON, wrong
  shapes, non-string paths → dropped, never throws). Every read/write in `try/catch`.
- Recorded when a file is opened from the palette.
- Empty query shows, de-duplicated, up to 50: the files open in file tiles of this repo
  (`kind === 'file'`, not `container`, `file.root === root`), most recently focused first; then
  the recents for `root` that are still in the listing (once it has arrived; before that, all of
  them). Nothing to show → the hint `Type to search <N> files` (`N` with `toLocaleString()`),
  or `Listing files…` while the first listing is in flight.

### The palette (`static/palette.js`)

`mountPalette({ tileArea })`, called once by `app.js` after `mountTiles`. It registers the
shortcut listener. `main-page.js` and `sidebar-page.js` do not call it.

- A modal `<dialog class="dialog palette">` (`showModal()`, so Escape and the backdrop close it,
  and focus is trapped). Top-centred, `width: min(640px, calc(100vw - 32px))`, results list
  scrolling, max height `60vh`. Removed from the DOM on `close`, after focusing the element that
  was `document.activeElement` when it opened (a terminal's xterm textarea, a CodeMirror view),
  if that element is still connected.
- Header: an `<input type="text">` (`spellcheck=false`, `autocomplete=off`) with placeholder
  `Search files in <name>`, `<name>` = basename of the repo's `folder`; the repo's
  `git?.branch`, when known, in a dimmed span after the input.
- Results: `role="listbox"`; each row `role="option"`, the basename (matched characters in
  `<mark>`), then the directory part dimmed (`''` at the root). The input carries
  `aria-activedescendant` for the selected row. The first row is selected after every render.
- Keys in the input: **↓ / ↑** move the selection (wrapping), keeping it scrolled into view;
  **Enter** opens the selected file `'preview'`; **⌘Enter** on a Mac, **Ctrl+Enter** elsewhere
  opens it `'right'`; **Escape** closes. Click opens `'preview'`; hovering a row selects it.
  Opening closes the palette and records the recent.
- Listing: on open, `call({type:'find_files', localFolder, root})`. The page keeps the last
  listing per `root` in memory for its life: on open, a cached listing is used at once and
  replaced when the new reply arrives (re-rank the current query; keep the selection on the same
  path when it is still in the results, else the first row). A reply arriving after the palette
  closed, or for another root, is only cached.
- `truncated`: a dimmed footer `Searching the first 50,000 files`.
- Error reply: the list shows `Couldn't list files: <message>`; the cached listing, if any, is
  still searched below it.
- No `alert`/`confirm`/`prompt` (`web_no_native_dialogs_test.ts`).

## Implementation notes

- `call` in `client.js` already returns a promise per request id; use it.
- `tileRepo` takes a tile with `kind`, `file`, `diff`, `ref`, which `TileState` has; it reads the
  page's own `projects` map, which every page has once connected.
- Reuse `.dialog` styles from `style.css`; add `.palette*` rules with existing colour tokens only
  (the stylesheet's light and dark sets both apply).
- devc-web-host-environments (pending) will route repo file reads through an `Environment`; the
  walk reads host paths with Deno FS, which is what its host environment does too. No seam is
  added here.

## Validation

- [x] `cd devc && deno task check` passes (with `web/file_index.ts` in the list)
- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env tests/web_file_index_test.ts tests/web_palette_test.ts` passes, covering every row of the ignore, ranking and shortcut tables above
- [x] `cd devc && deno task test` passes (including `web_page_split_test.ts` and `web_no_native_dialogs_test.ts`)
- [ ] `cd devc && deno lint && deno fmt --check` pass
- [x] `parseClientMessage` test: a `find_files` with a relative `root` is rejected; a valid one parses to `{type, id, localFolder, root}`
- [ ] Manual, `devc web` in Chrome on a Mac, a project with a repo holding a `.gitignore`d `node_modules/`: with a terminal tile focused, ⌘P opens the palette (no Print dialog), placeholder names the repo; typing `serv` ranks `server.ts`-like basenames first with highlighted letters; no `node_modules/` or `.git/` path appears
- [ ] Manual: Enter opens the file in the preview tile; ⌘Enter opens it to the right; reopening with an empty query lists that file first
- [ ] Manual: ⌘P inside a focused file tile (CodeMirror) and inside a terminal both open the palette; ⌘P again closes it; Escape closes it and focus returns to where it was
- [ ] Manual: on `/main` and `/sidebar`, ⌘P does nothing new (the browser's Print dialog, as today)
- [ ] Manual: with no tiles (or only empty tiles), the palette shows `No repo to search: …`
- [ ] Manual, devc-desktop: ⌘P opens the palette

## Relevant Files

- `devc/web/file_index.ts` (new)
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/deno.json`
- `devc/web/static/lib/palette.js` (new)
- `devc/web/static/palette.js` (new)
- `devc/web/static/app.js`
- `devc/web/static/style.css`
- `devc/tests/web_file_index_test.ts` (new)
- `devc/tests/web_palette_test.ts` (new)
- `devc/tests/web_server_test.ts`
- `devc/tests/web_page_split_test.ts`
- `devc/README.md`
