# devc-desktop

`devc web` in its own window, with a **host terminal** that slides up from the bottom and that
devc web cannot reach. The app runs the installed `devc web --no-open` as a child process. It
shows a status page while that starts, then shows the page `devc web` serves. Live mode
(`--live`, `--live-yolo`) works as in a browser tab.

It is an [Electron](https://www.electronjs.org/) app. One window holds three separate views, each
its own browser instance (not frames of one page):

| View              | Shows                                                    | Can reach                               |
| ----------------- | -------------------------------------------------------- | --------------------------------------- |
| **devc web**      | devc web's page                                          | devc web's own server, and nothing else |
| **status**        | the status page while devc web starts, or why it stopped | Restart, nothing else                   |
| **host terminal** | your login shell on this machine                         | the shell, through the app              |

## Build

Run these in this directory. You need Node 24 and npm 11. `.nvmrc` names the Node version, so
`nvm install` (or `nvm use`, or fnm) here picks it, on a Mac as in a container.

```sh
npm ci              # dependencies; npm 11 runs only the install scripts listed under
                    # "allowScripts" in package.json (esbuild, node-pty)
npm run build       # for this OS and CPU: dist/linux-unpacked/ on Linux, dist/mac/ or
                    # dist/mac-arm64/ on macOS
npm run build:mac   # both macOS apps from Linux: dist/mac/devcd.app (Intel) and
                    # dist/mac-arm64/devcd.app (Apple silicon)
```

**Building the macOS apps from a Linux container.** `npm run build:mac` cross-builds an Intel
and an Apple silicon app. It uses `node-pty`'s own macOS prebuilds, so nothing is compiled, and
each app carries both, loading the one for its CPU. The checkout is bind-mounted, so the apps
land on the Mac's disk. They are **unsigned**. If macOS refuses to open one, sign it ad hoc once
on that Mac:

```sh
codesign --force --deep --sign - dist/mac-arm64/devcd.app   # or dist/mac/devcd.app (Intel)
```

**Taking an app to another Mac.** Zip it with `ditto`, which keeps the bundle intact:

```sh
ditto -c -k --keepParent dist/mac-arm64/devcd.app devcd-arm64.zip
```

A copy that arrives by download, AirDrop or Messages is quarantined, and macOS blocks an
unsigned quarantined app. Clear the quarantine there, then sign it ad hoc:

```sh
xattr -dr com.apple.quarantine devcd.app && codesign --force --deep --sign - devcd.app
```

Building on the Mac itself (`npm ci && npm run build`) also works. Its `node-pty` comes from
the same prebuild.

Each app is about 330 MB on macOS and 290 MB on Linux, unpacked.

## Run

Open `dist/mac/devcd.app` (Intel) or `dist/mac-arm64/devcd.app` (Apple silicon), or run `dist/linux-unpacked/devc-desktop` on Linux. From
source, `npm start`.

A terminal launch passes its arguments on to `devc web`. Chromium's own switches
(`--remote-debugging-port`, `--inspect`, `--no-sandbox` and the like) are not passed on.

```sh
dist/mac/devcd.app/Contents/MacOS/devcd --live-yolo
```

Launched with no arguments (from the Dock or Finder), the app reads them from
`~/.config/devc/config.json`:

```json
{ "desktopWebArgs": ["--live-yolo"] }
```

`--no-open` is always added. The app never passes `--port`. It uses whichever port `devc web`
picks, read from the URL `devc web` prints.

### Which `devc`

`"desktopDevc"` in the same file picks it:

| `desktopDevc`            | Runs                                          |
| ------------------------ | --------------------------------------------- |
| absent, or `"installed"` | the installed `devc`                          |
| `"devc2"`                | the checkout from source, through `$DEVC_BIN` |
| an absolute path         | that `devc` binary                            |

```json
{ "desktopDevc": "devc2", "desktopWebArgs": ["--live-yolo"] }
```

- **`installed`:** `devc` on the app's `PATH`, else on your login shell's (`$SHELL -ilc`, else
  `/bin/zsh`).
- **`devc2`:** `$DEVC_BIN`. Sourcing [`scripts/bash_aliases.sh`](../scripts/bash_aliases.sh)
  exports it as `devc2`'s from-source invocation (`deno run … devc/main.ts`), so no build of
  devc is needed. It comes from the app's environment, else your login shell's, so the shell
  that sets it must source that file.
- **`$DEVC_DESKTOP_DEVC`** (an absolute path) overrides `desktopDevc` for a terminal launch.

An app opened from the Dock gets a minimal `PATH` without `~/.local/bin`, `docker` or `deno`,
and none of your shell's variables, so the app asks your login shell. Its `PATH` is also passed
on to `devc web`.

If `devc` can't be found or `devc web` exits, the window shows why, with the last lines of its
stderr and a **Restart devc web** button.

### Shortcuts

| macOS           | Linux                       | Does                                                               |
| --------------- | --------------------------- | ------------------------------------------------------------------ |
| Cmd+J or Ctrl+` | Ctrl+`                      | Opens or closes the host terminal                                  |
| Cmd+R           | Ctrl+Shift+R                | Restarts `devc web` (a new token; a copied page URL stops working) |
| Cmd+Q           | Ctrl+Shift+Q                | Quits                                                              |
| Cmd+C / Cmd+V   | Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste                                                       |
| Alt+Cmd+I       | Ctrl+Shift+I                | devc web's developer tools                                         |

Ctrl+` is VS Code's terminal toggle, and Cmd+J its panel toggle. On Linux the app's other
shortcuts take Ctrl+Shift, because Ctrl+C, Ctrl+R and the like belong to the terminals. The menu
bar shows when you press Alt. On macOS the menu is in the screen's menu bar, under the app's
name (**devc**).

### Closing

Closing the window or quitting stops `devc web` (SIGTERM, then SIGKILL after 5 s) and the host
shell (SIGHUP to its process group, then SIGKILL), and then exits.

## The host terminal

Ctrl+`(or Cmd+J on macOS) opens a drawer at the bottom of the window running your login
shell (`$SHELL -l`) in your home folder. Drag its **HOST** strip to resize it. The height is
remembered. Closing the drawer keeps the shell, so reopening it finds the same session.
Restarting`devc web` does not touch it. If the shell exits, a key press starts a new one.

A paste with a line break in it is shown in a bar first, and goes in only when you press
**Paste**.

Right-click in the host terminal for **`cd <folder>`**: the folder on this machine behind devc
web's focused terminal pane (the pane's own directory, through its container's bind mounts).
Clicking it clears whatever is typed at the prompt (Ctrl+E, Ctrl+U) and runs `cd '<folder>'`.
The item is disabled, with the reason, when there is no such folder, and while a program runs
in the shell (`(busy: vim)`). If devc web is open in a browser too, the window you used last
decides which pane counts.

### Why devc web cannot reach it

An agent in a container can control devc web's page, for example through `--live` code from a
checkout it can write, or a token it learns. So devc web's view is locked down:

- **No access to the app:** no preload and no IPC. The page sees no `require`, no `process`,
  and nothing of the app's own.
- **No dialogs:** `alert`, `confirm` and `prompt` are off. devc web asks with its own in-page
  dialogs.
- **No windows:** a `window.open` of an `http(s)` URL goes to your system browser, and anything
  else is dropped.
- **No navigation off devc web's own address**, and no `<webview>`.
- **No permission but copying:** no clipboard reading (it would see what you copied from the
  host terminal), no fullscreen, no media, no notifications.
- **Its own storage partition**, separate from the host terminal's.

The host terminal's page is loaded from the app itself, never from a server. It talks to the
shell only over IPC, and the app checks every message's sender. The app runs **no** network
listener of its own. The drawer only opens from the app menu. Started with a debugging switch
(`--remote-debugging-port`, `--inspect`), the app keeps the host terminal off, because those
would let any local process drive it.

**The right-click `cd`** gets its folder from devc web's server, never from devc web's page
directly. The page tells the server which pane is focused, and the app asks the server
(`GET /desktop/active-folder` with the token). The page still has no way to reach the app. The
answer comes from the page, Herdr and the container, so the app checks it before showing it:
the folder's real path (symlinks resolved on this machine) must be inside the bind mount it came
from, must be a folder, and must have a printable name of at most 256 characters, with no
control, bidi or zero-width characters. That real path is what it types, quoted. The item shows
it with `~` for your home folder. A label longer than 80 characters shortens the mount's own part
to `…/<mount name>`, but never the part below the mount, which is the part a container chooses.
It is checked again when you click, and nothing is typed if the folder changed. Anything holding the token (devc web's page,
an agent with it) can choose **which** pane counts.

**What was tested:** Electron 44.5.0 under Xvfb on Linux, with real keystrokes. A hostile copy
of devc web tried to take keyboard focus every 300 ms, with `window.focus()`, focusing an input,
`autofocus`, `showModal`, dialogs, fullscreen and `window.open`, both before and after the user
had clicked in devc web.

- **Keystrokes:** none of the keystrokes typed into the host terminal reached devc web.
- **Reach:** it found no bridge to the app and could not read the clipboard.

The measurements are in
[`.plans/devc-desktop-electron.md`](../.plans/devc-desktop-electron.md) and
[`.plans/archived/devc-desktop-host-terminal.md`](../.plans/archived/devc-desktop-host-terminal.md).

**What it does not protect against:**

- **Live modes run code a container may have written.** `--live-yolo` runs devc web's server
  code from the checkout on this machine, and `desktopDevc: "devc2"` runs devc itself from
  source. When that checkout is mounted into a container, an agent that edits it runs code here
  at the next start. That holds with or without the host terminal.
- **The app's own source.** The host terminal is only as trustworthy as the checkout it was
  built from.
- **Spoofing inside devc web's area.** devc web can draw something that looks like a terminal
  in its own part of the window. The real one is always below it, under the **HOST** strip,
  where devc web cannot draw.
- **The toggle shortcut is visible.** Pressing Ctrl+` or Cmd+J while devc web has focus shows devc web
  that keypress, but nothing typed in the host terminal. devc web could also swallow it while
  it has focus. The menu item works regardless.
- **Pasting what an agent put on the clipboard.** devc web can write the clipboard (copy). The
  paste bar shows multi-line pastes before they run, but a one-liner goes straight in.
- **`cd` into a container-writable repo and running git there**, as in any terminal. devc's
  git-protect is the defence there.
- **Which folder the right-click `cd` offers.** A container can steer it to any folder inside
  your bind mounts. You see the folder before you click.
- **A folder swapped after the check.** A container can replace a folder with a symlink between
  the app's check and the `cd`. Look at the prompt afterwards.
- **vi-mode shells.** Ctrl+E and Ctrl+U may not clear the prompt before the `cd`.

## Development

```sh
npm run check   # tsc over src/ and tests/
npm test        # node --test: launch, policy and PTY rules
npm start       # bundle and run from source
```

**Layout:**

- `src/main/`: the main process. `main.ts` holds the window, views, menus and IPC.
  `launch.ts` finds `devc` and runs `devc web`. `policy.ts` holds the pure rules (navigation,
  windows, permissions, IPC senders, drawer geometry). `pty.ts` is the host shell.
- `src/preload/`: the status and host bridges.
- `src/renderer/`: the two bundled pages.

`build.mjs` bundles them with esbuild into `build/`, which electron-builder packs.
`after-pack.cjs` makes `node-pty`'s `spawn-helper` executable in the packed app.

**Versions:** exact, each at least two weeks old when added: Electron 44.5.0, `node-pty` 1.1.0,
`@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, esbuild 0.28.2, TypeScript 7.0.2,
electron-builder 26.17.0. `deno fmt` (run from the repo root) formats the sources. The
`deno.json` here only carries its settings.

**Running headless on Linux:** `xvfb-run -a npm start`, with `DEVC_DESKTOP_DISABLE_GPU=1` if the
GPU process fails under Xvfb. To try the app without Docker, point `DEVC_DESKTOP_DEVC` at a
stand-in script, or put a stub `docker` first on `PATH`. The `chrome-sandbox` helper must be
setuid root (`sudo chown root:root …/chrome-sandbox && sudo chmod 4755 …/chrome-sandbox`), or
the app will not start.
