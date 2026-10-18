# devc-desktop-host-terminal

- [ ] Step 0: isolation gate (§ Step 0). **If any check fails, stop and report to the user.** Do
      not build the drawer. Offer the fallback ([§ Fallback](#fallback-open-iterm-from-the-app-menu)) instead.
- [ ] Step 1: devc web can be framed by the shell: `--frame-ancestor`, and no `confirm()`/`prompt()`
- [ ] Step 2: host PTY helper and its framing, with tests
- [ ] Step 3: the shell page (devc web iframe + host drawer), served only by the desktop process
- [ ] Step 4: the shell ↔ main-process channel (bindings, or the loopback fallback that Step 0 picks)
- [ ] Step 5: focus guard, paste confirm, the trusted strip, toggle via the app menu
- [ ] Step 6: `devc-desktop/README.md`: a "Host terminal" section with the threat model below
- [ ] Verify (below), including the adversarial checks, then ask the user to run the macOS checks

A terminal on the **host** that slides up from the bottom of the devc-desktop window, below
`devc web`, like VS Code's panel. **The constraint that decides everything:** nothing an agent can
influence may be able to type into it, read it, open it or impersonate it. If Step 0 cannot show
that, the drawer is not built.

## Why this shape

`deno desktop` (2.9) has exactly one webview per `BrowserWindow`, and no embedded views (no
`WebContentsView` equivalent; docs.deno.com/runtime/desktop/windows). A pane inside one window
therefore means frames. The design keeps **two parties**:

- **The shell page** is the window's top frame. It is owned and served by the desktop process.
  It draws the host drawer (xterm.js on the host PTY) itself.
- **devc web**, which agents must be assumed to control, runs in a **sandboxed, cross-origin
  `<iframe>`** inside the shell. It is a child that cannot reach its parent.

The host terminal is **not** a second iframe. Iframes can navigate sibling iframes, and a parent
cannot be navigated by a sandboxed child, so the terminal lives in the frame that devc web cannot
touch.

```
┌──────────────── BrowserWindow (top frame: shell page, origin S) ────────────────┐
│ ┌──────────── <iframe sandbox> devc web (origin D) ─────────────────────────┐ │
│ │                                                                            │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ ▔▔ HOST TERMINAL — brian@mac ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ (shell-drawn) ▔▔ │
│ $ _                                                     (xterm.js in the shell) │
└────────────────────────────────────────────────────────────────────────────────┘
```

## Threat model

**The attacker** is an agent in any devcontainer. It can:

- send anything to `devc web`'s server (it can learn the token);
- run arbitrary JavaScript in the devc web iframe (the page can be live-reloaded from a
  container-writable checkout);
- write the clipboard through devc web;
- reach host ports bound to `127.0.0.1` via `host.docker.internal` (Docker Desktop forwards them).

**The guarantee:** with all of that, it cannot:

- send input to the host terminal, or read its output;
- move keyboard focus out of it;
- open it;
- navigate the shell;
- draw over the shell's own strip and drawer.

**Out of scope, and stated in the README:**

- **Live modes already give host code execution, with or without this feature.**
  - `--live-yolo` runs devc web's server code from the checkout on the host.
  - `desktopDevc: "devc2"` runs devc itself from source.
  - When that checkout is bind-mounted into a container, an agent that edits it runs code on the
    host at the next swap or start. The drawer adds no path beyond that one, and does not close it.
- **The desktop app's own source.** The drawer is only as trustworthy as the checkout
  devc-desktop was built from.
- **Spoofing inside devc web's own rectangle.** devc web can draw a fake terminal within its
  iframe. The defense is that the real drawer and the strip are where devc web cannot draw
  (Step 5).
- **Pasting** agent-planted clipboard text yourself. This is mitigated by the paste confirm, not
  prevented.
- **`cd`ing into a container-writable repo** and running git there (`core.fsmonitor`, hooks).
  That is the same as in iTerm today. devc's git-protect is the mitigation.
- A Chromium renderer exploit.

## Step 0: isolation gate (do first, record answers here)

Use throwaway probe apps (as in the [devc-desktop](archived/devc-desktop.md) spike): a shell page
with a sandboxed cross-origin iframe running an **attack page**, and xterm.js in the shell. Run
them on Linux under Xvfb, then on macOS. Every check must pass.

**G1. Bindings scope.** Register `win.bind('probe', …)` and call `bindings.probe()` from:

- (a) the shell's top frame;
- (b) the iframe;
- (c) a page the iframe opens with `window.open`.

**Only (a) may succeed.** If (b) or (c) can call it, bindings are unusable. Step 4 then uses the
loopback channel instead. That is not a no-go.

**G2. Containment.** From the iframe, try each of these. Each must fail or yield nothing:

- reading `parent.document`;
- `top.location = …` (with and without a click first);
- `parent.postMessage` that changes shell state (the shell must ignore every message);
- `window.open(<shell URL>)` then scripting it;
- reading `localStorage`, `BroadcastChannel` or cookies of the shell origin;
- `requestFullscreen()`;
- `requestPointerLock()`;
- `alert`, `confirm` and `prompt` (must be blocked by the sandbox).

**G3. Focus theft: the decisive check.** Focus the shell's terminal and type continuously. From
the iframe, on timers, try each of the following:

- `window.focus()`;
- `element.focus()` on an input;
- inserting an `autofocus` input;
- `dialog.showModal()`;
- `window.open()`;
- `location.reload()`;
- navigating itself.

Repeat each after the user has clicked inside the iframe earlier (sticky activation), and with
the shell's pointer overlay up (Step 5). **Pass means not one keystroke ever lands in the iframe**
(the attack page logs every key it gets). Record what Chromium 149 / CEF does for each attempt.
If any attempt moves focus even briefly, the single-window drawer is a **no-go**.

**G4. Process separation.** With the shell on `http://localhost:<S>` and devc web on
`http://127.0.0.1:<D>` (different hosts, so different sites), confirm the two frames run in
different renderer processes (`chrome://process-internals` via `openDevtools`, or the process
list). Record whether same-host-different-port would also have split them.

**G5. Popups.** devc web opens links with
`window.open(url, '_blank', 'noopener,noreferrer')` (Cmd/Ctrl+click). Record where a popup from
the sandboxed iframe goes:

- the system browser;
- a new CEF window (whose title and content the attacker controls);
- nowhere.

Under a new CEF window, the main process must be able to recognize it and mark or refuse it. If it
can do neither, links must be routed differently (a `linkclick`-style message to the shell,
which opens the system browser), and `allow-popups` is dropped.

**G6. Debugging ports.** Find what exposes CDP (`LAUFEY_REMOTE_DEBUGGING_PORT`, CEF switches) and
how the app detects it. The drawer refuses to open while it is set.

**G7. Native input only.** Confirm that events synthesized in the iframe (`dispatchEvent`) do not
reach the main process's `keydown` listeners or menu accelerators.

**Outcome:** if G2, G3, G6 or G7 fails, or G5 has no fix, write "No-go" and the failing check at
the top of this file, set the `PLAN.md` entry to **No-go**, and tell the user. The fallback below
is then the plan.

## Concept boundaries

- **Shell page vs status page vs devc web.**
  - The status page (`status.ts`, the app's first `Deno.serve` via `DENO_SERVE_ADDRESS`) becomes
    part of the shell. The shell shows status in place of the iframe while `devc web` starts or
    has failed.
  - The window is navigated **once**, to the shell, and never again. `start()`, `restart()` and
    the child's exit change the iframe's `src` through `executeJs` into the shell, instead of
    `win.navigate`.
- **Host terminal vs devc web terminals.** devc web terminals are Herdr panes in containers. The
  host terminal is a bare PTY owned by the desktop main process. No code is shared:
  - the shell vendors its **own** xterm.js under `devc-desktop/shell/`, embedded in the build;
  - it never loads anything from devc web's server or from the checkout at run time;
  - there is no Herdr on the host.
- **Who may open the drawer.** Only the user can: the native app menu, or a click on the
  shell-drawn strip. The shell ignores every `postMessage` from the iframe. devc web has no
  "open host terminal" action, and must never gain one.
- **`--frame-ancestor` is not a credential.** It only lets devc web be framed by the shell's
  origin. It grants the shell nothing inside devc web, which stays cross-origin.

## Existing touchpoints

| File                        | Role                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `devc/web/server.ts`        | CSP `frame-ancestors 'none'` (line ~190) becomes the `--frame-ancestor` origin when given. The default is unchanged. |
| `devc/args.ts`, `devc/help.ts`, `devc/README.md` | The new `devc web --frame-ancestor <origin>` flag.                                              |
| `devc/web/static/app.js`    | `confirm()` (Kill pane, ~1435, ~1996) and `prompt()` (rename, ~3075) become in-page `<dialog>`s, because the sandbox has no `allow-modals`. If G5 says so, the `window.open` link path (~3705) changes. |
| `devc-desktop/main.ts`      | Loads the shell once. `start`/`restart`/exit drive the iframe via `executeJs`. Adds the app menu's **Host Terminal** item, the binding (G1), the debug-port refusal, and kills the PTY in `shutdown()`. |
| `devc-desktop/launch.ts`    | `devcArgs` adds `--frame-ancestor <shell origin>`. `childEnv` stays free of anything host-terminal related (tested). |
| `devc-desktop/status.ts`    | Folded into the shell, or kept as the shell's status view.                                               |
| `devc-desktop/deno.json`    | `--include` for the shell assets and the PTY helper.                                                     |

New: `devc-desktop/shell/` (page, vendored xterm.js), `devc-desktop/host_pty.ts` (spawns the
helper and speaks its framing), `devc-desktop/hostpty/` (the Go helper).

## Contracts

### Step 1: devc web in a frame

- `devc web --frame-ancestor <origin>`: `<origin>` must parse as `http://localhost:<port>` or
  `http://127.0.0.1:<port>`, else exit 2. CSP becomes `frame-ancestors <origin>`. Without the
  flag, it is `'none'`, as today. Tested in `devc/tests/web_server_test.ts`.
- No `alert`/`confirm`/`prompt` anywhere in `devc/web/static/` (a test greps for them). Each
  becomes a `<dialog>` with the same wording.

### The iframe

```html
<iframe id="devc"
  src="http://127.0.0.1:<D>/#token=…"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
  allow="clipboard-read; clipboard-write"
  referrerpolicy="no-referrer"></iframe>
```

- **No** `allow-modals`, `allow-top-navigation*`, `allow-pointer-lock`, `allow-presentation`, or
  `fullscreen`.
- `allow-popups*` only if G5 allows it.
- The shell's CSP is `default-src 'self'; frame-src http://127.0.0.1:<D>; connect-src 'self'`
  (plus `ws:` for the loopback fallback).

### Step 2: host PTY (Go helper `devc-pty`, `github.com/creack/pty`)

Deno has no PTY API. The helper runs `$SHELL -l` (else `/bin/zsh` on macOS, `/bin/bash`
elsewhere) in `$HOME`, never listens on anything, and exits when its stdin closes. Its
stdin/stdout framing:

```
frame   = type:u8  length:u32be  payload
type 0  data   (both directions; raw bytes)
type 1  resize (to helper; payload = cols:u16be rows:u16be)
type 2  exit   (from helper; payload = code:i32be)
```

Tests: round-trip, resize, exit code, and dying when stdin closes.

### Step 4: shell ↔ main process

- **If G1 passed (bindings are top-frame only):**
  - **Shell → main:** `bindings.hostInput(b64)`, `bindings.hostResize(cols, rows)`,
    `bindings.hostOpen()` (start the PTY if none is running).
  - **Main → shell:** `win.executeJs('hostOutput("<b64>")')` and `hostExit(code)`, batched to
    one call per 16 ms.
  - No network listener at all.
- **Else (loopback fallback):**
  - A second `Deno.serve` on `127.0.0.1:0`, serving only `GET /pty` (a WebSocket).
  - A 32-byte secret is handed to the shell by `executeJs` and sent as the first WebSocket
    message. It is consumed on first use, and the next connection needs a new one.
  - `Host` and `Origin` must equal the shell's own. Only one connection at a time, and the first
    message must arrive within 2 s.
  - The secret is never in a URL, an env var, an argument, a file or a log.
  - Pure checks are tested.

### Step 5: shell behavior

- **Drawer:** it slides up from a strip at the bottom of the window and is resizable by dragging
  its top edge. The iframe always ends **above** the strip, so devc web never draws over the
  drawer. The strip is always visible (open or closed), drawn by the shell, and reads
  "HOST TERMINAL — `<user>@<hostname>`".
- **Toggle:** the app menu item **Host Terminal** (accelerator Cmd+J, unless Step 0 finds
  it taken) calls `executeJs('toggleHost()')`. A click on the strip
  also toggles it. On Linux there is no app menu, so only the strip works.
- **Focus guard:** while the drawer has focus, a transparent overlay owned by the shell covers the
  iframe. A real click on the overlay removes it and focuses the iframe. That way devc web gets no
  user activation while you type in the host pane. G3 must pass with **and** without the overlay.
  The overlay is defense in depth, not the gate.
- **Paste:** bracketed paste is on. A paste containing a newline shows a confirm bar with the text
  before anything is sent.
- **Refuses to open** while a debugging port is set (G6), and says why in the drawer.
- **Quitting the app** sends SIGHUP to the PTY's process group, then SIGKILL after 5 s.

## Fallback: open iTerm from the app menu

If the gate fails, build this instead. It is small and has no isolation questions:

- A macOS app-menu item **Open iTerm at Project ▸** with one submenu entry per project. The
  entries come from `~/.config/devc/projects.json` (`localFolder`), read when the menu is built,
  with **Home** first.
- Choosing one runs `open -a iTerm <localFolder>`, or `open -a Terminal` when iTerm is not
  installed.
- **It is native-menu only.** devc web gets no message, button or URL that triggers it, because
  devc web is agent-drivable and the trigger must be a real keystroke or click on native UI.
- The path list can include folders an agent pinned through devc web (`add_project`). Opening a
  shell in a host folder is no worse than `cd` there in iTerm, and the README's git-in-a-
  container-writable-repo caveat applies the same way.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc && deno task check && deno task test
cd ../devc-desktop && deno task check && deno task test && deno task build
cd hostpty && go test ./...
cd /workspaces/tools/devc-tools && deno fmt --check
```

Adversarial checks against the real build under Xvfb:

1. **Every G2/G3/G5/G7 attack, from inside devc web**, the way an agent would get code there: run
   `devc web --live --source <throwaway copy>` with the attack script appended to that copy's
   `app.js`. Not one keystroke reaches it, and nothing escapes.
2. **The secret, if the loopback channel is used:** `grep` the app's and its children's
   environments (`/proc/<pid>/environ`), stderr and `~/.config/devc/` for it. Never found.
3. **No orphan shell:** SIGKILL the app, then `pgrep -f devc-pty` finds nothing.
4. **Debug port:** set it and confirm the drawer refuses to open.

Then ask the user, on macOS:

- toggle the drawer with the accelerator while typing in a devc web terminal;
- run `ls ~`, resize, and paste multi-line text (the confirm bar should appear);
- check that devc web still works in the frame: Kill pane, rename, links, Copy page URL, live
  reload;
- quit the app (no shell left behind).
