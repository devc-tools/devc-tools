# devc-web-file-viewer

- [ ] Vendor CodeMirror 6 as one bundled ES module (`static/vendor/codemirror/`), with `VERSIONS` and `LICENSE`
- [ ] Server: `read_file` (host side, confined to a repo root, size and binary checks), with tests
- [ ] `layout.js`: a second component type, `file`, whose state is a `FileRef`; persisted and restored like pane tiles
- [ ] `static/viewer.js`: the only CodeMirror importer. Mounts a read-only view with language highlighting by file name
- [ ] Page: clicking a file opens it in a file tile; "Open in editor" (`$EDITOR` in a pane) moves to the menu
- [ ] File tile header menu: Reload, Open in editor, Copy path
- [ ] `.plans/devc-web.md` protocol and UI sections updated
- [ ] Verify (below) and ask the user to try it in their open tab

A real file view in `devc web`: a tile that shows a file with syntax highlighting, line
numbers, search and code folding. It starts **read-only**. Today the only way to see a file is
"Open in editor", which runs the container's `$EDITOR` in a new terminal pane. That stays, as a
menu item.

CodeMirror 6 is the component because the next step, editing, is the same view with
`readOnly` off plus a `write_file` message. A highlight-only library (highlight.js, Prism,
Shiki) would have to be replaced at that point.

Depends on [devc-web-repo-tree](devc-web-repo-tree.md) (the `root` a file path is relative to).
Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first.

**Not in this plan** (follow-ons):

- editing and saving (`write_file`, a dirty marker in the tab, conflict check on save via mtime);
- live reload when the file changes on disk (file watching);
- language servers, diagnostics, go-to-definition;
- images, PDFs and other binary previews;
- diffs against git `HEAD`.

## Concept boundaries

- **File tile vs pane tile.** Today every tile is a `pane` component holding a `PaneRef` (a Herdr
  pane in a container). A `file` tile holds a `FileRef` and has no Herdr pane, no terminal, no
  agent badge and no container dependency: it works while the container is stopped. Code that
  walks tiles to attach streams, resize terminals or show "Pane gone" must skip file tiles.
- **"Open" vs "View" vs "Open in editor".** `open` (existing message) attaches a tile to a pane's
  stream. `open_file` (existing) creates a terminal pane running `$EDITOR`. `read_file` (new)
  only reads bytes. In UI text: clicking a file **opens** it in a file tile; the terminal route
  stays "Open in editor" / "Open in editor to the right". Don't rename `open_file`.
- **One importer per vendor library.** `layout.js` is the only Golden Layout importer and
  `renderer.js` the only xterm importer. `viewer.js` is the only CodeMirror importer. `app.js`
  talks to it through the `Viewer` contract below.
- **Host read, not container read.** `read_file` reads the host side of the bind mount, like
  `list_dir`, so what you see is what's on disk on the host. No `docker exec`.

## Existing touchpoints

| File                                    | Role                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `devc/web/static/vendor/golden-layout/` | The pattern to follow for vendoring: one `deno bundle --platform browser --format esm` output, `VERSIONS`, `LICENSE`. |
| `devc/web/protocol.ts`                  | New `read_file` `ClientMessage` variant and its parser case.                                                          |
| `devc/web/server.ts`                    | `read_file` handling, next to `list_dir`; same project and `root` checks.                                             |
| `devc/web/files.ts`                     | `confine`; a new `readProjectFile`.                                                                                   |
| `devc/web/static/layout.js`             | Registers the second component type; `Tile` gains a kind; `add` / `addBeside` / `dragSource` accept a file ref.       |
| `devc/web/static/lib/layout_state.js`   | `paneRefFromState` and a new `fileRefFromState`.                                                                      |
| `devc/web/static/app.js`                | `mount` / `unmount` / `visibility` hooks branch on tile kind; `fileEntryRow` click; `fileMenuItems`; tile menu.       |
| `devc/web/static/style.css`             | The viewer's container and a theme built from the page's existing CSS custom properties.                              |
| `devc/web/server.ts` (static serving)   | `.mjs` / `.css` under `vendor/` are already served; check nothing else is needed for the new directory.               |

## Contracts

### Vendored CodeMirror

- `devc/web/static/vendor/codemirror/codemirror.mjs`: one bundled ES module (no bare imports
  left), built from a small entry file that re-exports what `viewer.js` needs. Keep the entry
  file in the same directory as `entry.js` so the bundle can be rebuilt; `VERSIONS` lists every
  package and version and the exact bundle command.
- Packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`,
  `@codemirror/commands`, `@codemirror/search`, `@codemirror/legacy-modes`, and the language
  packages for: JavaScript/TypeScript/JSX/TSX, JSON, Markdown, CSS, HTML, Python, Go, Rust, YAML,
  SQL. Through `legacy-modes`: shell, Dockerfile, TOML. Everything is bundled up front; no
  dynamic imports (the page has no build step and the server serves files as they are).
- `LICENSE`: CodeMirror's MIT licence text.

### `static/viewer.js`

```js
/** @typedef {{localFolder: string, root: string, path: string}} FileRef */

/**
 * Mounts a read-only view of `text` into `el`, highlighted for `name` (a file name; its
 * extension, or the whole name for `Dockerfile`, `Makefile` and dotfiles like `.bashrc`, picks
 * the language; unknown gives plain text).
 * @returns {Viewer}
 */
export function createViewer(el, { name, text });

/**
 * @typedef {object} Viewer
 * @property {(text: string) => void} setText   replaces the content, keeping the scroll position when it can
 * @property {() => void} focus
 * @property {() => void} destroy
 */

/** The language picked for `name`, or null for plain text. Pure, exported for tests. */
export function languageFor(name);
```

- Extensions on: line numbers, active-line highlight, bracket matching, code folding, search
  (Ctrl/Cmd-F), selection and copy. `EditorState.readOnly` on, `EditorView.editable` off.
- The theme reads the page's existing custom properties (background, foreground, muted, accent)
  so it matches light and dark the same way the rest of the page does. No new theme tokens.

### Browser → server

| Message     | Fields                              | Server does                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file` | `id`, `localFolder`, `root`, `path` | Same project and `root` checks as `list_dir` (`bad_request` `unknown project` / `unknown repo`). `confine(root, path)`: `null` → `forbidden`. Not a regular file → `bad_request`. Larger than `MAX_READ_BYTES` → `too_large` (message gives the size). A NUL byte in the first 8 KiB → `binary`. Else reply `result {ok: true, result: {text, size, mtimeMs}}`, decoding as UTF-8 with replacement characters. |

```ts
// devc/web/files.ts
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Throws FilesError ('forbidden' | 'not_found' | 'bad_request' | 'too_large' | 'binary'). */
export function readProjectFile(
  root: string,
  rel: string,
): Promise<{ text: string; size: number; mtimeMs: number }>;
```

- `FilesError`'s code union gains `too_large` and `binary`.
- `mtimeMs` isn't used by the page yet. It's there so the editing follow-on can refuse a save
  over a newer file.
- Tests: reads a file; refuses `..`, an escaping symlink and a directory; `too_large` just over
  the cap; `binary` for a file with a NUL; invalid UTF-8 decodes with replacement characters.

### Layout (`layout.js`, `lib/layout_state.js`)

- Second component type `'file'`, whose component state is exactly a `FileRef`.
  `fileRefFromState(state)` returns a `FileRef` when all three fields are non-empty strings,
  else `null` (pure, tested beside `paneRefFromState`).
- `Tile` gains `kind: 'pane' | 'file'` and `file: FileRef | null` (`ref` stays the `PaneRef`, and
  is `null` on file tiles). The hooks are unchanged. `app.js` branches on `tile.kind`.
- `add(ref)`, `addBeside(id, ref, where)` and `dragSource(el, ref, title)` accept either a
  `PaneRef` or `{file: FileRef}` and pick the component type from it.
- Saved layouts restore file tiles; on mount the page re-reads the file.

### Page

- **File row click / Enter:** open the file in a file tile, placed with `placeInFocusedStack`.
  If a file tile for the same `FileRef` already exists, focus it instead of opening another.
  Works whether or not the container runs.
- **File row menu:** Open · Open to the right · Open in editor · Open in editor to the right ·
  Copy path. The two "Open in editor" items keep today's behavior and messages.
- **File rows are drag sources** into the layout (as pane rows are), dropping a file tile.
- **File tile:** title is the file name; tooltip is the full host path. While loading, a
  "Loading…" overlay. On `too_large` / `binary` / `not_found` / `forbidden`, an overlay with the
  message and, where the container runs, an "Open in editor" button. Right-click on the tile's
  tab: Reload · Open in editor · Copy path · Close.
- **No stream work:** file tiles never send `open`, `resize`, `input` or `close`.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Then ask the user to check, in their open tab:

1. Click a `.ts`, a `.go`, a `.md` and a `Dockerfile`: each opens in a tile, highlighted, with
   line numbers. Ctrl/Cmd-F searches. Typing does nothing.
2. Click the same file again: the existing tile is focused, not duplicated.
3. Drag a file row onto a tile's edge: it splits there.
4. Stop the container: files still open and read; "Open in editor" says to start it first.
5. A large log (> 2 MiB) and a binary show the message overlay, not garbage.
6. Edit the file on the host, then Reload from the tile menu: the new content shows.
7. Reload the page: file tiles come back with their content.
