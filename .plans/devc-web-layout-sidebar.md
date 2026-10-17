# devc-web-layout-sidebar

- [x] `lib/layout_state.js`: `foldTree` and `treeSignature`, with tests in `devc/tests/web_layout_test.ts`
- [x] `layout.js`: `tree()`, `reveal()`, `addBeside()`, `close()`, and header context-menu hooks
- [x] Server: `new_shell` message (`tab.create` + find its pane), `REQUEST_METHODS` cut to `pane.rename`, `pane.close`
- [x] Sidebar: **Layout** section mirroring Golden Layout, **Projects** section without Herdr tabs, visible-pane marker
- [x] Context menus by node type (table below); Herdr split/tab actions removed
- [x] Click semantics: focus a visible pane's tile, else open in the focused tile; Ctrl/⌘-click opens a new tile
- [x] `.plans/devc-web.md` protocol section updated for `new_shell` and the smaller allowlist
- [ ] Verify (below) and ask the user to try it in their open tab

Make `devc web`'s sidebar use the browser's own window-management words. The tiling area (Golden
Layout) owns **all** layout; Herdr is only where panes (processes) live. The browser never splits a
Herdr pane, and it never shows Herdr tabs. Every pane it creates gets its own Herdr tab
(`tab.create`), and that tab is never shown. Panes that the Herdr TUI split into a shared tab
are just more panes: the page already gets every pane flat in `snapshot.panes`.

The sidebar gets two sections:

```
LAYOUT
  ⬌ row
    ▣ stack
      api · claude        ● working
      api · shell
    web · npm run dev
PROJECTS
  ▾ api                    ● blocked
      claude   👁
      shell    👁
      shell · scripts
  ▾ web
      npm run dev 👁
  ▸ Not running (2)
```

- **Layout** answers "where is it on screen". It is a live mirror of the Golden Layout tree, and
  it carries the layout actions.
- **Projects** answers "what is running". It lists every pane, whether or not a tile shows it,
  and it carries the process actions. A pane shown in a tile gets a marker (👁 above; use a
  small icon, not an emoji).

Builds on [devc-web](devc-web.md) and [devc-web-golden-layout](devc-web-golden-layout.md). It comes
before [devc-web-projects](devc-web-projects.md) and [devc-web-files](devc-web-files.md). Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first: the user runs `devc web` in live
mode, so every save reaches their tab.

## Concept boundaries

- **"Tab" means only a Golden Layout tab** (a tile's header tab inside a stack) anywhere a user
  can see it. Herdr tabs still exist in the protocol (`tab_id` on panes, `tab.create`), but the
  page shows no Herdr tab rows, labels or actions. `tabName`, `renameTabItem` and `newTabItem`
  go away. In code, call a Herdr tab a "Herdr tab" whenever the plain word could be misread.
- **Layout section ≠ `layout.js` ≠ Herdr layout.** Herdr has `layout.updated` events and a
  `pane.layout` method. They are about Herdr's split tree, which this plan ignores. The new
  sidebar section mirrors Golden Layout only. Name its code `layoutTree…` / `.row.layout-node`,
  never `herdrLayout`.
- **Close vs Kill.** **Close** removes a tile or a stack, and only the browser changes (the
  server-side `close` message already detaches the stream when the last tile goes). **Kill**
  ends the Herdr pane (`pane.close`), always after a `confirm()`. No menu item may say "Close"
  and mean Kill.
- **Projects section.** For now it lists running containers, exactly the set that the `containers`
  message carries today, plus the existing "Not running" group. It is named "Projects" now
  because [devc-web-projects](devc-web-projects.md) adds stopped and never-started projects to
  it. Rows stay keyed by `localFolder`, as they are now.
- **`paneRows`** (in `app.js`) keeps one row per pane across renders so that its Golden Layout
  drag source survives. That stays as it is for Projects rows. Layout rows are new, keyed by tile id,
  and are not drag sources. Rearranging happens in the tiling area. Dragging inside the sidebar
  tree is out of scope.
- **`tile.id`** (`t1`, `t2`, … from `layout.js`) lives only as long as the page and isn't saved. Layout
  node ids for rows, columns and stacks are the same kind of runtime id.

## Existing touchpoints

| File                                                                         | Role                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/static/layout.js`                                                  | The only Golden Layout importer (keep it that way). Gains the tree export, reveal/add/close, and header context-menu hooks.                  |
| `devc/web/static/lib/layout_state.js`                                        | Pure tiling helpers. Gains `foldTree` and `treeSignature`.                                                                                   |
| `devc/web/static/app.js`                                                     | `renderTree`, `containerRows`, `paneRow`, `paneMenu`, `openMenu`, `openInFocusedTile`, `onResult`, `request`. Most of the work happens here. |
| `devc/web/static/lib/sidebar.js`                                             | `tabName` is removed. `paneTitle` may need to prefer `pane.label` (see Behavior).                                                            |
| `devc/web/static/style.css`                                                  | Section headers, layout-node rows (row/column/stack icons), visible marker, highlighted row.                                                 |
| `devc/web/protocol.ts`                                                       | `REQUEST_METHODS`, `ClientMessage`, `parseFields`. Adds `new_shell`.                                                                         |
| `devc/web/server.ts`                                                         | `handle()`: a `new_shell` case next to `request`.                                                                                            |
| `devc/web/herdr_bridge.ts`                                                   | `bridgeRequest(target, method, params)`, used by `new_shell`. Add a `createShell` helper here.                                               |
| `devc/tests/web_layout_test.ts`, `web_server_test.ts`, `web_sidebar_test.ts` | Existing tests to extend or trim.                                                                                                            |

## Contracts

### `lib/layout_state.js` (pure)

```js
/**
 * @typedef {{kind: 'row' | 'column' | 'stack', id: string, children: LayoutNode[]}
 *   | {kind: 'tile', id: string, active: boolean}} LayoutNode
 * `id` of a tile node is its Tile.id; `active` is whether it is its stack's visible tab.
 */

/**
 * The tree the sidebar shows: a row, column or stack with exactly one child is replaced by
 * that child (recursively); an empty one is dropped. `null` in, `null` out.
 * @param {LayoutNode | null} node
 * @returns {LayoutNode | null}
 */
export function foldTree(node) {}

/**
 * A string that changes exactly when the tree's shape, its ids or any `active` flag changes —
 * so `app.js` re-renders on a move or a tab switch, not on every splitter drag.
 * @param {LayoutNode | null} node
 * @returns {string}
 */
export function treeSignature(node) {}
```

Tests cover these cases:

- **`foldTree`:** a single tile; a stack holding one tile; a row with one stack holding one tile
  (folds to the tile); nested single-child chains; a row with two children (kept); an empty stack
  (dropped).
- **`treeSignature`:** stable for equal trees; different after a reorder, an `active` change, or
  a node being added or removed.

### `layout.js` additions

```js
// createTiling(root, hooks): hooks gains
/** @property {(tile: Tile, e: MouseEvent) => void} tileMenu   right-click on a tile's header tab */
/** @property {(stackId: string, e: MouseEvent) => void} stackMenu  right-click on a stack header's empty area */

// the returned object gains
/** @returns {LayoutNode | null} the unfolded tree (app.js folds it) */
tree() {}
/** Brings `tileId` to the front of its stack and focuses it. No-op for an unknown id. */
reveal(tileId) {}
/**
 * A new tile showing `ref`, placed relative to `tileId`: 'right' / 'below' splits beside the
 * tile's stack (inserting into the parent row/column when its direction matches, else wrapping
 * the stack in a new row/column), 'stack' adds it to the tile's stack. `tileId` null (or
 * unknown) behaves like `add(ref)`. The new tile is focused.
 * @param {string | null} tileId
 * @param {PaneRef | null} ref
 * @param {'right' | 'below' | 'stack'} where
 * @returns {Tile}
 */
addBeside(tileId, ref, where) {}
/** Closes a tile, or every tile in a stack, by id (tile or stack id). */
close(id) {}
```

- **Ids for rows, columns and stacks:** they must stay the same for one Golden Layout item
  across `tree()` calls, so keep them in a `WeakMap` from the content item. Don't use Golden
  Layout's `id` config field: it is saved with the layout.
- **Context-menu listeners:** Golden Layout rebuilds tab elements whenever a tab moves.
  Attach the tile listener in the existing `tabCreated` handler, as `applyBadge` already does.
  For the stack menu, a delegated listener on the root that ignores clicks on `.lm_tab` works.
  Call `preventDefault()` in both.

### Protocol: `new_shell`

| Browser → server | Fields                                     | Server does                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_shell`      | `id`, `container`, `workspace_id?`, `cwd?` | `tab.create {workspace_id, cwd, focus: false}`. The result is `{type: "tab_created", tab: TabInfo}` and carries **no pane id**. Then `pane.list {workspace_id: tab.workspace_id}` and pick the pane with `tab_id === tab.tab_id`. Reply `result {ok: true, result: {pane_id, tab_id}}`, or `ok: false` with `code: "herdr_error"`. |

- **`createShell`:** put this in `herdr_bridge.ts`, typed as
  `createShell(target: HerdrTarget, opts: {workspace_id?: string, cwd?: string}): Promise<{pane_id: string, tab_id: string}>`.
  [devc-web-files](devc-web-files.md) reuses it.
- **No `workspace_id`:** omit it, so Herdr uses its default. That is fine, because the page
  always sends the workspace of the row it was invoked from (or the workspace of the focused
  tile's pane).
- **`focus: false`:** never move a Herdr TUI user's focus.
- **The allowlist:** `REQUEST_METHODS` becomes exactly `pane.rename` and `pane.close`. Remove
  `tab.create`, `tab.rename`, `tab.close` and `pane.split`, along with their tests and their
  lines in `.plans/devc-web.md`.
- **The page needs `pane_id` back.** `request()` in `app.js` is fire-and-forget today. Either
  give `new_shell` its own pending map, as `pendingSelections` does, or make `request()` return
  a promise. Either is fine.

### Menus

| Node                                 | Items                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Layout: tile (row, or GL tab header) | New shell to the right · New shell below · New shell in this stack · Reveal in Projects · Close · Kill pane… |
| Layout: stack                        | New shell in this stack · Close stack                                                                        |
| Layout: row / column                 | New shell at end                                                                                             |
| Projects: project (container) row    | New shell (goes to the focused tile's stack, or a fresh tile when the layout is empty)                       |
| Projects: workspace row              | New shell (in that workspace)                                                                                |
| Projects: pane row                   | Open in new tile · Show in layout (only when visible) · Rename… · Kill…                                      |

- **New shell:** `new_shell`, then place the result with `addBeside(…)` and the ref
  `{localFolder, pane_id}`. The tile appears before the snapshot that lists the pane does. Its
  overlay may say "Pane gone" for a moment, so let `reconcileTiles` treat an unknown pane as
  _pending_ (no message) for a short grace period after a `new_shell` the page itself sent.
- **The cwd** for a new shell is the pane's `foreground_cwd || cwd` when the menu is on a pane,
  and Herdr's default otherwise.
- **Rename** is `pane.rename`. **Kill** is `pane.close` behind a `confirm()`. In a throwaway session,
  check that killing the only pane in a Herdr tab also closes that tab. If it doesn't, have the
  server-side `pane.close` handling (or the page) follow up with `tab.close`, and keep `tab.close`
  in the allowlist after all.

### Sidebar behavior

- **Projects tree:** Container → (Workspace, only when there are several) → Pane. Herdr tabs no
  longer group anything. Pane order is Herdr's tab number, then pane order within the tab, which
  is the same order you see today with the tab rows removed.
- **Visible marker:** set on a pane row when any tile's `ref` matches it.
- **Click a pane row:**
  - if the pane is visible, `reveal` the most recently focused tile showing it;
  - otherwise, open it in the focused tile (today's `openInFocusedTile`).
  - Ctrl/⌘-click always opens a new tile via `addBeside(focused, ref, 'stack')`.
- **Click a Layout tile row:** `reveal(tileId)`.
- **Highlight:** the focused tile's Layout row and its pane's Projects row(s) get a
  `data-current` attribute. Hovering either row also highlights the other (CSS class toggle, no
  re-render).
- **Layout row label:** `tileTitle(...)`, as in the tile header, plus the agent `badge`.
  - Row and column nodes show a ⬌/⬍ glyph and no text. Use CSS or SVG, not emoji.
  - A stack node shows its tile count.
  - Stack, row and column nodes show the rolled-up badge of their tiles' panes (`rollupBadge`).
- **The Layout section is collapsible:** `sidebarState` gains `layoutOpen` (default `true`) under
  the existing `SIDEBAR_KEY`. When the layout is empty, the section shows "No tiles open".
- **Re-render** on `hooks.changed` only when `treeSignature(foldTree(tiling.tree()))` differs
  from last time. Re-render on snapshot events as now.
- **Renamed panes:** check whether a renamed pane's new name reaches `terminal_title_stripped`.
  If it doesn't, `paneTitle` should prefer a non-empty `pane.label`, and the tests should cover it.

## Implementation notes

- Herdr 0.9.5's `tab.create` result **does** carry `root_pane` (its bundled schema omits it).
  `createShell` uses it and only falls back to `pane.list`.
- Measured in a throwaway session: `pane.close` on a tab's only pane closes the tab, so
  `tab.close` stays out of the allowlist. `pane.rename` sets `label` and leaves
  `terminal_title_stripped` alone, so `paneTitle` prefers `label`.
- `addBeside` also accepts a stack, row or column id (a row or column appends a new stack), which
  the stack and row/column menus use.
- Row, column and stack rows in the Layout section show a small glyph plus a muted
  `<kind> · <tile count>` label, rather than a bare glyph, so they read at a glance.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Save the order so the user's tab keeps working:

1. `lib/layout_state.js`
2. `layout.js`
3. `protocol.ts` / `herdr_bridge.ts` / `server.ts`. The server restarts, and the page keeps
   working because nothing uses `new_shell` yet.
4. `app.js` / `style.css`

Then ask the user to check in their open tab:

1. Drag tiles into a nested arrangement. The Layout section should follow every move and tab
   switch, with single-child levels folded away.
2. Use New shell right / below / in stack from a tile's header. Each should land in the right
   place and show a prompt, with no lingering "Pane gone".
3. Click a visible pane under Projects: its tile comes to the front. Ctrl/⌘-click opens a second tile.
4. Close a tile: the pane's marker clears, and the pane is still listed and still running.
5. Kill a pane: after the confirm it disappears from both sections.
6. A pane split in the Herdr TUI shows up as an ordinary pane row.
7. Reload: the layout and the `layoutOpen` state are restored.
