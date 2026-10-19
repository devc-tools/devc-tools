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

| `type`           | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containers`     | `containers: [{id, localFolder, name, state, error?}]`. `name` is the basename of `localFolder`. Sent on connect and on every change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `projects`       | `projects: [{localFolder, name, pinned, lastUsed, container: "running"\|"stopped"\|"missing", starting, repos}]`: devc's projects list merged with every devcontainer's folder. `repos: [{folder, name, worktreeOf, git?, gitProblem?}]` is the folder itself first, then (with a container) every other repo it bind-mounts and the worktrees in its `<repo>.worktrees` mounts, each worktree after its repo (`worktreeOf`). `git` is `{branch, upstream, ahead, behind, gone}` (`upstream` null when untracked), `null` for no repo or no status, absent until read. `gitProblem` is why `git` is `null` for a folder that is a repo (`detached HEAD`, a timed-out or failed git call, e.g. `git fetch: timed out`); the page marks it `?`. The host never runs git in a repo: branches are fetched from it into a host-owned mirror, which also fetches each upstream every 5 min (`web/git_status.ts`). Sent on connect after `containers`, and on every change, including every git change (read every 15 s). See [devc-web-projects](devc-web-projects.md) |
| `project_output` | `localFolder`, `line`: one line of a `start_project`'s output, broadcast to every client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pinned_files`   | `pins: [{id, localFolder, root, path, label?}]`, in pin order ([devc-web-pinned-files](devc-web-pinned-files.md)): the pinned files of `~/.config/devc/pinned-files.json`. Sent on connect and, to every client, after every change (also one another devc web made: the file is watched). A pin's `last` editor pane is never sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tasks`          | `tasks: [{id, text, createdAt, localFolder?, root?}]` in creation order, `sent: [{id, text, createdAt, action, agent, sentAt, localFolder, root, cwd, sessionId}]` newest first ([devc-web-tasks](devc-web-tasks.md)): `~/.config/devc/tasks.json`. Sent on connect and, to every client, after every change (the file is watched). A sent task's `last` pane is never sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bridge_status`  | `running` (bool: devc-bridge's pidfile names a live pid), `active` (string[]: sorted regular-file names in its state dir, e.g. `caffeinate` while keepawake holds the host awake). Read from devc-bridge's own files on this host (`web/bridge_status.ts`). Sent on connect after `projects`, and on every change; broadcast to every client. See [devc-web-bridge-status](devc-web-bridge-status.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `usage`          | `sources: [{agent, observedAt, windows: [{id, label, usedPercentage, resetsAt}]}]` (times epoch s; `resetsAt` may be null): the account-wide agent usage limits, one source per agent, the newest observation winning, read from the `devc-usage.json` files status-line reporters write (`scripts/devc-usage-tap`, `web/usage.ts`). Windows keep the source's order and are rendered generically from `label`. Sent on connect after `bridge_status`, and on every change; broadcast to every client. See [devc-web-usage](devc-web-usage.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `snapshot`       | `container`, `snapshot` (Herdr's `result.snapshot`, verbatim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pane_updated`   | `container`, `pane` (Herdr's `data.pane`, verbatim)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `agent_status`   | `container`, `pane_id`, `agent`, `agent_status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `frame`          | `container`, `pane_id`, `seq`, `full`, `cols`, `rows`, `bytes` (base64, as received)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pane_closed`    | `container`, `pane_id`, `reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `result`         | `id`, `ok` (bool), `result` or `error` (`{code, message}`): the reply to a `request`, or to an `open` that failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hello`          | `generation`, `live` (bool). Sent first on every connection, before `containers`. `generation` is `"embedded"` unless live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `static_changed` | `generation`, `paths` (changed files under `static/`, `/`-separated). Live mode only; broadcast to every client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Browser → server:

| `type`                   | Fields                                                                                                                                                                                                                      | Server action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`                   | `id`, `container`, `pane_id`, `cols`, `rows`                                                                                                                                                                                | Start or join the controller                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `close`                  | `container`, `pane_id`                                                                                                                                                                                                      | Unsubscribe, and release if this was the last subscriber                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `input`                  | `container`, `pane_id`, `bytes` (base64)                                                                                                                                                                                    | `terminal.input` `bytes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `resize`                 | `container`, `pane_id`, `cols`, `rows`                                                                                                                                                                                      | `terminal.resize`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `scroll`                 | `container`, `pane_id`, `direction`, `lines`                                                                                                                                                                                | `terminal.scroll`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `mouse`                  | `container`, `pane_id`, `action`, `button?`, `column`, `row`                                                                                                                                                                | `terminal.mouse` (zero-based cells)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `request`                | `id`, `container`, `method`, `params`                                                                                                                                                                                       | One-shot bridge call, replied to with `result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `new_shell`              | `id`, `container`, `workspace_id?`, `cwd?`                                                                                                                                                                                  | `tab.create {workspace_id?, cwd?, focus: false}`; replied to with `result {pane_id, tab_id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `read_selection`         | `id`, `container`, `pane_id`, `anchor: {column, row}`, `cursor: {column, row}`                                                                                                                                              | `pane.get`, viewport → content rows, `pane.selection.read`; replied to with `result {text}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `start_session`          | `id`, `container`                                                                                                                                                                                                           | `docker exec -d … server`, then reconnect (retried for about 15 s); replied to with `result`, or `no_session` with the last lines of the session's `herdr-server.log` when no server came up                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `start_project`          | `id`, `localFolder` (absolute)                                                                                                                                                                                              | Start or create the project's container in-process (start hooks as `devc attach`; bridge policy refreshed; the ancestor-repo guard answers "no"), streaming `project_output`; `result`, or `start_failed` / `already_starting`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `stop_project`           | `id`, `localFolder`                                                                                                                                                                                                         | Stop its container; `result {stopped}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pin_project`            | `id`, `localFolder`, `pinned` (bool)                                                                                                                                                                                        | Pin or unpin it in `~/.config/devc/projects.json`; `result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `forget_project`         | `id`, `localFolder`                                                                                                                                                                                                         | Drop it from the projects file (it stays listed while a container exists); `result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `add_project`            | `id`, `localFolder`                                                                                                                                                                                                         | Must be an existing directory (else `bad_request`); pins it; `result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `list_dir`               | `id`, `localFolder` (a listed project), `root` (one of its `repos[].folder`), `path` (relative to `root`; `''` is the root)                                                                                                 | List one directory, confined to `root` (symlinks out of it fail). `result {entries, truncated, containerPath?}`; `forbidden` / `not_found`; a `root` that isn't one of the project's repos is `bad_request` `unknown repo`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list_host_dir`          | `id`, `path` (absolute, or `''`)                                                                                                                                                                                            | `''`: `result {roots}` (existing `codeRoots`, else `$HOME`). Else that host folder's subdirectories: `result {path, parent, entries, truncated}`. Refused under `--live`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `read_file`              | `id`, `localFolder`, `root`, `path`: as `list_dir` (`path` non-empty)                                                                                                                                                       | Read one file from the host side of the mount, confined to `root`, for the page's file viewer. `result {text, size, mtimeMs}` (UTF-8, invalid bytes replaced); `forbidden` / `not_found`; `bad_request` (not a file, `unknown repo`); `too_large` (over 2 MiB); `binary` (a NUL in the first 8 KiB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `preview_file`           | `id`, `localFolder`, `root`, `path`: as `read_file`                                                                                                                                                                         | **Open in browser** for an HTML file: reads it once (errors as `read_file`, up to 32 MiB), then answers `result {path}`, a one-off `/preview/<nonce>/<path>` the page opens in a new tab. The nonce is per repo root and serves any file under it (confined like `read_file`), so relative CSS, images and scripts load. Every preview response carries CSP `sandbox allow-scripts …` without `allow-same-origin`: the file's page gets an opaque origin and can't reach the devc web page or `/ws`. The server remembers the 64 most recent sources                                                                                                                                                                                                                                                                       |
| `open_file`              | `id`, `container`, `root` (one of its project's `repos[].folder`), `path` (relative to `root`); without `root`, `path` is an absolute container path (no `..`, no NUL), from the Files node                                 | `tab.create {cwd: file's dir}` + `pane.send_text` of `exec "${EDITOR:-$(command -v micro                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `locate_file`            | `id`, `container`, `path`: an absolute container path (no `..`), as a terminal printed it                                                                                                                                   | Map `path` to the host through the container's bind mounts, then find the innermost of its project's `repos[].folder` holding it, confined like `read_file`. `result {localFolder, root, path}` for `read_file` (terminal links open the file viewer with it); `not_mounted` / `forbidden` (outside the repos) / `not_found` (missing, or not a file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `list_container_dir`     | `id`, `container`, `path`: an absolute container path (no `..`, no NUL)                                                                                                                                                     | The container's own filesystem for its Files node, whatever Herdr's state: GNU `find -H <path> -mindepth 1 -maxdepth 1 -printf` through `docker exec` as the remote user (the CLI's `connectionFor`/`dockerExecArgv`). `result {entries, truncated}` as `list_dir` (sorted, capped at 2000); `not_found` / `forbidden` from find's stderr; else `list_failed` with it (BusyBox `find` has no `-printf`)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `read_container_file`    | `id`, `container`, `path`: as `list_container_dir`                                                                                                                                                                          | A container file's text for the file viewer, read with `sh -c 'head -c …'` after `-e`/`-f`/`-r` checks, the path passed as an argument. `result {text, size}`; `not_found` / `bad_request` (not a file) / `forbidden` / `too_large` / `binary` as `read_file`; else `read_failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `preview_container_file` | `id`, `container`, `path`: as `read_container_file`                                                                                                                                                                         | As `preview_file` for a container file: the nonce is per container and serves its filesystem, read with `docker exec` as `read_container_file` (so only while it runs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `create_file`            | `id`, `container`, `kind` (`file` \| `dir`), `path` whose last segment is a name (not empty, `.` or `..`; no NUL); with `root` (as `open_file`'s) `path` is relative with no `..`, without it an absolute container path    | Creates the entry inside the container as the remote user (`docker exec`, `dockerExecArgv`): a file with `sh -c 'set -C; : > "$1"'` (noclobber), a folder with `mkdir --` (no `-p`); the path is an argument. With `root`, the **parent** is confined (`confine(root, dirname(path))`) and translated to its container path. Starts no pane: the page sends `open_file` after. `result {path}` (the container path); `exists` / `not_found` (missing parent) / `forbidden` (permission, or outside the root) / `not_running` / `bad_request`; else `create_failed`                                                                                                                                                                                                                                                         |
| `rename_file`            | `id`, `container`, `path` as `create_file`'s (never the root itself), `to` (a new name: one segment, not `.` or `..`, no NUL)                                                                                               | Renames the entry within its folder inside the container as the remote user: `sh -c` refusing when anything (a broken link included) is at the new path, then `mv -T --`; both paths are arguments. With `root`, the entry's **folder** is confined and its name taken as it is, so a link is renamed itself. `result {path}` (the new container path); `exists` / `not_found` / `forbidden` / `not_running` / `bad_request`; else `rename_failed`                                                                                                                                                                                                                                                                                                                                                                         |
| `delete_file`            | `id`, `container`, `path` as `rename_file`'s                                                                                                                                                                                | Deletes the entry inside the container as the remote user with `rm -r --` (a folder with everything in it; a link, never its target); confined as `rename_file`. The page confirms first. `result {}`; `not_found` / `forbidden` / `not_running` / `bad_request`; else `delete_failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pin_file`               | `id`, `localFolder` (a listed project), `root` (one of its `repos[].folder`), `path` (relative, no `..`, no NUL), `label?`                                                                                                  | `confine(root, path)` must succeed and name a file (`not_found` / `forbidden` / `bad_request`); an unknown project or repo is `bad_request`. Appends the pin; the same `(root, path)` again is a no-op. `result {pin}` (its id)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unpin_file`             | `id`, `pin`                                                                                                                                                                                                                 | Removes it (an unknown id is `not_found`). The editor pane is left alone. `result {}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rename_pin`             | `id`, `pin`, `label` (`''` clears it)                                                                                                                                                                                       | Sets the pin's label. `result {}`; `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `open_pinned`            | `id`, `pin`                                                                                                                                                                                                                 | The pin's project's running container, else `not_running`; Herdr started when it has no session, as `open_tab` does. When the pin's `last` names that container and its pane is in the session's current snapshot, `result {pane_id, tab_id, reused: true}` (no Herdr query); else an editor pane as `open_file` makes one (`root` + `path`), stored as `last`, `result {pane_id, tab_id, reused: false}`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `add_task`               | `id`, `text`, `localFolder?` + `root?` (both or neither)                                                                                                                                                                    | Text trimmed, 1–20 000 characters, else `bad_request`. A route must be a listed project and one of its repos (`bad_request`: `unknown project` / `unknown repo`). Appends. `result {task}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `update_task`            | `id`, `task`, `text`, `localFolder?` + `root?`                                                                                                                                                                              | Same checks; replaces text and route (no route fields: not routed). `result {}`; `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `delete_task`            | `id`, `task`                                                                                                                                                                                                                | Removes it from the list or from Sent. `result {}`; `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `restore_task`           | `id`, `task`                                                                                                                                                                                                                | Moves a sent task back to the end of the list, routed where it was sent. `result {}`; `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `send_task`              | `id`, `task`, `localFolder`, `root`, `agent` (`claude`\|`copilot`\|`pi`), `action` (`plan`\|`implement`)                                                                                                                    | The task must be on the list (`not_found`), the route as `add_task`, its project's container running (`not_running`; Herdr started as `open_tab` does), `root` mounted (`not_mounted`), the agent installed (`not_installed`). Writes the text to `/tmp/devc-tasks/<uuid>.md` through `docker exec -i`, opens a shell tab at the repo, types the agent's start command with `<uuid>` as its session id (the task text is never on the command line), names the pane after the task, and moves it to Sent with `last`. `result {pane_id, tab_id, reused: false}`                                                                                                                                                                                                                                                            |
| `open_sent`              | `id`, `task`                                                                                                                                                                                                                | The sent task's project's running container (`not_running`). Its `last` pane while it is in the session's snapshot: `result {pane_id, tab_id, reused: true}`; else a new tab at the repo resuming the session (`not_mounted`, `not_installed` as `send_task`), stored as `last`: `result {pane_id, tab_id, reused: false}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `open_tab`               | `id`, `container`, `root` (one of its project's `repos[].folder`), `path` (a directory relative to `root`; `''` is the root), `reuse` (bool), `agent?` (`claude` / `copilot` / `pi` / `opencode`; only with `reuse: false`) | A Herdr tab at that folder's container path. `no-session`: start the session first (its error is the reply); `connecting`: wait up to ~15 s, else `not_ready`; `no-herdr` / `unsupported` / `error`: `herdr_unavailable`. With `reuse`, a shell pane (no `agent`) whose `cwd` is the folder answers; else `tab.create {cwd, focus: false}`. With `agent`: first `command -v <command>` in a login shell (`not_installed` if missing, no tab made), then after creating the tab `pane.send_text "<command>\n"` (no `exec`: quitting leaves the shell); the command comes from `AGENT_COMMANDS` in `web/agents.ts`, never from the page. `result {pane_id, tab_id, reused}`; `forbidden` / `not_found` / `not_mounted` / `not_installed`; `bad_request` (`unknown repo`, not a directory, unknown agent, agent with `reuse`) |
| `retry`                  | `container`                                                                                                                                                                                                                 | Re-run the connection lifecycle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `client_ready`           | `generation` (non-empty)                                                                                                                                                                                                    | Live mode: snapshot `static/` as last-good if current. No reply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

- **`request` allowlist:** `pane.rename`, `pane.close` (since
  [devc-web-layout-sidebar](devc-web-layout-sidebar.md): the browser owns all layout, so it
  never splits a Herdr pane or touches Herdr tabs). Any other method gets
  `result {ok:false, error:{code:"method_not_allowed"}}` without touching Herdr. The
  param shapes are Herdr's own:
  - `pane.rename`: `{pane_id, label}` (sets the pane's `label`; its terminal title is unchanged)
  - `pane.close`: `{pane_id}` (closing a tab's only pane closes the tab too)
- **`new_shell`:** every pane the browser creates is the root pane of its own Herdr tab.
  Herdr 0.9.5's `tab.create` result carries `root_pane` (missing from its bundled schema);
  without it the server finds the pane with `pane.list {workspace_id}` by `tab_id`. A
  failure is `result {ok:false, error:{code, message}}` as for `request`.
- **`open_tab` ([devc-web-open-tab-here](devc-web-open-tab-here.md)):** the "Open / New Herdr
  tab here" menu items. A pane is at the folder when it has no `agent` and its `cwd` (the
  shell's own directory, which follows `cd`) equals the folder, ignoring a trailing `/`;
  `foreground_cwd` (a child process's) is not used. Of several, the lowest-numbered tab wins.
  It never starts the container.
- **Files ([devc-web-files](devc-web-files.md)):** an entry is `{name, kind: 'dir'|'file'|'symlink',
  size?, to?: 'dir'|'file'}` (`to`: what a symlink resolves to; absent when broken); a picker
  entry adds `project` (it holds a dev container config or is a known project). Listings are
  sorted directories first and capped at 2000 (`truncated`). `containerPath` is the listed
  directory's path in the project's running container, absent when none runs. `parent` is
  `null` at `/`. Since [devc-web-repo-tree](devc-web-repo-tree.md), `list_dir` and
  `open_file` address files by `root`: one of the project's repo folders as the `projects`
  message lists them (the project folder first, then every mounted repo and worktree), checked
  against that same list. `localFolder` / `container` still pick the project. `read_file`
  ([devc-web-file-viewer](devc-web-file-viewer.md)) addresses files the same way and, like
  `list_dir`, reads the host side of the bind mount, so it works while the container is
  stopped. Its `mtimeMs` is unused by the page for now (kept for a later save's conflict
  check).
- **Pinned files ([devc-web-pinned-files](devc-web-pinned-files.md)):** repo files kept in the
  page's Pinned section, server-side so the desktop window and browser tabs agree. Not pinned
  projects (`pin_project`) and not a preview tile's "Keep open". The page keeps each pin's
  editor pane (from `open_pinned`) to know which tiles are the pin's: a click closes those
  tiles (never `pane.close`), else sends `open_pinned` and shows the pane in the focused stack.
  On `not_running` it opens the file read-only (`read_file`) and offers `start_project`.
- **Tasks ([devc-web-tasks](devc-web-tasks.md)):** to-dos kept server-side in
  `~/.config/devc/tasks.json`. `send_task` is one-way: the host writes the task into the
  container and starts the agent, and nothing in a container writes to the list. The agent's
  session id is a uuid the server chooses, so a Sent entry can find or resume its session.
  These messages carry `localFolder` too, so the server dispatches them before its
  project-message check.
- **Message validation:** a message that is malformed, or names an unknown container or
  pane, gets `result {ok:false, error:{code:"bad_request", message}}` when it carries an
  `id`, and is ignored otherwise. It never crashes the server.
- **Disconnect:** when a WebSocket closes, run `close` for every pane it had open.
- **Live reload** (`hello`, `static_changed`, `client_ready`): added by
  [devc-web-live](devc-web-live.md), which describes when the page reloads and the `/safe/`
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
- **Sidebar:** a tree of Container → Terminals → terminal, and Container → Repos → repo →
  files, built from the latest snapshot (see
  [devc-web-terminals-group](devc-web-terminals-group.md)).
  - **Vocabulary:** the page says **terminal** for a Herdr pane; code and protocol keep
    `pane`. A **tile** is a panel in the browser layout that shows a terminal or a file.
    "Herdr" stays in text about the server the terminals run on (Start Herdr, `no session`).
    User-visible names are in `LABELS` in `app.js`.
  - Herdr's spaces (`workspace` in its API) and tabs get no rows: devc web doesn't manage
    them. Terminals are listed in Herdr's order (space by space, then tab by tab). When a
    container has more than one space, a terminal's tooltip names its space.
  - Container rows show the name, with the parent folder appended when two containers
    share a name (`feature1 · demos`), or the full folder when the parent is shared too.
    Clicking one collapses or expands it; the collapsed set is kept in `localStorage`
    (`devc-web-sidebar-v1`). A collapsed container shows its agents' most urgent status
    (`blocked` > `working` > `done` > `unknown` > `idle`), with a count when several
    agents share it. `connecting` shows as a muted state.
  - Containers in `no-session`, `no-herdr`, `unsupported` or `error` are still running, so
    they stay in the list with the others, expandable, with their state on the row and no
    terminals. Hovering the row shows **Start Herdr** (`no-session` only) and
    **Retry**; the tooltip has the folder and any error message. Projects without a running
    container are listed last under a **Not running (N)** group, collapsed by default (see
    [devc-web-repos-group](devc-web-repos-group.md)).
  - Under every expanded container, whatever its Herdr state, a **Terminals** row comes
    first: open by default, showing the agents' most urgent status while collapsed (collapsed
    ones kept as `terminalsClosed`), with "No terminals" when there are none. Its hover **+**
    opens a menu (Terminal, Claude, Copilot, Pi, OpenCode) that starts a shell or that agent in
    a new terminal at the project folder (`open_tab` with `agent`, so it starts Herdr first on
    a `no-session` container). Every terminal row, and every terminal tile's Layout row, leads
    with an icon: the agent's own mark (Lobe Icons, `static/vendor/agent-icons/`, path data
    inlined in `static/lib/agent_icons.js`), a generic agent glyph for other agents, or a
    terminal glyph for a shell; file tiles' Layout rows get a file glyph; the container row's menu no longer has "New terminal". A **Repos** row follows, on
    every container whatever its repo count: collapsed by default, showing the combined
    push/pull mark while collapsed (open ones kept as `reposOpen`). Expanding a repo shows its
    worktrees (repo rows of their own), then its files.
  - Terminal rows show `terminal_title_stripped` (or the basename of `cwd` when it is empty).
    A pane without an agent whose title is just its folder reads `bash`, or
    `bash · <folder>` when that folder is not the container's. An **agent badge** is a
    colored dot and the status (`idle`/`working`/`blocked`/`done`/`unknown`), with the
    agent's name in the tooltip. A pane with no `agent` gets no badge.
  - Clicking a terminal (or a file) shows it where a tile already does; otherwise it opens in
    the focused stack's **preview tile** (italic tab title and Layout row), replacing what that
    tile showed, or in a new preview tile there (see
    [devc-web-preview-tiles](devc-web-preview-tiles.md)). A preview is pinned by
    double-clicking its tab or sidebar row, typing or pasting into it, dragging it, or **Keep
    open** in its menu. Ctrl/Cmd-click, and every menu item that names a place, open pinned
    tiles. The flag is saved with the layout (`preview: true` in the component state).
  - Context menus: superseded by [devc-web-layout-sidebar](devc-web-layout-sidebar.md),
    which split the sidebar into Layout and Projects sections, dropped Herdr tab rows and
    split actions, and gave each node type its own menu. Kept as history: workspace: New
    tab; tab: Rename, Close; pane: Split right, Split down, Rename, Close.
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
    [devc-web-copy-on-select](devc-web-copy-on-select.md).
  - The **wheel** is always sent as `scroll`: direction from the sign of `deltaY`. Pixel
    deltas accumulate per tile until they reach a whole cell height (so a trackpad scrolls in
    proportion to finger travel), with the remainder carried and reset on reversal; line deltas
    scroll that many lines (at least 1); capped at 10 per event. Use
    xterm.js `attachCustomWheelEventHandler` to suppress its own scrolling.
  - Map the browser button numbers 0/1/2 to `left`/`middle`/`right`.
- **File tiles ([devc-web-file-viewer](devc-web-file-viewer.md)):** a second Golden Layout
  component type, `file`, whose state is a `FileRef` `{localFolder, root, path}`; a `pane`
  tile's is a `PaneRef`. A file tile shows the file read-only in CodeMirror 6 (`viewer.js`,
  the only CodeMirror importer; vendored as one bundle in `static/vendor/codemirror/`):
  line numbers, highlighting by file name, folding, bracket matching, Ctrl/Cmd-F search. It
  has no Herdr pane and never sends `open`, `resize`, `input` or `close`.
  - Clicking (or Enter on) a file row opens it in a file tile in the focused stack, or
    brings forward a tile already showing it. File rows are drag sources, as pane rows
    are. A file row's menu: Open · Open to the right · Open in editor · Open in editor to
    the right · Copy path ("Open in editor" is the `open_file` terminal route).
  - The tab's title is the file name, its tooltip the host path. While reading: a
    "Loading…" overlay; an error (`too_large`, `binary`, `not_found`, …) shows its
    message, with an **Open in editor** button while the container runs. Right-click on
    the tab: Reload · Open in editor · Copy path · Close.
  - Saved layouts restore file tiles, which read their file again.
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
- **CodeMirror:** `devc/web/static/vendor/codemirror/codemirror.mjs` is one `deno bundle` of
  `scripts/codemirror-entry.js` (exact `npm:` pins; kept out of `web/static/`, whose `.js`
  files `deno compile --include` would follow into the binary), rebuilt by
  `scripts/vendor-codemirror.sh`. `VERSIONS` lists every bundled package, `LICENSE` is
  CodeMirror's MIT text.
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

**Closed 2026-10-19 by the user:** the items below that were still open were accepted without being re-run for this close-out.

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
  - pixel→cell is zero-based and clamped to the grid; wheel→lines accumulates pixel deltas and clamps to 1..10;
    button mapping 0/1/2 → left/middle/right
- [x] `cd devc && deno task build` produces a binary, and `./devc web --help` prints the usage block

Manual, on a macOS host with Docker Desktop and at least two running devcontainers whose
images have the Agents Feature with `installHerdr: true`:

- [x] `devc web` prints exactly one `devc web: http://127.0.0.1:48228/#token=…` line; opening it lists both containers
- [x] With `devc herdr` running in container A only: A is `connected` with its workspace/tab/pane tree; B is `no-session`. **Start session** on B brings it to `connected` with no page reload
- [x] `devc web --port 48228` while another `devc web` holds the port exits 1 with a `devc web:` message
- [x] `curl -H 'Origin: https://example.com' …/ws?token=<token>` with upgrade headers gets 403; no token gets 401; `curl -H 'Host: evil.test:48228' http://127.0.0.1:48228/` gets 403
- [x] Open panes from both containers into side-by-side tiles; typing works in each; `vim` inside a pane is usable (arrows, `:q`)
- [x] Pasting three lines into a Claude Code prompt inserts them without submitting
- [x] In `htop` or `vim` with `:set mouse=a`, clicks land on the clicked cell; the wheel scrolls the app. In a plain shell the wheel scrolls Herdr's scrollback. Shift+drag selects and copies text
- [x] Splitting a pane from the sidebar context menu creates it in Herdr (visible in a `devc herdr` TUI) and in the sidebar within about 1 s; closing it removes both
- [x] An agent going `working` → `idle` updates its badge within about 1 s; a newly split pane's agent also gets badge updates (status-connection swap)
- [x] Opening the same pane in a second browser tab: both render it; closing one keeps the other live
- [x] Opening a pane with `herdr terminal attach <terminal_id> --takeover` from a container shell shows "taken over" with **Reconnect** in the tile; Reconnect restores it
- [x] Stopping container B (`devc stop`) removes it from the list without a reload; `devc up` brings it back to `connected`
- [x] Reloading the page restores the tile layout; a tile whose pane was closed shows "Pane gone"
- [x] After Ctrl-C on `devc web`, `docker exec <id> ps -eo args | grep -E 'remote-api-bridge|terminal session control'` in each container shows nothing within 5 s
- [x] The released binary (`deno task build:release` for the host target) serves the page with no network access to any CDN (block external network in the browser devtools and reload)

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
