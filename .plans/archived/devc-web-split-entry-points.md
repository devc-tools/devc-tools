# devc web: the sidebar and the tiling area as modules of their own

Decided with the user on 2026-10-22. Phase 2 of 5 of running the sidebar and the tiling area as
separate pages (for example the sidebar in a VS Code webview and the tiles in VS Code's integrated
browser). Phase 1 (commit `16129aa`) put the sidebar → tiling area traffic behind
`static/lib/view.js`. This phase splits `static/app.js` (≈8.3k lines) into modules so each half
can be mounted on its own. **Page code only: no server or protocol change**, and `/` must look and
behave exactly as it does now. Phase 3 is
[devc-web-sidebar-main-routes](devc-web-sidebar-main-routes.md).

## Checklist

- [x] 1. `static/ui.js`: the DOM helpers and widgets both halves use
- [x] 2. `static/client.js`: the server connection and the server's data
- [x] 3. `lib/view.js` gains `SidebarIntents`; the tiling area calls the sidebar only through it
- [x] 4. `static/tiles.js`: the tiling area, exporting `mountTiles`
- [x] 5. `static/sidebar.js`: the sidebar, exporting `mountSidebar`
- [x] 6. `static/app.js` becomes the composer for `/`
- [x] 7. A source test that the halves stay apart
- [x] 8. Validation (below), then commit

## Touchpoints

| File | Role after this plan |
|---|---|
| `devc/web/static/app.js` | The composer for `/`: imports `client.js`, `tiles.js`, `sidebar.js`; owns what only the combined page has (the sidebar resizer, the hide-sidebar button and Cmd+B, `sidebarState.width`/`hidden`). Small. |
| `devc/web/static/ui.js` (new) | `h`, toasts, menus (`openMenu`, `openMenuAt`, `closeMenu`), `confirmDialog`, `promptDialog`, icons (`ICON_PATHS`, `svgIcon`, `iconButton`, `rowIcon`), `LABELS`, `IS_MAC`, `markBooted`, row helpers both halves' menus use (`rowTrail`, `hoverActions`, `markedText`), `writeClipboard`. |
| `devc/web/static/client.js` (new) | The `/ws` connection (`connect`, `send`, `call`, `request`, reconnect, `hello`/live reload, `/safe/` banner), the server's data (`containers`, `snapshots`, `projects`, pinned files, tasks, jira config, usage, bridge status) and the pure-ish lookups over it (`containerByFolder`, `findPane`, `resolveRef`, `projectRepos`, `paneRepo`, `activeRepo`, `tileRepo`, …). |
| `devc/web/static/tiles.js` (new) | The tiling area: file tiles, diff tiles, pane tiles, layout persistence, preview tiles, `viewState`/`viewChanged`, the tile keyboard shortcuts (Ctrl/⌘+S), the window title and `active_pane` reporting. |
| `devc/web/static/sidebar.js` (new) | Every `// Sidebar…` section of today's `app.js`, the task and new-note dialogs, the "Add project…" folder picker, and the Ctrl+Alt+N and Ctrl+Alt+Z shortcuts. |
| `devc/web/static/lib/view.js` | Gains the `SidebarIntents` typedef (below). Stays pure. |
| `devc/web/static/index.html` | Unchanged markup; still loads `boot.js` then `app.js`. |
| `devc/tests/web_page_split_test.ts` (new) | The source test of step 7. |

Where a function lands is the agent's call within these rules:

- **One owner per piece of state.** Tile views (`views`, `fileViews`, `diffViews`, `focusSeq`,
  `focusedTileId`, `tiling`, `pendingOpens`, `pendingLines`, `newPanes`) belong to `tiles.js`.
  Sidebar state (`sidebarState` except width/hidden, `paneRows`, `fileRows`, `fileTrees`, session
  and PR lists, dialogs, `shownLayout`/`shownMarks`/`shownZenCard`) belongs to `sidebar.js`.
  Server data belongs to `client.js`.
- **Menus built from server data and intents are shared code**, not sidebar code: `tileMenuItems`,
  `fileTileMenuItems`, `diffTileMenuItems`, `nodeMenuItems`, `stackMenu`, `newShell`,
  `createPane`, `placePane`, `killPane`, pin items, copy-path and host-open items. They may live in
  a further module (for example `static/menus.js`) that takes the `tileArea` and `SidebarIntents`
  objects as parameters or through a setter. They must not import `tiles.js` or `sidebar.js`.
- `tiles.js` and `sidebar.js` never import each other. `app.js` is the only file that imports
  both.

## Contracts

### Module exports

```js
// tiles.js
/**
 * Mounts the tiling area into `root` (today's `#tiles`) and returns the sidebar's way in.
 * `sidebar` is how the tiling area reaches the sidebar; `null` when no sidebar is on the page.
 *
 * @param {HTMLElement} root
 * @param {{sidebar: import('./lib/view.js').SidebarIntents | null,
 *   onViewChange: (state: import('./lib/view.js').ViewState) => void}} opts
 * @returns {TileArea}  // phase 1's `tileArea` object: ViewIntents & {state, dragSource}
 */
export function mountTiles(root, opts) {}

// sidebar.js
/**
 * Mounts the sidebar into `root` (today's `aside.sidebar` contents: header, `#tree`) and returns
 * the tiling area's way in. `tileArea` is phase 1's object.
 *
 * @param {HTMLElement} root
 * @param {{tileArea: TileArea}} opts
 * @returns {{intents: import('./lib/view.js').SidebarIntents,
 *   onViewState: (state: import('./lib/view.js').ViewState) => void}}
 */
export function mountSidebar(root, opts) {}

// client.js
/** Opens `/ws` (token from the URL hash, as now) and starts dispatching. */
export function connect() {}
/**
 * Subscribes to the server's messages after `client.js` has applied them to its data:
 * `fn(msg)` runs for every message, in order. Returns an unsubscribe function.
 */
export function onServerMessage(fn) {}
```

`TileArea` is the type of phase 1's `tileArea` constant; export a typedef for it from
`lib/view.js` (`ViewIntents & {state: () => ViewState, dragSource: …}`) rather than re-declaring
it. Names inside the modules are free; these exports, their parameters and the typedef names are
fixed, because phase 3 builds on them.

`app.js` wires them: `mountTiles` first with a `sidebar` forwarder whose methods call the
sidebar's `intents` once `mountSidebar` has returned, and an `onViewChange` that calls the
sidebar's `onViewState`; then `mountSidebar` with the returned `tileArea`; then `connect()`.
Startup order today (`applySidebarLayout`, `restoreLayout`, `applyZen`, `reconcileTiles`,
`renderTree`, `connect`) is kept in effect.

Each half re-renders from `onServerMessage` what today's `onMessage` switch does for it directly
(`renderTree`, `reconcileTiles`, `onFrame`, `onPaneClosed`, `onResult` for tile requests…). A
`result` whose id belongs to a module's own pending map is that module's to settle; `call()`'s
pending map stays in `client.js`.

### `SidebarIntents` (new, `lib/view.js`)

What the tiling area asks of the sidebar. Plain data in, nothing out, as `ViewIntents`.

```js
/**
 * @typedef {object} SidebarIntents
 * @property {(ref: PaneRef) => void} revealInContainers  a tile menu's **Reveal in Containers**
 * @property {(scope: 'off' | 'container' | 'repo') => void} setZen  a tile menu's zen items
 */
```

Today the tile menus call `revealInContainers(c, pane)` and `setZen(scope)` directly; after this
plan they call these. A tile menu's zen items read the current scope; the tiling area learns it
from the sidebar through `tileArea.setZen(on)` as today, so add the scope the items need to
whatever the shared menu code is given (a getter is fine). With `sidebar: null` the tile menus
leave out **Reveal in Containers** and the zen items.

### Who owns the window title and `active_pane`

Both follow the focused tile, so both move to `tiles.js`: the `document.title` update and
`reportActivePane` (including the `focus` listener and the call in `ws.onopen`, which becomes a
call from `tiles.js` on the `hello` message). The sidebar keeps marking its current rows
(`updateCurrent`'s row marking) from `ViewState.focused`.

## Concept boundaries

- **`tiles.js` is not `layout.js`.** `layout.js` stays the only Golden Layout importer;
  `tiles.js` is what `app.js`'s tile sections were.
- **"main"** in phase 3's route `/main` means the tiling-area page. It is not `devc/main.ts` and not
  the git branch. Don't name a module `main.js`.
- **`tileArea` vs `tiling`**: `tiling` is `layout.js`'s handle, private to `tiles.js`; `tileArea`
  is the contract object the sidebar gets.
- **`SidebarIntents` vs `sidebarState`**: the first is the new contract; the second is the
  sidebar's persisted UI state (`devc-web-sidebar-v1` in `localStorage`), whose key and shape must
  not change (users' saved state).
- **`localStorage` keys** (`devc-web-layout-v2`, `devc-web-sidebar-v1`, file-pin panes, task
  defaults, show-resolved) keep their names and shapes, whichever module now owns them.

## Step 7: the source test

`devc/tests/web_page_split_test.ts`, in the style of `web_no_native_dialogs_test.ts` (reads the
page scripts, no DOM):

- `sidebar.js` never mentions the identifiers `tiling`, `views`, `fileViews`, `diffViews`,
  `focusSeq`, `focusedTileId` outside comments, and imports neither `tiles.js` nor `layout.js`.
- `tiles.js` never imports `sidebar.js`.
- Only `app.js` imports both `tiles.js` and `sidebar.js`.

## Validation

1. `cd devc && deno task test` passes, and `cd .. && deno fmt --check` reports nothing new
   (`devc/web/static/index.html` already fails on `main`; leave it).
2. No undefined names: run `deno check` over each page module with a throwaway config
   `{"compilerOptions": {"checkJs": true, "strict": false, "noImplicitAny": false, "lib": ["dom",
   "dom.iterable", "esnext", "deno.ns"]}}` (put it in your scratchpad, never in the repo). It
   must report no `TS2304` (cannot find name) and no `TS2305`/`TS2307`/`TS2724` (missing export or
   module) for files under `web/static/` other than `vendor/`.
3. Drive `/` in a headless browser (the `agent-browser` skill) against a fake server, as the
   `devc-web` skill's "Testing without the user's tab" describes: one init script replacing
   `window.WebSocket`, delivering `hello`, `projects` (with a repo), `containers` and `snapshot`
   with two panes, answering `new_shell`, `list_dir`, `read_file`, `list_sessions` and
   `request`. Serve `devc/web/static/` with a static file server. Check, with no console errors:
   a pane row click opens a preview tile; Ctrl+click opens a new tile; clicking another pane
   replaces the preview in place; a sidebar tile row's menu shows Split vertically and it places a
   new pane to the right; a tile tab's own menu shows Reveal in Containers and the zen items; zen
   mode on and off; a repo file opens as a preview; typing in it shows `● a.ts` on its sidebar
   row; Save from that row's menu sends `write_file`; closing it asks first; a reload restores
   the layout; the window title follows the focused tile.
4. The user runs `devc web --live` from this checkout and their tab reloads on every save to
   `web/static/`. Write new modules before `app.js` imports them, and make the `app.js` switch over
   in as few saves as possible, so the tab is never left on a half-made split.

Commit with a message in the repo's style (`devc web: …`).
