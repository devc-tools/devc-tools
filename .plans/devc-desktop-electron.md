# devc-desktop-electron

- [x] Step 0: measure (§ Step 0) and record the answers here (M1–M3 done; M4 runs in Verify). **Stop and report to the user if
      M4 (the adversarial re-run) leaks anything.**
- [x] Step 1: devc web: in-page dialogs replace `confirm()` / `prompt()` (works in any browser)
- [ ] Step 2: devc-desktop rewritten on Electron: child `devc web`, status view, devc view, menus,
      restart, quit — feature parity with today's `deno desktop` app, no host terminal yet
- [ ] Step 3: the devc view's lockdown (§ The devc view), with tests of every policy function
- [ ] Step 4: the host terminal: host view, `node-pty`, IPC bridge, drawer, toggle
- [ ] Step 5: `devc-desktop/README.md` rewritten (build, run, config, host terminal, threat model);
      `.gitignore`; `.plans/PLAN.md`
- [ ] Verify (below), then hand the user the macOS checks

**devc-desktop moves from `deno desktop` (CEF) to Electron**, so that one window can hold a host
terminal that devc web cannot reach. `deno desktop` gives one webview per window, and a host
terminal drawn in the same page as devc web fails isolation: a sandboxed cross-origin iframe
took every keystroke from it. Electron, with two separate `WebContentsView`s, passed the same
attacks. The measurements are in
[devc-desktop-host-terminal](archived/devc-desktop-host-terminal.md) ("Step 0 results" and
"Electron probe results"). Read that plan's threat model first. It still holds, and this plan
does not restate it.

```
┌──────────────────────── BaseWindow "devc web" ────────────────────────┐
│ ┌──────── devc view (WebContentsView) ─────────────────────────────┐ │
│ │ devc web's page: sandboxed, partition persist:devc, no preload    │ │
│ └───────────────────────────────────────────────────────────────────┘ │
│ ┌──────── host view (WebContentsView), slides up ──────────────────┐ │
│ │ HOST — brian@mac                       (drawn by the host page)  │ │
│ │ $ _          xterm.js ⇄ preload ⇄ IPC ⇄ node-pty in main          │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

While `devc web` is starting or has failed, a **status view** sits where the devc view goes.

## What stays the same

Everything the user configures or sees today, unless listed under "What changes":

- **Config:** `~/.config/devc/config.json` keys `desktopWebArgs` and `desktopDevc` (`installed` /
  `devc2` / an absolute path), and `$DEVC_DESKTOP_DEVC`.
- **Finding `devc`:** the app's `PATH`, else the login shell's (`$SHELL -ilc`, else `/bin/zsh`).
- **Arguments:** a terminal launch's arguments go to `devc web`, and `--no-open` is always added.
- **The child:** the ready line `devc web: http://127.0.0.1:<port>/#token=<64 hex>`, which
  is never printed or kept. The child's last 40 stderr lines feed the status view.
- **Restart and quit:** **Restart devc web** (Cmd+R) and **Quit** (Cmd+Q). Quitting stops the
  child (SIGTERM, then SIGKILL after 5 s) before exiting.
- **Copy page URL** in devc web still works.

The rules in today's `devc-desktop/launch.ts` (`readyUrl`, `desktopConfig`, `devcArgs`,
`childEnv`, `looked`, `findDevc`, `loginEnv`, `startDevcWeb`) carry over with their tests,
ported off `Deno.*` APIs. Keep the pure parts pure and tested.

## What changes

- **Runtime:** Electron replaces `deno desktop`. `devc-desktop/` becomes an npm project.
  `main.ts`, `launch.ts`, `status.ts` and `deno.json` are replaced. Nothing else in the repo
  depends on them.
- **The status page:** it was an HTTP server (`statusHandler`). It becomes a page bundled with
  the app, in its own **status view**, with a preload for `status:get` / `status:restart`, so
  there is **no loopback listener at all** in the app.
- **`childEnv`:** it also strips every `ELECTRON_*` variable, so a shell or `devc` never inherits
  `ELECTRON_RUN_AS_NODE` and friends. `DENO_SERVE_ADDRESS` is still stripped (harmless).
- **The window title** stays "devc web" and is set by the main process only. A `WebContentsView`
  never sets it.

## Step 0: measure first (record answers here)

Run on Linux under Xvfb in the container, as the probes were (`xdotool` for real keystrokes).

- **M1. `node-pty` under the chosen Electron.** Rebuilt with `@electron/rebuild`, does it:
  - spawn `bash -l`, echo input, report a resize (`stty size`), report exit codes, and die with
    the app (SIGKILL the app, then `pgrep` finds no orphan)?

  Record the versions. If it cannot be made to work, stop and report.
- **M2. Real devc web in the locked-down view.** Run the checkout's `devc web` with a stub
  `docker` (see the `devc-web` skill, "Testing without the user's tab") and load it in a view
  with every setting from "The devc view" below. Record:
  - **Connection:** whether the WebSocket connects (Origin and Host as `authorize` checks them).
  - **Persistence:** whether `localStorage` (the layout) survives an app restart with
    `partition: 'persist:devc'`.
  - **Clipboard:** whether copy works (Copy page URL, copy-on-select) and which permission name
    it uses. Whether paste works through the `paste` event alone.
  - **Opening things:** whether Cmd/Ctrl+click on a link, and **Open in browser** (`about:blank`
    then fallback `window.open(url)` in `openInBrowser`), reach the system browser through
    `setWindowOpenHandler` → `shell.openExternal`.
  - **Live reload and safe mode:** whether `--live` reloads land, and whether `/safe/` loads.
  - **Every permission check/request** devc web makes in normal use: log them all, and set the
    allow list from that log.
- **M3. Shortcut collisions.** Is Cmd+J (macOS) / Ctrl+Shift+J (Linux) free in devc web,
  Herdr, micro and the host shell? If not, pick another, and record it.
- **M4. Adversarial re-run.** Repeat every attack from the Electron probe (focus,
  `alert`, fullscreen, `window.open`, navigation to the host page's URL, synthetic keys, IPC
  attempts) from inside **real devc web**. Use a throwaway copy:
  `devc web --live --source <copy>` with the attack script appended to the copy's `app.js`.
  Run it against the Step 2–4 app, not a probe. **0 keystrokes may leak and 0 host-term IPC
  messages may come from the devc view.** A leak stops the plan.

## Step 0 results (Linux, 2026-10-19)

Electron 44.5.0 (Chromium 152) under Xvfb in the container.

- **M1 `node-pty`: pass.** `node-pty` 1.1.0 rebuilt with `@electron/rebuild` 4.2.0 for Electron
  44.5.0. In the main process it spawned `bash -l`, echoed input (`HELLO-42`), reported a resize
  (`stty size` → `40 132`) and the exit code (`exit 3` → 3). SIGKILLing the Electron main process
  closed the PTY and the shell exited (SIGHUP): no orphan. `node-pty` 1.1.0 is N-API and ships
  prebuilds for `darwin-arm64` and `darwin-x64` (and win32), so a macOS build may not need
  compiling on the Mac. The Mac build checks that.
- **M2 real devc web, locked down: pass.** The checkout's `devc web --live --source <copy>`
  ran with a stub `docker`. The view had every `webPreferences` and policy in "The devc view".
  - **Connection:** the WebSocket connected (Origin and Host passed `authorize`), and the page
    rendered the Pinned, Layout and Containers sections.
  - **Persistence:** `localStorage` survived an app restart with `partition: 'persist:devc'`.
  - **Copy:** **Copy page URL** (a trusted click) asked for **`clipboard-sanitized-write`**, the
    only permission devc web requested in normal use. The page URL landed on the clipboard.
  - **Clipboard read:** `navigator.clipboard.readText()` asked for `clipboard-read`, which the
    policy denies (`NotAllowedError`). devc web never reads it: paste uses the `paste` event.
    **Paste into a real terminal was not measured** (no container), so it is a macOS check.
  - **Links:** `window.open('https://…')` reached `setWindowOpenHandler` (deny +
    `openExternal`). `window.open('about:blank')` returns `null`, so `openInBrowser` takes its
    existing fallback, `window.open(url)`, which then reaches the handler with the real URL.
  - **Live reload:** a `--live` save of `style.css` then `app.js` reloaded the view, and the
    WebSocket reconnected. `/safe/` (same origin) loads, and navigating to `https://example.com/`
    is blocked by `will-navigate`.
  - **Never log permission `details`:** `details.requestingUrl` carries the page URL **with its
    `#token=`**. The app may log the permission name only.
  - **Harness quirks:** under Xvfb, Electron's `clipboard.readText()` in the main process hung.
    A synchronous `xclip` from the main process deadlocks too, because the app owns the
    selection. Read the clipboard asynchronously, from outside. Run with
    `app.disableHardwareAcceleration()` under Xvfb (the GPU process crashed otherwise).
- **M3 shortcuts: Cmd+J / Ctrl+Shift+J are kept.** devc web binds no J, and its only global
  shortcut is Ctrl/Cmd+Alt+N (pins). An Electron menu accelerator acts before the focused page
  sees the key, so it reaches neither devc web nor the host shell.
- **M4** runs on the built app (Verify).

## Concept boundaries

- **Three views, three partitions.** These are separate `WebContentsView`s, never iframes of
  each other:
  - **devc view:** devc web, partition `persist:devc`.
  - **status view:** partition `status`.
  - **host view:** partition `persist:host`.

  Only the status view and the host view have a preload. Never give the devc view one.
- **Host terminal vs devc web terminals.** devc web terminals are Herdr panes in containers.
  The host terminal is one `node-pty` process on the host, owned by the main process. They share
  no code at run time. The host view's xterm.js is its own npm dependency (`@xterm/xterm`,
  pinned), bundled into the app. It is never loaded from devc web's server or from
  `devc/web/static/vendor/`.
- **No Herdr on the host.** Herdr has a control API devc web knows how to drive.
- **IPC is a trust boundary.** Every `host-term:*` and `status:*` handler checks that
  `event.sender` is the expected view's `webContents`, and that `event.senderFrame` is that
  view's main frame at its bundled URL. Anything else is dropped and logged.
- **Restart devc web never touches the PTY**, and the host terminal survives `devc web` exiting.
- **Live modes are unchanged and still out of scope:** `--live-yolo` and `devc2` from a
  container-mounted checkout already run container-writable code on the host (see the archived
  plan's threat model).

## Existing touchpoints

| File                                                                    | Role                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devc-desktop/launch.ts`, `status.ts`, `main.ts`, `deno.json`, `tests/` | Replaced. The `launch.ts` rules and tests are ported.                                                                                                                                      |
| `devc-desktop/README.md`                                                | Rewritten.                                                                                                                                                                                 |
| `devc/web/static/app.js`                                                | Step 1: the five `confirm()`/`prompt()` call sites become in-page dialogs: Kill pane (~1549), Stop container (~2114), Rename pinned file (~2440), Delete (~3270), Rename terminal (~3929). |
| `devc/web/static/lib/`                                                  | A small dialog helper if it has pure parts.                                                                                                                                                |
| `.gitignore`                                                            | `devc-desktop/dist/` exists. Add `devc-desktop/node_modules/`.                                                                                                                             |
| `.plans/PLAN.md`                                                        | Entry for this plan.                                                                                                                                                                       |

## Contracts

### Step 1: in-page dialogs (devc web)

```js
/** Resolves true on OK / Enter, false on Cancel / Escape. Never a native dialog. */
confirmDialog(message, { okLabel = 'OK', danger = false } = {}) → Promise<boolean>
/** Resolves the entered text on OK / Enter, null on Cancel / Escape. */
promptDialog(message, defaultValue = '') → Promise<string | null>
```

- Built on `<dialog>` with `showModal()`. Text is inserted as text, never HTML (`devc-web`
  skill, rule 8).
- A test asserts that `devc/web/static/**/*.js` (outside `vendor/`) calls no `alert(`,
  `confirm(` or `prompt(`.
- This lands first, on its own. It is a page-only change, and plain browsers get it too.

### npm project (`devc-desktop/`)

- **Dependency versions:** exact, never ranges, and each release at least two weeks old when
  added. `electron`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@electron/rebuild`,
  `electron-builder`, plus whatever the TypeScript build needs. Record them in the README.
- **Scripts:**
  - `npm run check`: type-check everything.
  - `npm test`: unit tests, headless, no display.
  - `npm start`: run from source.
  - `npm run build`: `electron-builder` for the host OS. On macOS that is
    `dist/mac-arm64/devc.app`, unsigned. On Linux it is `dist/linux-unpacked/`.
- **Native module:** `node-pty` must be built for the target, so **the macOS app is built on
  the Mac** (`npm ci && npm run build`). Linux builds happen here.
- **TypeScript:** source is TypeScript, compiled or bundled to the JS Electron loads. The
  implementer picks the tool and records why.
- **Repo checks:** `deno fmt` keeps formatting the TS. Add a root-level note if `deno fmt`
  should skip `node_modules/`.

### The devc view

`webPreferences`:

```js
{ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
  webviewTag: false, disableDialogs: true, partition: 'persist:devc' }   // no preload
```

Policy is applied to its `webContents` and session. Keep each check a pure, unit-tested
function:

- **`setWindowOpenHandler`:** always `{action: 'deny'}`. If the URL is `http:` or `https:`, it is
  also passed to `shell.openExternal`. Any other scheme (`file:`, custom, `javascript:`) is
  dropped.
- **`will-navigate` / `will-redirect`:** `preventDefault` unless the target has devc web's origin
  (`http://127.0.0.1:<port>`, the ready line's), which covers reloads, `/safe/` and hash changes.
- **Permissions:** `setPermissionRequestHandler` and `setPermissionCheckHandler` on the
  `persist:devc` session allow **only** the clipboard-write permission M2 found. They deny
  everything else, including fullscreen, clipboard read, media, notifications, pointer lock and
  `openExternal`. Each request is logged at debug level.
- **`will-attach-webview`:** `preventDefault`.
- **The devc view never gets** a preload, IPC listeners, or `executeJavaScript` from main.
  Main has no reason to script it.

### The host view

- **Loading:** it loads a page from the app bundle (`file://` or a registered custom protocol),
  never from a network origin.
- **`webPreferences`:** `sandbox: true`, `contextIsolation: true`, `partition: 'persist:host'`,
  and `preload` set to the host preload.
- **Navigation and windows:** it may not navigate (`will-navigate` → `preventDefault`), and
  `setWindowOpenHandler` denies everything.

The preload exposes exactly this, as `window.hostTerm` via `contextBridge`:

```ts
interface HostTerm {
  start(cols: number, rows: number): void; // spawn the PTY if none is running
  input(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(cb: (data: string) => void): void;
  onExit(cb: (code: number) => void): void;
  info(): Promise<{ user: string; host: string }>; // for the header strip
  dragDrawer(dy: number): void; // the strip's drag handle resizes the drawer
}
```

IPC channels are `host-term:start`, `host-term:input`, `host-term:resize`, `host-term:info`
and `host-term:drag` (renderer → main), and `host-term:output` and `host-term:exit` (main →
renderer).

- **PTY:** `node-pty` runs the login shell (`$SHELL -l`, else `/bin/zsh` on macOS and
  `/bin/bash` elsewhere) in `$HOME`. Its environment is the login shell's environment (as
  `loginEnv` gets it) after `childEnv`'s stripping, plus `TERM=xterm-256color` and
  `COLORTERM=truecolor`.
- **One PTY at a time:** it is spawned on the first open, and spawned again on the next open
  after it exits. Output is batched to at most one IPC message per 16 ms.
- **Quitting:** SIGHUP to its process group, SIGKILL after 5 s, before the app exits.
- **The page:** xterm.js with fit.
  - A fixed header strip reads `HOST — <user>@<host>` and doubles as the drag handle.
  - Bracketed paste is on. A paste containing a newline shows a confirm bar with the text before
    sending it.
  - Copy and paste go through the Edit menu roles. There is no clipboard permission in this
    view beyond what Electron's roles need.

### Drawer and toggle

- **Toggle:** a menu item **Host Terminal**, accelerator `Cmd+J` on macOS and `Ctrl+Shift+J`
  elsewhere (or M3's choice), with the menu present on both platforms. Opening focuses the host
  view (`hostView.webContents.focus()`), and closing focuses the devc view.
- **No page can open it.** Nothing in the devc view or the status view can toggle it: no IPC, no
  message, no URL.
- **Layout:** the main process lays out the views. The drawer is 40% of the content height by
  default, and dragging its strip resizes it (min 120 px, max 85%). The height is remembered in
  Electron's `userData` and restored at launch. The drawer starts closed.
- **Refusals:** if the app was started with `--remote-debugging-port` or `--inspect*`
  (`app.commandLine.hasSwitch`, `process.execArgv`), the toggle opens the drawer showing why and
  starts no PTY.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc && deno task check && deno task test    # Step 1
cd ../devc-desktop && npm ci && npm run check && npm test && npm run build      # Linux
cd .. && deno fmt --check
```

Then, under Xvfb with `xdotool`:

1. **The app comes up:** the status view, then devc web (checkout, stub `docker`). Restart
   works, and quit leaves no `devc` and no shell behind.
2. **The host terminal works:** the toggle opens it focused, `echo`, resize, multi-line paste
   shows the confirm bar, and closing and reopening keeps the same shell.
3. **M4 again on the final build:** 0 leaked keystrokes, 0 host-term IPC from the devc view.

**Hand the user the macOS checks.** They build with `npm ci && npm run build` in
`devc-desktop/` on the Mac, then:

- **Launch:** Finder finds `devc` through the login shell, and devc web works as before:
  keyboard, Ctrl+W/T/N in terminals, copy and paste, links open in their browser, live reload.
- **Restart:** Cmd+R restarts devc web.
- **Host terminal:** Cmd+J opens it with their shell, and Cmd+C/V work there.
- **Quit:** Cmd+Q leaves nothing running.
- **Focus attack:** the implementer ships the throwaway attack copy of devc web, run with
  `--live --source`. Typing in the host terminal while it runs must show nothing in its log.
