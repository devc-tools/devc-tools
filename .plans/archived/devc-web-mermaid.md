# devc-web-mermaid

## Checklist

- [x] `scripts/vendor-mermaid.sh`: Mermaid 12.3.0's prebuilt `dist/mermaid.esm.min.mjs` and its `chunks/mermaid.esm.min/*.mjs`, unmodified but for source map comments, into `devc/web/static/vendor/mermaid/` with `LICENSE` and `VERSIONS`
- [x] `rendered-view.js`: each `` ```mermaid `` block of a rendered view (file tile or diff Preview) becomes a diagram, loaded on first use (`import('./vendor/mermaid/mermaid.esm.min.mjs')`), drawn one at a time, cached by source (64, blob URLs revoked on eviction)
- [x] Drawn as an `<img>` of a `blob:` SVG, never inserted as markup: an SVG image runs no script. `securityLevel: 'strict'`, `theme: 'default'` (a block's `%%{init}%%` may still pick another), `suppressErrorRendering`
- [x] `server.ts`: the page CSP gains `img-src 'self' blob:`
- [x] `style.css`: `.md-mermaid` light card (`--diagram-bg`, `--diagram-note` in `:root`), a failed block shows `Mermaid: <reason>` above its code
- [x] `devc/README.md` updated
- [x] Mermaid files (`.mmd`, `.mermaid`): media kind `mermaid` (`media.js`), `renderedKind` `'mermaid'`, rendered as one `` ```mermaid `` block (`renderedMarkdown`, fenced past any backtick run in the source); **Preview** in file and diff tiles, with tests
- [x] Mac apps rebuilt (`style.css` changes)

## Contracts

- The SVG Mermaid returns is parsed as HTML (its labels' `<br>` is not XML), sized from its
  `viewBox` (`width`/`height` attributes, `max-width` style dropped), and serialized with
  `XMLSerializer` into a `Blob` of type `image/svg+xml`.
- A block that fails keeps its `<pre>` under the note; a redraw of the view drops results of the
  draw before (a generation counter).

## Validation

- [x] `cd devc && deno task check`, `deno lint web/static`, `deno fmt --check` on touched files
- [x] `cd devc && deno task test` — no new failures (`web_themes_test` keeps literal colours in `:root`)
- [x] `serveStatic` serves `/vendor/mermaid/mermaid.esm.min.mjs` and a chunk as `text/javascript`, and `/main.html`'s CSP carries `img-src 'self' blob:`
- [x] `deno compile … --include web/static` succeeds with the vendored chunks
- [ ] Live: Preview `test-mermaid.md`-style blocks (gitGraph with `%%{init}%%` and `themeCSS`, flowcharts with `classDef` and `<br/>` labels); a broken block shows its error and code — **not run**: no browser in the container

## Relevant Files

| File                               | Change                     |
| ---------------------------------- | -------------------------- |
| `scripts/vendor-mermaid.sh`        | new                        |
| `devc/web/static/vendor/mermaid/`  | new, vendored              |
| `devc/web/static/rendered-view.js` | diagrams                   |
| `devc/web/server.ts`               | CSP `img-src 'self' blob:` |
| `devc/web/static/style.css`        | `.md-mermaid`              |
| `devc/README.md`                   | Markdown bullet            |
| `.plans/PLAN.md`                   | registration               |
