# devc-web-menu-groups-reveal

## Checklist

- [x] `openMenuAt` renders dividers: a `null` item is a divider; leading, trailing and repeated dividers are dropped
- [x] `style.css`: `.menu .menu-sep`
- [x] Sidebar and file-tile menus grouped with dividers (groups below); `pathMenuItems` split so its copy items and its open-on-host items land in different groups
- [x] `devc/web/reveal.ts`: `revealCommands(os, path)` and `revealOnHost(path)`, with tests for `revealCommands`
- [x] Protocol: `reveal_path` message (both addressings), parser case, with tests
- [x] Server: `reveal_path` handler, sharing `open_in_code`'s path resolution and confinement
- [x] `hello` gains `hostOs`; the page labels the item by it
- [x] Reveal item in every menu that has **Open in Code**, under the same condition
- [x] `devc/README.md` (devc web, "Files and editing") updated

Two sidebar menu changes in `devc web`:

1. **Dividers.** Context menus can group items with a divider.
2. **Reveal in Finder.** The host's file manager opens with the file or folder selected. The server
   runs on the host, the way `open_in_code` opens VS Code, so the browser and devc-desktop both
   get it.

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Existing touchpoints

- `devc/web/static/app.js`:
  - `openMenu` / `openMenuAt`: the one context-menu renderer (`$menu`, `#menu` in `index.html`).
  - `dirMenuItems`, `fileMenuItems`, `fileTileMenuItems`, `filePinMenuItems`, `pathMenuItems`:
    menus that change.
  - `openInCode`: the model for the reveal call.
  - `LABELS`: holds the new labels.
  - `onHello`: reads `hostOs`.
- `devc/web/static/style.css`: the `.menu` rules (around "Context menu and toasts").
- `devc/web/vscode.ts`: the model for `reveal.ts`. It builds argv only, never goes through a
  shell, never waits, and falls back on `NotFound`.
- `devc/web/protocol.ts`: `open_in_code`'s two shapes and its parser case are the model.
- `devc/web/server.ts`: the `openInCode` handler (container path → `containerToHostPath` →
  `repoFileFor`, confinement like `read_file`), the dispatch at `msg.type === 'open_in_code'`,
  and the `hello` literal sent on connect.

## Concept boundaries

- **Reveal is not Open in Code, and not Open in browser.** Reveal selects the entry in the
  host's file manager; it never opens the file in an app. On Linux the fallback opens the
  containing folder, because there is no portable "select" there.
- **Which paths qualify.** Exactly the ones that get **Open in Code**: a repo path, or a
  container path that a bind mount puts inside one of the project's repos (`pathMenuItems`'
  `inRepo`). A container-only path such as `/usr/lib` has no host file and gets no item.
- **A divider is not an item.** Every existing caller passes `[label, action, danger?, icon?]`
  tuples. `null` is the only new shape. No caller has to change unless it wants dividers.

## Contracts

### Menu dividers (`app.js`)

```js
/** @typedef {[string, () => void, boolean?, Node?] | null} MenuItem  null: a divider */
openMenu(e, items: MenuItem[])
openMenuAt(x, y, items: MenuItem[])
```

Before rendering, drop dividers that are first, last, or directly after another divider. Then a
group built from conditional spreads that comes out empty leaves no stray line. Each divider
renders as `<div class="menu-sep" role="separator"></div>`: a 1px rule in the menu's border
color, with a few px of vertical margin, full width. It takes no hover and no click (a
`mousedown` on it must not close the menu).

### Groups

Separate each group with `null`. A group that comes out empty disappears (see above).

| Menu                | Groups, in order                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileMenuItems`     | Open, Open to the right · Open in editor, Open in editor to the right · Open in browser, Open in Code, Reveal · Copy path, Copy container path · Pin/Unpin file · Rename…, Delete… |
| `dirMenuItems`      | terminal-here / task-here · New file…, New folder… · Open in Code, Reveal · Copy path, Copy container path · Refresh · Rename…, Delete…                     |
| `fileTileMenuItems` | Save, Reload · Open in editor, Open in browser, Open in Code, Reveal · Copy path, Copy container path · Pin/Unpin file · Keep open · Close                 |
| `filePinMenuItems`  | Open to the right, Open read-only · Open in Code, Reveal · Copy path, Copy container path · Rename… · Unpin file                                          |

Split `pathMenuItems(fr, path)` into two functions so the groups can be placed apart:
- `copyPathItems(fr, path)`: the copy items.
- `hostOpenItems(fr, path)`: Open in Code and Reveal, under the existing `inRepo` condition.

Other menus (pane, tile, Layout node, project) may get dividers where a group is evident.
Destructive items (`danger`) go last, behind a divider.

### `devc/web/reveal.ts`

```ts
/** argv lists to try in order; the first whose command exists is spawned. */
export function revealCommands(os: typeof Deno.build.os, path: string): string[][];
/** Spawns the first runnable command without waiting; throws if none can run. */
export function revealOnHost(path: string): void;
```

| `os`      | Commands, in order                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `darwin`  | `['open', '-R', path]`                                                                                                                                                                                              |
| `windows` | `['explorer.exe', '/select,' + path]` (explorer exits 1 on success, so its status is never read)                                                                                                                   |
| other     | `['dbus-send', '--session', '--dest=org.freedesktop.FileManager1', '--type=method_call', '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems', 'array:string:' + fileUrl(path), 'string:']`, then `['xdg-open', dirname(path)]` |

`fileUrl` is `toFileUrl` from `jsr:@std/path`. The fallback order is about `NotFound` only, as in
`openInVSCode`. A `dbus-send` that runs but finds no file manager is not retried. That is
accepted.

### Protocol (`protocol.ts`)

```ts
| { type: 'reveal_path'; id: string; localFolder: string; root: string; path: string }
| { type: 'reveal_path'; id: string; container: string; path: string }
```

The parser follows `open_in_code` field for field. In the repo form `path` may be `''`, which
means the root folder itself.

### Server

`reveal_path` resolves its path exactly as `open_in_code` does, including the errors
`bad_request` (unknown container), `not_mounted`, and the not-in-a-repo case. Factor that
resolution out of `openInCode` rather than copying it. Then it calls `revealOnHost(absPath)` and
replies `result {ok: true, result: {}}`. A throw from `revealOnHost` → `fail(c, id,
'reveal_failed', message)`.

`hello` gains `hostOs: typeof Deno.build.os`.

### Page

- `LABELS.reveal`: `'Reveal in Finder'` when `hostOs === 'darwin'`, `'Reveal in File Explorer'`
  for `'windows'`, else `'Open containing folder'`. It is read when a menu opens, so a reconnect
  that changes nothing still works.
- `revealPath(fr, path)` mirrors `openInCode`: "Start the container first" when a container file's
  container is gone; `errorToast` on failure.

## Verification

- `deno task check` and the web tests pass. New unit tests cover `revealCommands` (each OS), the
  `reveal_path` parser (both forms, bad fields), and the divider trimming. The trimming should be a
  pure function, exported from a `static/lib/` module so `devc/tests/` can test it.
- By hand, on the macOS host: Reveal on a repo file, a repo folder, a repo root row, a container
  file inside a mounted repo, and a pinned file. Finder opens each with the entry selected. A
  container-only path (`/etc/hosts` under Files) shows no Reveal. Menus show dividers, with no
  doubled or edge dividers when conditional items are missing (for example a container file,
  which has no Pin).
