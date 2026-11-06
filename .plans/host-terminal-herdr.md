# devc-desktop: host terminals on a Herdr session, one terminal for both apps

Decided with the user on 2026-11-06. Runs after `host-terminal-themes` (host terminals themed
like devc web, in a host theme of their own) and before anything else on terminals. Absorbs the
`terminal-shared-surface` plan (superseded, archived): with host terminals on Herdr, both apps
draw their terminals with devc web's `renderer.js`, so what that plan shared at the xterm.js level
is shared here at the Herdr-terminal level instead.

Prerequisite: the copy-on-select change (the viewer's in `viewer.js`; host terminals'
`copy_select.ts` and `hostPermission`) is committed. This plan deletes `copy_select.ts` and keeps
`hostPermission` (host pages still write the clipboard).

## Checklist

- [ ] Step 0: measurements (below), recorded in this plan before any code.
- [ ] Main process: a Node Herdr client for the app's `devc-desktop-<12 hex>` session
      (`src/main/herdr.ts`): find `herdr`, check the bridge, start the session, create, list,
      close and control panes.
- [ ] No Herdr, or an unsupported one: the host terminal is refused with a reason, as under a
      debugging switch.
- [ ] `devc/web/static/term_mouse.js`: `tiles.js`'s `attachMouse` moved out, with hooks;
      `tiles.js` uses it, container terminals unchanged.
- [ ] `renderer.js`: a `colors` option and `setColors`, for the host theme.
- [ ] `devc-desktop/src/renderer/host_terminal.ts`: one host terminal (renderer, mouse, wheel,
      paste bar, shortcuts) used by both `host.ts` and `slot.ts`. node-pty, `@xterm/xterm`,
      `@xterm/addon-fit`, `@xterm/addon-serialize`, `copy_select.ts` and the move replay IPC are
      gone.
- [ ] Close releases a pane; Close terminal… (after a confirmation) closes it in Herdr. Panes
      outlive the app; saved layouts reattach them; Restore Host Tiles reopens panes no view
      shows.
- [ ] One menu: `hostMenuEntries` in `policy.ts`, one builder in `main.ts` for the drawer and host
      tiles.
- [ ] Copy (drag through Herdr, Shift+drag local) and the paste bar work over Herdr.
- [ ] `cd` items read the pane's folder and busy state from Herdr.
- [ ] Links: Cmd+click (Ctrl+click off a Mac) on a URL opens the system browser (host views'
      `lockDownBundled` get `external: true`); on a file path, devc web's viewer through
      `/main`'s `open-host-file` and a new `locate_host_file`.
- [ ] `desktopSessionName`, with a test that it can never equal a `hostSessionName`.
- [ ] Tests, `devc-desktop/README.md` (host terminal, host tiles, requirements, security sections),
      `devc/README.md` (`open-host-file`).

## Goal

Host terminals get container terminals' semantics and code. A shell is a Herdr pane in a session
of the app's own; closing its tile only lets go of it, and Close terminal… ends it. Shells survive
quitting the app, and moving one between the drawer and `/main` is reattaching the same pane. Both
apps' terminals are `renderer.js` driven by one mouse module, so a terminal feature is written
once, and the drawer and host tiles are one module with one menu, so neither falls behind the
other again (the tile's split items arrived a day after the drawer's). Herdr gives the pane's
folder, so file paths in a host terminal open in devc web's viewer.

## Decisions

- **D1: one Herdr session, `devc-desktop-<12 hex>`.** The 12 hex are the first 12 of the SHA-256
  (hex, lowercase) of the app's `app.getPath('userData')`, so an installed app and a dev build
  with another `userData` each have their own session; computed by `desktopSessionName(userData)`
  in `policy.ts`. Started by the app with `herdr --session <name> server`, detached, in the home
  folder, as `env_host.ts` starts a host project's session (`START_SESSION_TRIES` ×
  `START_SESSION_WAIT_MS` polling `herdr session list --json`).
  - **It cannot clash with a project's session.** `hostSessionName(base, folder)` is always
    `<base>-<slug>-<8 hex>` or `<base>-<8 hex>`: its 9th character from the end is `-`. In
    `devc-desktop-<12 hex>` it is a hex digit, whatever devc web's `--session` base and whatever
    the folder (`/x/desktop` gives `devc-desktop-<8 hex>`, a different name). Nor is it a plain
    word a person names a session by hand.
  - devc web never connects to it: it finds host sessions only by the exact names it computes.
    This is no new reach: devc web's server without `--live-yolo` is trusted and only names
    sessions it computes from project folders; under `--live-yolo` its code can already run
    anything as the user (README, "What it does not protect against").
- **D2: Herdr is required.** `herdr` is looked up on a login shell's PATH (devc-desktop started
  from Finder has a bare one), as `env_host.ts`'s `HostShell` does. Not found, or
  `herdr --session <name> remote-api-bridge --check` not printing exactly
  `herdr-api-bridge-v1` with exit 0: the host terminal is refused through the existing `refused`
  path, with `The host terminal needs Herdr: <reason>` (`herdr was not found on your login
  shell's PATH` / `herdr <version> has no remote-api-bridge`).
- **D3: the app has its own Node Herdr client.** devc web's (`herdr_bridge.ts`,
  `controllers.ts`) is Deno code on its `Environment`; the app reimplements the parts it needs in
  `src/main/herdr.ts` with `node:child_process`, following those files and `.plans/devc-web.md`
  § Background: one request per `remote-api-bridge` connection; `createShell`'s `tab.create` with
  the `workspace.create` fallback; `pane.close`; `pane.get`; `pane.selection.read` (as
  `server.ts`'s `read_selection`: `pane.get`'s scroll position, then `toTextPoint`); and one
  `terminal session control <pane> --takeover` per attached view, released with
  `terminal.release`. Every Herdr process is an argv spawn, never a shell string, never a pty.
- **D4: one Herdr terminal in both apps.**
  - **Drawing:** `renderer.js`, bundled into the app as `layout.js` is. It stays the only module
    importing xterm.js; the app's own `@xterm/*` dependencies go.
  - **Mouse:** `tiles.js`'s `attachMouse` moves to `devc/web/static/term_mouse.js` (contract
    below) and both apps call it. Wheel: `renderer.onWheel` → `wheelToScroll` (`lib/input.js`) →
    `terminal.scroll`, as `tiles.js`.
  - **Host theme:** `renderer.js`'s colors come from the page's hash theme and mode
    (`termOptions`). A host page has no hash theme: its colors are the host theme's, which the
    main process computes and sends (`host-term:color`, `host-terminal-themes`' D3,
    `{theme, minimumContrastRatio}`). `createRenderer` gains `colors?: {theme,
    minimumContrastRatio}`; when given, it uses them instead of `termOptions()` and ignores
    `devc-theme` events. `setColors(colors)` replaces both outright, as `onTheme` does.
  - Frames and commands go page ↔ main over the host preload's IPC (below). The page never runs
    Herdr itself.
- **D5: one host terminal module.** `host_terminal.ts` builds a host terminal in an element for a
  pane id (or a new pane): renderer, `attachTerminalMouse`, wheel, keyboard (`renderer.onData` →
  `terminal.input`), resize (`renderer.resize()` → `terminal.resize`), the multi-line paste bar
  (accepted text as one `terminal.input`, as `tiles.js` sends a paste), and `onHostShortcut` for
  the split shortcuts. `host.ts` (the drawer's tiling) and `slot.ts` (one tile) only place it.
  `slot.ts` skips the `close` shortcut, as today; the drawer does not.
- **D6: lifetime and wording**, as devc web's terminal tiles (`menus.js`: **Close**, then
  `LABELS.close` = **Close terminal…**):
  - **Close** (the drawer's tab ×, its menu's Close and shortcut; devc web's × on a host tile, and
    a host tile's own menu's Close) releases the pane; it keeps running.
  - **Close terminal…** (both menus, and the drawer tab's trash button, tooltip
    `Close terminal…`) asks first, then closes the pane in Herdr (`pane.close`). The question is a
    native dialog from the main process (the pages are granted no dialogs), in devc web's words:
    `dialog.showMessageBox(win, {type: 'warning', message: 'Close terminal "<label>"? Its process
    ends.', buttons: ['Close terminal', 'Cancel'], defaultId: 1, cancelId: 1})`, `<label>` being
    the tile's title as its tab shows it. A host tile in `/main` gets no trash button: devc web's
    page draws that tab and must not be able to end a host shell.
  - **Quitting the app** releases every pane. On the next start the drawer's saved layout and
    devc web's saved host tiles reattach their panes by pane id; a pane Herdr no longer has gives
    an empty tile with `[pane gone]`.
  - **Restore Host Tiles** (View menu, today's item) reopens, as drawer tiles, every pane of the
    app's session that no drawer tile and no host tile shows.
- **D7: moving a shell** between the drawer and `/main` releases the pane in one view and attaches
  it in the other. `@xterm/addon-serialize`, `host-term:detach`, `host-term:detached`,
  `host-term:adopt` and a host tile's `replay` are removed.
- **D7a: the drawer's Actions column is unchanged** (`devc-desktop-host-actions.md`; since
  `ba5f3ae7` a push request opens a closed drawer without focus). Opening the drawer by any route,
  a request included, with no tiles makes one tile on a new pane, as it makes one shell today;
  attaching it never takes focus, so keys still go to devc web. With Herdr refused (D2), the
  drawer still opens and its Actions column works; only its tiles show the refusal.
- **D8: one menu.** The drawer's and a host tile's menus differ only in the move item; both come
  from `hostMenuEntries(where)` (below).
- **D9: copy and paste**, as container terminals: a plain left-drag goes to Herdr as cells and its
  text is read with `pane.selection.read`, then written with `navigator.clipboard.writeText`;
  Shift+drag is xterm.js's local selection, copied on mouseup (`renderer.selection()`). Both are
  in `term_mouse.js`.
- **D10: `cd` items** take the pane's folder (`foreground_cwd`, else `cwd`) and its busy state
  from Herdr (step 0 decides the field). They are typed with `terminal.input`, keeping today's
  Ctrl+E Ctrl+U prefix and the recheck before typing.
- **D11: links.** `createRenderer`'s link provider (`lib/links.js`) underlines URLs and paths in
  host terminals too; `term_mouse.js` catches Cmd/Ctrl+click on mousedown, in the capture phase,
  so it works while an app has mouse reporting on (vim with `mouse=a`).
  - **URL:** `window.open(url, '_blank', 'noopener,noreferrer')`. The host views'
    `lockDownBundled` get `external: true`, which sends an http(s) `window.open` to
    `shell.openExternal` (`externalUrl`) and denies everything else.
  - **Path:** resolved against the pane's folder (`resolvePath`) into an absolute host path, sent
    to the app (`host-term:open-file`), which sets `/main`'s `open-host-file`. `/main` sends
    `locate_host_file`; the server opens it only inside a project's repos (`repoFileFor`, then
    `confine`), as `locate_file` does after mapping a container path; otherwise the page shows
    `Can't open <path>: <message>`. devc web's page learns only paths the user clicked, which it
    may read already.
  - **OSC 8 hyperlinks:** step 0 checks whether Herdr's frames carry them. If they do,
    `createRenderer` gains `openUrl?: (url) => void` and sets xterm.js's `linkHandler` to call it
    for `http:`/`https:` only when `linkModifier(ev)` (no `confirm()`), in both apps. If not,
    record it and leave them out.

## Step 0: measure first

On macOS with Herdr 0.9.5 (or newer), from a Node script spawning `herdr` as `herdr.ts` will:

1. `herdr --session <name> server` (the D1 name) started detached by a Node parent: does the
   server outlive the parent (quit the parent, list sessions)? If not, record what does (e.g.
   `detached: true` plus `unref()`, or `setsid`), and use that.
2. Frame latency through `terminal session control` → Node → IPC → page, typing in a shell:
   record the median keystroke-to-paint time against today's node-pty drawer.
3. `pane.get`: which field gives the foreground process (for D10's busy check). If none does, use
   `ps -o stat=,comm= -t <tty>` on the pane's tty, a process whose `stat` contains `+` being the
   foreground one, and record the field that gives the tty.
4. `cd` typed with `terminal.input` lands at the prompt in zsh and bash.
5. `printf '\e]8;;https://example.com\e\\link\e]8;;\e\\\n'` in a pane: does the frame carry the
   OSC 8 sequence (D11)?

Record results here; if 1 cannot be made to hold, stop and ask the user.

## Contracts

### `devc/web/static/term_mouse.js`

```js
/**
 * Mouse handling for a Herdr-driven terminal (moved from `tiles.js`'s `attachMouse`, same
 * behavior): right-click → `contextMenu`; Cmd/Ctrl+click on a link → `openLink`; Shift+drag →
 * xterm.js's local selection, copied on mouseup; any other press, drag and release →
 * `mouse` as cells (drags throttled by DRAG_INTERVAL_MS), and a plain left-drag's range copied
 * through `copyRange`, flashed unless a frame arrived during the drag.
 * @param {HTMLElement} termEl
 * @param {import('./renderer.js').Renderer} renderer
 * @param {{
 *   mouse(cmd: {action: 'down'|'up'|'drag', button: 'left'|'right'|'middle',
 *               column: number, row: number}): void,
 *   copyRange(anchor: {column: number, row: number}, cursor: {column: number, row: number}): void,
 *   openLink(link: import('./lib/links.js').Link): void,
 *   contextMenu(ev: MouseEvent): void,
 *   frames(): number,
 *   linkModifier(ev: MouseEvent | KeyboardEvent): boolean,
 * }} hooks
 * @returns {() => void} dispose
 */
export function attachTerminalMouse(termEl, renderer, hooks) {}
```

`DRAG_INTERVAL_MS`, `COPY_FLASH_MS` and `cellAt` move with it. `tiles.js` keeps `copySelection`,
`openLink` and its menu, passed as hooks; its `keepTileOpen` call goes inside its `openLink` hook.

### `renderer.js`

`createRenderer(element, {linkHint, linkModifier, colors?, openUrl?})`; `Renderer` gains
`setColors(colors: {theme: Record<string, string>, minimumContrastRatio: number}): void` (a no-op
without `colors`). Unchanged for devc web, which passes neither.

### IPC (host preload, both pages)

| Channel                    | Direction   | Payload                                          |
| -------------------------- | ----------- | ------------------------------------------------ |
| `host-term:attach`         | page → main | `paneId: string \| null` (null: a new pane)      |
| `host-term:attached`       | main → page | `{paneId, cwd}`                                  |
| `host-term:frame`          | main → page | `paneId`, Herdr's `frame` message, unchanged     |
| `host-term:command`        | page → main | `paneId`, a `TerminalCommand` (`controllers.ts`) |
| `host-term:read-selection` | page → main | `paneId`, `anchor`, `cursor` → `string`          |
| `host-term:release`        | page → main | `paneId`                                         |
| `host-term:end`            | page → main | `paneId`, `label` (asks, then closes)            |
| `host-term:open-file`      | page → main | `{path, line?, column?}`                         |

The main process accepts a `paneId` only if it is in the app's session's last pane list, and
from the view it attached it to (a host tile: only its own pane). `start`, `input`, `resize`,
`close`, `detach`, `detached`, `adopt` and their node-pty plumbing are removed.

### Menus

`policy.ts`:

```ts
export type HostMenuEntry =
  | 'split-right'
  | 'split-below'
  | 'new-tab'
  | 'separator'
  | 'cd'
  | 'move'
  | 'close'
  | 'close-terminal';
export function hostMenuEntries(where: 'drawer' | 'slot'): HostMenuEntry[];
// both: ['split-right','split-below','new-tab','separator','cd','separator','move',
//        'separator','close','close-terminal']
```

`main.ts` has one builder mapping entries to `MenuItemConstructorOptions`, used by the
`host-term:context-menu` handler for both views. Labels:

| Entry          | Drawer                               | Host tile                                                                                   |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| split-right    | Split vertically                     | Split vertically                                                                            |
| split-below    | Split horizontally                   | Split horizontally                                                                          |
| new-tab        | New terminal in this stack           | New terminal in this stack                                                                  |
| cd             | `cdItems`                            | `cdItems`; none (and no separator) once the pane is gone                                    |
| move           | Move to Main Area (enabled as today) | Move to Bottom Panel (enabled as today)                                                     |
| close          | Close (the `close` shortcut shown)   | Close (devc web's tab closes: the app sets `/main`'s `host-gone=<slot id>`, as a move does) |
| close-terminal | Close terminal…                      | Close terminal… (disabled once the pane is gone)                                            |

Split accelerators shown with `registerAccelerator: false`, as today.

### `/main`'s hash: `open-host-file`

`#…&open-host-file=<encodeURIComponent(absolute host path)>[&open-line=<n>[&open-column=<n>]]`,
set only by the app, on `/main` only, as `host-slot`. devc web reads it (`hostOpenFromHash` in
`lib/view.js`, beside `hostPlacementFromHash`; called from `main-page.js`), removes it from the
hash, and sends `locate_host_file`.

### devc web: `locate_host_file`

```ts
| { type: 'locate_host_file'; id: string; path: string }
```

Not tied to a container session. The server tries every project in `projectsMessage().projects`,
first `repoFileFor(projects, p.localFolder, path)` that is not null, then `confine`. Replies as
`locate_file`: `{localFolder, root, path}`, or `forbidden` (`<path> is outside every project's
repos`), `not_found` (`<path> does not exist` / `<path> is not a file`), `bad_request` (not
absolute). The page then calls `openFileAt(file, line, column)`.

## Validation

- [ ] Step 0's results are written in this plan.
- [ ] `cd devc-desktop && npm run check && npm test`, including new `tests/herdr.test.ts`:
      request framing (one id per connection, error codes to `BridgeError`-like errors, a reply
      for another id ignored), the bridge check (`herdr-api-bridge-v1` exact), and the IPC pane-id
      guard (a pane not in the list, or another view's, refused).
- [ ] `policy.test.ts`: `hostMenuEntries('drawer')` and `hostMenuEntries('slot')` equal the list
      above; `desktopSessionName('/Users/a/Library/Application Support/devcd')` matches
      `^devc-desktop-[0-9a-f]{12}$`, is the same on every call, differs for another `userData`,
      and its 9th character from the end is not `-`.
- [ ] `cd devc && deno task test`, including: every `hostSessionName` (bases `devc` and
      `devc-desktop`, generated folders and `/x/desktop`) has `-` as its 9th character from the
      end, the property D1 relies on; `locate_host_file` opens a file in a host project's repo and
      one in a container project's bind-mounted repo, refuses `/etc/hosts` and a symlink out of a
      repo (`forbidden`), a missing file (`not_found`) and a relative path (`bad_request`);
      `hostOpenFromHash` parses and drops the three parameters.
- [ ] `deno check` / `deno lint` / `deno fmt --check` on touched devc web files.
- [ ] `grep -rn "node-pty\|@xterm/" devc-desktop/src devc-desktop/package.json devc-desktop/build.mjs`
      finds nothing.
- [ ] `grep -rn "new Terminal(" devc/web/static devc-desktop/src --include=*.js --include=*.ts | grep -v vendor`
      matches only `renderer.js`.
- [ ] `grep -n "attachTerminalMouse(" devc/web/static/tiles.js devc-desktop/src/renderer/host_terminal.ts`
      matches once in each; `grep -n "function attachMouse" devc/web/static/tiles.js` finds nothing.
- [ ] `grep -n "Split vertically" devc-desktop/src/main/main.ts` matches once; `grep -rn "End Shell"
      devc-desktop/src devc-desktop/README.md` finds nothing.
- [ ] `test ! -e devc-desktop/src/renderer/copy_select.ts`.
- [ ] `cd devc-desktop && npm run build:mac` succeeds.
- [ ] Real app, macOS:
  - [ ] Herdr renamed away from PATH: the drawer shows `The host terminal needs Herdr: herdr was
        not found on your login shell's PATH`; New Host Tile is refused the same way.
  - [ ] `herdr session list` shows one `devc-desktop-<12 hex>` session; a new drawer tile and a
        new host tile each make a pane in it (`herdr --session <it> pane list` shows them).
  - [ ] `host-terminal-themes`' real-app checks still pass (light and dark, a host theme change,
        Same as Theme following View → Theme), now through `renderer.js`.
  - [ ] Close a tile: the pane is still listed; Restore Host Tiles brings it back with its screen.
        Close terminal…: the dialog reads `Close terminal "<title>"? Its process ends.`; Cancel
        keeps it; Close terminal removes the pane from the list. The drawer tab's trash button
        does the same.
  - [ ] Both menus show exactly the table's items; each works.
  - [ ] Quit the app with a running `top` in a tile; start it again: the tile shows `top` still
        running.
  - [ ] Move to Main Area and back: the same pane id, the screen intact.
  - [ ] Drag-select copies; Shift+drag copies; a two-line paste shows the paste bar.
  - [ ] `echo https://example.com/a_(b)`: Cmd/Ctrl+click opens it in the system browser; a plain
        click does not. The same inside `vim` with `:set mouse=a`, without vim moving its cursor.
  - [ ] `cd /tmp && echo ../etc/hosts`, and `echo README.md:3` in a project repo: Cmd/Ctrl+click
        on the repo file opens it in devc web's viewer at line 3; on `../etc/hosts` devc web shows
        `Can't open /etc/hosts: … outside every project's repos`.
  - [ ] The OSC 8 line from step 0 (if Herdr carries it): Cmd/Ctrl+click on `link` opens it; a
        plain click does nothing.
  - [ ] The `cd` items: correct folder; disabled while `vim` runs.
  - [ ] Split shortcuts work in the drawer and a host tile.
  - [ ] A push request from devc web with the drawer closed opens it, with one new pane, while
        typing continues in devc web; the confirm works. With Herdr renamed away from PATH, the
        same request opens the drawer and its confirm works.
  - [ ] devc web's Projects list does not show the app's session.
- [ ] Real devc web, a container terminal (regression): click, drag (copied, flashed), Shift+drag
      (copied), right-click menu, wheel scroll, Cmd/Ctrl+click on a URL and on a repo file path;
      themes and light mode as before.

## Relevant Files

- `devc-desktop/src/main/herdr.ts` (new)
- `devc-desktop/src/main/pty.ts` (`HostPtys` and node-pty removed; `accountShell`/`hostShell` stay
  if the login-shell PATH lookup uses them, else the file is deleted)
- `devc-desktop/src/main/main.ts`
- `devc-desktop/src/main/policy.ts`
- `devc-desktop/src/preload/host.ts`
- `devc-desktop/src/renderer/host_terminal.ts` (new)
- `devc-desktop/src/renderer/host.ts`, `host.html`
- `devc-desktop/src/renderer/slot.ts`, `slot.html`
- `devc-desktop/src/renderer/copy_select.ts` (deleted)
- `devc-desktop/src/renderer/devc-web.d.ts` (`renderer.js`, `term_mouse.js`, `lib/input.js`,
  `lib/links.js`)
- `devc-desktop/package.json`, `devc-desktop/package-lock.json` (drop `node-pty`, its
  `files`/`asarUnpack` entries and allow-scripts entry, `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-serialize`, the `rebuild` script and `@electron/rebuild`)
- `devc-desktop/build.mjs` (`node-pty` in `external`; `xterm.css` copied from devc web's
  `vendor/xterm/` instead of `node_modules`)
- `devc-desktop/tests/herdr.test.ts` (new), `devc-desktop/tests/pty.test.ts` (deleted, or trimmed
  to what stays in `pty.ts`), `devc-desktop/tests/policy.test.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/term_mouse.js` (new)
- `devc/web/static/renderer.js`
- `devc/web/static/tiles.js`
- `devc/web/static/lib/view.js` (`hostOpenFromHash`)
- `devc/web/static/main-page.js`
- `devc/tests/web_server_test.ts` (`locate_host_file`), `devc/tests/web_host_env_test.ts`
  (`hostSessionName`), `devc/tests/web_layout_test.ts` (`hostOpenFromHash`)
- `devc-desktop/README.md`
- `devc/README.md`
- `.plans/PLAN.md`
