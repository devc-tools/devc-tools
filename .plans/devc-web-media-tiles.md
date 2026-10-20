# devc-web-media-tiles

## Checklist

- [x] `static/lib/media.js`: `mediaKind(path)`, `defaultView(path)`, with tests
- [x] `FileRef` gains `view?: 'text' | 'media'`; `layout_state.js` round-trips it, and file identity (`fileKey`, `tileShowingFile`, same-file checks) includes the effective view, with tests
- [x] File tiles mount a media view instead of CodeMirror when the effective view is `media`: an image view and an HTML view
- [x] Image view: fit / 1:1 zoom, checkerboard behind transparency, pixelated scaling when enlarged, a dimensions line
- [x] HTML view: sandboxed `<iframe>`; **Reload** re-mints the preview URL
- [x] Menus: **Preview** / **Preview to the right** for HTML and SVG; **Open as text** for SVG; image files open as media
- [x] A successful save in a text tile reloads media tiles showing the same file
- [ ] devc-desktop: the iframe loads, and its links and popups behave (see Verification) — not verifiable from the container; left for a by-hand check
- [x] `devc/README.md` (devc web, "Files and editing") updated

File tiles in `devc web` can show a file as media rather than text:
- an **image** (`.png`, `.gif`, `.jpg`, …), drawn as an image;
- an **HTML page**, rendered in a sandboxed iframe inside a tile.

The existing **Open in browser** (a separate browser tab, or the system browser in devc-desktop)
stays as it is.

Both views load through the existing preview URLs (`preview_file` / `preview_container_file` →
`/preview/<nonce>/<path>`), so the server needs no change. Those URLs already serve images with
their MIME type, and HTML with its neighbouring files and a `sandbox` CSP. The page's CSP
(`default-src 'self'`) already allows same-origin `<img>` and `<iframe>`, and preview responses
send no `frame-ancestors`.

[devc-web-aseprite-viewer](devc-web-aseprite-viewer.md) adds a third media kind on top of this
plan.

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Existing touchpoints

- `devc/web/static/app.js`:
  - `mountFileTile`, `loadFile`, `updateFileOverlay`, `reloadFile`, `saveFile`: the file tile
    lifecycle.
  - `openFileTile`, `fileKey`, `tileShowingFile`: file identity.
  - `fileMenuItems`, `fileTileMenuItems`: menus.
  - `openInBrowser`: shows how to call the preview messages and turn `result.path` into a URL.
  - `isHtmlPath`: replaced by `mediaKind`.
  - The sidebar's file drag: uses the default view.
- `devc/web/static/lib/layout_state.js`: `FileRef`, its parse from component state, and
  `tileContent`.
- `devc/web/static/style.css`: the `.file-view` rules.
- `devc/web/preview.ts`: read only, for the MIME table and headers. No change expected.

## Concept boundaries

- **Preview tile vs. `view: 'media'`.** "Preview tile" already means the single reusable tile
  that a click opens (`tile.preview`, `openInPreview`, `keepOpen`). It has nothing to do with
  media. A media view can sit in a preview tile or in a kept tile. Name the new things "media
  view" / `view: 'media'`, never "preview tile". The menu label **Preview** is fine: it is
  user-facing and means "render it".
- **Preview URLs are not a new message.** `preview_file` / `preview_container_file` and
  `/preview/<nonce>/…` are reused unchanged. A nonce can be evicted (`MAX_PREVIEWS`), so a media
  view mints a fresh URL on each load and reload rather than keeping one.
- **Media views are read-only.** They are never dirty, never editable, and never promoted from a
  preview tile by an edit.

## Contracts

### `static/lib/media.js`

```js
/** @returns {'image' | 'html' | null} by lowercase extension */
export function mediaKind(path)
/** 'media' for images other than SVG, else 'text' */
export function defaultView(path)
```

- `image`: `.png .jpg .jpeg .gif .webp .avif .bmp .ico .svg`.
- `html`: `.html .htm .xhtml`.
- An SVG is `image`, but its default view is `text`: it is source people edit.

### `FileRef`

```js
/** @typedef {{localFolder, root, path, container?: true, view?: 'text' | 'media'}} FileRef */
```

- The effective view is `ref.view ?? defaultView(ref.path)`.
- `view` is saved in component state only when it differs from the default, so saved layouts
  from before this change load unchanged.
- `view: 'media'` on a path with `mediaKind === null` is treated as `text`.
- The same file in `text` and in `media` is two different files for `tileShowingFile` and
  `fileKey`. Source and rendering can sit side by side, and **Open** on one never reveals the
  other.

### Image view

- `<img>` with `src` set to the minted preview URL, centred, over a CSS checkerboard.
- Clicking toggles between **fit** (the default: scaled down to fit, never enlarged) and **1:1**
  (scrolls when larger than the tile).
- Whenever the drawn size is larger than the natural size, use `image-rendering: pixelated`, so
  pixel art stays crisp.
- A small corner line shows `W × H`, read from `naturalWidth` / `naturalHeight` once loaded.
- An `<img>` `error` → the tile's error overlay ("Couldn't show <name> as an image").

### HTML view

- `<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads">`. This
  is the same set as `previewHeaders()`'s CSP, and never `allow-same-origin`.
- `src` is set to the minted URL, and the iframe fills the tile.
- The tile's `contextmenu` handler covers the margins only. Right-clicks inside the frame belong
  to the page.

### Loading, errors, reload

- A load calls `preview_container_file` (container file; the container must be running, else the
  existing `LABELS.notRunning` overlay) or `preview_file`. It then sets `src` from
  `new URL(result.path, location.origin)`.
- Call errors use the existing overlay states (`view.state = 'error'`).
- **Reload** (the tile menu) mints again and resets `src`.
- After `saveFile` succeeds, every media view whose `FileRef` names the same file (ignoring
  `view`) reloads.

### Menus

- `fileMenuItems`:
  - For an `image` path other than SVG, **Open** / **Open to the right** open the media view.
    **Open in editor** stays.
  - For `html` and SVG, **Preview** and **Preview to the right** open `view: 'media'`, next to
    **Open in browser**.
  - For SVG, **Open** opens text.
- `fileTileMenuItems`:
  - A media tile on SVG or HTML offers **Open as text**.
  - A text tile on SVG or HTML offers **Preview**.
  - A media tile has **Reload** and no **Save**.

## Verification

- Unit tests:
  - `mediaKind` / `defaultView`, including case-insensitivity and an unknown extension.
  - `FileRef` round-trip with and without `view`; a saved layout without `view` parses unchanged.
- In `devc web --live`, by hand:
  - Open a repo `.png` and a `.gif` (it animates). Toggle fit and 1:1.
  - Open a container `.jpg` under Files, then stop the container: the tile shows the not-running
    overlay.
  - **Preview** an HTML file whose CSS and images sit beside it: they load.
  - Edit the HTML in a text tile beside it, then save: the preview reloads.
  - Open an SVG as text and as media side by side.
  - Restore a layout saved before the change.
- In devc-desktop:
  - The iframe renders.
  - A link with `target=_blank` opens in the system browser, as `setWindowOpenHandler` directs.
  - A plain link navigates the iframe only, and never the devc view. The main frame's
    `will-navigate` guard does not cover subframes, so confirm this by hand and note it.
