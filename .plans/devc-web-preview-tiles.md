# devc-web-preview-tiles

- [x] `layout.js`: a tile can be a **preview**: saved in its component state, its tab title in italics, `setPreview`, and a hook for a double-click on its tab
- [x] `lib/layout_state.js`: `previewFromState`, with tests; the ref parsers ignore the new key
- [x] Page: clicking a terminal (or a file) that isn't shown opens it in the focused stack's preview tile, creating one if there is none
- [x] Page: pinning: double-click the tab or the sidebar row, typing into the terminal, dragging the tile, or "Keep open" in the tile menu
- [x] Page: the Layout section's row for a preview tile is italic too
- [x] `.plans/devc-web.md` "Browser UI" section updated
- [x] Verify (below) and ask the user to try it in their open tab

Clicking a terminal row today **replaces** what the focused tile shows (`openInFocusedTile`). If
you're reading one terminal and click another to glance at it, the first one leaves the layout.
This plan makes devc web behave like VS Code's preview editors:

- A click opens the terminal in a **preview tile**: a new tab in the focused stack, its title
  in _italics_.
- Clicking another terminal **replaces the preview tile's content**, not the tile you were
  working in.
- **Double-clicking** the tab (or the sidebar row) makes it stick: the title turns upright, and
  the next click opens a new preview tile beside it.

Files get the same behavior: clicking a file today opens a new tile every time, which piles up
tabs.

Page only, with no protocol change, so it works under plain `--live`. Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first.

## Deviations (implementation)

- **Typing pins through xterm's `onData`** (and paste), not a raw keydown, so only input that
  reaches the terminal counts.
- **`layout.js` gained `replace(tileId, ref)`** for a preview whose content changes kind (file ↔
  terminal), and for file → file: a file tile can't switch files in place. Same stack, same
  position.
- **`openInFocusedTile` is gone:** its only caller was the plain click.
- **An empty focused tile** (no terminal yet) takes a clicked terminal as a preview, as it used
  to take it outright.

## Concept boundaries

- **Preview vs pinned is a tile property, not a terminal or file one.** The same terminal can't
  be in two tiles anyway (`tileShowing`), but the flag lives on the tile, in its Golden Layout
  component state, next to the `PaneRef` or `FileRef`. Nothing about it reaches the server or
  Herdr.
- **One preview tile per stack**, as VS Code has one per editor group. "The preview tile" means
  the focused stack's.
- **Ctrl/Cmd-click stays "open in a new pinned tile"** (`openInNewTile` today). Menu items that
  say where to open ("Open in new tile", "Open to the right", the + menu, "Open/New terminal
  here", `createPane`) open **pinned** tiles: choosing a place is deliberate.
- **Replace vs close.** Replacing a preview tile's terminal detaches the tile from it
  (`closeTilePane`, as `openInFocusedTile` does). The terminal keeps running in Herdr. It is not
  "Close terminal…".

## Existing touchpoints

| File                                  | Role                                                                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/static/layout.js`           | Component state, `Tile`, tab (re)creation (`applyBadge` is the pattern for decorating a tab that Golden Layout rebuilds), drag end, the hooks.                                                             |
| `devc/web/static/lib/layout_state.js` | `paneRefFromState`, `fileRefFromState` (they already ignore unknown keys; keep it so), a new `previewFromState`. Tested in `devc/tests/web_layout_test.ts`.                                                |
| `devc/web/static/app.js`              | `onPaneClick`, `openInFocusedTile`, `openFileTile`, `fileEntryRow`, `tileMenuItems`, `fileTileMenuItems`, `layoutTileRow`, `layoutFileTileRow`, the terminal input path (`encodeInput` callers), `LABELS`. |
| `devc/web/static/style.css`           | Italic tab title (Golden Layout's `.lm_title`) and Layout row label for previews.                                                                                                                          |
| `.plans/devc-web.md`                  | "Browser UI": how clicks open tiles.                                                                                                                                                                       |

## Contracts

### Layout (`layout.js`, `lib/layout_state.js`)

- **Component state** gains `preview: true` on preview tiles. It's absent on pinned ones (so
  every saved layout from before loads as pinned).
- `previewFromState(state): boolean`: true only for `state.preview === true`. Pure, tested.
- `Tile` gains:
  - `preview: boolean`;
  - `setPreview(on: boolean)`: persists it into the component state and re-applies the tab's
    styling.
- **The tab title is italic** while `preview` is true: a class on the tab element, re-applied
  whenever Golden Layout rebuilds the tab (moves, restores), the same way `applyBadge` keeps
  the badge.
- **New hook** `tabDoubleClick(tile)`: a double-click on a tile's tab title.
- `add`, `addBeside` and `dragSource` take an optional `{preview: true}` so a tile can be
  created as a preview.
- **A dragged tile becomes pinned:** a tile moved by dragging its tab calls `setPreview(false)`
  (moving it is deliberate). A preview tile dropped from a sidebar drag is pinned too.

### Page

- **Click a terminal row** (no modifier):
  1. A tile already shows it → reveal it, as now.
  2. Else the focused stack has a preview tile → that tile switches to this terminal (detach
     the old one, `setRef`, reveal and focus it).
  3. Else a new tile is added to the focused stack (`placeInFocusedStack`) with `preview: true`.
  - "The focused stack" is the stack of `targetTile()`. With an empty layout, the new preview
    tile becomes the layout.
  - A file preview tile counts as the stack's preview tile: clicking a terminal **replaces**
    it with a terminal tile. The component type changes, so this is close + add in the same
    stack position, still a preview.
- **Click a file row**: the same three steps, with `tileShowingFile`, and the file's `FileRef`.
- **Pinning** (`setPreview(false)`), any of:
  - double-click the tile's tab (`tabDoubleClick`);
  - double-click the terminal's or file's sidebar row (opens it as above, then pins it);
  - the first keystroke or paste sent to a preview terminal (typing into it means you're using
    it, like editing a file in VS Code);
  - dragging the tile;
  - **Keep open** in the tile's menu and its Layout row's menu (only shown on previews).
- **Layout section:** a preview tile's row has an italic label.
- **Labels:** `LABELS.keepOpen: 'Keep open'`.
- **A restored preview tile is still a preview** (the flag is in the saved layout).

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

In a headless page with a fake WebSocket (see the devc-web skill), open one tile on terminal
A, then:

- click terminal B: a second tile appears in the same stack, its tab title italic; A's tile
  still shows A;
- click terminal C: the italic tile now shows C (B is no longer in any tile); still two tiles;
- double-click the italic tab: upright; click D: a third, italic tile;
- type into the D tile: its title turns upright;
- click a file, then a terminal: the file preview is replaced by the terminal preview, in the
  same place;
- reload: preview tiles come back italic.

Then ask the user, in their open tab:

1. Click a terminal: it opens in a new italic tab next to what you had. Click another: it
   replaces the italic one, not your tile.
2. Double-click the italic tab: it sticks (upright); the next click opens a new italic tab.
3. Type into a preview terminal: it sticks.
4. Files behave the same.
