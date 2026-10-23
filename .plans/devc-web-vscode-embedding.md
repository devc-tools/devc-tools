# devc web: `/sidebar` and `/main` may be framed by VS Code webviews

Decided with the user on 2026-10-22. Phase 5 of 5 of running the sidebar and the tiling area as
separate pages, devc-tools' half. The extension's half is `devc-vscode`'s
`.plans/devc-web-panels.md`: a sidebar `WebviewView` and a tiles panel, each an `<iframe>` of a
`devc web` the extension starts. Today every static response carries `frame-ancestors 'none'`
(`devc/web/server.ts`, `securityHeaders`), so no webview can show either page. This plan lets VS
Code webviews, and only them, frame the two split pages. Small and independent of phase 4
([devc-web-cross-page-drag](devc-web-cross-page-drag.md)); either may land first.

## Checklist

- [ ] 1. `securityHeaders` takes the request's path; `/sidebar` and `/main` (and their `/safe/`
      forms) get `frame-ancestors vscode-webview:`; everything else keeps `'none'`
- [ ] 2. Tests in `devc/tests/web_server_test.ts`
- [ ] 3. Spec note in `.plans/archived/devc-web.md` (§ Views, or where the CSP is described)
- [ ] 4. Validation (below), then commit

## Touchpoints

| File | Role |
|---|---|
| `devc/web/server.ts` | `securityHeaders(port)` gains the path (or a `framable: boolean`); `serveStatic` passes it. |
| `devc/tests/web_server_test.ts` | The headers per path. |
| `.plans/archived/devc-web.md` | One line: which pages may be framed, by whom, and why. |

## Contracts

- The HTML responses for `/sidebar`, `/main`, `/safe/sidebar` and `/safe/main` carry
  `frame-ancestors vscode-webview:` instead of `frame-ancestors 'none'`. Every other directive of
  the CSP is unchanged.
- Every other response (`/`, `/index.html`, `/safe/`, scripts, styles, images, `/preview/…`, and the
  `.html` files when asked for by their file name, `/sidebar.html` and `/main.html`) keeps
  `frame-ancestors 'none'`. So framing needs the route, not the file.
- No change to the WebSocket's Origin check: a framed page's own origin is still
  `http://127.0.0.1:<port>`, which `originAllowed` already accepts. No change to the token: it
  still comes only in the URL's hash.

## Concept boundaries

- **`vscode-webview:` is a scheme source**, matching any VS Code webview's origin
  (`vscode-webview://<id>`). Any VS Code extension's webview could frame the page, but without the
  token (hash only, never sent to the server) a framed page can't connect; that is the same
  protection the page has in a browser tab today.
- **`/preview/…` is a different thing**: it is the media-tile frame's content, sandboxed and served
  with its own headers. Don't touch it.

## Validation

1. `cd devc && deno check main.ts && deno task check && deno task test`; `cd .. && deno fmt --check`
   reports nothing new.
2. Against a real server (the `devc-web` skill's stub-`docker` recipe, spare port), `curl -sI` each
   path above and check its `Content-Security-Policy`.
3. The user runs `devc web --live` with the installed server: this is server code, so it arrives
   with their next restart. The extension's plan can't be validated in VS Code before then.

Commit with a message in the repo's style (`devc web: …`).
