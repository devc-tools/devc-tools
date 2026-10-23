# devc web: dragging from `/sidebar` into `/main`, and zen across reloads

Decided with the user on 2026-10-22. Phase 4 of 5 of running the sidebar and the tiling area as
separate pages. After [devc-web-sidebar-main-routes](archived/devc-web-sidebar-main-routes.md),
the `/sidebar` page's rows can't be dragged into a `/main` page: today's drag is Golden Layout's
pointer drag (`layout.js`'s `dragSource`), which can't leave its document, so the `/sidebar`
page's `tileArea.dragSource` (`static/remote.js`) does nothing. This plan uses native HTML drag and
drop across pages, and closes the zen gap phase 3 left. Phase 5 is the VS Code shell
(`devc-vscode`'s `.plans/devc-web-panels.md`, with
[devc-web-vscode-embedding](devc-web-vscode-embedding.md) in this repo).

## Checklist

- [x] 1. `lib/view.js`: the drag payload's MIME type, encoder and parser (pure, tested)
- [x] 2. `/sidebar`: `remote.js`'s `dragSource` makes rows native drag sources
- [x] 3. `tiles.js`: the tiling area accepts native drops of that payload, with a drop indicator
- [x] 4. Server: a view's last `setZen` is replayed to a `tiles` joiner (`web/views.ts`)
- [x] 5. Validation (below), then commit

## Touchpoints

| File | Role |
|---|---|
| `devc/web/static/lib/view.js` | `DRAG_MIME`, `encodeDrag`, `parseDrag` (below). |
| `devc/web/static/remote.js` | The `/sidebar` page's `tileArea.dragSource`: a native drag source instead of a no-op. |
| `devc/web/static/tiles.js` | A native `dragover`/`drop` handler on the tiling area's root, for every page that mounts tiles (`/` and `/main`), and the drop indicator. |
| `devc/web/static/style.css` | The drop indicator. |
| `devc/web/views.ts` | Keeps each view's last `setZen` `view_intent` and replays it to a `tiles` member on `join`. |
| `devc/tests/web_view_test.ts`, `devc/tests/web_views_test.ts` | Tests. |
| `.plans/archived/devc-web.md` | § Views: one line on the replay. |

`/`'s own drag (Golden Layout's, through `tiles.js`'s `tileArea.dragSource`) is unchanged.

## Contracts

### The drag payload (`lib/view.js`)

```js
/** The `DataTransfer` type of a sidebar row dragged into a tiling area. */
export const DRAG_MIME = 'application/x-devc-web-tile';

/**
 * What a row's drag carries: the content a dropped tile shows.
 *
 * @param {PaneRef | {file: FileRef}} ref
 * @returns {string}  JSON
 */
export function encodeDrag(ref) {}

/**
 * A drag payload back, or null for anything that isn't one: a `PaneRef` (two non-empty strings)
 * or `{file}` with a well-formed `FileRef` (as `layout_state.js`'s `fileRefFromState` accepts).
 *
 * @param {string} text
 * @returns {PaneRef | {file: FileRef} | null}
 */
export function parseDrag(text) {}
```

The payload is the same shape `tileArea.dragSource`'s `ref()` already returns. Nothing else is
in it: no token, no container id.

### Drag source (`/sidebar` page)

`dragSource(el, ref, title)` sets `el.draggable = true` and on `dragstart` puts
`encodeDrag(ref())` under `DRAG_MIME` and `title()` under `text/plain`, with `effectAllowed =
'copy'`. It returns a remover that undoes both. The rows that call it today (pane rows, file rows)
are the only drag sources.

### Drop target (every tiling area)

- `dragover` on the tiling area's root with `DRAG_MIME` among `dataTransfer.types` is accepted
  (`preventDefault`, `dropEffect = 'copy'`); others are left alone, so Golden Layout's own drags
  and text drops into a file viewer are unaffected.
- Where it lands, from the pointer: over a tile (its body or its tab), `at` is that tile. In its
  right quarter → `'right'`, its bottom quarter → `'below'`, else `'stack'`. Over no tile (an
  empty layout) → a new tile where `tileArea.openPane` would put one with no `at`.
- On `drop`: `parseDrag` the data; null is ignored. A pane opens as a new tile (not a preview)
  placed as above. A file opens as a new file tile placed the same way: a tile already showing it
  is **not** reused (an explicit drag asks for a tile there). The new tile is focused.
- While dragging over, a translucent indicator shows the target region (the tile's right quarter,
  bottom quarter or whole body); it goes on `dragleave` of the root, `drop` and `dragend`.
- The drop is handled inside `tiles.js` with its own placement functions; `ViewIntents` does not
  change (an intent's `openFile` has no `at`, and needs none for this).

### Zen replay (server)

`ViewRegistry` keeps, per view, the `args` of the last `view_intent` named `setZen` from a sidebar
member. When a member joins as `tiles` and the view has one, `join` also returns a delivery of
`{type: 'view_intent', view, name: 'setZen', args}` to that member, after nothing else (tiles
joiners get no state). It is dropped with the view.

## Concept boundaries

- **Native drag vs Golden Layout drag.** `layout.js`'s `dragSource` is Golden Layout's
  (pointer events, same document). This plan's is HTML5 drag and drop
  (`draggable`/`DataTransfer`). In `/`, rows keep Golden Layout's; only `/sidebar` uses native.
- **`DRAG_MIME`'s payload is a tile ref, not a file path for the OS.** Don't put a `text/uri-list`
  or a host path in it: a drop on VS Code's editor area or the desktop must not open anything.
- **Zen replay is the only state the server keeps for a view besides `view_state`.** Don't add
  other replayed intents.

## Validation

Done 2026-10-23: 1–4 pass (643 tests; `deno fmt --check` flags only the 4 plan docs it flagged
before). 3–4 ran in Playwright's Chromium 1140 via `agent-browser` against a real server (stub
`docker`, scratch `HOME`): drops landed in an empty layout, right, below and in the stack (body
and tab), a file already shown got a new tile, junk payloads and plain `text/plain` drags were
ignored; the `/sidebar` drag source set both types and its remover undid it; Golden Layout tab
drags still worked; zen came back on a `/main` reload (on, then off, then on) and not in another
view. The text-into-a-file-tile check could only be done as "not accepted" (no container to read
a file from). A synthetic `dragstart` reads `effectAllowed` back as `none`; real drags set it.

1. `cd devc && deno check main.ts && deno task check && deno task test`; `cd .. && deno fmt --check`
   reports nothing new.
2. Unit tests: `encodeDrag`/`parseDrag` round-trip a pane and a file and reject junk;
   `ViewRegistry` replays the last `setZen` to a tiles joiner only, the latest one wins, and none
   is replayed for a view that never had one.
3. Headless browser against a real server (the `devc-web` skill's stub-`docker` recipe, spare
   port) or the two-tab fake-server relay phase 3 used: `/sidebar` and `/main` with one view id.
   Native drag events can't be produced by synthetic mouse moves; dispatch `dragstart` on a row
   (with a real `DataTransfer` object), then `dragover`/`drop` on the main page's tiling area with a
   `DataTransfer` carrying the same data, and check the tile lands in each region (right,
   below, stack, empty layout). Check `/` still drags rows into its layout through Golden Layout,
   and that a text selection dragged into a file tile still inserts text.
4. Zen: with the sidebar page in zen, reload the main page: it comes back in zen.
5. (Left to the user.) The user runs `devc web --live` with the installed server: the drop target and drag source are
   page code and reload live; the zen replay needs the checkout's server, so it arrives with their
   next restart.

Commit with a message in the repo's style (`devc web: …`).
