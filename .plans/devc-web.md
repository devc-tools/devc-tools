# devc-web

`devc web`: a host-side web UI for the Herdr sessions running **inside** devcontainers.
One loopback HTTP + WebSocket server on the host finds every running devcontainer,
reaches each container's Herdr server through `docker exec` (nothing is published from
any container), and serves a browser page where you arrange Herdr panes from any
container into your own browser layout. Events are pushed end to end, with no polling.

Out of scope for v1: reaching the page from another machine (loopback only, by design),
Herdr running on the **host** (the existing `devc/herdr.ts` sidecar covers that case),
rendering Herdr's own split geometry, and per-viewer authentication beyond the token
described below.

## Background: what Herdr provides (measured against Herdr 0.9.5)

Everything here was measured in throwaway `herdr --session <name> server` sessions.
**Treat it as the spec.** The docs leave most of it out.

### Socket API through stdio: `herdr remote-api-bridge` (hidden subcommand)

- `herdr --session <S> remote-api-bridge` relays its stdin and stdout to that session's
  API socket (`~/.config/herdr/sessions/<S>/herdr.sock`). Herdr's own
  `--machine` SSH forwarding uses it. It is absent from `--help`.
- `herdr remote-api-bridge --check` prints `herdr-api-bridge-v1` and exits 0. Treat any
  other output or exit code as "bridge unsupported".
- With no server for that session it prints
  `Error: Custom { kind: NotFound, error: "failed to connect to remote Herdr API socket … No such file or directory (os error 2)" }`
  on stderr and exits 1. That means "no session".
- Wire format: one JSON object per line in both directions. A request is
  `{"id":"<string>","method":"<method>","params":{…}}`. A success is
  `{"id":…,"result":{…}}`, an error `{"id":…,"error":{"code":…,"message":…}}`.
- **One request per connection.** A second request on the same connection resets it. A
  one-shot call is therefore: spawn a bridge, write one line, read one line, close
  stdin. An `events.subscribe` connection stays open and streams.
- `session.snapshot` (params `{}`) returns `result.snapshot` with keys `workspaces`,
  `tabs`, `panes`, `agents`, `layouts`, `focused_workspace_id`, `focused_tab_id`,
  `focused_pane_id`, `version`, `protocol`. Pane objects carry `pane_id`, `tab_id`,
  `workspace_id`, `terminal_id`, `cwd`, `foreground_cwd`, `agent`, `agent_status`,
  `terminal_title_stripped`, `revision`. Workspaces carry `workspace_id`, `label`,
  `number`. Tabs carry `tab_id`, `workspace_id`, `label`, `number`.

### Events: `events.subscribe`

- Request:
  `{"id":"s","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.created"},…]}}`.
  The first reply line is `{"id":"s","result":{"type":"subscription_started"}}`, and
  every later line is `{"event":"<name>","data":{…}}`.
- Global subscription types (no extra fields): `workspace.created`, `workspace.updated`,
  `workspace.metadata_updated`, `workspace.renamed`, `workspace.moved`,
  `workspace.reordered`, `workspace.closed`, `workspace.focused`, `worktree.created`,
  `worktree.opened`, `worktree.removed`, `tab.created`, `tab.closed`, `tab.focused`,
  `tab.renamed`, `tab.moved`, `pane.created`, `pane.closed`, `pane.updated`,
  `pane.focused`, `pane.moved`, `pane.exited`, `pane.agent_detected`, `layout.updated`.
- Subscriptions that need a pane: `pane.agent_status_changed` requires `pane_id`. Without
  it the request fails with `invalid_request … missing field 'pane_id'`. One request may
  list it once per pane:
  `[{"type":"pane.agent_status_changed","pane_id":"w1:p1"},{"type":"pane.agent_status_changed","pane_id":"w1:p2"}]`.
  The data is `{"agent":"claude","agent_status":"working","pane_id":"w1:p1","workspace_id":"w1"}`.
  (`pane.scroll_changed` and `pane.output_matched` also need extra fields. They are not
  used.)
- **Agent status changes do not emit `pane.updated`.** Measured: only
  `pane.agent_status_changed` carries them, so the per-pane subscription is required for
  badges.
- **Event names are spelled inconsistently.** Most arrive with underscores (`pane_created`,
  `layout_updated`, `tab_created`, `pane_exited`, `pane_agent_detected`), but
  `pane.agent_status_changed` arrives with dots. Normalize: if the name contains no `.`,
  replace its **first** `_` with `.` (`workspace_metadata_updated` →
  `workspace.metadata_updated`).
- No replay: a subscription starts when accepted. Subscribe **before** taking the
  snapshot. On overflow Herdr sends an error with `code: "events_lost"`. Treat it as
  "take a fresh snapshot".
- A pane whose process exits emits `pane_exited` and a `layout_updated` for its tab.

### Terminal streams: `herdr terminal session control`

- `herdr --session <S> terminal session control <pane_id> --takeover --cols <C> --rows <R>`
  prints one JSON record per line on stdout and reads one JSON command per line on stdin.
- Output records:
  - `{"type":"terminal.frame","seq":<n>,"encoding":"ansi","full":<bool>,"width":<cols>,"height":<rows>,"bytes":"<base64>"}`.
    The first frame is always `full:true`, a complete repaint. A resize also produces a
    `full:true` frame.
  - `{"type":"terminal.closed","reason":"<text>"}`. Observed reasons: `detached` (after
    `terminal.release`), `terminal attach taken over` (another controller took it), and
    `terminal attach failed: terminal <id> already has an attached client; retry with --takeover`
    (when started without `--takeover`).
- Stdin commands (field names established by testing; invalid input is reported on
  stderr as `herdr: terminal session control input ignored: invalid json command: …`
  and the stream keeps going):
  - `{"type":"terminal.input","text":"…"}` or `{"type":"terminal.input","bytes":"<base64>"}`.
    Not both.
  - `{"type":"terminal.resize","cols":<n>,"rows":<n>}`. Both must be > 0.
  - `{"type":"terminal.scroll","direction":"up"|"down","lines":<n>}`. Lines must be > 0.
  - `{"type":"terminal.mouse","action":"down"|"up"|"drag"|"move","button":"left"|"right"|"middle","column":<n>,"row":<n>}`,
    with an optional `"modifiers":<u8>`. `button` may be omitted for `move`.
  - `{"type":"terminal.release"}`. Ends the stream with `terminal.closed` /
    `detached`.
- Only one controller per terminal: a second `--takeover` closes the first with
  `terminal attach taken over`.
- **Resize changes the pane's real pty size, and the size persists after release.** A
  Herdr TUI showing the same pane will draw it at the browser's size until the TUI
  takes it back.

### Frames are Herdr's own redraw: terminal modes never reach the browser

Frames are Herdr re-rendering its screen, not the app's raw output. In a test pane, an
app enabled application cursor keys (`?1h`), bracketed paste (`?2004h`), mouse tracking
(`?1000h` `?1006h`), the kitty keyboard protocol (`>1u`) and the alternate screen
(`?1049h`). The frames contained only `?2026h/l` (synchronized output) and `?25h/l`
(cursor show/hide). The browser renderer is therefore a **plain screen painter** that
never learns the app's modes. Measured consequences:

- `terminal.input` is passed through **raw**. `pane send-keys up` produced `ESC O A`
  (application cursor mode respected), but the same key through `terminal.input` stays
  whatever bytes the browser sent. Herdr does **not** add bracketed-paste markers
  either.
- `terminal.mouse` **is** encoded by Herdr using the pane's real mode. With SGR mouse on,
  `column:3,row:2` reached the app as `ESC[<0;4;3M`, so **`column` and `row` are
  zero-based**.
- `terminal.scroll` reached a mouse-tracking app as a wheel event (`ESC[<64;…`). Without
  mouse tracking it scrolls Herdr's own scrollback view and sends the scrolled screen as
  frames.

These decide the input design below.

## Design

### Placement and invocation

A new `devc web` subcommand in `devc/`. It runs in the foreground until Ctrl-C and
ignores PATH (it serves every running devcontainer, not one project).

```text
Usage: devc web [--port N] [--session NAME]

Options:
  --port N        Port to listen on, on 127.0.0.1 (default: 48228)
  --session NAME  Herdr session to use in each container (default: devc)
  -h, --help      Print help
```

- **Dispatch:** `devc web` is dispatched **before** the first-run global-config wizard
  hook in `devc/main.ts`, as `init` and `config` are. It needs no global config.
- **Session default:** the default comes from `DEVC_HERDR_SESSION` in `devc/args.ts`, so
  `devc web` and `devc herdr` agree.
- **Startup output:** after a successful listen, stdout gets exactly one line,
  `devc web: http://127.0.0.1:<port>/#token=<token>`, and nothing else.
- **Exit codes:** a port already in use, or a bad flag value, writes
  `devc web: <message>` to stderr and exits 1. `docker` missing from PATH writes
  `devc: docker not found on PATH` and exits 1, the same wording as the lookup
  commands.
- **Shutdown:** on SIGINT or SIGTERM it sends `terminal.release` to every controller,
  kills every child process it spawned, and exits 0.

### Security

Any website the user visits could open a WebSocket to `127.0.0.1`. Without these checks
that would hand it a shell in every container:

- Listen only on `127.0.0.1`.
- **Token:** a random token (32 bytes, hex) is minted on every start and appears only in
  the printed URL's fragment. The page reads it from `location.hash` and sends it as
  `?token=` on the WebSocket URL. A wrong or missing token gets HTTP 401 with no
  upgrade.
- **Host check (DNS rebinding):** every HTTP and WebSocket request must have
  `Host: 127.0.0.1:<port>`, `localhost:<port>` or `host.docker.internal:<port>` (how a
  container on Docker Desktop reaches the host's loopback). Anything else gets 403.
- **Origin check:** a WebSocket upgrade must carry `Origin: http://<name>:<port>` for one
  of those three names, or no Origin. Browsers always send one on an upgrade, so a missing
  Origin is a non-browser client such as an agent's script. Anything else gets 403.
- Static responses carry `Cache-Control: no-store`. The page loads nothing from any
  origin but its own.

### Container discovery (push, not poll)

- **Initial list:**
  `docker ps --filter label=devcontainer.local_folder --format '{{.ID}}\t{{.Label "devcontainer.local_folder"}}'`
  lists running devcontainers at startup.
- **Changes:** `docker events --filter type=container --filter label=devcontainer.local_folder --filter event=start --filter event=die --format '{{json .}}'`
  runs for the server's lifetime. Each line's `.Action` (`start`/`die`) and `.Actor.ID`
  add or remove a container, and `.Actor.Attributes["devcontainer.local_folder"]` gives
  its folder. If this process exits, restart it after 2 s and re-run `docker ps` to
  reconcile.
- **remoteUser:** `docker inspect --format '{{json .Config.Labels}}' <id>` returns the
  container's labels.
  - Parse the `devcontainer.metadata` label as JSON. It may be an array or a single
    object; wrap an object in an array.
  - `remoteUser` is the value from the **last** entry that has a string `remoteUser`.
  - If no entry has one, use `docker inspect --format '{{.Config.User}}'`; if that is
    empty, use `root`.
  - Nothing in devc reads this label today (`startContainer` gets `remoteUser` from
    `devcontainer up`), so this parser is new. Make it a pure, tested function.
- **herdr path:** run `docker exec -u <remoteUser> <id> sh -lc 'command -v herdr'` once
  per container. The login shell is needed because the Agents Feature installs into
  `~/.local/bin`, which a plain `docker exec` PATH may not include. An empty result
  means state `no-herdr`. Every later exec uses the absolute path directly, never through
  `sh -c`. (`devc/herdr.ts` documents the `sh -c '<script>' <arg>` `$0` off-by-one
  this avoids.)
- **Every Herdr process** the server starts is
  `docker exec -i -u <remoteUser> <id> <herdrPath> --session <S> …`. Use `-i`; never
  `-t`, because a pty would corrupt the JSON lines.

### Per-container connection lifecycle

States sent to the browser: `connecting`, `connected`, `no-session`, `no-herdr`,
`unsupported`, `error`. Steps for each running container:

1. Resolve `remoteUser` and `herdrPath`. If there is no herdr, the state is `no-herdr`.
2. Run `remote-api-bridge --check`. Any output other than `herdr-api-bridge-v1` means
   `unsupported`.
3. Open the **lifecycle connection**: a bridge subscribed to every global type listed
   above. Wait for `subscription_started`. If the bridge exits with the NotFound error,
   the state is `no-session`.
4. Take a **snapshot** with a one-shot `session.snapshot` and send it to the browser. The
   state is now `connected`.
5. Open the **status connection**: a bridge subscribed to `pane.agent_status_changed` for
   every `pane_id` in the snapshot. Skip it when there are no panes.
6. On any structural event (normalized name starting with `workspace.`, `tab.`,
   `worktree.` or `layout.`, or one of `pane.created`, `pane.closed`, `pane.moved`,
   `pane.exited`), take a fresh snapshot, coalescing events within 50 ms, and send it.
   If the pane-id set changed, start a **new** status connection first, wait for its
   `subscription_started`, then kill the old one. The overlap means no status change is
   lost, and duplicates are harmless.
7. `pane.updated` and `pane.agent_status_changed` go to the browser as patches, with no
   new snapshot.
8. `events_lost` triggers a fresh snapshot.
9. If the lifecycle connection exits, kill the status connection and every controller
   for the container. The state becomes `no-session` (the server stopped) or `error`
   (any other exit).

`no-session` is not polled. The browser offers **Start session**, which runs
`docker exec -d -u <remoteUser> <id> <herdrPath> --session <S> server` and then repeats
from step 2, plus **Retry**.

A server started outside the browser is still noticed without polling: discovery's
`docker events` also passes `--filter event=exec_start`, and an exec in a known container
whose command has a `herdr` token (e.g. `devc herdr`'s `/bin/bash -lc '…' herdr --session
devc`) and no `remote-api-bridge` token (devc web's own execs) makes a `no-session`
container repeat from step 2 with the same bounded retry as **Start session**. A server
started from a shell that is already open in the container (no new `docker exec`) still
needs **Retry**.

### Pane streams

- **One controller per pane:** the server keeps at most one
  `terminal session control <pane_id> --takeover` per (container, pane), shared by every
  browser connection that has the pane open.
- **Opening:** the first open starts the controller with the requester's
  `--cols/--rows`. A later open from another browser connection restarts it with
  `--takeover`, which is how that viewer gets a `full:true` frame.
- **Fan-out and closing:** frames go to every subscriber. When the last subscriber
  closes, send `terminal.release`.
- **Takeover from elsewhere:** on `terminal.closed` with any reason other than
  `detached` after the server's own release, drop the controller and send `pane_closed`
  (below) with the reason. The browser shows it with a **Reconnect** button.
- **Resize:** comes from the browser, and the last resize wins.

### Browser ⇄ server WebSocket protocol (`/ws`)

All messages are JSON text frames. Container ids are the full Docker id.

Server → browser:

| `type`           | Fields                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `containers`     | `containers: [{id, localFolder, name, state, error?}]`. `name` is the basename of `localFolder`. Sent on connect and on every change |
| `snapshot`       | `container`, `snapshot` (Herdr's `result.snapshot`, verbatim)                                                                        |
| `pane_updated`   | `container`, `pane` (Herdr's `data.pane`, verbatim)                                                                                  |
| `agent_status`   | `container`, `pane_id`, `agent`, `agent_status`                                                                                      |
| `frame`          | `container`, `pane_id`, `seq`, `full`, `cols`, `rows`, `bytes` (base64, as received)                                                 |
| `pane_closed`    | `container`, `pane_id`, `reason`                                                                                                     |
| `result`         | `id`, `ok` (bool), `result` or `error` (`{code, message}`): the reply to a `request`, or to an `open` that failed                    |
| `hello`          | `generation`, `live` (bool). Sent first on every connection, before `containers`. `generation` is `"embedded"` unless live           |
| `static_changed` | `generation`, `paths` (changed files under `static/`, `/`-separated). Live mode only; broadcast to every client                      |

Browser → server:

| `type`           | Fields                                                                         | Server action                                                                               |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `open`           | `id`, `container`, `pane_id`, `cols`, `rows`                                   | Start or join the controller                                                                |
| `close`          | `container`, `pane_id`                                                         | Unsubscribe, and release if this was the last subscriber                                    |
| `input`          | `container`, `pane_id`, `bytes` (base64)                                       | `terminal.input` `bytes`                                                                    |
| `resize`         | `container`, `pane_id`, `cols`, `rows`                                         | `terminal.resize`                                                                           |
| `scroll`         | `container`, `pane_id`, `direction`, `lines`                                   | `terminal.scroll`                                                                           |
| `mouse`          | `container`, `pane_id`, `action`, `button?`, `column`, `row`                   | `terminal.mouse` (zero-based cells)                                                         |
| `request`        | `id`, `container`, `method`, `params`                                          | One-shot bridge call, replied to with `result`                                              |
| `read_selection` | `id`, `container`, `pane_id`, `anchor: {column, row}`, `cursor: {column, row}` | `pane.get`, viewport → content rows, `pane.selection.read`; replied to with `result {text}` |
| `start_session`  | `id`, `container`                                                              | `docker exec -d … server`, then reconnect; replied to with `result`                         |
| `retry`          | `container`                                                                    | Re-run the connection lifecycle                                                             |
| `client_ready`   | `generation` (non-empty)                                                       | Live mode: snapshot `static/` as last-good if current. No reply                             |

- **`request` allowlist:** `tab.create`, `tab.rename`, `tab.close`, `pane.split`,
  `pane.rename`, `pane.close`. Any other method gets
  `result {ok:false, error:{code:"method_not_allowed"}}` without touching Herdr. The
  param shapes are Herdr's own:
  - `tab.create`: `{workspace_id, cwd?, label?, focus?}`
  - `tab.rename`: `{tab_id, label}`
  - `tab.close`: `{tab_id}`
  - `pane.split`: `{target_pane_id, direction: "right"|"down", cwd?, focus?}`
  - `pane.rename`: `{pane_id, label}`
  - `pane.close`: `{pane_id}`
- **Message validation:** a message that is malformed, or names an unknown container or
  pane, gets `result {ok:false, error:{code:"bad_request", message}}` when it carries an
  `id`, and is ignored otherwise. It never crashes the server.
- **Disconnect:** when a WebSocket closes, run `close` for every pane it had open.
- **Live reload** (`hello`, `static_changed`, `client_ready`): added by
  [devc-web-live](archived/devc-web-live.md), which describes when the page reloads and the `/safe/`
  last-good snapshot.

### Browser UI

- **Renderer:** xterm.js `@xterm/xterm@6.0.0` with `@xterm/addon-fit@0.11.0`, using the
  **DOM renderer**. Do not add `addon-webgl`: browsers cap active WebGL contexts at about
  16 per page. All renderer use goes through one module that exposes `write(bytes)`,
  `resize()`→`{cols, rows}`, `onData(cb)`, `focus()` and `dispose()`, so swapping in
  `ghostty-web` later is a one-file change. (ghostty-web was evaluated and rejected for
  v1:
  - it is pre-1.0, with no release since June 2026;
  - its plain-drag selection and its alternate-screen wheel-to-arrows behavior are
    hardwired and would need overriding;
  - its main advantage, more accurate parsing, mostly disappears because Herdr has
    already parsed and re-rendered the output.)
- **Scrollback:** xterm.js `scrollback: 0`. Herdr owns scrollback.
- **Sidebar:** a tree of Container → Workspace → Tab → Pane, built from the latest
  snapshot, with single-child levels folded away: a workspace row shows only when its
  container has more than one workspace, and a tab row only when the tab has more than
  one pane. Numeric tab labels read `tab N`.
  - Container rows show the name, with the parent folder appended when two containers
    share a name (`feature1 · demos`), or the full folder when the parent is shared too.
    Clicking one collapses or expands it; the collapsed set is kept in `localStorage`
    (`devc-web-sidebar-v1`). A collapsed container shows its agents' most urgent status
    (`blocked` > `working` > `done` > `unknown` > `idle`), with a count when several
    agents share it. `connecting` shows as a muted state.
  - Containers in `no-session`, `no-herdr`, `unsupported` or `error` are listed last under
    a **Not running (N)** group, collapsed by default, one row each with its state; the
    group row counts the ones with errors. Hovering a row shows **Start** (`no-session`
    only) and **Retry**; the tooltip has the folder and any error message.
  - Pane rows show `terminal_title_stripped` (or the basename of `cwd` when it is empty).
    A pane without an agent whose title is just its folder reads `shell`, or
    `shell · <folder>` when that folder is not the container's. An **agent badge** is a
    colored dot and the status (`idle`/`working`/`blocked`/`done`/`unknown`), with the
    agent's name in the tooltip. A pane with no `agent` gets no badge.
  - Clicking a pane opens it in the focused tile.
  - A context menu offers the allowlisted pane-management actions:
    - workspace: New tab (on the container row when the workspace row is folded)
    - tab: Rename, Close (a folded tab's pane menu offers Rename tab)
    - pane: Split right, Split down, Rename, Close
  - Close actions ask for confirmation first.
- **Tiling area (browser-owned windowing):** superseded by
  [devc-web-golden-layout](devc-web-golden-layout.md), which replaced the split tree
  below with Golden Layout (drag and drop, tab stacks, nesting). Kept as history.
  - The main area is a tiling layout of tiles, each showing one pane. Each tile's
    header shows the container name, pane title, agent badge, and buttons for tile
    split right, tile split down and close tile.
  - Tile splits are browser-only and never change Herdr's layout. Tiles are resizable
    by dragging the dividers.
  - Closing a tile sends `close` for its pane.
  - The layout, with each tile identified by (`localFolder`, `pane_id`), is saved to
    `localStorage` and restored on reload. A restored tile whose pane no longer exists
    shows "Pane gone".
  - Wrap every `localStorage` access in try/catch.
- **Resize:** when a tile's size changes, the fit addon computes cols and rows, and
  `resize` is sent, debounced to 100 ms.
- **Keyboard input:** xterm.js `onData` output is sent as `input`, with the string
  encoded to UTF-8 and then base64.
- **Paste:** intercept the paste event yourself.
  - A paste containing `\n` or `\r` has `\r\n` and `\n` normalized to `\r`, is wrapped as
    `ESC[200~` + text + `ESC[201~`, and is sent as one `input`.
  - A single-line paste is sent as is.
  - (Bash 5.1+, zsh, Claude Code and the other agent TUIs enable bracketed paste. Without
    the wrap, each newline would submit.)
- **Mouse:**
  - Plain mouse down, up and drag over a tile are converted to zero-based cells and sent
    as `mouse`. Use a 50 ms cap for `drag`. The browser does not select on these.
  - **Shift+drag** does local xterm.js selection, never forwarded, and copies to the
    clipboard on mouseup.
  - A plain **left-drag** that ends on a different cell is also highlighted locally and its
    text copied: the page sends `read_selection` with the down and up cells (viewport,
    inclusive), and writes the reply's `text` to the clipboard. Herdr 0.9.5 draws no selection
    for a control client and sends it no OSC 52 (measured; an app's own OSC 52 is lost too),
    so the text comes from `pane.selection.read`. See
    [devc-web-copy-on-select](archived/devc-web-copy-on-select.md).
  - The **wheel** is always sent as `scroll`: direction from the sign of `deltaY`,
    `lines` = max(1, round(|deltaY| / cell height)), capped at 10 per event. Use
    xterm.js `attachCustomWheelEventHandler` to suppress its own scrolling.
  - Map the browser button numbers 0/1/2 to `left`/`middle`/`right`.
- **Known limitation (documented, not fixed):** application cursor key mode is not
  honored. Arrow keys always go as `ESC[A` and the like. vim, less, readline and the
  agent TUIs accept both forms.
- **Known limitation (documented, not fixed):** copy on select reads the rows as they are when
  the server handles `read_selection`. If the pane scrolls or prints in between, the copied
  rows can be off: `pane.selection.read`'s `content_revision` would catch it, but `pane.get`'s
  `revision` is not that value and no other source was found.

### Static assets

- **Layout:** the page is plain browser ES modules (`.js`, no build step) in
  `devc/web/static/`. xterm.js is vendored, unmodified, into
  `devc/web/static/vendor/xterm/`: `xterm.mjs`, `xterm.css`, `addon-fit.mjs`, plus
  `LICENSE` and a `VERSIONS` file naming both versions.
- **Refresh script:** `scripts/vendor-xterm.sh` re-fetches them with `npm pack` at the
  pinned versions. It's the only way the vendored files change.
- **Embedding:** add `--include web/static` to **both** `build` and `build:release` in
  `devc/deno.json`. Read files with `Deno.readFile(new URL('./web/static/…', import.meta.url))`,
  which works from source and from a compiled binary. Never read from `Deno.cwd()`. No
  workflow change is needed, because `release.yml` only runs `deno task build:release`.
- **Formatting:** exclude `devc/web/static/vendor/` from `deno fmt` (`fmt.exclude` in
  the root `deno.json` and in `devc/deno.json`), so `deno fmt --check` at the repo root
  stays clean.
- **Shared pure logic:** keep logic needed by both the page and the tests in
  `devc/web/static/lib/*.js` with JSDoc types, and test it from `devc/tests/`. Deno
  imports `.js` directly. That logic is the paste wrapper, pixel-to-cell conversion,
  wheel-to-lines conversion and button mapping.

### Gotchas for the implementer

- **`docker exec` does not kill processes inside the container** when the host-side
  client dies (`devc/herdr.ts` measured this for its watcher). For a bridge or
  controller this is harmless in practice: each exits when its stdin closes. Always end
  a controller with `terminal.release` and then close stdin rather than killing it.
  Close a bridge by closing its stdin. Validation checks for leftovers.
- **Reading stdout:** read child stdout as lines with a streaming decoder. A
  `terminal.frame` line can be hundreds of KB.
- **Permissions:** `devc/deno.json`'s `run`, `build` and `build:release` already grant
  `--allow-net`, and `devc/tests/permission_parity_test.ts` guards those lists, so leave
  the permission lists unchanged. Tests must not open sockets, because the `test` task
  has no `--allow-net`.
- **`devc/tests/help_test.ts`** asserts `COMMANDS.length === 15`. Raise it to 16.
- **`devc/deno.json` `check`** lists files explicitly. Add every new `.ts` file.

## Checklist

- [x] `web` added to `COMMANDS` and `COMMAND_HELP` in `devc/help.ts` with the usage text above; `devc/tests/help_test.ts` count raised to 16
- [x] `devc web` dispatch in `devc/main.ts`, placed before the first-run wizard hook; flag parsing for `--port` and `--session` (default `DEVC_HERDR_SESSION`)
- [x] Pure `devcontainer.metadata` → `remoteUser` resolver, with tests
- [x] Container discovery: initial `docker ps` plus a long-lived `docker events`, restarted after 2 s on exit with reconciliation
- [x] herdr path resolution (`sh -lc 'command -v herdr'`) and `remote-api-bridge --check`
- [x] Bridge helpers: one-shot request, and a streaming subscription with `subscription_started` handshake
- [x] Event-name normalization (pure, tested)
- [x] Per-container lifecycle: the six states, coalesced re-snapshots, overlapping status-connection swap, `events_lost`, lifecycle-exit teardown
- [x] Start session (`docker exec -d … server`) and Retry
- [x] Controller manager: one controller per pane, shared, `--takeover` rejoin for full frames, release on last close, `pane_closed` with reason
- [x] HTTP + WebSocket server on 127.0.0.1 with token, Host and Origin checks (check logic pure and tested); `Cache-Control: no-store`
- [x] WebSocket protocol exactly as specified, including the `request` allowlist and `bad_request` handling (message validation pure and tested)
- [x] SIGINT/SIGTERM teardown: release controllers, close bridges, stop `docker events`, exit 0
- [x] Vendored xterm.js 6.0.0 + addon-fit 0.11.0 with `LICENSE`/`VERSIONS`; `scripts/vendor-xterm.sh`; fmt exclude in both `deno.json` files
- [x] `--include web/static` in `build` and `build:release`
- [x] Renderer wrapper module (the only file that imports xterm)
- [x] Sidebar tree with container states, agent badges and context-menu pane management
- [x] Browser-owned tiling: splits, divider drag, close, `localStorage` persistence, "Pane gone"
- [x] Input: keyboard via `onData`; paste wrapping; mouse forwarding with Shift+drag local selection; wheel → `scroll`
- [x] Pure browser helpers in `devc/web/static/lib/` with tests (paste wrapper, pixel→cell, wheel→lines, button map)
- [x] New `.ts` files added to the `check` task
- [x] Docs: `devc/README.md` Commands block and a `web` note (including the application cursor key limitation and the TUI size conflict); `.plans/design/devc-design.md` Top-level help plus a new `## \`web\``section; root`README.md` everyday-commands table row

## Validation

Automated (inside the repo's dev container):

- [x] `deno fmt --check` at the repo root passes, with vendored files excluded
- [x] `cd devc && deno task check` passes
- [x] `cd devc && deno task test` passes. The new tests cover:
  - `remoteUser` resolution: an array whose last entry has `remoteUser`; a single
    object; no `remoteUser` (falls back to `Config.User`, then `root`); malformed JSON
    (falls back)
  - event-name normalization: `pane_created`→`pane.created`,
    `workspace_metadata_updated`→`workspace.metadata_updated`,
    `pane.agent_status_changed` unchanged
  - Host/Origin/token checks: accepts `127.0.0.1:<port>`, `localhost:<port>` and
    `host.docker.internal:<port>`, and a missing Origin on upgrade; rejects another port,
    another host and a foreign Origin; a missing or wrong token is 401
  - message validation: an unknown `type`, missing fields and a disallowed `request`
    method each produce the specified `result` error
  - paste wrapper: single line unchanged; `"a\nb"` → `"\x1b[200~a\rb\x1b[201~"`;
    `"a\r\nb"` → the same
  - pixel→cell is zero-based and clamped to the grid; wheel→lines clamps to 1..10;
    button mapping 0/1/2 → left/middle/right
- [x] `cd devc && deno task build` produces a binary, and `./devc web --help` prints the usage block

Manual, on a macOS host with Docker Desktop and at least two running devcontainers whose
images have the Agents Feature with `installHerdr: true`:

- [ ] `devc web` prints exactly one `devc web: http://127.0.0.1:48228/#token=…` line; opening it lists both containers
- [ ] With `devc herdr` running in container A only: A is `connected` with its workspace/tab/pane tree; B is `no-session`. **Start session** on B brings it to `connected` with no page reload
- [ ] `devc web --port 48228` while another `devc web` holds the port exits 1 with a `devc web:` message
- [ ] `curl -H 'Origin: https://example.com' …/ws?token=<token>` with upgrade headers gets 403; no token gets 401; `curl -H 'Host: evil.test:48228' http://127.0.0.1:48228/` gets 403
- [ ] Open panes from both containers into side-by-side tiles; typing works in each; `vim` inside a pane is usable (arrows, `:q`)
- [ ] Pasting three lines into a Claude Code prompt inserts them without submitting
- [ ] In `htop` or `vim` with `:set mouse=a`, clicks land on the clicked cell; the wheel scrolls the app. In a plain shell the wheel scrolls Herdr's scrollback. Shift+drag selects and copies text
- [ ] Splitting a pane from the sidebar context menu creates it in Herdr (visible in a `devc herdr` TUI) and in the sidebar within about 1 s; closing it removes both
- [ ] An agent going `working` → `idle` updates its badge within about 1 s; a newly split pane's agent also gets badge updates (status-connection swap)
- [ ] Opening the same pane in a second browser tab: both render it; closing one keeps the other live
- [ ] Opening a pane with `herdr terminal attach <terminal_id> --takeover` from a container shell shows "taken over" with **Reconnect** in the tile; Reconnect restores it
- [ ] Stopping container B (`devc stop`) removes it from the list without a reload; `devc up` brings it back to `connected`
- [ ] Reloading the page restores the tile layout; a tile whose pane was closed shows "Pane gone"
- [ ] After Ctrl-C on `devc web`, `docker exec <id> ps -eo args | grep -E 'remote-api-bridge|terminal session control'` in each container shows nothing within 5 s
- [ ] The released binary (`deno task build:release` for the host target) serves the page with no network access to any CDN (block external network in the browser devtools and reload)

## Relevant Files

- `devc/main.ts`: `web` dispatch before the wizard hook
- `devc/help.ts`: `COMMANDS` entry and `COMMAND_HELP` usage
- `devc/args.ts`: `devc web` flag parsing (reuses `DEVC_HERDR_SESSION`)
- `devc/web/server.ts` (new): HTTP/WebSocket server, Host/Origin/token checks, static files, protocol routing
- `devc/web/containers.ts` (new): `docker ps` / `docker events` discovery, `remoteUser` resolution, herdr path
- `devc/web/herdr_bridge.ts` (new): one-shot and subscription bridge helpers, event normalization, per-container lifecycle
- `devc/web/controllers.ts` (new): per-pane controller manager
- `devc/web/protocol.ts` (new): WebSocket message types and validation
- `devc/web/static/index.html` (new)
- `devc/web/static/app.js` (new): sidebar, tiling, WebSocket client
- `devc/web/static/renderer.js` (new): the only xterm.js importer
- `devc/web/static/style.css` (new)
- `devc/web/static/lib/input.js` (new): paste wrapper, pixel→cell, wheel→lines, button map
- `devc/web/static/vendor/xterm/xterm.mjs`, `xterm.css`, `addon-fit.mjs`, `LICENSE`, `VERSIONS` (new, vendored)
- `scripts/vendor-xterm.sh` (new)
- `devc/deno.json`: `check` file list, `--include web/static` in `build` and `build:release`, `fmt.exclude`
- `deno.json` (repo root): `fmt.exclude` for the vendored directory
- `devc/tests/help_test.ts`: command count 16
- `devc/tests/web_containers_test.ts` (new)
- `devc/tests/web_bridge_test.ts` (new)
- `devc/tests/web_server_test.ts` (new): pure check and validation functions only, no sockets
- `devc/tests/web_input_test.ts` (new)
- `devc/README.md`: Commands block and `web` notes
- `.plans/design/devc-design.md`: Top-level help and the `## \`web\`` section
- `README.md` (repo root): everyday-commands table

## Follow-on (not in this plan)

- Ask Herdr upstream for a mode-aware `terminal.paste` / key command, or mode flags on
  `terminal.frame`. Either would remove the paste heuristic and the application cursor
  limitation.
- `ghostty-web` behind the renderer interface, once it has passed 1.0.
- `remote-api-bridge` is undocumented. If a Herdr release drops it, the fallback is a
  small Node or Python relay to the socket, run through `docker exec`.
