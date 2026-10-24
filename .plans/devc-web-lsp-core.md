# devc-web-lsp-core

## Checklist

- [ ] Vendored CodeMirror gains `@codemirror/lsp-client` 6.3.0 and `@codemirror/lang-java` 6.0.2
      (`scripts/codemirror-entry.js`, `VERSIONS`, rebuilt `codemirror.mjs` via
      `scripts/vendor-codemirror.sh`)
- [ ] `static/lib/languages.js` and `viewer.js`: Java highlighting for `.java`
- [ ] `devc/web/lsp_languages.ts` (new, pure): file name → LSP language, with tests
- [ ] `devc/web/lsp_framing.ts` (new, pure): `Content-Length` framing, with tests
- [ ] `devc/web/lsp_session.ts` (new, pure): the per-server multiplexer, with tests against a fake
      server port and an injected clock
- [ ] `devc/web/lsp_watch.ts` (new): watcher-glob matching (pure, tested) and host-side
      `Deno.watchFs` batching into `workspace/didChangeWatchedFiles`
- [ ] `devc/web/proc.ts`: `spawnBytes`, a byte-stream child tracked for shutdown like
      `spawnLines`
- [ ] `devc/web/lsp_manager.ts` (new): sessions by key, `describe` and `serve` through
      `docker exec`, idle stop, container loss, shutdown; tested end to end with an injected
      spawner and `devc/tests/fixtures/fake_lsp_server.ts` (new)
- [ ] `protocol.ts`: `lsp_attach`, `lsp_send`, `lsp_detach`, `lsp_restart`, with parser tests
- [ ] `server.ts`: the four handlers; `lsp` and `lsp_status` messages out; detach on socket close;
      sessions stopped on shutdown
- [ ] `viewer.js`: `createLanguageClient` and `Viewer.attachLanguage` / `detachLanguage`, and the
      one-view-per-URI workspace
- [ ] `static/lsp.js` (new): the page's sessions, transports, status, `displayFile`, URI-scheme
      hooks
- [ ] `tiles.js` / `menus.js` / `style.css`: attach on editable text tiles, the status line,
      **Restart language server**
- [ ] `devc/tests/fixtures/devc-lsp-typescript-deno` (new): a stub launcher wrapping `deno lsp`,
      for manual validation before any language Feature exists
- [ ] `devc/README.md`: devc web **Language servers** bullet and the launcher contract;
      `.plans/design/devc-design.md`: one paragraph; the exploration doc links this plan

devc web's file editor gains completion, hover, signature help, go-to-definition, find
references, formatting and diagnostics from a language server running **inside the file's
container**. This plan builds the language-agnostic machinery only. Servers come from
per-language Features, in [devc-web-lsp-typescript](devc-web-lsp-typescript.md),
[devc-web-lsp-python](devc-web-lsp-python.md) and [devc-web-lsp-java](devc-web-lsp-java.md).
Each installs one launcher command that this plan's [launcher contract](#launcher-contract)
defines. A container without a launcher behaves exactly as today.

Background and measurements: [design/devc-web-language-services.md](design/devc-web-language-services.md).

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Decisions (settled with the user, 2026-10-23)

- **Per-repo settings live in Feature options**, in the project's `devcontainer.json`, baked into
  the launcher at image build. devc web has no language-server config.
- **Servers start automatically.** Opening a supported file in an editable text tile starts or
  reuses its server. A server stops 30 minutes after its last attached tile goes away.
- **One type-aware server per file.** Lint servers (ESLint, `ruff server`) are a later plan.
  Sessions are keyed by root and language, so a later plan can add a second server per file
  without reworking them.

## Concept boundaries

- **The server runs in the container, devc web relays.** devc web's host server is the only LSP
  client the language server sees. Browser pages are clients of devc web, not of the server.
- **One session per (container id, language, root).** `root` is the container path the
  launcher's `describe` returns. Two worktrees are two roots, so two sessions. Two tiles, pages or
  browsers on the same root share one session.
- **Only editable text tiles attach.** A tile attaches when its file is shown as text (not media,
  not a diff) and `fileEditable` holds, which means the container is connected. Read-only
  tiles, media tiles and diff tiles never attach.
- **One attached view per URI per page.** A second tile showing the same file on the same page
  stays a plain editor. lsp-client's default workspace throws on a second view of a URI.
- **Rename is not offered.** lsp-client applies a multi-file `WorkspaceEdit` only to open files,
  so a rename would be partial. `renameKeymap` is not installed. A later plan can add it with
  host-side edits.
- **No new config, no new global state on disk.** Sessions live in memory in the host process.

## Launcher contract

Each language Feature installs an executable `devc-lsp-<language>` on the remote user's login
`PATH`, where `<language>` is `java`, `typescript` or `python`. devc web runs it through
`docker exec` as the remote user, through a login shell, so the user's `PATH` applies (nvm,
sdkman, `~/.local/bin`):

```ts
dockerExecArgv(info, {
  interactive: true, // serve only
  cwd: '/',
  cmd: loginShellArgv('exec "devc-lsp-$0" "$@"', language, ...args),
});
```

### `devc-lsp-<language> describe <file>`

`<file>` is an absolute container path. On success it exits 0 and prints exactly one JSON object
on stdout (nothing else):

```json
{
  "protocol": 1,
  "root": "/workspaces/web-client-ui",
  "languageId": "typescriptreact",
  "server": "vtsls 0.3.0 (TypeScript 5.6.3)",
  "initializationOptions": {},
  "settings": {
    "typescript": {
      "tsdk": "/workspaces/web-client-ui/node_modules/typescript/lib"
    }
  }
}
```

| Field                   | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `protocol`              | Always `1`. devc web refuses any other value with `describe_failed`.                      |
| `root`                  | Absolute container path: the server's workspace folder and the session key.               |
| `languageId`            | The LSP `languageId` for `didOpen`.                                                       |
| `server`                | Human-readable name and version, shown in the status line.                                |
| `initializationOptions` | Sent as-is in the host's `initialize`.                                                    |
| `settings`              | Answers `workspace/configuration` and is sent once as `workspace/didChangeConfiguration`. |

Exit codes:

| Exit  | Meaning                                                        | devc web                                                    |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 0     | JSON on stdout                                                 | starts or reuses the session                                |
| 3     | this file is not served (stderr: one-line reason)              | `unsupported`; the tile stays a plain editor, nothing shown |
| 127   | launcher not installed (the login shell's "command not found") | `no_language_server`; plain editor, nothing shown           |
| other | error (stderr)                                                 | `describe_failed`, status line shows the first stderr line  |

`describe` must be fast (it runs on every attach): no network, no build. It is run with a
15-second timeout, using `runDocker` from `container_files.ts`.

### `devc-lsp-<language> serve --root <root>`

Replaces itself (`exec`) with the language server speaking LSP over stdio. It must write nothing
else to stdout. stderr is free.

### Optional subcommands

Language plans may add subcommands (Java adds `build`). devc web only calls ones a plan
documents.

## Contracts

### Language by file name (`devc/web/lsp_languages.ts`)

`lspLanguageFor(path: string): 'java' | 'typescript' | 'python' | null`, decided by the
lower-cased extension of the last path segment:

| Extensions                                    | Language           |
| --------------------------------------------- | ------------------ |
| `java`                                        | `java`             |
| `ts` `tsx` `mts` `cts` `js` `jsx` `mjs` `cjs` | `typescript`       |
| `py` `pyi`                                    | `python`           |
| anything else, or no extension                | `null` (no attach) |

### Browser → server messages (`protocol.ts`)

```ts
| { type: 'lsp_attach'; id: string; container: string; root?: string; path: string }
| { type: 'lsp_send'; session: string; message: Record<string, unknown> }
| { type: 'lsp_detach'; session: string }
| { type: 'lsp_restart'; id: string; session: string }
```

- **`lsp_attach`** addresses its file exactly as `write_file` does. With `root` (a repo folder,
  host path), `path` is relative and resolved with `repoContainerPath`. Without it, `path` is an
  absolute container path (`containerPath` rules).
  - Reply `{ok: true, result: {session, uri, languageId, server, state}}`. `uri` is
    `file://` plus the container path, percent-encoded per segment. `state` is the session's
    current `lsp_status` state.
  - Errors use the existing `fail` shape, with codes `not_connected`, `no_language_server`,
    `unsupported`, `describe_failed` and `start_failed`. No language for the file name is
    `unsupported` without running `describe`.
- **`lsp_send`**: `message` must be a plain object, and the frame must be at most
  `MAX_LSP_MESSAGE = 8 * 1024 * 1024` UTF-16 code units (checked on the raw frame, like
  `MAX_VIEW_MESSAGE`). An unknown session, or one this connection has not attached, is
  silently dropped; there is no reply because there is no `id`.
- **`lsp_detach`**: this connection stops using the session. The host closes this connection's
  documents.
- **`lsp_restart`**: stop the server (see [Stopping](#stopping)) and start it again with the same
  key. Every attached connection gets `lsp_status` `starting`. Each page reconnects its client,
  which re-sends `initialize` and re-opens its documents. Reply `{ok: true}`.

### Server → browser messages

```json
{ "type": "lsp", "session": "<id>", "message": { "jsonrpc": "2.0", ... } }
{ "type": "lsp_status", "session": "<id>", "state": "starting" | "ready" | "exited", "detail": "..." }
```

`detail` is optional text:

- `starting`: the latest progress text, e.g. `Importing projects… 70%`
- `exited`: the reason, e.g. `exit code 1: <last stderr line>`, `container stopped`, or
  `stopped after 30 min idle`

`lsp_status` goes only to connections attached to the session.

### Host session behavior (`lsp_session.ts`)

`LspSession` owns one server process through a `ServerPort` (`send(msg)`, `onMessage(fn)`,
`onExit(fn)`), and its attached connections through a `Peer` (`send(text)`). It is pure: no
`docker`, no timers except through an injected clock.

**Startup.** The session waits for the **first** page's `initialize` request, then sends the
server its own `initialize`:

- `processId: null`. The host's pid means nothing inside the container, and some servers exit
  when that pid is not alive.
- `rootUri`, `rootPath` and `workspaceFolders: [{uri, name: basename(root)}]` from `root`.
- `initializationOptions`: from `describe`.
- `capabilities`: the page's capabilities, deep-merged with
  `{workspace: {configuration: true, workspaceFolders: true,
  didChangeWatchedFiles: {dynamicRegistration: true}}, window: {workDoneProgress: true},
  textDocument: {diagnostic: {dynamicRegistration: false}}}`.
- `clientInfo: {name: "devc web"}`.

On the result:

- send `initialized`
- send `workspace/didChangeConfiguration {settings}` (from `describe`)
- cache the result with `capabilities.textDocumentSync` rewritten to
  `{openClose: true, change: 1}` (Full)
- go `ready`

**Page lifecycle messages.** The host answers or absorbs these and never forwards them:

| From a page   | Host does                                                                           |
| ------------- | ----------------------------------------------------------------------------------- |
| `initialize`  | Replies with the cached result once ready (queued until then; `starting` meanwhile) |
| `initialized` | Drops                                                                               |
| `shutdown`    | Replies `null`                                                                      |
| `exit`        | Drops                                                                               |

Pages therefore always send whole documents. Every server must accept a full-text change event,
so the host forwards text unchanged.

**Documents.** The host keeps a table keyed by URI: which connections have it open, plus the
host's own version counter. Page version numbers are ignored.

| From a page                                   | Host does                                                          |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `didOpen`, URI not open                       | records the opener, forwards `didOpen` with version 1              |
| `didOpen`, already open by another connection | records the opener, forwards `didChange` (full text, next version) |
| `didChange`                                   | forwards with the next version (full text as received)             |
| `didClose`                                    | removes the opener; forwards `didClose` when no opener is left     |
| connection detaches or closes                 | as `didClose` for each of its URIs                                 |

A late opener immediately gets the last `publishDiagnostics` for that URI. Two pages editing the
same file is last-writer-wins.

**Requests.** Host ids are a per-session counter. `(connection, page id)` maps to the host id
and back. `$/cancelRequest` is mapped the same way. A response for a connection that has gone is
dropped.

**Server → client requests.** The host answers these itself and never forwards them to a page:

| Method                           | Answer                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `workspace/configuration`        | for each item, the value at `section` (dot path) in `settings`, or `null`; the whole `settings` when `section` is absent |
| `client/registerCapability`      | `null`; registrations for `workspace/didChangeWatchedFiles` go to the watcher (below)                                    |
| `client/unregisterCapability`    | `null`; removes those watcher registrations                                                                              |
| `window/workDoneProgress/create` | `null`                                                                                                                   |
| `workspace/workspaceFolders`     | `[{uri, name}]`                                                                                                          |
| `window/showMessageRequest`      | `null`                                                                                                                   |
| `workspace/applyEdit`            | `{applied: false}`                                                                                                       |
| `workspace/diagnostic/refresh`   | `null`, then re-pull every open URI (pull servers)                                                                       |
| anything else                    | error `-32601` Method not found                                                                                          |

**Server notifications:**

| Method                                         | Host does                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `textDocument/publishDiagnostics`              | stores the last per URI; sends to connections with that URI open                                               |
| `$/progress`                                   | `begin`/`report`: `lsp_status starting` detail `title message percentage%` while not ready; ignored once ready |
| `language/status` (JDT LS)                     | detail from `message` while not ready                                                                          |
| `window/showMessage`                           | type 1 (error) → `lsp_status` with the current state and `detail`; others dropped                              |
| `window/logMessage`, `telemetry/event`, others | dropped                                                                                                        |

**Pull diagnostics.** When the cached result has `capabilities.diagnosticProvider`:

- after each forwarded `didOpen` or `didChange` of a URI, debounced 250 ms per URI, send
  `textDocument/diagnostic {textDocument: {uri}}`
- turn the report into `publishDiagnostics {uri, diagnostics: items}`, routed as above
- `{kind: "unchanged"}` re-sends the stored list
- a failed pull is ignored

TS 7, Deno and ty need this.

### File watching (`lsp_watch.ts`)

Only `tsserver`-based servers notice on-disk changes on their own. TS 7, `deno lsp`, pyright,
basedpyright and ty did not, until the client sent `workspace/didChangeWatchedFiles`. Agents
edit files outside devc web all the time, so the host watches:

- **Where.** Per session, `Deno.watchFs(hostRoot, {recursive: true})`, where `hostRoot` is
  `containerToHostPath(root, mounts)`. Bind-mounted files are the same files, so in-container
  edits are seen. A root that maps to no host path is not watched, and `lsp_status` detail
  says `file changes outside the editor are not seen`.
- **What.** Only paths matching a glob some server registration asked for
  (`DidChangeWatchedFilesRegistrationOptions.watchers`). Patterns follow the LSP glob syntax
  (`*`, `**`, `?`, `{a,b}`, `[...]`), and a `RelativePattern` resolves against its `baseUri`.
  Use `globToRegExp` from `jsr:@std/path` with `globstar: true`, `extended: true`.
  - Event kinds: `create` → 1, `modify` → 2, `remove` → 3, `rename` → 3 then 1 for its two
    paths.
  - The `kind` bitmask (default 7) filters event types.
- **When.** Batched: a batch is sent 200 ms after the first event, de-duplicated by URI (last
  type wins, except create then remove drops it), at most 1,000 changes per notification.
- **Failure.** If `watchFs` fails (Linux `ENOSPC`, inotify limit), print once to stderr and set
  the same `lsp_status` detail. The session keeps running.
- **Stop.** The watcher is closed with the session.

### Process (`lsp_manager.ts`, `proc.ts`)

- **Key and session id.** `describe` runs first and gives the key. The session id is
  `crypto.randomUUID()`.
- **Spawn.** `serve` is spawned with `spawnBytes('docker', dockerExecArgv(...))`.
  `spawnBytes(cmd, args)` mirrors `spawnLines` (detached process group, `live` set, `kill`,
  `closeStdin`, `status`, capped `stderr`), but `stdout` is an `AsyncIterable<Uint8Array>` and
  `write(bytes)` writes raw bytes.
- **Framing (`lsp_framing.ts`).**
  - `encodeMessage(msg): Uint8Array` writes `Content-Length: <UTF-8 byte length>\r\n\r\n<json>`.
    `FrameReader.push(chunk)` returns the complete messages.
  - **Gotcha:** `Content-Length` counts **UTF-8 bytes**, not string length. Decode only
    complete bodies.
  - **Gotcha:** login-shell profile scripts can print to stdout before `exec`, and JDT LS
    prints "An error has occurred. See the log file" on a bad start. The reader discards bytes
    before a line starting `Content-Length:` (case-insensitive), keeps the first 4 KiB of
    discarded text for the `exited` detail, and ignores other headers (`Content-Type`).
- **Stopping.** In order:
  1. send `shutdown` and wait up to 5 s for its response
  2. send `exit`
  3. `closeGracefully(proc, 2000)`

  **Gotcha:** killing a `docker exec` client leaves the server running in the container, so the
  graceful path always comes first.
- **Idle.** When a session's attached connections reach zero, it stops after
  `LSP_IDLE_MS = 30 * 60 * 1000`. The environment variable `DEVC_WEB_LSP_IDLE_MS`, read at
  startup, overrides it for testing. An attach before then cancels the stop.
- **Exit.** A server exiting on its own, or its container stopping, marks the session `exited`
  with the reason and removes it, so the next attach starts a new one. There is no automatic
  restart loop.
- **Shutdown.** devc web's own shutdown stops every session with this sequence, inside the
  existing shutdown cap.
- **Testability.** `LspManager` takes `describe` and `spawn` functions. Tests inject a local
  spawner running `deno run devc/tests/fixtures/fake_lsp_server.ts`, which answers `initialize`
  with configurable capabilities, echoes documents back as diagnostics, registers a watcher, and
  supports pull diagnostics.

### Browser side

- **`viewer.js`** stays the only CodeMirror importer. It exports
  `createLanguageClient({send, subscribe, unsubscribe}, {displayFile})`, which returns
  `{client, attach(viewer, uri, languageId)}`.
  - The client is `new LSPClient({timeout: 20000, workspace: (c) => new DevcWorkspace(c, hooks)})`
    connected to the transport. **Gotcha:** the default `timeout` is 3000 ms, too short for a
    cold JDT LS completion.
  - `Viewer` gains `attachLanguage({client, uri, languageId}) → boolean` and
    `detachLanguage()`, through a `Compartment` holding `client.plugin(uri, languageId)`,
    `serverCompletion()`, `hoverTooltips()`, `signatureHelp()`, `serverDiagnostics()` and
    `keymap.of([...jumpToDefinitionKeymap, ...findReferencesKeymap, ...formatKeymap])`.
  - `attachLanguage` returns `false` and changes nothing when the URI already has an attached
    view.
  - `DevcWorkspace` subclasses `Workspace`: one file per URI, `displayFile(uri)` delegated to the
    hook.
- **`static/lsp.js`** keeps one `{session, client, uri…}` record per session per page, and
  routes `lsp` messages to that session's transport subscribers.
  - Tile attach: `lsp_attach`, then create the client for a new session, then
    `viewer.attachLanguage`. On `lsp_status exited` it detaches its views.
  - On reconnect (`hello`), it re-attaches every attached tile; sessions survive a page
    reload for the idle window.
  - `displayFile(uri)`:
    - `file:` URIs → `locate_file {container, path}` → a repo `FileRef`, opened in a file tile
      like a click in the tree. `forbidden` or `not_mounted` → a container `FileRef` for that
      path, opened the way the container **Files** node opens it.
    - Resolves with the tile's `EditorView` once its viewer has attached (10 s timeout →
      `null`).
    - Other schemes go to a hook registered with `registerUriScheme(scheme, fn)`;
      none → `null`.
- **Tiles.**
  - A small status line at the bottom-right of an attached tile shows
    `<Language>: starting…`, `<Language>: <detail>`, or
    `<Language> language server stopped: <detail>`. It shows nothing when `ready`.
    `<Language>` is `Java`, `TypeScript` or `Python`.
  - The file tile menu gains **Restart language server** (after **Reload**) while the tile is
    attached or its session `exited`.

## Gotchas

- **lsp-client 6.3.0 handles push diagnostics only** (`publishDiagnostics`). Hence the host's
  pull conversion.
- **lsp-client sends `initialize` per client**, and expects `textDocumentSync` from it. Hence the
  cached and rewritten result.
- **`marked`** (lsp-client's dependency, for hover Markdown) adds to the bundle. Record
  `codemirror.mjs`'s size before and after in `VERSIONS`.
- **The vendored bundle must stay a single module** (no dynamic import); the page has no build
  step.
- **A `tsserver`-based server answers early hovers with `(loading...)`.** That's fine in an
  editor; tests must not treat the first answer as final.

## Validation

- [ ] `cd devc && deno task check && deno task test` passes, including:
  - [ ] `web_lsp_framing_test.ts`: multi-byte UTF-8 body (length in bytes), a message split
        across chunks at every byte, two messages in one chunk, `Content-Type` header, junk
        lines before the first header (kept in the discard buffer)
  - [ ] `web_lsp_languages_test.ts`: every row of the language table, upper-case extensions,
        dotfiles, no extension
  - [ ] `web_lsp_session_test.ts`:
    - initialize cached and `textDocumentSync` rewritten to `change: 1`
    - a second page's `initialize` not forwarded
    - id remapping across two connections with colliding ids
    - `$/cancelRequest` mapped
    - didOpen → didChange for a second opener
    - didClose only after the last opener
    - late opener gets stored diagnostics
    - each server request in the table answered as specified
    - pull conversion including `unchanged`
    - idle stop after `DEVC_WEB_LSP_IDLE_MS` with the injected clock
    - detach cancels nothing while another connection is attached
  - [ ] `web_lsp_watch_test.ts`:
    - globs `**/*.ts`, `{src,lib}/**`, a `RelativePattern`, and the `kind` mask
    - batching, de-duplication and the 1,000 cap
    - `rename` as remove plus create
  - [ ] `web_lsp_manager_test.ts` with the fake server:
    - attach → `ready`
    - completion round trip
    - diagnostics routed
    - server exit gives `exited` with the stderr tail
    - restart re-initializes
    - shutdown sends `shutdown` then `exit`
  - [ ] parser tests for the four messages, beside the existing `parseClientMessage` tests:
        a missing `session`, a non-object `message`, an oversized frame, a `path` with `..`
- [ ] `deno fmt --check` passes for every file this plan touches
- [ ] Manual setup: in devc-tools' own container (it has `deno`), install the stub:
      `devc exec -- sudo install -m 755 devc/tests/fixtures/devc-lsp-typescript-deno /usr/local/bin/devc-lsp-typescript`.
      Then run `devc web --live-yolo` from this checkout.
- [ ] Manual: open `devc/web/server.ts`:
  - [ ] the status line shows `TypeScript: starting…`, then nothing
  - [ ] hovering `confine` shows its signature
  - [ ] `Deno.` offers completions
  - [ ] F12 on `confine` opens `devc/web/files.ts` in a tile at the definition
  - [ ] Shift-F12 lists references
- [ ] Manual: type `const devcProbe: number = "x";` and the error underline appears within 2 s.
      Undo, and it clears.
- [ ] Manual: with `server.ts` open, from a terminal in the container change `confine`'s return
      type in `files.ts` to `number`. `server.ts` shows the resulting errors within 5 s, without
      touching its tile. Revert the edit.
- [ ] Manual: open the same file in a second tile: it works as a plain editor (no hover), and
      the first tile is unaffected. Open `server.ts` in a second browser window: both get
      diagnostics.
- [ ] Manual: **Restart language server** shows `starting…` then works again. `docker exec` into
      the container and `pkill -f "deno lsp"`: the tile shows
      `TypeScript language server stopped: …`, and **Restart language server** brings it back.
- [ ] Manual: restart `devc web` with `DEVC_WEB_LSP_IDLE_MS=10000`, open and then close the
      tile. After 10 s, `docker exec … pgrep -f "deno lsp"` finds nothing.
- [ ] Manual: remove `/usr/local/bin/devc-lsp-typescript`, then open a `.ts` file: a plain editor,
      no status line, no error anywhere. A `.java` file is highlighted as Java.
- [ ] Manual: stop the container while a tile is attached. The status line shows
      `… stopped: container stopped`, and devc web's stderr shows no exception.

## Relevant Files

- `scripts/codemirror-entry.js` — lsp-client and lang-java exports
- `scripts/vendor-codemirror.sh` — unchanged; run it
- `devc/web/static/vendor/codemirror/codemirror.mjs` — rebuilt
- `devc/web/static/vendor/codemirror/VERSIONS` — new packages and bundle size
- `devc/web/static/lib/languages.js` — `java`
- `devc/web/static/viewer.js` — Java language, `createLanguageClient`, `attachLanguage`,
  `detachLanguage`, `DevcWorkspace`
- `devc/web/static/lsp.js` — new
- `devc/web/static/tiles.js` — attach and detach with editability, status line, `displayFile`
  opening, re-attach on `hello`
- `devc/web/static/menus.js` — **Restart language server**
- `devc/web/static/client.js` — route `lsp` and `lsp_status` to `lsp.js`
- `devc/web/static/style.css` — status line
- `devc/web/lsp_languages.ts` — new
- `devc/web/lsp_framing.ts` — new
- `devc/web/lsp_session.ts` — new
- `devc/web/lsp_watch.ts` — new
- `devc/web/lsp_manager.ts` — new
- `devc/web/proc.ts` — `spawnBytes`
- `devc/web/protocol.ts` — four messages, `MAX_LSP_MESSAGE`
- `devc/web/server.ts` — handlers, routing, close and shutdown
- `devc/tests/web_lsp_framing_test.ts` — new
- `devc/tests/web_lsp_languages_test.ts` — new
- `devc/tests/web_lsp_session_test.ts` — new
- `devc/tests/web_lsp_watch_test.ts` — new
- `devc/tests/web_lsp_manager_test.ts` — new
- `devc/tests/web_server_test.ts` — parser tests for the new messages
- `devc/tests/web_viewer_test.ts` — `languageFor` Java rows
- `devc/tests/fixtures/fake_lsp_server.ts` — new
- `devc/tests/fixtures/devc-lsp-typescript-deno` — new, the stub launcher:
  - `describe` prints `{"protocol":1,"root":<git top-level of the file>,"languageId":…,"server":"deno lsp (stub)","initializationOptions":{"enable":true},"settings":{"deno":{"enable":true}}}`
  - `serve` runs `exec deno lsp`
- `devc/deno.json` — `check` task gains the new modules
- `devc/README.md` — devc web **Language servers** bullet: what attaches, status line, keys
  (F12, Shift-F12, Shift-Alt-F), Restart, idle stop, `DEVC_WEB_LSP_IDLE_MS`; the launcher
  contract under Development
- `.plans/design/devc-design.md` — one paragraph: language servers run in the container behind
  launchers; devc web multiplexes and watches
- `.plans/design/devc-web-language-services.md` — link to the four plans
- `.plans/PLAN.md` — status
