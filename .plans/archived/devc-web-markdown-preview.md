# devc-web-markdown-preview

## Checklist

- [x] `static/lib/media.js`: a third media kind, `markdown` (`.md .markdown .mdown .mkd`), default view `text`, so it is `previewable` like HTML and SVG
- [x] `static/lib/rendered.js` (pure): the renderer registry (`renderedKind`), Markdown block line ranges, and a patch's change marks per block, with tests
- [x] `viewer.js`: `markdownBlocks(text, opts)` renders Markdown block by block through the bundled `marked`, sanitized (`sanitizeRenderedHtml`), code blocks highlighted
- [x] File tiles: a `markdown` media view renders the file's text; relative images load through a minted preview URL; links behave (below)
- [x] `DiffRef` gains `view?: 'media'`, only for a path whose `renderedKind` is non-null; `layout_state.js` round-trips it; `diffKey` / `sameDiff` include it, with tests
- [x] Diff tiles with `view: 'media'`: the new side rendered, changed blocks barred green, deletions marked red; a removed file renders its old side all red
- [x] Menus: **Preview** / **Preview to the right** on a Markdown diff's rows (Changes, PR tree, commit files) and its diff tile; **Open as diff** on a rendered diff tile
- [x] `devc/README.md` ("Files and editing") updated
- [x] Mac apps rebuilt (`style.css` changes)

`devc web` already previews HTML and SVG: **Preview** / **Preview to the right** open a second file
tile with `view: 'media'` and a muted `Preview` title, **Open as text** goes back, and a save in a
text tile reloads every media tile on the same file
([devc-web-media-tiles](archived/devc-web-media-tiles.md)). Markdown joins that model unchanged,
and diff tiles get the same **Preview** for a file kind that has a rendered diff (Markdown first).

## Contracts

### Renderer registry (`lib/rendered.js`)

```js
/** @returns {'markdown' | null} a file kind with a rendered view in diff tiles, by extension */
export function renderedKind(path)
```

Every check of whether a diff can be previewed goes through `renderedKind`. A later renderer
(e.g. Mermaid, CSV) adds a kind here, a media kind in `media.js`, and a branch in the views.

### File tiles

- `mediaKind('README.md') === 'markdown'`; `defaultView` stays `text` for it. Everything keyed on
  `previewable` (menus in `menus.js`, `cards.js`, `sidebar.js`; the muted `Preview` title) then
  applies with no further change.
- The view reads the text with `read_file` / `read_container_file` (as a text tile does) and mints
  one preview URL for the file (`mintPreviewUrl`) as the base for relative images. A mint failure
  is not fatal: images then show as their placeholder.
- Reloaded on save like the HTML view (the existing `sameFile` loop), and by **Reload**.

### Rendering (`viewer.js` → `markdownBlocks`)

- `marked.lexer(text)`; each top-level token is parsed on its own (`marked.parser` with the
  lexer's `links`, so reference links resolve) into one block element carrying its source line
  range (1-based, inclusive), from `blockLines` in `lib/rendered.js` (cumulative `\n` count of
  the tokens' `raw`). `space` tokens make no block.
- GFM on (`marked` defaults): tables, task lists (checkboxes disabled), strikethrough.
- Sanitizer `sanitizeRenderedHtml`: `sanitizeLspHtml`'s tags plus `IMG`, `INPUT` (checkbox only,
  forced `disabled`), `DETAILS`, `SUMMARY`, `KBD`, `MARK`. Attributes kept: `A[href]`,
  `IMG[src alt title width height]`, `TH/TD[align]`, `INPUT[type checked]`, `class` on
  `CODE/SPAN/PRE`. No `style`, no event handlers, no `id` from the source.
- Headings get GitHub-style ids (lowercase, spaces → `-`, punctuation dropped, `-1`, `-2` for
  repeats) so `#anchor` links work.
- Images: a relative `src` resolves against the file's preview URL (`new URL(src, base)`) and is
  kept only if the result is under the same `/preview/<nonce>/`. Any other `src` (http(s), data:,
  outside the nonce) is never loaded — the page's CSP forbids remote images anyway — and becomes a
  placeholder `<a class="md-image">🖼 alt</a>` linking to an http(s) `src`, plain text otherwise.
- Links: `#x` scrolls the view to the heading; http(s) opens in a new window
  (`target=_blank rel=noopener noreferrer`); a relative link opens that repo file in the stack
  (`openFileTile`, `.md` as `media`, anything else its default view), with `#x` ignored; anything
  else (`javascript:`, `mailto:`, …) loses its `href`.
- Fenced code blocks are highlighted as hovers are (`highlightCodeBlocks`).

### `DiffRef.view`

```js
/** @typedef {{…, view?: 'media'}} DiffRef */
```

- Parsed from component state only as `'media'`, and only when `renderedKind(path) !== null`;
  anything else drops it. Saved layouts without it load unchanged.
- `diffKey` appends `\nview:media`; `sameDiff` compares it: a diff and its rendering are two
  tiles, as a file and its preview are.

### Rendered diff tile (`view: 'media'`)

- Same data load (`pr_diff` / `commit_diff` / `uncommitted_diff`) and same header line (path,
  status, `+a −d`, PR/commit/changes info); none of the tools row (Compare, layout, Whole file,
  Hide whitespace, Tint rows, Show resolved), no threads, no review, no language server, no
  Outline, no change ruler, no Ask agent button.
- Text: the new side from `readHead` (`pr_file_at` / `commit_file_at` /
  `uncommitted_file_at`), `Loading…` until it arrives. A removed file (`status === 'removed'`)
  renders the old side: the patch's `-` rows' text. A head that is unavailable shows
  `Can't preview: <message>` with Retry.
- Marks from the PR's/commit's/changes' patch as read (`view.parsed`, never Hide whitespace or
  Compare), via `changeMarks(parsed)` and `blockMarks(blocks, marks)` in `lib/rendered.js`:
  - a block whose line range holds an added (`+`) new-side line: `data-change="add"` (green bar
    in the left margin, `--overview-add`);
  - a run of `-` rows with no `+` row in the same run is a deletion before the next new-side
    line: the block holding that line gets `data-deleted="<n>"` (a red marker above it, title
    `<n> lines removed`; after the last block if it is at the end);
  - a removed file: every block `data-change="del"` (red bar).
- Relative images resolve against the working-tree copy (`preview_file` on the diff's repo): the
  diff's own revision's images are not served. A file missing there shows its placeholder.
- An uncommitted diff re-reads on its timer as today; the rendering follows.

### Menus

- Changes rows, PR tree rows, commit file rows (wherever **Open diff** / **Open diff to the
  right** are), when `renderedKind(path)`: **Preview** / **Preview to the right** open the
  diff with `view: 'media'` (`'stack'` / `'right'`).
- A diff tile (`diffTileMenuGroups`, preview group): **Preview** on a source diff whose path has a
  `renderedKind`; **Open as diff** on a rendered one.
- A rendered diff tile's title: the usual diff title, with `Preview` muted (as a file preview).

## Validation

- [x] `cd devc && deno task check` passes (`web/static` is not type-checked by it; a one-off `checkJs` run found no errors in the new code beyond the codebase's usual implicit-any noise)
- [x] `cd devc && deno lint web/static && deno fmt --check` on touched files
- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env tests/web_media_test.ts tests/web_rendered_test.ts tests/web_layout_test.ts` passes: `mediaKind('a.MD') === 'markdown'`, `defaultView('a.md') === 'text'`; `renderedKind`; `blockLines` on raws with blank lines and a trailing block without `\n`; `changeMarks` (add, modify, pure deletion mid-file and at the end); `blockMarks`; `diffRefFromState` keeps `view: 'media'` only for a Markdown path, `diffKey` differs with it
- [x] `cd devc && deno task test` — no new failures (1219 pass; the 1 failure is the known `docker_exec_single_path_test`, which reads `devc-core/dist`)
- [ ] Live (`devc web --live`, by hand): Preview a README with a table, task list, fenced code, a relative image and a remote badge; edit the source and save, the preview reloads; Preview a Markdown file's uncommitted diff and a PR diff: added paragraphs barred green, a deleted paragraph marked red; restore a layout saved before the change — **not run**: no browser in the container; left for a by-hand check

## Relevant Files

| File                                  | Change                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `devc/web/static/lib/media.js`        | `markdown` media kind                                                  |
| `devc/web/static/lib/rendered.js`     | new: `renderedKind`, `blockLines`, `changeMarks`, `blockMarks`, `slug` |
| `devc/web/static/viewer.js`           | `markdownBlocks`, `sanitizeRenderedHtml`                               |
| `devc/web/static/rendered-view.js`    | new: the rendered view's DOM, image and link resolution                |
| `devc/web/static/ui.js`               | `LABELS.openAsDiff`, `LABELS.cantPreview`                              |
| `devc/web/static/tiles.js`            | Markdown media view; rendered diff tile                                |
| `devc/web/static/menus.js`            | diff tile menu Preview / Open as diff                                  |
| `devc/web/static/cards.js`            | Preview items on diff rows                                             |
| `devc/web/static/lib/layout_state.js` | `DiffRef.view`                                                         |
| `devc/web/static/style.css`           | `.md-view`, rendered diff marks                                        |
| `devc/tests/web_media_test.ts`        | markdown kind                                                          |
| `devc/tests/web_rendered_test.ts`     | new                                                                    |
| `devc/tests/web_layout_test.ts`       | `DiffRef.view`                                                         |
| `devc/README.md`                      | "Files and editing"                                                    |
| `.plans/PLAN.md`                      | registration                                                           |
