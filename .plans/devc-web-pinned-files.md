# devc-web-pinned-files

- [ ] Server: `~/.config/devc/pinned-files.json` (read/write module, tested)
- [ ] Server: `pinned_files` broadcast, `pin_file` / `unpin_file` / `open_pinned`, with tests
- [ ] Page: a **Pinned** section at the top of the sidebar; rows toggle their editor tile
- [ ] Page: **Pin** / **Unpin** on file rows and file tiles; **New note…** in the section header
- [ ] Page: a keyboard shortcut toggles the first pin
- [ ] `devc/README.md` (devc web section) and `.plans/devc-web.md` protocol section updated
- [ ] Verify (below) and ask the user to try it in their open tab

Ad-hoc notes, kept for later plans, one click away. This is built as **pinned files**: any repo
file can be pinned to a section at the top of the sidebar. Clicking a pin opens the file in the
editor, or closes it again. A "note" is simply a pinned file, usually `.plans/notes.md`, and
**New note…** creates and pins one in a single step.

Closing a pin closes its **tile**, not the editor. The Helix pane keeps running in Herdr, so
reopening it brings back the same buffer, cursor and unsaved edits. That is what makes a toggle
feel like a drawer and not like a relaunch.

Depends on [devc-web-editor](archived/devc-web-editor.md) (`create_file`, Helix). Read the `devc-web`
skill first.

```
PINNED                         +
  notes.md      devc-tools   ●      ← ● = its tile is open
  ideas.md      api
CONTAINERS
  ▾ devc-tools
  …
```

## Concept boundaries

There are already two other "pins" in devc web. Keep all three apart in code, messages and UI
text:

- **Pinned projects** (`pin_project`, `projects.json`'s pinned list) are a project kept in the
  Containers list.
- **Pinning a preview tile** ("Keep open", `preview: false`) turns an italic preview tile into a
  normal one.
- **Pinned files** are this plan. Code names always say `file pin`, `pinned_files` or
  `pinnedFiles`. A bare `pin` is never used. The UI section is titled **Pinned**, its items say
  "Pin file" / "Unpin file", and the tile menu's "Keep open" stays as it is.

Two other boundaries:

- **`open_pinned` vs `open_file` vs `open`.** `open_pinned` reuses the pin's editor pane when it
  is still alive, and only otherwise creates one, as `open_file` does. The page then attaches a
  tile with the ordinary `open`.
- **Server-side, not `localStorage`.** The devc-desktop window and a browser tab have different
  origins, and so different `localStorage`. Pins must be the same in both, so they live in
  `~/.config/devc/`, beside `projects.json` (`devc/projects.ts` is the pattern to follow for
  the read/write module: path constant, tolerant read, atomic write).

## Existing touchpoints

| File                                  | Role                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `devc/projects.ts`                    | Pattern for a `~/.config/devc/*.json` store: `CONFIG_DIR`, tolerant read, atomic write.                            |
| `devc/web/protocol.ts`                | New client messages and the `pinned_files` server message.                                                         |
| `devc/web/server.ts`                  | Handlers. Sends `pinned_files` on connect and to every client after a change. `openFile`/`create_file` are reused. |
| `devc/web/static/app.js`              | The Pinned section, toggle logic, menu items, New note dialog, shortcut.                                           |
| `devc/web/static/lib/layout_state.js` | Finding the tiles that show a given pane (for the toggle's open/closed state).                                     |
| `devc/web/static/style.css`           | The section and its rows.                                                                                          |

## Contracts

### Store: `~/.config/devc/pinned-files.json`

```ts
// devc/web/pinned_files.ts
export const PINNED_FILES_PATH: string; // `${CONFIG_DIR}/pinned-files.json`
export interface FilePin {
  /** Stable id, generated at pin time (crypto.randomUUID()). */
  id: string;
  /** The project (its host `localFolder`) the file belongs to. */
  localFolder: string;
  /** The repo folder `path` is relative to (as in `open_file`'s `root`). */
  root: string;
  path: string;
  /** Shown instead of the basename when set. */
  label?: string;
  /** The editor pane last opened for it: a hint, checked before use. */
  last?: { containerId: string; paneId: string };
}
export interface PinnedFilesFile {
  version: 1;
  pins: FilePin[];
}
export function readPinnedFiles(): Promise<FilePin[]>; // missing or unreadable file → []
export function writePinnedFiles(pins: FilePin[]): Promise<void>; // atomic (temp + rename)
```

- Pins are repo files only (host paths), so they survive container rebuilds. Files outside the
  bind mount (the container's Files node) can't be pinned. The Pin item is absent there.
- Pinning the same `(root, path)` twice is a no-op that returns the existing id.

### Server → browser

`{type: 'pinned_files', pins: {id, localFolder, root, path, label?}[]}`. It is sent on connect
and after every change, to every client. `last` is never sent to the page.

### Browser → server

| Message       | Fields                                        | Server does                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin_file`    | `id`, `localFolder`, `root`, `path`, `label?` | `localFolder` must be a listed project and `root` one of its repo folders, else `bad_request`. `confine(root, path)` must succeed (the file exists), else `forbidden`/`not_found`. Appends the pin and replies `{pin: string}` (its id).                                                                                                                   |
| `unpin_file`  | `id`, `pin`                                   | Removes it. An unknown id is `not_found`. The editor pane is left alone.                                                                                                                                                                                                                                                                                   |
| `rename_pin`  | `id`, `pin`, `label`                          | Sets the label, or clears it when `label` is `''`.                                                                                                                                                                                                                                                                                                         |
| `open_pinned` | `id`, `pin`                                   | Finds the pin's running container (by `localFolder`), else `code: "not_running"`. If `last` names that container and `paneId` is in its session's current pane list, replies `{pane_id, tab_id, reused: true}`. Otherwise it creates the editor pane as `open_file` does (`root` + `path`), stores `last`, and replies `{pane_id, tab_id, reused: false}`. |

The reuse check uses the pane list the server already keeps per session (the same state that
feeds the pane rows). It never runs a new Herdr query per click.

### Page

- **Pinned section**, above Containers, always shown. It is collapsible, and its open state is
  saved under `SIDEBAR_KEY` like the other sections. Rows show the label or basename, the
  project name dimmed, and a dot while a tile shows the pin's pane.
- **Click toggles:**
  - If any tile shows the pin's pane, close those tiles (tiles only; never `pane.close`).
  - Otherwise send `open_pinned` and attach a **non-preview** tile in the focused stack. If the
    pane is already visible somewhere, focus it instead of adding a second tile.
  - The page keeps a `pin id → pane_id` map from `open_pinned` replies, to know which tiles
    belong to a pin.
- **Stopped container:** on `not_running`, open the file read-only in a file tile (the existing
  viewer, host-side `read_file`), and show a toast offering **Start** (the existing
  `start_project`). Notes stay readable while the container is down.
- **Row menu:** Open to the right · Open read-only · Rename… · Copy path · Unpin file.
- **Pin file / Unpin file** items on repo file rows (`fileMenuItems`) and file tile menus
  (`fileTileMenuItems`), and on editor tiles that came from a pin.
- **New note…** (the section header's **+**): a small `<dialog>` with a project select and a
  path field. The path is prefilled with `.plans/notes.md` when that project's repo has a
  `.plans/` folder, else `NOTES.md`. Submitting sends `create_file` (treating `exists` as fine:
  the file is pinned as it is), then `pin_file`, then toggles it open. A missing parent folder
  is reported, not created.
- **Shortcut:** toggles the first pin. Use Ctrl+Alt+N (Cmd+Alt+N on macOS) unless Step 0 of
  [devc-web-editor](archived/devc-web-editor.md) found it taken. Handle it in the page's capture-phase
  key handler so it works while a terminal has focus, and swallow it there. Record it in the
  README.

**Not in this plan:** reordering pins by drag (pins keep their pin order), pins outside the
bind mount, a slide-over drawer tile (a later change if the stack tile feels wrong), syncing
notes anywhere.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc && deno task check && deno task test
cd .. && deno fmt --check
```

Unit tests cover the store (missing file, corrupt file, atomic write, duplicate pin), the
parsers, and `open_pinned`'s reuse decision (`last` alive, dead, or in another container).

Then ask the user to check, in their open tab and in the devc-desktop window:

1. **New note…** on devc-tools creates `.plans/notes.md`, pins it, and opens Helix.
2. Type something without saving, then click the pin: the tile closes. Click it again: the
   same unsaved text is there.
3. The shortcut toggles it from inside a focused terminal.
4. Reload the page: the pin is still there, and toggling it reuses the same pane.
5. The browser tab and the desktop window show the same pins.
6. Stop the container: the pin opens read-only and offers Start.
