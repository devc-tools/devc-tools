# devc-desktop: host tiles drawn in devc web's page

A host tile's terminal is drawn by devc web's `/main` page itself, inside the tile, instead of by a
separate app view laid over a placeholder. The page reaches the tile's Herdr pane through a new
preload that only `/main` views get, and the main process checks every call as it does for the
drawer today. The overlay machinery goes: the placeholder-rectangle lines, slot views, hiding
during drags, menus and dialogs, and the half-second input pause. Host tiles then behave like
any tile, including moving to tile windows (`devc-desktop-tile-windows`, archived).

Why this is acceptable: the separate view guarded only against devc web's page being taken over
by content it renders (a sanitizer or library bug). It never guarded against the code itself,
since the page under `devc2` and the app are both built from the same agent-written checkout. The host terminal already runs devc web's renderer and xterm on
container-influenced output. The
page's defenses (allowlist sanitizers, CSP with no inline script or eval, sandboxed previews)
stay. **Host shell I/O goes only through the preload to the main process, never through devc
web's server**, so the page token never becomes a key to a host shell.

Unchanged: the drawer (its own bundled view, `host.html`), host actions and their confirm cards,
the Containers pane, the overlay menu, `/sidebar` (no preload), the host status strip,
`POST /desktop/host-tiles`, `--live` handling (`livePage` and what it gates), and the debugging
switches turning the host terminal off.

Out of scope: retiring `--live` modes; moving the drawer into the page.

## Checklist

- [ ] `devc/web/static/host-terminal.js` and `devc/web/static/lib/term_colors.js`, moved from
      devc-desktop's `host_terminal.ts` and `term_colors.ts` (TypeScript types become JSDoc);
      the drawer imports them through the `devc-web/` alias
- [ ] `devc/web/static/lib/host_keys.js`: `hostShortcut` and `HOST_SHORTCUTS` moved from
      `policy.ts`, which re-exports both
- [ ] `devc-desktop/src/preload/devc.ts`: `window.devcHost`; built by `build.mjs` as
      `preload-devc.js`; set on `/main` views only (the primary `devcView` and each tile window's)
- [ ] Main process: the slot model without views, the `/main` sender check, the IPC channels
      accepting `/main` senders, frames and colors to the attached page
- [ ] Main process: delete the overlay machinery (list below)
- [ ] devc web: a host tile mounts the terminal when `window.devcHost` exists, else the
      placeholder as today; the overlay console lines go
- [ ] Tile windows: host tiles move (`{host}` drag payload); **Move to Bottom Panel** reaches
      the window that has the tile
- [ ] Delete `src/renderer/slot.html`, `slot.ts`, `slot.css` and their `build.mjs` entries
- [ ] Tests: `policy.test.ts` (sender check, keys re-export), `web_view_test.ts` (`{host}`
      payload), a new `devc/tests/web_host_keys_test.ts`
- [ ] Docs: `devc-desktop/README.md` (**Host tiles**, **Why devc web cannot reach it**, **Tile
      windows**), `devc/README.md` (the `host-slot` paragraph), header comments of
      `host-slots.js` and `preload/host.ts`
- [ ] Mac apps rebuilt (`npm run build:mac` in `devc-desktop/`)

## Contracts

### `window.devcHost` (`src/preload/devc.ts`)

Exposed with `contextBridge.exposeInMainWorld('devcHost', …)` on `/main` views only. Every
method sends on an existing `host-term:*` channel unless noted. Arguments are coerced as
`preload/host.ts` coerces them (`String(id)`).

| Method                                      | Channel (kind)                          | Notes                                                                                                                                |
| ------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `slotInfo(slot)`                            | `host-term:slot-info` (invoke, **new**) | → `{user, host, refused, pane, color}`, as `host-term:info` answers a slot view today; `pane` null when the slot is unknown or ended |
| `attach(paneId, cols, rows)`                | `host-term:attach` (invoke)             |                                                                                                                                      |
| `paneCommand(paneId, cmd)`                  | `host-term:pane-command` (send)         |                                                                                                                                      |
| `readSelection(paneId, anchor, cursor)`     | `host-term:read-selection` (invoke)     |                                                                                                                                      |
| `release(paneId)`                           | `host-term:release` (send)              |                                                                                                                                      |
| `contextMenu(paneId)`                       | `host-term:context-menu` (send)         | the app's host tile menu (split, `cd`, Move to Bottom Panel, Close terminal…)                                                        |
| `openFile(file)`                            | `host-term:open-file` (send)            |                                                                                                                                      |
| `command(slot, name)`                       | `host-term:slot-command` (send)         | now takes the slot id first; `name` is `split-right`, `split-below` or `new-tab`                                                     |
| `pasteGuard()`                              | `host-term:paste-guard` (invoke)        |                                                                                                                                      |
| `onFrame`, `onClosed`, `onPanes`, `onColor` | the same receive channels               |                                                                                                                                      |

`create`, `unshown`, `hide`, `dragDrawer`, `end`, the actions channels, `onRemove`, `onAdopt`,
`onShown` and `onGuard` are **not** exposed: they stay the drawer's.

### Main process

**Senders.** A **`/main` sender** is an IPC event whose `e.sender` is `devcView.webContents` or
a tile window's view's `webContents`, from its main frame, with a URL whose origin is devc web's
current `origin`. Write the URL part as `devcMainUrl(url, origin)` in `policy.ts`: true when
`url`'s origin equals `origin` and its pathname is `/main` or `/safe/main`. `/sidebar`,
`/host-status` and `/containers` are never `/main` senders.

**Slots** keep `id`, `pane` and `ended`, and gain `wc: WebContents | null`, the `/main` page
attached to the pane, and `detachedAt: number`, when it was last let go (0 while attached).
They lose `view`, `line`, `shown`, `seenAt` and `focusOnShow`. `makeSlot(id, pane)` makes no
view.

**`mayUse(e, id)`**, for a `/main` sender: `id` must be the `pane` of a slot that is not ended.
The drawer's rule (`fromHost`, and a pane no slot has) is unchanged.

**`host-term:slot-info`** from a `/main` sender for slot `s`:

- If `s` is a slot, answer it.
- Else, if `savedSlots` has `s` (a host tile restored from a saved layout), and `refusal` is null,
  and no slot has its pane, make the slot. This is the rule `slotLine` applies today.
- Else answer with `pane: null`.

**Attaching:** `host-term:attach` sets the slot's `wc` to the sender and `detachedAt` to 0, as
`attachments` records it today. A takeover from another page replaces the last one, as now. Each
of these sets `wc` to null and `detachedAt` to now:

- `host-term:release`;
- the attached webContents navigating to a new document;
- the attached webContents being destroyed.

**Ended:** a pane closing (`closed`) marks its slot ended. The slot goes once its page releases
it or the page goes.

**Restore Host Tiles:** a slot is **lost** when it is not ended, `wc` is null, and
`now - detachedAt >= 2000`. The 2 s covers a page reload and a tile moving between windows.
**Restore Host Tiles** and the item's enabled state use this rule. Everything else about restore
is unchanged.

**Colors:** `host-term:color` goes to every attached slot's `wc` as well as to the drawer, on
every host color or mode change.

**Move to Bottom Panel and Close:** the `host-gone=<slot>` hash goes to the view whose
webContents is the slot's `wc`, by `setMainHash` for the primary and `setViewHash` for a tile
window. With no `wc`, it goes to the primary. **New Host Tile**, **Move to Main Area** and
**Restore Host Tiles** still add tiles to the primary.

**Context menu:** `host-term:context-menu` from a `/main` sender for its slot's pane opens
`hostMenu(slot, pane)`, as from a slot view today.

**Slot commands:** `host-term:slot-command (slot, name)` from a `/main` sender runs
`slotCommand` for that slot, when the slot is not ended and `name` is one of the three. The new
tile goes beside it (`host-at`, `host-where`) in the sender's own view. That is the primary via
`setMainHash`, or a tile window via `setViewHash`.

**Deleted** (each is used only by the overlay):

- in `main.ts`: `slotLine`, `applySlots`, `scheduleSlots`, `setShown`, `restackSlots`,
  `resetSlotLines`, `slotDrag`, `slotOverlay`, `coverChanges`, `muted`, `setMuted`,
  `SLOT_URL`, `slotOf`, and the `host-term:guard` channel;
- the muting half of `watchPresses`. Its focus and menu-closing half stays for the other views;
- in `policy.ts`: `parseSlotLine`, `placeSlot`, `SLOT_MIN_WIDTH`, `SLOT_MIN_HEIGHT`,
  `COVER_MS`, `recentChanges`, `ambiguousPress`, and their tests;
- `devcDialog`'s call to `restackSlots`.

### devc web page

**`host-slots.js`:**

- With `window.devcHost`, `mountHostTile` mounts, inside the tile:
  - a strip at its top reading `HOST · <user>@<host>`, with its color from the host color (the
    existing `.host-strip` look of `slot.css`, moved to `style.css`);
  - the terminal below it, `host-terminal.js`'s `mountHostTerminal(devcHost, el, pane, …)`,
    with the pane from `slotInfo(slot)`.
  - A `refused` answer or `pane: null` shows its reason in the tile as `slot.ts` does now.
  - `onGone` writes `[<reason>] Close this tab.` into the terminal.
  - A multi-line paste with `pasteGuard()` true shows the same paste bar `slot.ts` has (its
    markup and CSS move into the page).
- Without `window.devcHost` (a browser, VS Code), the placeholder _Host terminal — not running
  here_, as today.
- `unmountHostTile` disposes of the terminal with `release` true.
- A hidden tab keeps its terminal attached, as container panes do.

**Keys:** in a host tile, a capture-phase `keydown` matching `hostShortcut(e, IS_MAC)` (from
`lib/host_keys.js`) with `split-right`, `split-below` or `new-tab` calls
`devcHost.command(slot, name)` and is stopped. `close` is ignored, as `slot.ts` ignores it.

**Console lines removed** (and from `host-slots.js`'s header list):

- `devc-desktop:slot <id> <x> <y> <w> <h>`
- `devc-desktop:slot <id> hidden`
- `devc-desktop:drag start|end`
- `devc-desktop:overlay open|closed`

`devc-desktop:slot-end <id>` stays.

**Tile windows:**

- `lib/view.js`'s `DragRef` gains `{host: string}`. `parseDrag` accepts it when `host` matches
  `HOST_SLOT`.
- `movePayload` returns `{host: tile.host}` for a host tile with a slot, so host tiles get
  **Move to New Window** and drag out.
- `openDropped` opens `{host}` with `openHostTile(slot)`.
- Host tile ids that the page doesn't know (another window's) are still honored: the main
  process's `mayUse` decides, not the page.

## Gotchas

- **`contextBridge` copies values.** Frames' `bytes` stay base64 strings, as now. Callbacks
  registered through `onFrame` and the rest are called with copied arguments.
- **One controller per pane:** `host-term:attach` from a second page releases the first. A
  host tile shown in two windows at once is not supported. The move closes the source tile
  before the target attaches, and the 2 s lost rule covers the gap.
- **The preload is set at view creation.** `devcView` and the tile windows' views need
  `preload: join(__dirname, 'preload-devc.js')` in their own `webPreferences`. `sidebarView` and
  `footerView` keep the shared `devcPrefs`, with no preload.
- **The sender check must use the URL at call time.** A `/main` view that navigated off devc
  web's origin is refused. The navigation guard should make that impossible, but check anyway.
- **`host_terminal.ts` imports `PaneNews` from `policy.ts`.** In `host-terminal.js` it becomes a
  JSDoc typedef, and `policy.ts` keeps its TypeScript type for the main process.

## Validation

- [ ] `cd devc-desktop && npm test`. New cases:
  - `devcMainUrl` accepts `/main` and `/safe/main` on the origin, and rejects `/sidebar`, another
    port and `file:`
  - `hostShortcut` (re-exported) keeps its existing cases
- [ ] `cd devc-desktop && npm run check`
- [ ] `deno test -A devc/tests/web_view_test.ts`: `parseDrag` round-trips `{host}` and rejects
      a malformed slot id
- [ ] `deno test -A devc/tests/web_host_keys_test.ts`: the `hostShortcut` cases move here from
      `policy.test.ts`
- [ ] `deno task check`, `deno task test` (no new failures), and `deno fmt` and `deno lint` on
      touched files; a throwaway `checkJs` run reports no new errors in `web/static/`
- [ ] `grep -rn "slot.html\|parseSlotLine\|placeSlot\|ambiguousPress\|host-term:guard" devc-desktop/src devc/web/static`
      finds nothing
- [ ] Live, in devc-desktop:
  - **New Host Tile** opens a working host terminal inside the tile, which stays visible while
    a tab is dragged, a menu is open and a dialog is open
  - Cmd+D, Cmd+Shift+D and Cmd+T split from it
  - right-click shows the host menu, and **Move to Bottom Panel** works
- [ ] Live: a host tile moves to a tile window by **Move to New Window** and by drag. Its shell
      keeps running, and **Move to Bottom Panel** from there works
- [ ] Live: quit and relaunch: host tiles come back attached. Close a host tile's tab, and
      **Restore Host Tiles** brings it back after 2 s
- [ ] Live: the host color changes apply to host tiles at once
- [ ] Browser: `/main` shows the placeholder for a host tile, and nothing throws

## Relevant Files

- `devc/web/static/host-terminal.js` (new, from `devc-desktop/src/renderer/host_terminal.ts`)
- `devc/web/static/lib/term_colors.js` (new, from `devc-desktop/src/renderer/term_colors.ts`)
- `devc/web/static/lib/host_keys.js` (new)
- `devc/web/static/host-slots.js`
- `devc/web/static/tiles.js`: `movePayload` and `openDropped` for `{host}`
- `devc/web/static/lib/view.js`: `DragRef` and `parseDrag`
- `devc/web/static/style.css`: the host strip and paste bar
- `devc/tests/web_view_test.ts`, `devc/tests/web_host_keys_test.ts` (new)
- `devc-desktop/src/preload/devc.ts` (new)
- `devc-desktop/src/preload/host.ts`: its header comment
- `devc-desktop/src/main/main.ts`
- `devc-desktop/src/main/policy.ts`
- `devc-desktop/src/renderer/host.ts`: imports from `devc-web/`
- `devc-desktop/src/renderer/host_terminal.ts`, `term_colors.ts`, `slot.ts`, `slot.html`,
  `slot.css` (deleted)
- `devc-desktop/build.mjs`: the `preload-devc.js` entry, no `slot.*`
- `devc-desktop/src/renderer/devc-web.d.ts`: declarations for the new `devc-web/` imports
- `devc-desktop/tests/policy.test.ts`
- `devc-desktop/README.md`, `devc/README.md`
- `.plans/PLAN.md`
