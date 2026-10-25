# devc-web-dashboard

> **Revised after it landed:** the dashboard is no longer a pin flag. Any repo file can be it
> (**Use as dashboard** wherever **Pin file** is offered), kept in
> `~/.config/devc/dashboard.json` by `devc/web/dashboard.ts`; `set_dashboard` takes
> `file: {localFolder, root, path} | null`, and a `dashboard` message replaces the pin's
> `dashboard` field. The header button, the file tile and opening into an empty area are as below.

## Checklist

- [x] `devc/web/static/sidebar.js`: a pin's row menu gains **Preview** (previewable files) and
      **Open in browser** (HTML files). Page only; works under `--live` on its own
- [x] `devc/web/pinned_files.ts`: optional `dashboard: true` on `FilePin`, kept by
      `readPinnedFiles`, sent by `pinnedFilesMessage`; pure `setDashboardPin(pins, id | null)`.
      Tests in `devc/tests/web_pinned_files_test.ts`
- [x] `devc/web/protocol.ts` + `devc/web/server.ts`: `set_dashboard` message. Tests in
      `devc/tests/web_server_test.ts`
- [x] `devc/web/static/lib/pinned_files.js`: `parsePinnedFiles` keeps `dashboard`;
      `dashboardPin(pins)`. Tests in `devc/tests/web_pinned_files_page_test.ts`
- [x] `sidebar.js`: pin row menu **Use as dashboard** / **Stop using as dashboard**; the
      dashboard pin's row carries a mark
- [x] `index.html`, `sidebar.html`, `sidebar.js`: the header's **Dashboard** button
- [x] Tiling page (`tiles.js` or the module that owns the tile area): opens the dashboard when
      the tiling area is empty (see Contracts, "Opening by itself")
- [x] `devc/README.md`: a **Dashboard** bullet next to **Pinned files and notes**;
      `.plans/archived/devc-web.md`: the `pinned_files` row and a `set_dashboard` row

A **dashboard** is one pinned file the user marks as the place every session starts, such as a
generated `dashboard.html` or a `focus.md`. A header button opens it in one click, and devc web opens
it by itself when no tiles are open. Which file it is lives with the pins in
`~/.config/devc/pinned-files.json`, so each machine has its own (work and home differ), and the
browser and devc-desktop windows agree.

Read `.claude/skills/devc-web/SKILL.md` first if it exists. The user runs `--live`: the first
checklist item reaches them at once, and the rest needs `--live-yolo` or an updated `devc`.

## Concept boundaries

- **Dashboard ≠ a new kind of pin, file or tile.** It is a flag on an existing file pin, and it
  shows in an ordinary file tile. There is no new storage file and no new tile type. Code says
  `dashboard` / `dashboardPin`, never "home" or "start page".
- **Not pinned projects, and not a preview tile's "Keep open".** The pinned-files module already
  keeps these three apart (see its header comment), and this plan adds no fourth meaning of "pin".
- **A file tile, not the pin's editor pane.** Clicking a pin row still opens its editor
  (`open_pinned`). The dashboard always opens with `openFileTile`: a media view for `previewable`
  files (HTML, SVG) or images, and the text viewer for anything else. It never starts a container
  or Herdr, so it opens whether or not the project's container runs.
- **At most one dashboard.** Unpinning the dashboard's file removes the dashboard with it.
- **Opening it in a browser tab** is the existing `openInBrowser(fr, path)`, unchanged.

## Contracts

### `pinned-files.json` and the `pinned_files` message

`FilePin` gains `dashboard?: true`. It is written only when true, and at most one pin carries it.
`readPinnedFiles` keeps the flag on the first pin carrying it and drops it from any later pin.
`pinnedFilesMessage` sends it (only `last` stays private). The file's `version` stays `1`.

```ts
/** Marks `id` as the dashboard and clears every other pin's flag; null clears all. Pure.
 *  Returns null when `id` names no pin; returns `pins` itself when nothing changes. */
export function setDashboardPin(
  pins: FilePin[],
  id: string | null,
): FilePin[] | null;
```

### `set_dashboard` (page → server)

| Type            | Fields                          | Behaviour                                                                                                                                                                  |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set_dashboard` | `id`, `pin` (string, or `null`) | `setDashboardPin` through `changePinnedFiles`; an unknown pin is `not_found`; a store error is `pinned_files_error`. `result {}`. Every client gets the new `pinned_files` |

`protocol.ts`: `pin` must be a non-empty string or `null`, else `Invalid`.

### Page helpers (`static/lib/pinned_files.js`)

```js
/** The pin marked as the dashboard, or null. @param {FilePin[]} pins @returns {FilePin | null} */
export function dashboardPin(pins)
```

`FilePin`'s typedef gains `dashboard?: true`. `parsePinnedFiles` keeps it only when it is exactly
`true`.

### Pin row menu

After the open items, in this order:

- **Preview**: only when `previewable(path)` is true. `openFileTile(fr, path, 'stack', 'media')`
- **Open in browser**: only when `mediaKind(path) === 'html'`. `openInBrowser(fr, path)`
- then, beside **Rename…**: **Use as dashboard** (`set_dashboard {pin: pin.id}`), or **Stop
  using as dashboard** on the current dashboard (`set_dashboard {pin: null}`). A failure is an
  `errorToast`, as `rename_pin`'s is.

The dashboard pin's row shows a small dashboard glyph (`aria-label="Dashboard"`) before its label.

### Header button

- `<button class="sidebar-toggle" id="dashboard" type="button">` with an inline SVG (a 2×2 grid of
  rounded squares, 16×16 viewBox, stroke-only like its neighbours). It goes immediately before
  `#copy-url` in **both** `index.html` and `sidebar.html`.
- `title` / `aria-label`: `Open dashboard (<pin name>)` while one is set, else
  `Dashboard: right-click a pinned file → Use as dashboard`.
- Click with a dashboard set: if a tile shows that file, reveal it and reload it (the file may have
  been regenerated). Otherwise open it as in Concept boundaries, `'stack'`. Click without one:
  a `toast` with the same hint as the title.
- On the split pages, the sidebar page sends the open through the existing view intents
  (`tileArea.openFile` already crosses to `/main`). A reveal plus reload needs no new intent if
  `tileArea.reload` crosses too; otherwise add one alongside `openFile` in `lib/view.js`'s
  contract.

### Opening by itself

The page that owns the tiling area (`/` or `/main`) opens the dashboard (`'stack'`, no reload)
when **both** are true:

1. it has a dashboard pin (from `pinned_files`), and
2. the tiling area holds no tiles, either
   - once at startup, after the saved layout is restored and the first `pinned_files` arrives, or
   - right after a close leaves it empty, **unless** the tile just closed was the dashboard's own
     (closing the dashboard last must leave the area empty, not reopen it).

Marking a pin as the dashboard while the area is empty opens it too (rule 2's startup case
counts as "now").

## Verify

`deno task check`, `deno task test` (in `devc/`), and `deno fmt --check` at the repo root. Then the
page by `agent-browser` with a fake WebSocket (see the skill): a `pinned_files` message with
`dashboard: true` on an HTML pin and an empty layout opens one media file tile; closing it leaves
the area empty; the header button reopens it.

## Out of scope

- Reloading a dashboard tile when its file changes on disk (the button reloads it)
- A dashboard per project, or several dashboards
- A config-file setting for the dashboard (`config.json`): marking a pin replaces it
