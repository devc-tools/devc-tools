# devc-web-live

Make `devc web` the tool you run all the time **and** the tool you keep changing. Point it at
a devc-tools checkout and it serves the UI from that checkout. Edits show up in the open
browser tab within a second or two, with no rebuild and no new URL:

- A **page** edit (`web/static/**`) reloads the page, or swaps the CSS in place.
- A **server** edit (`devc/**/*.ts`, `devc-core/**/*.ts`) restarts the server process. The page
  reconnects on its own with the same token.

The workflow this is for: an agent in a pane of `devc web` is told "add xyz to the UI", edits
the checkout (any devcontainer with the `devc:source` mount has it read-write at
`/workspaces/tools/devc-tools`), and the user sees the change in the tab they are already
using. The tab also shows the agent doing the work, so a broken edit can't be allowed to cost
the user that view. The safety nets below are part of this plan, not a follow-on.

**Depends on:** [devc-web-golden-layout](devc-web-golden-layout.md). It rewrites `index.html`,
`app.js` and the tiling, which this plan also touches. Implement this plan only after that one
is merged, and read `devc/web/static/` as it stands then, not as described in
[devc-web](devc-web.md).

Out of scope: Hot module replacement that keeps JS state across a reload (a full reload is
fine: tile layout is in `localStorage`, and terminal contents live in Herdr), remote access,
and watching anything outside the checkout.

## Design

### Two modes

|              | **Embedded** (today, and still the default) | **Live**                                                      |
| ------------ | ------------------------------------------- | ------------------------------------------------------------- |
| Selected by  | no source configured                        | `--source DIR` or `DEVC_WEB_SOURCE=DIR`                       |
| Who serves   | the `devc` process, in-process              | a **child** `deno run DIR/main.ts web` that `devc` supervises |
| Static files | from the binary (`--include web/static`)    | from `DIR/web/static/` on disk, watched                       |
| Server code  | the binary's                                | the checkout's, restarted on change                           |
| `/safe/`     | the same embedded files                     | the last-good snapshot (below)                                |

`DIR` is the checkout's **`devc/` directory** (the one that holds `main.ts` and `deno.json`),
e.g. `~/code/tools/devc-tools/devc`. Live mode needs `deno` on the host PATH. If `DIR/main.ts`
is missing or `deno` can't be found, exit 1 with a `devc web: …` message.

Running `deno task run web` directly from a checkout (no supervisor) stays as it is: an
embedded-mode server that happens to read static files from disk. Refreshing the browser picks
up page edits, but nothing is watched.

### CLI

```text
Usage: devc web [--port N] [--session NAME] [--source DIR] [--new-token]

Options:
  --port N        Port to listen on, on 127.0.0.1 (default: 48228)
  --session NAME  Herdr session to use in each container (default: devc)
  --source DIR    Serve from the devc/ directory of a devc-tools checkout and reload on
                  change (default: $DEVC_WEB_SOURCE; unset: the built-in copy)
  --new-token     Replace the saved token, so URLs printed earlier stop working
  -h, --help      Print help
```

- `WebArgs` (`devc/args.ts`) gains `source?: string` and `newToken: boolean`. `parseWebArgs`
  accepts `--source DIR` / `--source=DIR` and the bare flag `--new-token`, and stays strict.
  `--new-token=x` is an error. A relative `--source` is resolved against `Deno.cwd()`.
- `DEVC_WEB_SOURCE` is read in `main.ts` (not in `parseWebArgs`, which stays pure). The flag
  wins over the environment variable. An empty value counts as unset.
- **Added after implementation:** last in line, `"webSource"` in `~/.config/devc/config.json`
  (`webSourceFromConfig` in `devc-core/config.ts`; kept in `extra`, so wizard saves preserve
  it; `~`/`$VAR` expand; must be absolute).
- Update `help.ts`, `devc/README.md` § `devc web` and the usage table at the top of the
  README.

### Persistent token

- Store the token at `~/.config/devc/web-token` (`CONFIG_DIR` from
  `devc-core/default_config.ts`): 64 hex characters plus a trailing newline. Create the file
  with mode `0600`, and the directory if needed.
- On start: read the file. If it's missing, unreadable, malformed, or `--new-token` was given,
  call `mintToken()` and write a new one. Both modes use this, so the printed URL stays the same
  across restarts in either mode.
- The startup line is unchanged: `devc web: http://127.0.0.1:<port>/#token=<token>`, printed
  once by the process the user started (the supervisor in live mode). The child never prints
  it.
- The token goes to the child in the environment variable **`DEVC_WEB_TOKEN`**, never in argv,
  because argv is visible in `ps`.
- In README § Security, replace "restart `devc web` for a fresh token" with `--new-token`.

### Supervisor (live mode)

The `devc` process the user started is the supervisor. It owns the token, the printed URL and
the watch on server code. It never binds the port itself, except as the fallback below.

- **Child command**, run with `cwd: DIR` so `DIR/deno.json`'s import map applies:
  `deno run --allow-run --allow-read --allow-write --allow-env --allow-sys --allow-net main.ts web --port <N> --session <S>`
  with env `DEVC_WEB_CHILD=1` and `DEVC_WEB_TOKEN=<token>`. Use the same permission set as
  `DIR/deno.json`'s `run` task.
- **Child behavior** when `DEVC_WEB_CHILD=1`: ignore `--source` and `DEVC_WEB_SOURCE` (no
  recursion), take the token from `DEVC_WEB_TOKEN` (exit 1 if it is missing or malformed), print
  no URL, and turn on the static watch and last-good snapshot described below.
- **Process group:** start the child so that a terminal Ctrl-C reaches only the supervisor, the
  same reason `web/proc.ts` puts its `docker exec` children in their own group. The supervisor
  forwards SIGINT/SIGTERM as SIGTERM to the child, waits for it to exit (the existing 6 s cap
  inside the child, then SIGKILL), and exits 0.
- **Server-code watch:** watch `DIR` and `DIR/../devc-core` recursively (`Deno.watchFs`). React
  only to `.ts` paths that are not under a `tests/` directory or `web/static/`. Debounce
  ~300 ms.
- **Check before swap:** on a change, run `deno check main.ts` (cwd `DIR`) **while the old
  child keeps serving**.
  - If the check fails, keep the old child and write `devc web: not restarting: deno check
    failed` plus the checker's output to stderr.
  - If it passes, SIGTERM the old child, wait for it to exit, and spawn the new one. The port is
    free for under a second, and the page's existing 2 s reconnect covers the gap.
  - If another change arrives during a check, the latest change wins.
- **Fallback server:** if a child exits on its own (not because the supervisor stopped it),
  write `devc web: server exited (<code>); serving the built-in copy until the next change` and
  start the **embedded** server in-process on the same port with the same token. On the next
  change that passes `deno check`, stop the embedded server and spawn a child again. So a
  runtime crash in checkout code still leaves a working UI, and with it the agent pane that can
  fix the crash. The page served by the fallback is the binary's own, so it always matches the
  fallback's protocol.
- **Refactor this requires:** `serveWeb` currently installs its own signal handlers and calls
  `Deno.exit`. Split it:

  ```ts
  /** Starts the server and returns once it is listening. Throws WebStartError as today. */
  export function startWeb(
    opts: WebOptions & { token: string; live: boolean },
  ): Promise<WebHandle>;
  export interface WebHandle {
    /** The existing shutdown sequence (release controllers, dispose sessions, kill procs,
     *  server.shutdown), without Deno.exit. Idempotent. */
    stop(): Promise<void>;
    /** Resolves when the HTTP server has finished. */
    finished: Promise<void>;
  }
  ```

  `main.ts` handles signals and exit codes for the plain (embedded) case and for the child. The
  supervisor lives in a new module, `devc/web/supervisor.ts`, which uses `startWeb` for the
  fallback.

### Static generations and reload (child only)

- A **generation** is a hex content hash over every file under `web/static/` (path plus
  bytes, sorted by path). Use 16 hex chars of SHA-256. In embedded mode it is the constant
  `"embedded"`.
- The child computes the generation at start, then watches `web/static/` recursively and
  recomputes it after a ~150 ms debounce. If the hash changed, it broadcasts `static_changed`
  with the paths that changed since the last generation, relative to `static/` and
  `/`-separated (e.g. `"style.css"`, `"lib/sidebar.js"`).
- HTTP serving keeps reading from disk per request with `no-store`, as today. No in-memory copy
  is needed.

### Last-good snapshot and `/safe/` (child only)

- **Snapshot dir:** `~/.cache/devc/web/last-good/`, a full copy of `web/static/` plus a file
  `GENERATION` holding the generation it was copied from.
- **When to snapshot:** when a browser sends `client_ready` whose `generation` equals the
  child's current generation and differs from the snapshot's. Copy to a sibling temp dir, then
  rename it over `last-good/`, so a half-written snapshot never exists. Snapshot each
  generation at most once.
- **`/safe/` routes:** `GET /safe/` and `GET /safe/<path>` serve from the snapshot, with the
  same `staticPathAllowed` rules, content types and security headers as `/`. If there's no
  snapshot yet, `/safe/` returns 404 with the body `no last-good snapshot yet`. In embedded
  mode (including the fallback server), `/safe/<path>` serves the embedded files.
- **Required static change:** in `index.html`, every `href`/`src` becomes relative (`./app.js`,
  `./vendor/xterm/xterm.css`, …) so the same page works under `/` and `/safe/`. Module imports
  are already relative. Nothing in the page may build an absolute static URL. The WebSocket
  URL (`ws://${location.host}/ws?…`) stays absolute and is served at `/ws` in both cases.
- `authorize()` applies to `/safe/` unchanged. Note that it checks the Host header on every
  request.

### Browser ⇄ server protocol additions

Server → browser:

```jsonc
// Sent first on every connection, before `containers`.
{ "type": "hello", "generation": "3f9a0c1d2e4b5a69", "live": true }
// Live mode only; broadcast to every client.
{ "type": "static_changed", "generation": "7b1e…", "paths": ["style.css"] }
```

Browser → server (validated in `protocol.ts`; `generation` must be a non-empty string):

```jsonc
{ "type": "client_ready", "generation": "3f9a0c1d2e4b5a69" }
```

The server answers `client_ready` with nothing. It is a no-op in embedded mode. Add it to
`ClientMessage` and `parseFields`, and document all three in
[devc-web](devc-web.md) § "Browser ⇄ server WebSocket protocol".

### Page behavior

- **Boot generation:** the page takes the `generation` of the **first** `hello` it gets as the
  generation it was loaded from.
- **On a later `hello`** (after a reconnect, e.g. a server restart) whose generation differs:
  `location.reload()`. This catches static changes made while the socket was down.
- **On `static_changed`:** if every path ends in `.css`, re-point each `<link rel=stylesheet>`
  whose file changed to `?g=<generation>` (an in-place swap) and set the boot generation to the
  new one. Otherwise `location.reload()`.
- **`client_ready`:** sent once per page load, after the first `containers` message has been
  rendered and the layout has been restored without an exception. It carries the boot
  generation. Never send it from `/safe/`.
- **Safe mode** (`location.pathname` starts with `/safe/`): show a banner "Safe mode — last good
  UI" with a "Back to live" link (to `/` with the same hash). Ignore `static_changed` and
  `hello` generation mismatches.
- **Boot guard:** a new **classic** (non-module) script, `static/boot.js`, loaded from
  `index.html` before `app.js`. The CSP allows no inline script, so it must be a file. It:
  - records `error` and `unhandledrejection` on `window`;
  - starts a 5 s timer that `app.js` cancels by calling `window.__devcBooted()` once the page
    is rendered (the same moment as `client_ready`);
  - on an error before boot, or on the timeout, shows a fixed overlay with the message and two
    buttons: **Reload** and **Load last good** (navigates to `/safe/` with the current
    `location.hash`). On `/safe/`, show only Reload.
  - Keep `boot.js` small, dependency-free and styled with inline `style` properties (the CSP
    allows inline styles), so a broken `style.css` doesn't hide it. Errors after boot go to the
    existing toasts and do not show the overlay.

### Agent-facing notes

Add a short section to `devc/README.md` (under `devc web`), "Changing devc web while using
it", written so an agent can follow it cold:

- Where the code is: `devc/web/static/` (page) and `devc/web/*.ts` (server). From a
  container, that is `/workspaces/tools/devc-tools/devc/…`.
- What happens on save (page reload or CSS swap, or a server restart gated on `deno check`).
- How to verify: `deno task check` and `deno task test` in `devc/`.
- If the UI breaks: the user can use **Load last good** / `/safe/`, or `devc herdr` from a
  terminal. Fix forward or `git checkout` the file. Never edit `boot.js` together with other
  page files.

## Concept boundaries

- **Generation** (a hash of the static files) is not the devc **version** or `build_info.json`
  (`version_info.ts`). Don't reuse either.
- **`client_ready`** is not `open`'s `id`/`result` handshake. It has no id and gets no reply.
- **`hello`** is new. The existing first message, `containers`, keeps its shape and still
  follows `hello`.
- **`--source DIR`** is not the `devc:source` mount (`/workspaces/tools/devc-tools` inside
  containers, managed in `devc.jsonc`). `DIR` is a **host** path. The README should say they
  name the same checkout from two sides.
- **Supervisor**, **child** and **fallback** are processes and servers of `devc web`. They are
  not Herdr's `server` (`herdr --session devc server`), which `devc web` starts from the
  sidebar's **Start**.
- **`web-token`** in `~/.config/devc/` is not anything in `~/.config/devc-bridge/keys/`.
- **Last-good snapshot** (`~/.cache/devc/web/last-good/`) is not `localStorage` layout
  persistence.

## Checklist

- [x] `args.ts`: `--source`, `--new-token`; `help.ts`; tests in the existing args test file
- [x] Persistent token file (`0600`) with `--new-token`; both modes use it
- [x] `server.ts`: split `serveWeb` into `startWeb`/`WebHandle`; `main.ts` owns signals and exit
- [x] Child mode (`DEVC_WEB_CHILD`, `DEVC_WEB_TOKEN`): no URL line, static watch, generations
- [x] Protocol: `hello`, `static_changed`, `client_ready` in `protocol.ts` + tests; spec in
      `devc-web.md`
- [x] Last-good snapshot (atomic rename) and `/safe/` routes in both modes
- [x] `index.html` relative URLs; `boot.js` overlay; `app.js` hello/static_changed/client_ready/
      safe-mode banner
- [x] `web/supervisor.ts`: spawn, process group, `.ts` watch, `deno check` gate, swap, fallback
- [x] README: CLI, token, live mode, "Changing devc web while using it"; PLAN.md entry
- [x] `deno task check`, `deno task test`, `deno fmt --check` at the repo root

## Validation

**Result (2026-10-16):** automated tests pass (`devc/tests/web_live_test.ts`, plus the new
`parseWebArgs` and `client_ready` cases in `web_server_test.ts`). Manual steps 1–9 were run in
a Linux devcontainer against a copy of the checkout, with a stub `docker` (no containers, so no
panes) and a headless Chromium: one URL printed and reused across restarts; CSS swapped in place
without a reload; a JS edit reloaded; a server edit restarted and the client reconnected with
the same token; a type error kept the old child with the checker's output; a module-level throw
fell back to the built-in copy (`hello` generation `embedded`) and recovered when removed; a
syntax error in `app.js` showed the overlay, **Load last good** opened `/safe/` with the banner,
and **Back to live** returned; Ctrl-C left no processes; `--new-token` made the old token get
401. **Still to do on the macOS host:** the same steps with real containers and open panes,
including step 8's check for leftover `docker exec … herdr` children.

Automated (`devc/tests/`):

- `parseWebArgs`: `--source` in both forms, `--new-token`, `--new-token=x` rejected, unknown
  flags still rejected.
- Token file: created with mode `0600`; reused on the next start; replaced by `--new-token`; a
  malformed file is replaced.
- `parseClientMessage`: `client_ready` accepted; a missing or empty `generation` gives
  `bad_request`.
- Generation: the same tree gives the same hash; a byte change or a rename changes it; the
  changed-paths list is right.
- Snapshot: `client_ready` with the current generation creates `last-good/` + `GENERATION`; a
  stale generation does not; `/safe/x.js` serves the snapshot; with no snapshot, `/safe/`
  returns 404.
- `staticPathAllowed` still refuses `..` under `/safe/`.

Manual, on the host, with a copy of the checkout so real files aren't broken:

1. `devc web --source <copy>/devc` prints one URL. Open it and open a pane.
2. Change a colour in `style.css`: it updates without a reload (the terminal doesn't flash).
3. Add a `console.log` to `app.js`: the page reloads, and tiles and panes come back.
4. Add a harmless log line to `server.ts`: the indicator shows "disconnected", then "live"
   within ~3 s, same URL, and panes reopen.
5. Add a type error to `server.ts`: no restart, the stderr message appears, the UI keeps
   working. Remove it: it restarts.
6. Add `throw new Error('x')` at the top of `server.ts`'s module body (valid types): the child
   crashes, the fallback message appears, and the UI comes back as the built-in copy. Remove
   the throw: the checkout serves again.
7. Add a syntax error to `app.js`: after reload the overlay appears; **Load last good** gives a
   working UI with the safe-mode banner. Fix it, click "Back to live", and it works.
8. Ctrl-C the supervisor: both processes exit, and `docker ps`/`ps` show no leftover
   `docker exec … herdr` children.
9. Restart `devc web --source …`: the same URL as in step 1 still works. `--new-token`: the old
   URL gets 401.

## Relevant Files

- `devc/args.ts`: `WebArgs`, `parseWebArgs`
- `devc/help.ts`: `web` help text
- `devc/main.ts`: the `web` dispatch, `DEVC_WEB_SOURCE` / `DEVC_WEB_CHILD`, signals and exit
- `devc/web/server.ts`: `serveWeb` → `startWeb`, `serveStatic`, `/safe/`, `hello`, `client_ready`
  handling, generations, snapshot
- `devc/web/protocol.ts`: `ClientMessage`, `parseFields`
- `devc/web/proc.ts`: process-group pattern to reuse for the child
- `devc/web/supervisor.ts`: **new**
- `devc/web/static/index.html`, `app.js`, `boot.js` (**new**)
- `devc-core/default_config.ts`: `CONFIG_DIR`
- `devc/README.md`, `.plans/devc-web.md` (protocol section), `.plans/PLAN.md`
- `devc/tests/web_server_test.ts` and the existing args tests
