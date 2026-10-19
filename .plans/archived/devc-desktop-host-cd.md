# devc-desktop-host-cd

Right-click in the host terminal shows **`cd <host path>`**, the host folder behind devc web's
active terminal pane. Clicking it types `cd '<path>'` into the host shell.

**The boundary this plan keeps:** the devc view gets **no** new channel to the app. It still has
no preload and no IPC, and main still never scripts it. The page reports its active pane to the
devc web **server** over its existing `/ws`. The main process asks the server over loopback.
Everything that comes back is attacker-controlled (from the page, Herdr or the container), so
main verifies it before it shows or types anything. The trigger, the right-click, is in the host
view only, so the guarantees in [devc-desktop-electron](archived/devc-desktop-electron.md)'s
threat model still hold: devc web cannot open the drawer, move focus or send input. **The worst
case left is a `cd` into the wrong folder inside one of your own bind mounts, shown to you
before you click.**

```
devc view (page) ──/ws {type:'active_pane'}──▶ devc web server (host)
                                                   │ pane cwd (Herdr snapshot) → host path (bind mounts)
host view ──IPC host-term:context-menu──▶ main ──GET /desktop/active-folder (Bearer token)──┘
                                           │ verify: realpath, inside the mount, a directory, printable
                                           └─▶ native menu "cd <path>" ──click──▶ PTY: ^E ^U cd '<path>' ⏎
```

## Checklist

- [x] Step 1 (devc web page): `active_pane` reports
- [x] Step 2 (devc web server): `active_pane` message, remembered active pane, `GET /desktop/active-folder`
- [x] Step 3 (devc-desktop policy): pure verification, quoting, label and idle-shell functions, with tests
- [x] Step 4 (devc-desktop): token kept in main, `host-term:context-menu` IPC, the native menu, the click
- [x] Step 5 (devc-desktop host page): `contextmenu` on the terminal sends the IPC
- [x] Step 6: `devc-desktop/README.md` and `devc/README.md`
- [x] Validation (below) on Linux, as far as this container allows (see Verification results); macOS checks handed to the user

## Step 1: the page reports its active pane

`devc/web/static/app.js`:

- At the end of `updateCurrent()`, compute the active pane from `targetTile()` and
  `resolveRef(tile.ref)`. With a container `c` and a `tile.ref`, it is
  `{ type: 'active_pane', container: c.id, pane_id: tile.ref.pane_id }`. Otherwise it is
  `{ type: 'active_pane' }` with no other fields.
- Send it with `send()` **only when it differs** from the last one sent (compare
  `container` + `pane_id`). Reset "last sent" when the socket reopens, so a reconnect reports
  again.
- In a `window` `focus` listener, send the current value even when unchanged. That makes the
  window most recently focused (the desktop's devc view, or a browser tab on the same server)
  the one whose pane counts.

## Step 2: the server remembers it and serves it to the desktop

### `active_pane` (`devc/web/protocol.ts`, `devc/web/server.ts`)

- `ClientMessage` gains
  `{ type: 'active_pane'; container: string; pane_id: string } | { type: 'active_pane' }`.
  `parseClientMessage` accepts either shape. If one of `container`/`pane_id` is present, both
  must be non-empty strings of at most 256 characters, otherwise `bad_request`. The message has
  no `id` and gets no reply.
- The server keeps **one** `activePane: { container: string; pane_id: string } | null` for the
  whole server, not per client. The last `active_pane` from any client wins. `{type:'active_pane'}`
  sets it to `null`. A client closing does **not** clear it. The container and pane are not
  checked when the message arrives. They are resolved per request, below.

### `GET /desktop/active-folder`

- **Auth** (`authorize` in `server.ts`): for any path starting with `/desktop/`, after the
  existing Host check:
  - a request carrying an `Origin` header → **403**;
  - unless `Authorization` is exactly `Bearer <token>` (compared with `tokenMatches`) → **401**.
  - The token is **not** accepted in the query string on these paths.
  - Every other path keeps today's rules.
- **Methods:** `GET` only. Other methods get **405**, through the existing check. Any other path
  under `/desktop/` gets **404**.
- **Resolution:** a pure function in `server.ts`, so it can be tested. Inputs: `activePane`, the
  session for `activePane.container` (`sessions.get`), its `snapshot`, and its mounts
  (`mountsOf(session.record.id)`). Steps:
  1. `activePane === null` → `no_active_pane`.
  2. No session for the container → `no_session`.
  3. _(Changed during implementation: the session's cached snapshot keeps a pane's `cwd` from
     when it was taken, so a shell's `cd` never reached it, and the route answered
     `not_mounted` for folders you'd `cd`'d into. The route now asks Herdr `pane.get` live,
     waiting up to 2 s, and falls back to the cached snapshot. devc-desktop's fetch timeout is
     3 s.)_
     Find the pane in `snapshot.panes` (an array or an object of values, read the way
     `paneAtFolder` reads it) by `pane_id`. Read its `cwd`, the shell's own directory, and never
     `foreground_cwd`. Missing pane, or `cwd` not a non-empty string starting with `/` →
     `no_cwd`. Agent panes count: their `cwd` is where the agent runs.
  4. `findMountForContainerPath(cwd, mounts)` (`devc-core/mount_paths.ts`, bind mounts only) and
     `containerToHostPath` → `null` → `not_mounted`.
- **Response:** always `200`, `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: no-store`. Exactly one of:

  ```json
  { "ok": true, "folder": "/Users/brian/src/foo/sub", "mount": "/Users/brian/src/foo",
    "container": "<container id>", "containerFolder": "/workspaces/foo/sub" }
  { "ok": false, "reason": "no_active_pane" | "no_session" | "no_cwd" | "not_mounted" }
  ```

  `mount` is the matched bind mount's host `source`, unchanged. The server does **not** touch the
  host filesystem for this route (no `realpath`, no `stat`). Main does that.
- Never log the `Authorization` header or the token.

## Step 3: devc-desktop policy (pure, tested)

In `devc-desktop/src/main/policy.ts`, with tests in `devc-desktop/tests/policy.test.ts`. Names
are up to the implementer. The behavior is fixed.

### Verifying the folder

`cdTarget(answer, fs)` takes the parsed JSON and injected `fs.realpath`/`fs.stat`, which are the
real `node:fs/promises` ones in main and fakes in tests. It returns
`{ ok: true, path } | { ok: false, label }`. In order:

1. `answer.ok !== true` → the `label` for that `reason`: `no_active_pane` → `No active terminal
   in devc web`, `no_session` → `Its container isn't running`, `no_cwd` → `The terminal's folder
   isn't known`, `not_mounted` → `The terminal's folder isn't mounted from this machine`. Any
   other or malformed answer → `devc web gave no folder`.
2. `folder` and `mount` must be strings, absolute (start with `/`), each ≤ 4096 characters, and
   contain no NUL. Otherwise → `devc web gave no folder`.
3. `real = realpath(folder)`, `realMount = realpath(mount)`. Either throws → `The folder doesn't
   exist on this machine`.
4. `real === realMount` or `real.startsWith(realMount + '/')`. Otherwise → `The folder is outside
   its mount`. **Gotcha:** a container can create `/workspaces/foo/x -> /etc`. On the host that
   symlink resolves to the host's `/etc`, which is why this check runs on the **realpath**, never
   on `folder`.
5. `stat(real).isDirectory()`. Otherwise, or if it throws → `Not a folder`.
6. `real` must be **showable**: ≤ 256 characters, and no character in U+0000–U+001F,
   U+007F–U+009F, U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069 or U+FEFF (controls,
   bidi overrides, zero-width). Otherwise → `The folder's name can't be shown safely`.
7. → `{ ok: true, path: real, mount: realMount }`. **`real` is what gets typed, and the menu
   shows it (see `menuLabel` for shortening).**

### Quoting and the label

- `shellQuote(p)`: `'` + `p` with every `'` replaced by `'\''` + `'`. The command is
  `cd` + `shellQuote(path)`. There is no `--`: `path` is absolute, so it never starts with `-`,
  and a plain `cd '<abs>'` works the same in bash, zsh and fish.
- `menuLabel({path, mount}, home, platform, suffix)`: `cd <folder>` + `suffix`, at most **80**
  characters, else `null`, which gives a disabled `The folder's name is too long to show`.
  `<folder>` is `path` with `home` shown as `~`. If that is too long, it is `…/<basename of
  mount>/<path below mount>`. **The part below the mount, which the container chooses, is always
  shown in full.** Only the mount's part, which comes from the host's mount table, is shortened.
  _(Changed during implementation: Chromium's menus on Linux cut a label off at about 800 px
  with no ellipsis, as seen under Xvfb, so the full real path could not always be shown.)_
  **Gotcha:** Electron treats `&` in a menu label as a mnemonic marker on Windows and Linux, so
  there every `&` becomes `&&`. On `darwin` the label is used unchanged. Check this in
  Validation: a folder named `a&b` must show `a&b`.

### Whether the shell is idle

- `shellIdle(foreground, shell)`: true when `basename(foreground)` with one leading `-` removed
  equals `basename(shell)`. `foreground` is node-pty's `IPty.process`, the foreground process's
  name or path, which differs by platform; that's why it's compared by basename. Not idle →
  the item's label is `cd <path>` with `(busy: <basename>)` appended, and the item is disabled.

## Step 4: devc-desktop main process

`devc-desktop/src/main/main.ts`, `devc-desktop/src/main/pty.ts`:

- **The token:** when `child.ready` resolves, keep the URL's origin and its `#token=` value in
  main-process variables for that child. Clear them when the child exits or restarts. Never log
  them. (`launch.ts`'s `readyUrl` already guarantees `http://127.0.0.1:<port>/#token=<64 hex>`.)
- **`HostPty`** gains a read-only `foreground: string | null`, which is `IPty.process` while
  running and otherwise `null`, and exposes the configured `shell`.
- **`host-term:context-menu`** (`ipcMain.on`, no arguments):
  - Drop it unless `fromHost(e)` and `drawerOpen`.
  - If no devc web is ready → a menu with one disabled item `devc web isn't running`.
  - If the host shell isn't running → one disabled item `The host shell isn't running`.
  - Otherwise `fetch(`${origin}/desktop/active-folder`, { headers: { Authorization:`Bearer
    ${token}`}, signal: AbortSignal.timeout(1000) })`. Use **Node's global `fetch`**, not
    Electron's `net.fetch`: `net` uses Chromium's stack, which may attach an `Origin` and
    session cookies, and the server refuses any request with an `Origin`. A network error,
    timeout, non-200 response or bad JSON → `devc web gave no folder`.
  - Run `cdTarget`, then `shellIdle`, and build the one item (enabled only when both pass).
    Show it with `Menu.buildFromTemplate([...]).popup({ window: win })`, at the cursor.
  - Only one menu at a time: a second request while a fetch is in flight is dropped.
- **The click:**
  - Re-run the fetch, `cdTarget` and `shellIdle`. If any fails, or the path differs from the one
    the label showed, write nothing and call `shell.beep()`.
  - Otherwise `hostPty.write('\x05\x15' + 'cd ' + shellQuote(path) + '\r')` (Ctrl+E then Ctrl+U
    clear anything typed on the prompt first, in emacs-mode bash, zsh and fish), then
    `hostView.webContents.focus()`.
- The devc view gets nothing new: no preload, no IPC listener, no `executeJavaScript`. The
  app still runs no network listener of its own.

## Step 5: the host page

- `devc-desktop/src/preload/host.ts`: `hostTerm.contextMenu()` → `ipcRenderer.send('host-term:context-menu')`.
- `devc-desktop/src/renderer/host.ts`: add `contextMenu(): void` to `HostTerm`. Add a
  `contextmenu` listener on `#term` that calls `preventDefault()` and then `host.contextMenu()`.

## Step 6: docs

- `devc-desktop/README.md`, § "The host terminal": a paragraph on the right-click item (what it
  shows, that it types `cd '<path>'` after clearing the prompt, that it's disabled while a
  program is running in the shell). In § "Why devc web cannot reach it", add how the folder
  reaches the app (page → server → main, never page → main), the checks main runs, and that
  devc web, or anything holding the token, can choose **which** pane counts. **What it does not
  protect against** gains:
  - the folder can be any one inside your bind mounts that a container chooses, and you see it
    before you click;
  - a container can swap a folder for a symlink between the check and the `cd`, so look at the
    prompt afterwards;
  - in vi-mode shells, Ctrl+E/Ctrl+U may not clear the line first.
- `devc/README.md`, the "Security:" paragraph (the one starting "Herdr panes are shells, so `/ws` only accepts…"): one
  sentence. `/desktop/` routes need `Authorization: Bearer <token>` and refuse any request that
  has an `Origin`. Today the only route is `GET /desktop/active-folder`, which serves
  devc-desktop's right-click item.

## Validation

- [x] `(cd devc && deno task check && deno task test)` passes
- [ ] `(cd devc-core && deno task check && deno task test)` passes. **Not met:** check passes;
      `cliWorktreeMounts matches what the pinned devcontainer CLI computes` fails, also on the
      tree before this plan (`git stash`), which devc-core does not touch
- [x] `(cd devc-desktop && npm ci && npm run check && npm test)` passes
- [x] `devc/tests/web_server_test.ts`: `parseClientMessage` accepts both `active_pane` shapes and
      rejects `container` without `pane_id`, empty strings and >256-character values
- [x] `devc/tests/web_server_test.ts`: `authorize` on `/desktop/active-folder` → 403 with any
      `Origin`; 401 with no `Authorization`, a wrong token, or the token only in `?token=`;
      `null` with `Bearer <token>` and no `Origin`; `/ws` and static rules unchanged
- [x] `devc/tests/web_server_test.ts`: the resolver returns each of the four `reason`s, ignores
      `foreground_cwd`, and maps `/workspaces/foo/sub` under a bind mount `src=/h/foo
      dst=/workspaces/foo` to `folder: "/h/foo/sub", mount: "/h/foo"`
- [x] `devc-desktop/tests/policy.test.ts`: `cdTarget` covers every label above, including
      a symlink inside the mount pointing outside (faked `realpath` → `The folder is outside its
      mount`), a `mount` sibling prefix (`/h/foo` vs `/h/foobar` → outside), U+202E in the name,
      a 257-character path, and the happy path returning the realpath
- [x] `devc-desktop/tests/policy.test.ts`: `shellQuote("/a/it's")` → `'/a/it'\''s'`;
      `menuLabel` doubles `&` on linux, not on darwin, shows `~`, shortens only the mount's part,
      and returns `null` past 80 characters;
      `shellIdle('-zsh', '/bin/zsh')`, `shellIdle('/bin/bash', '/bin/bash')` true;
      `shellIdle('vim', '/bin/zsh')` false
- [x] Linux (Xvfb, as in devc-desktop-electron's Verify): with a running container, focus a
      devc web terminal, `cd` into a subfolder of a mounted repo there, open the host drawer,
      right-click → the item reads `cd <host path of that subfolder>`; clicking it → the host
      prompt is in that folder and `pwd` prints it
      **Done on macOS by the user (2026-10-19)** with a real container, after the live `pane.get` fix.
- [x] Linux: type `echo hi` at the host prompt without Enter, then use the item → the line runs
      only `cd …` (`echo hi` is gone, not prefixed)
- [x] Linux: run `sleep 100` in the host shell, right-click → the item is disabled with
      `(busy: sleep)`
- [x] Linux, adversarial: from inside the container, `ln -s /etc /workspaces/<repo>/evil`,
      `cd evil` in the focused pane, right-click → disabled `The folder is outside its mount`
      **Done on macOS (2026-10-19):** `evil-etc-test -> /etc`, `cd` into it → disabled `The terminal's folder isn't mounted from this machine` (the kernel resolves the link, so Herdr reports `/etc`).
- [x] Linux, adversarial: from the container, with the token, open `/ws` and send
      `{type:'active_pane', container:'<id>', pane_id:'<nonexistent>'}` → the item reads `The
      terminal's folder isn't known`; and `curl -H 'Origin: http://127.0.0.1:<port>' -H
      'Authorization: Bearer <token>' http://127.0.0.1:<port>/desktop/active-folder` → 403
      **Done on macOS (2026-10-19)** from devc web's DevTools console (same access as a hostile page): forged `active_pane` for container `nope` → disabled `Its container isn't running`. The `Origin` → 403 part was run with curl against `devc web` from source (Verification results).
- [x] Linux: a mounted folder named `a&b` shows `cd …/a&b` in the menu
- [x] Linux: the devc view still has no `window.hostTerm`, `require` or `process` (devtools
      console), and `ss -ltnp` shows no listener owned by the Electron process
      **Done on macOS (2026-10-19):** devc web's DevTools console gave `undefined` for `hostTerm`, `require`, `process` and `ipcRenderer`.
- [x] macOS, by the user: the first Linux check, the busy check with `vim`, and the `a&b` label.
      **Busy check passed (2026-10-19):** with `vim` running, the item was greyed out with
      `(busy: vim)`. **The first Linux check passed too:** the item `cd`'d the host prompt into
      the focused pane's folder.
      **All three passed:** the normal `cd`, `(busy: vim)`, and `a&b`.

## Verification results (Linux, Xvfb, 2026-10-19)

- `devc`: `deno task check` clean, `deno task test` 506 passed. devc-desktop: `npm ci`,
  `npm run check` clean, `npm test` 31 passed. `deno fmt --check` clean on the changed trees.
- **The route, on the real `devc web` from source** (stub `docker`, no containers): `Bearer` →
  200 `no_active_pane`; with an `Origin` → 403; `?token=` only → 401; no auth → 401; `POST` →
  405; `/desktop/x` → 404. After a `/ws` client sent `active_pane` naming a container that isn't
  running → `no_session`.
- **The app** (Electron 44.5.0 under Xvfb, `xdotool`), with a fake `devc` that prints a ready
  line and serves `/desktop/active-folder` from a file. Every request it got had the right
  Bearer token and no `Origin`.
  - The item read `cd …/repo/sub dir` and clicking it ran `cd '<realpath>'`. `pwd` printed the
    folder, space included. `echo hi` typed beforehand was cleared, not run.
  - `sleep 100` running → disabled `cd …/repo/sub dir (busy: sleep)`.
  - `repo/evil -> /etc` → disabled `The folder is outside its mount`. `no_cwd` → disabled
    `The terminal's folder isn't known`. `a&b` → `cd …/mnt/a&b`.
  - The answer changed between showing the menu and the click → nothing typed.
  - `ss -ltnp`: no listener owned by Electron. The devc view's construction, preload and IPC
    are unchanged (no diff touches them). It was not re-probed in devtools.
- **Found and fixed:** Chromium's Linux menus cut long labels off at about 800 px with no
  ellipsis, so a long real path and its `(busy: …)` were hidden. See `menuLabel`.
- **Not verified here (no Docker in this container):** the first Linux check and the two
  in-container adversarial checks against a real container, Herdr pane and `cwd`. The page's
  `active_pane` reporting is covered only by reading the code, and the server's resolver only
  by unit tests. macOS is not verified at all.

## Relevant Files

| File                                | Change                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `devc/web/static/app.js`            | `active_pane` sent from `updateCurrent()`, on socket open, and on window focus |
| `devc/web/protocol.ts`              | `active_pane` in `ClientMessage` and `parseClientMessage`                      |
| `devc/web/server.ts`                | `activePane`, the resolver, `/desktop/` auth in `authorize`, the route         |
| `devc/tests/web_server_test.ts`     | protocol, auth and resolver tests                                              |
| `devc-desktop/src/main/policy.ts`   | `cdTarget`, `shellQuote`, `menuLabel`, `shellIdle`                             |
| `devc-desktop/tests/policy.test.ts` | their tests                                                                    |
| `devc-desktop/src/main/pty.ts`      | `HostPty.foreground`, exposed `shell`                                          |
| `devc-desktop/tests/pty.test.ts`    | `foreground` is `null` before start, a string while running                    |
| `devc-desktop/src/main/main.ts`     | token kept, `host-term:context-menu`, menu, click                              |
| `devc-desktop/src/preload/host.ts`  | `contextMenu()`                                                                |
| `devc-desktop/src/renderer/host.ts` | `contextmenu` listener, `HostTerm.contextMenu`                                 |
| `devc-desktop/README.md`            | host terminal section, threat model additions                                  |
| `devc/README.md`                    | Security: `/desktop/` routes                                                   |
| `.plans/PLAN.md`                    | Pending entry and Development Phases row                                       |
