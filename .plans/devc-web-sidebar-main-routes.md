# devc web: `/sidebar` and `/main`, two pages relayed by the server

Decided with the user on 2026-10-22. Phase 3 of 5. After
[devc-web-split-entry-points](devc-web-split-entry-points.md), the sidebar and the tiling area are
modules (`static/sidebar.js`, `static/tiles.js`) talking through `lib/view.js`'s contracts
(`ViewIntents` + `ViewState` one way, `SidebarIntents` the other), wired in-process by `app.js`
for `/`. This phase serves each half as a page of its own, and the server relays the contracts
between them, so the sidebar can run in one window (a VS Code webview, later) and the tiles in
another (VS Code's integrated browser). `/` stays exactly as it is, in-process.

Later phases, **not** in this plan: dragging a sidebar row into a `/main` page (phase 4, native
drag and drop), and the VS Code extension's shell (phase 5). Don't change the CSP: `frame-ancestors
'none'` stays until the VS Code shell decides how it embeds the sidebar.

## Checklist

- [ ] 1. Protocol: the four `view_*` messages in `web/protocol.ts`, their tests, and the spec table
- [ ] 2. Server: views, relay, last state, cleanup in `web/server.ts` (pure part in a new `web/views.ts`, tested)
- [ ] 3. Server: `/sidebar` and `/main` serve `sidebar.html` and `main.html` (also under `/safe/`)
- [ ] 4. Page: remote `tileArea` and remote `SidebarIntents` over the socket
- [ ] 5. Page: `sidebar.html` + `sidebar-page.js`, `main.html` + `main-page.js`
- [ ] 6. Validation (below), then commit

## Touchpoints

| File | Role |
|---|---|
| `devc/web/protocol.ts` | Validates the new browser messages (`ClientMessage` union, `parseFields`). |
| `devc/web/views.ts` (new) | Pure: the view registry (who joined which view in which role, the last state per view) and what to relay to whom. No sockets; tested from `devc/tests/web_views_test.ts`. |
| `devc/web/server.ts` | Holds one registry; `handle()` routes the new messages through it; `socket.onclose` leaves the client's views; `serveStatic` maps the two routes. |
| `devc/web/static/client.js` | Exposes what the remote halves need (`send`, `onServerMessage`, the URL's `view`). |
| `devc/web/static/lib/view.js` | Gains the message-shaped helpers (below) if useful; stays pure. |
| `devc/web/static/sidebar.html`, `sidebar-page.js` (new) | The `/sidebar` page: `boot.js`, then the sidebar mounted against a remote `tileArea`. |
| `devc/web/static/main.html`, `main-page.js` (new) | The `/main` page: `boot.js`, then the tiles mounted against a remote `SidebarIntents`. |
| `devc/web/static/style.css` | Whatever the single-half pages need to fill the window (the sidebar page has no tiles column; the main page no sidebar column). |
| `.plans/archived/devc-web.md` | The protocol tables gain the new messages (§ "Browser ⇄ server WebSocket protocol"). |
| `devc/tests/web_protocol_test.ts` or the existing protocol test file, `devc/tests/web_views_test.ts` (new), `devc/tests/web_server_test.ts` | Tests. |

## Contracts

### URLs

- `/sidebar` serves `static/sidebar.html`; `/main` serves `static/main.html`. Under `/safe/` the
  same: `/safe/sidebar`, `/safe/main`. `/` and everything else are unchanged. Both pages use only
  relative URLs (`./style.css`), as `index.html` does.
- The URL hash carries the token as today and a view id: `#token=<t>&view=<id>`. A missing or
  invalid `view` (not matching `^[A-Za-z0-9_-]{1,64}$`) is `default`. A sidebar and a main page
  with the same view id are paired; many pages may share one view id (two sidebars on one main
  are fine).

### Browser → server

| `type` | Fields | Server |
|---|---|---|
| `view_join` | `view` (id as above), `role`: `"sidebar"` \| `"tiles"` | Records the client in that view and role (a client may join once; a second `view_join` on the same socket replaces the first). A `sidebar` joiner is sent the view's last `view_state`, if any. No reply. |
| `view_state` | `view`, `state` (a `ViewState`, below) | From a `tiles` member only (else ignored). Stored as the view's last state and sent as `view_state` to the view's `sidebar` members. No reply. |
| `view_intent` | `view`, `name` (a `ViewIntents` method name), `args` (JSON array, ≤ 4 items) | From a `sidebar` member only. Sent as `view_intent` to the view's `tiles` members. No reply. |
| `sidebar_intent` | `view`, `name` (a `SidebarIntents` method name), `args` (JSON array, ≤ 4 items) | From a `tiles` member only. Sent as `sidebar_intent` to the view's `sidebar` members. No reply. |

Validation in `protocol.ts` (shape only, `bad_request` otherwise): `view` matches the id pattern;
`role` is one of the two; `name` is in the fixed set — `view_intent`: `openPane`, `openFile`,
`openDiff`, `reveal`, `close`, `keepOpen`, `save`, `reload`, `setZen`; `sidebar_intent`:
`revealInContainers`, `setZen`; `args` is an array of at most 4 items; `state` is an object
whose `tiles` is an array of at most 500 items and whose `tree` is an object or `null`. The whole
message is already size-capped where `/ws` frames are parsed; if it is not, cap these messages at
256 KiB. The server does not interpret `state` or `args` beyond that: it relays them verbatim.

### Server → browser

| `type` | Fields | When |
|---|---|---|
| `view_state` | `view`, `state` | To a view's `sidebar` members on every `view_state` from its `tiles`, and to a `sidebar` joiner when the view has a last state. |
| `view_intent` | `view`, `name`, `args` | Relayed to the view's `tiles` members. |
| `sidebar_intent` | `view`, `name`, `args` | Relayed to the view's `sidebar` members. |

A client that closes leaves its view. A view with no members left drops its last state after 10
minutes (so a main page that reloads keeps its sidebar's state, and dead views don't pile up).
Nothing is persisted to disk.

### `ViewState` on the wire

Exactly `lib/view.js`'s `ViewState` (`{tiles, tree, focused}`, `TileState` fields as defined
there), JSON as is. Nothing in it is a DOM object.

### The remote halves (page)

- **`/main` page**: `mountTiles(root, {sidebar, onViewChange})` where `onViewChange(state)` sends
  `view_state` (it is already batched per microtask by `viewChanged`), and `sidebar` is a
  `SidebarIntents` whose methods send `sidebar_intent`. On every `hello` (connect and reconnect)
  it sends `view_join` (role `tiles`) and then the current state. A received `view_intent` calls
  the `tileArea` method `name` with `...args`; an unknown `name` is ignored.
- **`/sidebar` page**: `mountSidebar(root, {tileArea})` where `tileArea` is remote: `state()`
  returns the last `view_state` received (`{tiles: [], tree: null, focused: null}` before any),
  each `ViewIntents` method sends `view_intent`, and `dragSource` returns a no-op remover (rows are
  not draggable across pages until phase 4). On every `hello` it sends `view_join` (role
  `sidebar`). A received `view_state` stores the state and calls the sidebar's `onViewState`; a
  received `sidebar_intent` calls its `intents[name](...args)`.
- **`/`**: unchanged, in-process; it never sends `view_*` messages.
- Each page shows what it has while its partner is absent: the sidebar page with no main shows
  In use as empty of tiles (state is empty); the main page with no sidebar still works on its own
  (tiles, tab menus, Ctrl/⌘+S), with **Reveal in Containers** and zen items sent into the void.

## Concept boundaries

- **`view` (id) vs file views.** `app.js` already uses "view" for `TileView`, `FileView`,
  `DiffView`, `fileViews`, and for a file's text/media `view`. The new id is a *view id* /
  `view` field on messages only; don't reuse those names for it.
- **`role: "tiles"` is the `/main` page.** The route is `/main` (the user's name for it); the
  module and role are `tiles`. Not `devc/main.ts`, not the git branch.
- **`active_pane`** stays per client as it is: the `/main` page sends it, the `/sidebar` page
  doesn't (it has no tiles).
- **Live reload** (`static_changed`, `client_ready`, `/safe/` snapshots) works for the new pages
  as for `/`: the last-good snapshot is of `static/`, which now includes the new files.

## Validation

1. `cd devc && deno check main.ts && deno task check && deno task test`; `cd .. && deno fmt
   --check` reports nothing new (`devc/web/static/index.html` already fails on `main`).
2. Unit tests: protocol accepts/rejects each new message (including wrong role names, unknown
   intent names, too many args, bad view ids); `views.ts` relays each message to the right role
   in the right view only, sends the last state to a late sidebar joiner, ignores a `view_state`
   from a sidebar member and a `view_intent` from a tiles member, and drops a memberless view's
   state after the timeout (inject the clock); `serveStatic`/`routeStatic` serve the two routes,
   with and without `/safe/`.
3. A real server: per the `devc-web` skill, start `deno run -A main.ts web --source
   /workspaces/tools/devc-tools/devc --port <spare>` with a stub `docker` on `PATH`; connect two
   Deno WebSocket clients with the printed token, one joining `tiles` and one `sidebar` in view
   `v1`, and a third in view `v2`; check each relay reaches only its view and role.
4. Headless browser (`agent-browser`), two tabs against a fake server's init script extended to
   relay `view_*` between tabs is awkward, so prefer the real server of step 3 with its stub
   docker (no containers): open `/main#token=…&view=v1` and `/sidebar#token=…&view=v1`, check the
   sidebar page renders and receives state (an empty tile area shows "Nothing open"), and that an
   intent from the sidebar page (e.g. zen) reaches the main page. Then check `/` still behaves as
   before with the fake-server checks from phase 2's validation step 3.
5. The user runs `devc web --live` (installed server): the page side reloads live, but the new
   routes and messages need the checkout's server, so they will restart with the new build when
   this plan is done. While editing, `/` must keep working against the **old** server: the page
   at `/` never sends `view_*` messages, so it is unaffected.

Commit with a message in the repo's style (`devc web: …`).
