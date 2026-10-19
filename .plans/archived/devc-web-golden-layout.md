# devc-web-golden-layout

Replace `devc web`'s hand-written tiling area (a binary split tree in `app.js`) with
[Golden Layout](https://github.com/golden-layout/golden-layout) 2.6.0. That gives the page real
window management: drag a pane from the sidebar onto any tile edge or into a tab stack, drag
tiles between stacks, create, close and maximise tiles, and nest rows, columns and stacks to any
depth. Everything else in `devc web` stays the same: the server, the WebSocket protocol, the
renderer, input handling and the sidebar tree.

Builds on [devc-web](devc-web.md), whose "Browser UI → Tiling area" section this plan
supersedes. Nothing on the server side changes except one content type.

Out of scope: Golden Layout **popout windows** (each window would need its own WebSocket and
token handling), **virtual components**, and touch support beyond what Golden Layout does on
its own.

## Why Golden Layout, and the cost

- It is plain TypeScript with no runtime dependencies and an MIT license, so it can be vendored
  like xterm.js and loaded as an ES module.
- It provides rows, columns and tab stacks nested to any depth, plus drag sources
  (`newDragSource`), drop zones on every edge and in every stack, maximise, and
  `saveLayout`/`loadLayout`.
- **Risk:** the last release (2.6.0) is from 2022-09. Pin it exactly and vendor it. If it ever
  has to be replaced, only `layout.js` (below) changes.

## Background: what the package ships (measured with `npm pack golden-layout@2.6.0`)

- `dist/esm/index.js` re-exports 33 modules with **extensionless** relative imports
  (`export * from './ts/config/config'`). Browsers cannot load that without a bundler or an
  import map, so the vendored copy is a **single bundled module**. Verified:
  `deno bundle --platform browser --format esm -o golden-layout.mjs dist/esm/index.js` bundles
  all 33 modules into one ~290 KB file and exports `GoldenLayout`, `LayoutConfig` and the rest.
- `dist/css/goldenlayout-base.css` has no `url()` references.
  `dist/css/themes/goldenlayout-dark-theme.css` references `url('../../img/lm_*.png')`.
  Vendor `img/` beside `css/` so those paths still resolve.
- APIs this plan relies on (all present in `dist/types/index.d.ts`):
  - `new GoldenLayout(container)` and `registerComponentFactoryFunction(type, fn)`
  - `addComponent(type, state, title)` and `newDragSource(element, () => ComponentItemConfig)`
  - `saveLayout()` → `ResolvedLayoutConfig`, `LayoutConfig.fromResolved()`, and
    `loadLayout(config)`
  - `focusComponent(item)` and `resizeWithContainerAutomatically`
  - Container methods: `setTitle`, `setState`/`getState`, `close`, `focus`
  - Events: `stateChanged`, `focus`, `tabCreated`, `show`, `hide`, `resize`,
    `beforeComponentRelease`, `itemDestroyed`

## Design

### Vendoring

- `scripts/vendor-golden-layout.sh` (new) is the only way the vendored files change, as
  `scripts/vendor-xterm.sh` is for xterm. It pins `GOLDEN_LAYOUT_VERSION=2.6.0` and runs
  `npm pack`. It bundles `dist/esm/index.js` with `deno bundle --platform browser --format esm`
  and writes into `devc/web/static/vendor/golden-layout/`:
  - `golden-layout.mjs`: the bundle
  - `css/goldenlayout-base.css` and `css/themes/goldenlayout-dark-theme.css`: unmodified
  - `img/*.png`: unmodified, all of them
  - `LICENSE`
  - `VERSIONS`: `golden-layout 2.6.0`, plus a line saying `golden-layout.mjs` is a
    `deno bundle` of `dist/esm/index.js`
- `devc/web/static/vendor/` is already excluded from `deno fmt` and embedded by
  `--include web/static`. No `deno.json` change is needed.
- `devc/web/server.ts` `CONTENT_TYPES` gains `'.png': 'image/png'`. That is the only server
  change. `staticPathAllowed` already accepts these paths.

### Module boundary: `layout.js` is the only Golden Layout importer

Mirror `renderer.js`: one new module, `devc/web/static/layout.js`, imports
`./vendor/golden-layout/golden-layout.mjs`. `app.js` never touches Golden Layout directly.
Contract (JSDoc-typed, names exact):

```js
/** @typedef {{localFolder: string, pane_id: string}} PaneRef */

/**
 * @typedef {object} Tile
 * @property {string} id                 stable for the tile's lifetime
 * @property {PaneRef | null} ref        the pane this tile shows
 * @property {HTMLElement} element       where app.js mounts the renderer and overlay
 * @property {(ref: PaneRef | null) => void} setRef   persists into the component state
 * @property {(title: string) => void} setTitle
 * @property {(el: Node | null) => void} setBadge     agent badge shown in the tile's tab
 * @property {() => void} focus
 */

/**
 * @param {HTMLElement} root
 * @param {{
 *   mount(tile: Tile): void,               // a tile was created (also on restore)
 *   unmount(tile: Tile): void,             // a tile is about to be destroyed
 *   visibility(tile: Tile, visible: boolean): void, // its stack tab was hidden or shown
 *   focused(tile: Tile | null): void,
 *   changed(): void,                       // layout changed: persist it
 * }} hooks
 * @returns {{
 *   add(ref: PaneRef | null): Tile,        // new tile beside the focused one, or as root
 *   dragSource(el: HTMLElement, ref: () => PaneRef, title?: () => string): () => void,
 *                                          // returns the unregister function; title names the drag preview
 *   save(): unknown,                       // JSON-serializable LayoutConfig
 *   load(saved: unknown): boolean,         // false when it is unusable: the layout is left empty
 *   tiles(): Tile[],
 *   focusedTile(): Tile | null,
 *   isEmpty(): boolean,
 * }}
 */
export function createTiling(root, hooks) {}
```

- One Golden Layout component type, `'pane'`. Its component state is exactly a `PaneRef`, or
  `{}` for an empty tile. No other state is stored in Golden Layout.
- Settings:
  - `showPopoutIcon: false`, `showMaximiseIcon: true`, `showCloseIcon: true`
  - `reorderEnabled: true`, `constrainDragToContainer: true`
  - `resizeWithContainerAutomatically: true`
- Use non-virtual components. Golden Layout re-parents the tile element on drag, and xterm.js
  survives that. The existing per-tile `ResizeObserver` → debounced `resize` path refits it
  after a drop.

### Behavior in `app.js`

These replace the current tiling code; nothing else in the browser changes.

- **Remove:**
  - the `LayoutNode` tree: `splitTile`, `closeTile`, `replaceNode`, `removeTile`,
    `renderLayout` and the divider drag code
  - the custom `.tile-header` with its split and close buttons
  - their CSS (`.split`, `.slot`, `.divider`, `.tile`, `.tile-header`)
- **Per-tile state** (`TileView`: renderer, overlay, `openKey`, `closedReason`, size) is now
  keyed by `Tile.id`. It is created in `mount` and disposed in `unmount`.
  - `unmount` closes the tile's pane through the existing ref-counted `closeTilePane`, so a
    pane open in two tiles stays live until the last one closes.
- **Opening panes:**
  - **Click** a sidebar pane: show it in the focused tile (`setRef`). If there is no tile,
    `add(ref)` instead.
  - **Drag** a sidebar pane: every pane row is a `dragSource`. A drop creates a new tile for
    that pane wherever it lands, on an edge or as a tab in a stack.
  - Dragging a tile's tab moves or nests that tile. This is Golden Layout's own behavior and
    sends nothing to the server.
- **Tab title** is `<container name> · <pane title>` via `setTitle`, refreshed on every
  `snapshot`, `pane_updated` and `containers` message. The agent badge goes in the tab via
  `setBadge`, using the same `badge()` element the sidebar uses.
- **Hidden tabs:** a tile in a background stack tab keeps its controller open and keeps
  receiving frames. While hidden, it sends no `resize`: its size reads as zero, and
  `renderer.resize()` already returns `null` then. On `visibility(tile, true)` it refits at
  once and sends `resize` if the size changed.
- **Focus:** Golden Layout's `focus` event sets the focused tile. A mousedown anywhere in a
  tile calls `tile.focus()`, replacing the current capture-phase listener.
- **Empty layout:** when the last tile closes, the tiling area shows a placeholder: "Drag a
  pane here, or click one in the sidebar." Clicking a pane then creates the first tile.
- **Persistence:**
  - The `localStorage` key becomes `devc-web-layout-v2`. Its value is
    `JSON.stringify(save())`, written on `changed()`.
  - On load, `load(JSON.parse(…))` runs inside try/catch. Anything unusable leaves an empty
    layout.
  - The old `devc-web-layout-v1` key is removed on first load and **not** migrated. Its tree
    shape is not worth a converter.
  - A restored tile whose pane is gone still shows "Pane gone", exactly as today.
- **Theme:** link the dark theme CSS after the base CSS in `index.html`. Override colors in
  `style.css` with the existing `:root` tokens (`--panel`, `--border`, `--accent`,
  `--text`), so tabs and splitters match the sidebar.

### Shared pure logic

`devc/web/static/lib/layout_state.js` (new, JSDoc-typed, no DOM, no Golden Layout import):

- `paneRefFromState(state)` → `PaneRef | null`: accepts only objects with string `localFolder`
  and `pane_id`.
- `tileTitle(containerName, paneTitle)` → `string`.
- `parseSavedLayout(text)` → `object | null`: `null` for invalid JSON or a value with no
  object `root`. This shape check runs before `loadLayout` ever sees the value.

`layout.js` and `app.js` both use these helpers.

## Found during implementation

Measured in a headless Chrome against a fake `docker`/Herdr harness. Each one shaped the code:

- **Unregistering a drag source kills a drag in progress.** `removeDragSource` destroys the
  source's `DragListener`, which removes its document `pointerup` listener. The drag then never
  ends. The sidebar re-renders on every agent-status change, so `app.js` keeps each pane row
  element and its drag source for the pane's lifetime (`paneRows`), updates it in place, and
  unregisters it only when the pane leaves the tree.
- **Only the registered element starts a drag.** `newDragSource` passes no extra targets, so a
  `pointerdown` on a child (the label, the badge) does nothing. The pane row's children get
  `pointer-events: none`, and the badge's tooltip moves into the row's `title`.
- **A tile being dragged is mounted before it is placed.** A sidebar drag creates its component
  (and runs the factory) in a dummy ground, then moves it into the drag preview, appended to
  `document.body`. A tile whose tab is being dragged also moves into the preview. Its size there
  is the preview's thumbnail size. So `app.js` opens or resizes a pane only for tiles inside the
  layout root (`isPlaced`), and re-checks every tile on `changed()`, which fires on drop.
- **`deno bundle` comments name each module's path relative to the cwd.** Run from outside the
  temp dir, that path includes the temp dir's random name, so every vendoring run differed. The
  script runs the bundle from inside the work dir with a relative entry point; two runs are now
  byte-identical.
- With no title, Golden Layout labels a tile's tab and its drag preview with the component type
  (`pane`). `dragSource` takes an optional `title()` for the preview.

## Concept boundaries

Easy to confuse, so keep these straight in names and comments:

- **Golden Layout tab or stack** vs **Herdr tab.** A Golden Layout tab is one browser tile in a
  stack. A Herdr tab (`tab_id`, shown in the sidebar) is Herdr's own. Name the Golden Layout one
  `stack` or `tile` in code, never `tab`.
- **Tile** vs **Herdr pane.** A tile is browser-only and shows at most one Herdr pane. Several
  tiles may show the same pane.
- **Moving or nesting a tile** vs the `pane.split` request. Dragging a tile changes only the
  browser layout. Only the sidebar context menu's **Split right/down** changes Herdr's layout.
- **Golden Layout component state** vs Herdr snapshot state. The component state is only the
  `PaneRef`. Never store snapshot data in it.

## Checklist

- [x] `scripts/vendor-golden-layout.sh`; vendored `golden-layout.mjs`, `css/`, `img/`, `LICENSE`, `VERSIONS` under `devc/web/static/vendor/golden-layout/`
- [x] `'.png': 'image/png'` in `devc/web/server.ts` `CONTENT_TYPES`
- [x] `devc/web/static/layout.js` implementing `createTiling` exactly as specified (the only Golden Layout importer)
- [x] `devc/web/static/lib/layout_state.js` with `paneRefFromState`, `tileTitle`, `parseSavedLayout`; tests in `devc/tests/web_layout_test.ts`
- [x] `app.js`: old tiling code removed; `TileView` keyed by `Tile.id`, built in `mount` and disposed in `unmount` with ref-counted close
- [x] Sidebar pane rows registered as drag sources; click opens in the focused tile or creates the first
- [x] Tab titles and agent badges kept current; hidden-tab resize suppression and refit on show
- [x] Empty-layout placeholder
- [x] `localStorage` `devc-web-layout-v2` save on change and restore; `v1` removed; "Pane gone" still shown
- [x] `index.html` links the Golden Layout CSS; `style.css` theme overrides; dead tiling CSS removed
- [x] Docs: `devc/README.md` `devc web` Tiles bullet (drag and drop, stacks, maximise); a note in `.plans/devc-web.md` "Tiling area" pointing here

## Validation

**Closed 2026-10-19 by the user:** the items below that were still open were accepted without being re-run for this close-out.

Automated:

- [x] `deno fmt --check` at the repo root passes
- [x] `cd devc && deno task check` and `deno task test` pass. `web_layout_test.ts` covers
      `paneRefFromState` (valid; missing or non-string fields → `null`), `tileTitle`, and
      `parseSavedLayout` (invalid JSON, no `root`, a valid saved layout)
- [x] `bash scripts/vendor-golden-layout.sh` run twice produces no diff
- [x] `cd devc && deno task build`; the binary serves `/vendor/golden-layout/golden-layout.mjs`
      (`text/javascript`) and `/vendor/golden-layout/img/lm_close_white.png` (`image/png`)

Manual (macOS host, two running devcontainers with Herdr sessions):

- [x] Drag a sidebar pane onto each edge of a tile and into its stack: a tile appears in each
      spot and renders that pane
- [x] Nest three levels (a column inside a row inside a column) and drag tiles between stacks;
      every terminal keeps rendering and accepting input after each move
- [x] Close and maximise tiles from their tab controls; closing the last tile shows the
      placeholder, and clicking a pane brings back a tile
- [x] The same pane in two tiles: closing one keeps the other live
- [x] A tile in a background stack tab, after its stack is resized, shows at the right size
      when brought to the front
- [x] Tab titles and agent badges update with `pane_updated` and agent status changes
- [x] Reload restores the exact layout, including stacks and the active tab in each; a closed
      pane's tile shows "Pane gone"; an old `v1` layout in `localStorage` loads as empty
      without errors
- [x] With external network blocked in devtools, the page loads fully, Golden Layout icons
      included

## Relevant Files

- `scripts/vendor-golden-layout.sh` (new)
- `devc/web/static/vendor/golden-layout/` (new, vendored)
- `devc/web/server.ts`: `.png` content type
- `devc/web/static/layout.js` (new)
- `devc/web/static/lib/layout_state.js` (new)
- `devc/web/static/app.js`: tiling replaced
- `devc/web/static/index.html`: Golden Layout CSS links
- `devc/web/static/style.css`: theme overrides, dead CSS removed
- `devc/tests/web_layout_test.ts` (new)
- `devc/README.md`, `.plans/devc-web.md`: docs
