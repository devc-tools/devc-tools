# devc-desktop: tiles in windows of their own

A tile can leave devc-desktop's window for a window of its own: its tab's **Move to New Window**,
or its tab dragged out of the window and let go. The new window is a `/main` alone, with no
sidebar, no Containers pane, no host drawer, and no title bar of the app's own. The sidebar stays
in the primary window and works every window's tiles. A tab dragged out of one window and let go
over another devcd window moves there instead.

devc-desktop only. In a browser, VS Code's webview or `/` nothing changes, because none of the
new behaviour is offered without `#…&windows=1`, which only devc-desktop sets.

Out of scope:

- **Host tiles** never move. Their terminals are views in the primary window.
- **Drafts** (unsaved new files), **file tiles with unsaved edits** and **empty pane tiles** do
  not move.
- **Moving a whole stack.**
- **Showing which window a tile is in** on the sidebar's tile rows. The rows list the primary
  window's tiles first, then each other window's.
- **Dropping at a spot in the target window.** A tile always lands in the target window's
  focused stack.

## Checklist

- [x] Step 0: in devc-desktop, confirm a Golden Layout tab drag in a `/main` view gets its
      `pointerup` when let go outside the window, with `clientX`/`clientY` outside the
      viewport. Chromium keeps delivering pointer events to a page while the primary button
      that went down in it is held. If it does not, leave the drag out (the last two Tiling
      area items under Drag), ship the rest, and note it here and in PLAN.md
- [x] Protocol: `view_join` takes `main`, and the new `view_focus` message
- [x] `views.ts`: several tiling areas per view (merged state, routed intents, target main)
- [x] `server.ts`: pass `main` through and dispatch `view_focus`
- [x] `lib/view.js`: drag payloads take diff tiles; the hash helpers; `TileState.window`
- [x] Tiling area: layout saved per main, **Move to New Window**, drag out, `open-tile`, the
      window raise and window empty lines
- [x] `remote.js`: join with the main id, send `view_focus`
- [x] devc-desktop: extra windows (open, place, lock down, theme, reload on restart, close with
      unsaved edits, save and restore)
- [x] `policy.ts` helpers with tests
- [x] Tests: `web_views_test.ts`, `web_view_test.ts`, `policy.test.ts`
- [x] Docs: `devc/README.md` (split pages, hash parameters), `devc-desktop/README.md` (new
      `### Tile windows` section), the console-line list in `host-slots.js`
- [x] Mac apps rebuilt (`npm run build:mac` in `devc-desktop/`)

## Contracts

### Main ids

- A `/main` page's **main id** is its hash's `main` (`#…&main=<id>`, the `VIEW_ID` pattern
  `^[A-Za-z0-9_-]{1,64}$`). With none, or an invalid one, it is `main`: **the primary**.
  Every page that exists today is the primary.
- devc-desktop names an extra window `w` followed by 8 random hex characters (e.g. `w3f9a01c2`).

### Hash parameters (`/main`)

| Parameter       | Set by                       | Meaning                                                                                                                        |
| --------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `windows=1`     | devc-desktop, every `/main`  | Turns on **Move to New Window**, the drag out, and the `window raise` and `window empty` lines                                 |
| `main=<id>`     | devc-desktop, extra windows  | The main id                                                                                                                    |
| `open-tile=<…>` | devc-desktop, on a tile move | The tile to open: a drag payload (below), as `URLSearchParams` encodes it. Opened, then taken out of the hash like `host-slot` |

An extra window's URL is
`<origin><prefix>/main#token=…&view=devcd&theme=<name>&status=external&windows=1&main=<id>`, plus
`&open-tile=…` when it opens for a move. `<prefix>` is the primary `/main`'s path before `/main`
(`/safe` while the primary is on `/safe/main`, else empty). Extra windows have no `sidebar=`, so
they draw no corner toggle.

`setMainHash` in devc-desktop adds `open-tile` to the keys it clears, so it can deliver a move to
the primary window.

### Drag payload (`lib/view.js`)

`encodeDrag` and `parseDrag` take a third shape, `{diff: DiffRef}`, which `parseDrag` checks with
`layout_state.js`'s `diffRefFromState`. Native drops (`openDropped`) open it with
`openDiff(diff, 'stack')`. A diff tile's comparison choice does not travel.

### Console lines (page → devc-desktop)

These are added to the list at the top of `host-slots.js` and said through the same `tell`:

```
devc-desktop:tile-out new <payload>   Move to New Window: a new window with this tile
devc-desktop:tile-out drop <payload>  a tab let go outside the window: the app picks the window
devc-desktop:window raise             a relayed intent showed a tile here (open*, reveal, revealLine)
devc-desktop:window empty             an extra window's last tile closed, or it restored none
```

`<payload>` is `encodeDrag`'s JSON. It is the rest of the line after the second space, and the
app treats it as opaque: it passes it on unread. It parses only the verb and the size.
`parseTileOutLine(message)` in `policy.ts` returns `{how: 'new' | 'drop', payload}` or null. It
returns null when the line is not one of these, when the payload is empty, when it is over
16 384 characters, or when the payload's first character is not `{`.

A page says `window raise` and `window empty` only with `windows=1`, and `window empty` only
with a `main` other than `main`. The app ignores `window empty` from the primary.

### Protocol

- `view_join` gets an optional `main` (the `VIEW_ID` pattern), meaningful only with role
  `tiles`. Leaving it out means `main`. Validation: `main` present but not a string matching the
  pattern → `bad_request`.
- New client message `{type: 'view_focus', view: string}`, sent by a tiling area whenever its
  page's `window` gets `focus`, and once right after its `view_join` if `document.hasFocus()`.
  Validated like the other `view_*` messages (size cap included). It is ignored from anyone but
  a `tiles` member of that view.
- No protocol version bump. The new field is optional and the new message is just new.

### Server merge (`views.ts`)

A view keeps, per main id, its members and its last `view_state` (as `state` keeps one today).
It also keeps the **target main**: the main that sent the latest `view_focus`. It starts as
`main`. When the target's last member leaves, the target becomes `main` if that is joined,
else the most recently joined main still joined.

**Tile ids:** the primary's tile and node ids are relayed as they are. An extra main `M`'s ids
are relayed as `M:<id>`.

**The merged state** goes to sidebars and Containers sections. It is recomputed and sent on
every `view_state` from a main, every `view_focus` that changes the target, and every main
leaving.

- `tiles`: the primary's tiles as they are, then each extra main's in join order, each of those
  with `window: <main id>` and its `id` prefixed as above.
- `tree`: with one main, its tree with ids prefixed. With several, the tree is
  `{kind: 'row', id: 'windows', children: [...]}`, with the primary's tree first and then the
  extras' in join order. Null trees are left out. With none at all it is `null`.
- `focused`: the target main's `focused`, prefixed.
- `outline`: the target main's `outline` with its `tile` prefixed, or `null`.
- `withInUse` (Containers) applies to the merged state as it does today.

With only the primary's state (every page that exists today), the merged state is that state,
verbatim. Nothing else changes.

**Intent routing** (`view_intent`, from a sidebar or a Containers section):

| Intent                                                                                                           | Goes to                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reveal`, `close`, `keepOpen`, `save`, `reload`, `askAgent`, `restartLanguage`, `languageSettings`, `revealLine` | The main that `args[0]` names: `M:<id>` with `M` an extra main joined → `M` with `args[0] = <id>`. Anything else → `main`. The id `windows` → dropped |
| `openPane` with `args[1].at` a string                                                                            | Routed by `at` as above, with `at` stripped                                                                                                           |
| `openPane` without `at`, `openFile`, `openDiff`                                                                  | The target main                                                                                                                                       |
| `prViewed`                                                                                                       | Every main                                                                                                                                            |

A main's id prefix is split at the **first** `:`. It counts only when the part before it is an
extra main joined to the view. Otherwise the id is the primary's, unchanged.

`sidebar_intent` from any main goes to the sidebars, as it does today.

### Tiling area (`tiles.js`, `main-page.js`, `menus.js`, `remote.js`)

**Layout key:** the layout is saved under `devc-web-layout-v2` for the primary and
`devc-web-layout-v2:<main id>` for an extra main. Zen mode stays under the existing key, shared.

**Move to New Window** (`LABELS.moveToNewWindow`):

- It is in the `organize` group of the tab and body menu (`tileOwnMenuItems`), not in sidebar row
  menus.
- It shows only with `windows=1`, and only on a pane tile with a ref, a file tile with a file and
  no unsaved edits (`losesEdits` false), or a diff tile.
- It has no keyboard shortcut.
- It says `tile-out new <encodeDrag(ref)>`, then closes the tile. For a pane tile this is the
  existing close: it detaches this page's stream, and the pane keeps running.

**Drag out:**

- Only with `windows=1`, and only for a movable tile (as above).
- While a Golden Layout tab drag is under way, a capture-phase `pointerup` on `document` with
  `clientX < 0 || clientY < 0 || clientX >= innerWidth || clientY >= innerHeight` marks the
  drag as **out**.
- After Golden Layout's own drop has run (a `setTimeout(…, 0)` after that `pointerup`), the page
  says `tile-out drop <payload>` for the dragged tile and closes it.

**`open-tile`:**

- `main-page.js` takes it like `host-slot`: read it, `history.replaceState` it out, then
  `parseDrag` it. A valid payload goes to `openDropped(ref, null)` (the focused stack, focused).
  An invalid one is ignored.
- `main-page.js` also takes it on `hashchange`, which is how devc-desktop delivers a move to a
  window that is already open.

**Lines:**

- After carrying out a relayed `openPane`, `openFile`, `openDiff`, `reveal` or `revealLine`, the
  page says `window raise`.
- An extra main says `window empty` when its last tile closes. It also says it after restoring a
  layout with no tiles, when no `open-tile` came with it.

**`remote.js`:** `serveTileArea` joins with `{type: 'view_join', view, role: 'tiles', main}` and
then sends `view_focus` as described under Protocol. `main` is the page's main id, sent only when
it is not `main`.

### devc-desktop (`main.ts`)

**Extra windows:**

- Each is a `BaseWindow`, 1000×700, with the OS's own frame (no `titleBarStyle`, no overlay) and
  title `devcd`. Its background is the UI theme's.
- It holds one `WebContentsView` with `devcPrefs` (the `persist:devc` partition, so it shares
  `localStorage` with the primary), filling its content bounds.
- The app keeps them in a `Map<mainId, {win, view}>`.

**Lock down:** an extra window's view gets everything `lockDownDevc` gives the devc views (the
window-open handler, the navigation guard, no webviews). Factor that per-view part out and apply
it to each extra view as it is made. The session handlers are already set on the shared
partition.

**Theme:** `setUiTheme` and `retheme` theme each extra view as they theme `devcView`.

**`tile-out` lines** come from `devcView` or any extra view. Take the cursor from
`screen.getCursorScreenPoint()`, then:

- `new`: open an extra window with `open-tile=<payload>`. It is placed 30 px right of and 30 px
  below the sender's window's top-left corner, kept in that display's work area.
- `drop`, with the cursor inside a devcd window other than the sender's (the primary or an
  extra): deliver the move to that window and raise it. To the primary it goes by `setMainHash({
  'open-tile': payload })`; to an extra, by `open-tile` set in its URL's hash, as `loadMainHash`
  sets `sidebar`.
- `drop`, otherwise: open an extra window whose top-left is the cursor minus (40, 15), kept in the
  work area of `screen.getDisplayNearestPoint(cursor)`.

**`window raise`:** focus that view's window (`win.focus()` for an extra; the primary `win`).
**`window empty`:** close that extra window.

**Closing an extra window:**

- On the window's `close`, `preventDefault`, then
  `view.webContents.close({ waitForBeforeUnload: true })`.
- The page's `beforeunload` guard (unsaved edits) shows up as the webContents'
  `will-prevent-unload`. Answer it with `dialog.showMessageBoxSync(win, …)`, with the message
  "This window has unsaved edits." and the buttons **Discard and Close** and **Cancel**.
  **Discard and Close** → `event.preventDefault()`, which lets the unload go ahead.
- On the webContents' `destroyed`:
  - run nothing more in it;
  - destroy the window and drop it from the map;
  - remove it from the saved windows;
  - remove its layout key by running
    `localStorage.removeItem('devc-web-layout-v2:<id>')` in the **primary** view's webContents
    (`executeJavaScript`; same origin and partition), when the primary is showing devc web.

**devc web restart:** whenever the primary `/main` is loaded again for a new devc web (a new
origin or token), every extra view loads its URL again, built anew and without `open-tile`.
While devc web is not running, an extra view shows `about:blank`.

**Saved across launches:** `desktop-state.json` gets
`tileWindows: [{id, x, y, width, height}]`. It is written by `saveState` on an extra window's
`moved`, `resized`, open and close. On launch, it is restored once devc web's origin is known,
each entry opened at its saved bounds and kept in a display's work area. Read it with
`savedTileWindows(value)` in `policy.ts`, which keeps only entries with an id matching
`^w[0-9a-f]{8}$` and four finite numbers, with width and height at least 200. It keeps at most
20 entries.

**App quit:** extra windows close with the app. They are not closed one by one first, so the
saved list stays as it was and they come back on the next launch.

## Gotchas

- **Golden Layout clamps the drag:** `constrainDragToContainer: true` keeps the proxy inside the
  layout, and on `dragStop` Golden Layout drops the tile at its last valid area. So a tile dragged
  out first lands somewhere in its own window. Closing it after that drop (the `setTimeout`) is
  what makes the move. Do not cancel Golden Layout's drop.
- **The page can't see the drop target:** the page cannot tell which window the pointer was let
  go over, which is why it says `drop` and devc-desktop decides from the cursor.
- **`beforeunload` in Electron** does not show a dialog. Without a `will-prevent-unload` handler,
  the close is silently cancelled, which is why the handler is required.
- **The primary's ids are not prefixed:** the server must not prefix the primary's ids. With one
  main, every existing contract (sidebar menus, `nodeById`, Containers) has to see exactly the
  ids it does today.
- **The sidebar's last-focused window:** a click in the sidebar does not change the target main.
  The sidebar is not a `/main`, so its focus sends no `view_focus`. "Open" from the sidebar goes
  to the `/main` focused last, which then raises its window.

## Validation

Accepted 2026-11-27 by the user after trying it in devc-desktop ("things seem to work"). Step 0
and the live checks below were not run item by item; they will be tested in use and any issues
re-planned.

- [x] `deno test -A devc/tests/web_views_test.ts`. New cases:
  - one main: the merged state equals the main's state, verbatim
  - two mains: tiles are prefixed (`wabc12345:t1`), the tree is the `windows` row, and
    `focused` and `outline` follow the target
  - `view_focus` moves the target and sends the state again
  - the target's leaving falls back to `main`
  - `close('wabc12345:t1')` reaches only that main, as `close('t1')`
  - `close('t1')` reaches only `main`
  - `openFile` reaches only the target
  - `openPane` with `at: 'wabc12345:t2'` reaches that main with `at: 't2'`
  - `prViewed` reaches every main
  - an id `nope:t1` (no such main) goes to `main` unchanged
  - `view_focus` from a sidebar is ignored
- [x] `deno test -A devc/tests/web_view_test.ts`. New cases:
  - `parseDrag` round-trips `{diff}` and rejects a malformed diff
  - `mainIdFromHash`: absent or invalid gives `main`
  - `windowsFromHash` and the `open-tile` reader round-trip a payload through `URLSearchParams`
- [x] `deno test -A devc/tests/web_server_test.ts`: `main` is accepted when valid, rejected when invalid, and `view_focus` parses
- [x] `cd devc-desktop && npm test`. New cases:
  - `parseTileOutLine` accepts `new` and `drop`, and rejects an unknown verb, an empty payload,
    16 385 characters and a payload not starting with `{`
  - `savedTileWindows` keeps valid entries, drops bad ids, small sizes and non-numbers, and caps
    at 20
- [x] `cd devc-desktop && npm run check`
- [x] `deno task check`, `deno task test` (no new failures), and `deno fmt` and `deno lint` on
      touched files
- [x] Browser `/` and VS Code `/main`: no **Move to New Window** item, and a tab dragged off the
      page lands back in the layout as before
- [x] Live, in devc-desktop: **Move to New Window** on a terminal tile opens a window where the
      terminal is live, and the primary no longer has the tile
- [x] Live: opening a file from the sidebar after focusing the extra window opens it there and
      raises that window
- [x] Live: dragging a tab out of the primary and letting go on the desktop opens a window at the
      pointer. Dragging that tile's tab back over the primary moves it back
- [x] Live: a file tile with unsaved edits has no **Move to New Window**. Editing a file in an
      extra window and then closing that window asks, and **Cancel** keeps the window
- [x] Live: closing an extra window's last tile closes the window. Quitting and relaunching
      restores open extra windows with their tiles
- [x] Live: restarting devc web (the app's restart) reloads the extra windows, which come back
      with their tiles

## Relevant Files

- `devc/web/protocol.ts`: `view_join.main`, `view_focus`, and its size-cap check
- `devc/web/views.ts`: several mains per view, the merge, routing, the target main
- `devc/web/server.ts`: `view_join` `main` passed to `views.join`, `view_focus` dispatch
- `devc/web/static/lib/view.js`: `encodeDrag`/`parseDrag` `{diff}`, `mainIdFromHash`,
  `windowsFromHash`, the `open-tile` reader and its removal from the hash, `TileState.window`
- `devc/web/static/client.js`: export `MAIN_ID` beside `VIEW_ID`
- `devc/web/static/remote.js`: `view_join` with `main`, `view_focus`
- `devc/web/static/main-page.js`: take `open-tile`
- `devc/web/static/tiles.js`: the layout key per main, the drag out, `openDropped` for `{diff}`,
  `window raise` and `window empty`, the move (close after the line)
- `devc/web/static/menus.js`: **Move to New Window**
- `devc/web/static/ui.js`: `LABELS.moveToNewWindow`
- `devc/web/static/host-slots.js`: the console-line list in its header comment
- `devc/tests/web_views_test.ts`, `devc/tests/web_view_test.ts`, `devc/tests/web_server_test.ts`
- `devc-desktop/src/main/main.ts`: extra windows
- `devc-desktop/src/main/policy.ts`: `parseTileOutLine`, `savedTileWindows`
- `devc-desktop/tests/policy.test.ts`
- `devc/README.md`: the split pages paragraph (several `/main` pages per view, `main=`,
  `windows=1`, `open-tile=`)
- `devc-desktop/README.md`: new `### Tile windows` section
- `.plans/PLAN.md`
