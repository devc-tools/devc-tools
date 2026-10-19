# devc-web-sidebar-resize

- [x] `clampSidebarWidth` in `devc/web/static/lib/sidebar.js`, with tests in `devc/tests/web_sidebar_test.ts`
- [x] Saved sidebar state gains `width` and `hidden` (same `localStorage` key, old values still load)
- [x] Resize handle between the sidebar and the tiles: drag to resize, double-click to reset
- [x] Hide button in the sidebar header; show button over the tile area while hidden
- [x] Verify (below) and ask the user to try it in their open tab

Make `devc web`'s sidebar **resizable** (drag its right edge) and **hideable** (it disappears
completely, and a small button over the tiles brings it back). Both survive a reload. This is a
page-only change: no server, protocol or Golden Layout changes.

Builds on [devc-web](devc-web.md) ("Browser UI → Sidebar") and
[devc-web-golden-layout](devc-web-golden-layout.md). Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first: the user runs `devc web` in live
mode, so every save reaches their tab.

## Concept boundaries

- **"Collapsed" is already taken.** `sidebarState.collapsed` in `app.js` is the set of
  _containers_ folded in the tree, and `toggleContainer` toggles it. Hiding the whole sidebar is
  a different thing. Call it **hidden** (`hidden`, `toggleSidebarHidden`, the `data-sidebar`
  attribute below). Never call it "collapse".
- **`.lm_splitter`** is Golden Layout's splitter between tiles. The new handle is not a
  Golden Layout item. Give it its own class (`.sidebar-resizer`) and don't reuse `lm_` names, so
  the theme rules in `style.css` don't style it by accident.
- **Sidebar rows are Golden Layout drag sources** (`newDragSource` in `layout.js`). The resize
  handle is outside `#tree` and must not start a pane drag.

## Existing touchpoints

| File (under `devc/web/static/`)  | Role                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                     | Gains the handle element (between `<aside class="sidebar">` and `<main class="tiles">`), the hide button in `.sidebar-header`, and the show button. No inline `<script>` (CSP).   |
| `style.css`                      | `.app` is already `grid-template-columns: var(--sidebar-width) 1fr`, with `--sidebar-width: 280px` on `:root`. Add a column for the handle, the hidden state and the two buttons. |
| `app.js` § Sidebar               | `SIDEBAR_KEY`, `loadSidebarState`, `saveSidebarState`. Extend them and wire up the handle and the buttons.                                                                        |
| `lib/sidebar.js`                 | Pure helpers. Add `clampSidebarWidth`.                                                                                                                                            |
| `devc/tests/web_sidebar_test.ts` | Existing tests for `lib/sidebar.js`.                                                                                                                                              |

## Contracts

### Saved state

The key stays `devc-web-sidebar-v1`. The JSON gains two optional fields:

```json
{
  "collapsed": ["/path/a"],
  "inactiveOpen": false,
  "width": 320,
  "hidden": false
}
```

- `width`: the user's chosen width in CSS px. If it is missing or not a finite number, use the
  default of 280. Clamp it on load (the window may be smaller now).
- `hidden`: `true` only when it is exactly `true`.
- Values saved before this change (no `width`/`hidden`) load as width 280, not hidden.
  `saveSidebarState` writes all four fields.

### `clampSidebarWidth` (`lib/sidebar.js`)

```js
/** Sidebar bounds in CSS px. */
export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_DEFAULT_WIDTH = 280;

/**
 * Clamps a sidebar width to [SIDEBAR_MIN_WIDTH, max(SIDEBAR_MIN_WIDTH, floor(viewportWidth * 0.6))].
 * A non-finite `width` gives SIDEBAR_DEFAULT_WIDTH, clamped the same way.
 *
 * @param {number} width
 * @param {number} viewportWidth  window.innerWidth
 * @returns {number} an integer
 */
export function clampSidebarWidth(width, viewportWidth) {}
```

Tests cover: in range (unchanged, rounded), below min, above 60%, a tiny viewport (min wins),
and `NaN`/`Infinity` (default).

### DOM and CSS

- The `.app` element carries `data-sidebar="shown" | "hidden"` and an inline
  `--sidebar-width: <n>px`. That is a runtime value, so it is set with
  `style.setProperty`. The `:root` default stays as the fallback.
- **Shown:** columns are `var(--sidebar-width) <handle> 1fr`. The handle is a narrow strip
  (about 5px wide, with `cursor: col-resize`). On hover and while dragging, it uses the same
  accent color as `.lm_splitter:hover` so the two read as one family.
- **Hidden:** the sidebar and the handle take no space (column width 0, `display: none`),
  and the tiles fill the window.
- **Hide button:** an icon button in `.sidebar-header`, labeled "Hide sidebar" (`aria-label`
  and `title`).
- **Show button:** a small fixed-size button (about 22×20px, roughly Golden Layout's header
  height) at the top-left corner of `.tiles`, shown only while hidden. It is labeled
  "Show sidebar". It sits on top of the top-left stack's header, so while hidden, every
  `.lm_header` gets left padding equal to the button's width. That way no tab is covered.
  Scope that padding to `.app[data-sidebar='hidden']`.
- No keyboard shortcut: the focused terminal takes all keys.

### Behavior

- **Drag the handle:** use pointer events with `setPointerCapture`. The new width is the
  pointer's `clientX`, clamped with `clampSidebarWidth`. Set it live while the pointer moves,
  and save it on `pointerup`. While dragging, set `user-select: none` on the body and stop
  the event from reaching Golden Layout or the terminals.
- **Double-click the handle:** reset to `SIDEBAR_DEFAULT_WIDTH` and save.
- **Window resize:** re-clamp the width that is in effect, but don't save it, so the user's
  chosen width comes back when the window grows again.
- **Hide/show:** flip `hidden`, update `data-sidebar`, and save.
- **Tiles and Herdr:** you don't need to resize anything by hand. Golden Layout has
  `resizeWithContainerAutomatically`, and each tile's `ResizeObserver` debounces its
  `resize` to Herdr (`RESIZE_DEBOUNCE_MS`). Check that a long drag doesn't flood the socket.
  It shouldn't, because the debounce is per tile.
- **Safe mode** (`/safe/`) gets the same behavior. Nothing here touches the server.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Then ask the user to check in their open tab:

1. Drag to resize and release.
2. Reload: the width should be kept.
3. Double-click the handle: it resets.
4. Hide, then reload: still hidden, and no tab title is covered.
5. Show it again.
6. Drag a pane from the sidebar into a tile (this should still work).

Save `lib/sidebar.js` before the `app.js` edit that imports from it.
