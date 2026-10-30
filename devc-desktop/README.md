# devc-desktop

`devc web` in its own window, with a **host terminal** that slides up from the bottom and that
devc web cannot reach. The app runs the installed `devc web --no-open` as a child process. It
shows a status page while that starts, then shows the page `devc web` serves. Live mode
(`--live`, `--live-yolo`) works as in a browser tab.

It is an [Electron](https://www.electronjs.org/) app. One window holds separate views, each its
own browser instance (not frames of one page):

```
┌──────────── title bar ────────────┐
│ /sidebar          ┃               │
│ (devc web)        ┃   /main       │
│━━━━━━━━━━━━━━━━━━━┫   (devc web)  │
│ Containers pane   ┃━ HOST ━━━━━━━━│
│ (the app's)       ┃ host drawer   │
├─ /host-status (devc web) ─────────┤
└───────────────────────────────────┘
```

| View                | Shows                                                                                                                                     | Can reach                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **devc web**        | `/sidebar` (Tasks, In use, pinned files), `/main` (the tiles) and `/host-status` (the status strip across the window's foot): three views | devc web's own server, and nothing else                                                 |
| **Containers pane** | devc web's Containers section, built into the app, under a zone divider                                                                   | devc web's `/ws` with the desktop token (the desktop role), and the app's confirm cards |
| **rail**            | the divider between the left column and `/main`                                                                                           | its own drag and click, nothing else                                                    |
| **overlay menu**    | the Containers pane's right-click menu, over every other view                                                                             | the pick, nothing else                                                                  |
| **status**          | the status page while devc web starts, or why it stopped                                                                                  | Restart, nothing else                                                                   |
| **host terminal**   | your login shell on this machine, under `/main`                                                                                           | the shell, through the app                                                              |
| **title bar**       | the window's title, in place of the OS's own bar                                                                                          | nothing                                                                                 |

Drag the rail, the divider over the Containers pane and the drawer's **HOST** strip
to resize. The sizes are remembered. **Layout → Containers Pane** (Cmd+Shift+E, Ctrl+Shift+E on
Linux) hides the pane: `/sidebar` then takes the whole column and draws devc web's own
Containers section again. **Layout → Sidebar** (Cmd+B, Ctrl+Shift+B on Linux) hides the whole
left column, `/sidebar` and the Containers pane, leaving the window to `/main`, as devc web's own
page hides its sidebar; the rail stays at the window's edge, and a click or a drag on it shows the
column again. Whether it shows is remembered too.

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

Launched with no arguments (from the Dock or Finder), the app reads them from devc's global
config, `~/.config/devc/config.jsonc` when it exists, else `~/.config/devc/config.json` (never
both, as devc reads it; comments and trailing commas allowed in either):

```jsonc
{
  // What the Dock icon runs.
  "desktopWebArgs": ["--live-yolo"]
}
```

The app only reads the file, on every start; a message about it names the file read.

`--no-open` and `--desktop-channel` are always added (see [Host actions](#host-actions)). The
app never passes `--port`. It uses whichever port `devc web`
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
| Cmd+B           | Ctrl+Shift+B                | Shows or hides the sidebar (the whole left column)                 |
| Cmd+Shift+E     | Ctrl+Shift+E                | Shows or hides the Containers pane                                 |
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

## The Containers pane

The bottom of the left column is devc web's Containers section (running containers, their repo
cards, Not running, Add project), but its code is built into the app from this checkout's
`devc/web/static/containers.js` when the app is built. `devc web --live` changes `/sidebar` and
`/main` as you edit them; it never changes the pane. An edit to the Containers section reaches
the pane at the next build.

The pane connects to devc web's `/ws` with the desktop token, which gives it the server's
**desktop role**: it can start, stop and remove containers, add projects and move them, under
`--live` too, where the page can't. Under `--live-yolo` it does none of that (the server's code
then comes from the checkout): hide the pane and use devc web's own section. If the app was
built for another version of devc web's messages than the running one speaks, the pane shows
`This devc-desktop was built for protocol <n>; devc web speaks <m>. Rebuild devc-desktop.` and
nothing else.

**Push…**, **Start**, **Stop** and **Remove container** in the pane don't run at once. Each
shows a card at the top of the pane, worked out by the app as in the drawer's Actions column
(below): a push shows the app's own push plan, a start the folder and its `initializeCommand`
note. The confirm arms 1 s after the card last changed. The card's progress streams into it.

The pane's right-click menus are drawn by the **overlay menu**, a view of the app's own that sits
over every other view while a menu is open, so a menu can spread over `/sidebar` and `/main`. It
flips and shifts only at the window's edges. Use the arrow keys, Enter and Escape; a click
anywhere else, or resizing the window, closes it. devc web's own menus stay inside their views.

The pane reads as the bottom of one sidebar: the divider over it is the one In use and Containers
have in devc web's own sidebar (double-click resets the pane's height), and clicking
**CONTAINERS** folds the section, shrinking the pane to its heading. While one of its dialogs is
open (**Add project**, a task, a confirm), the app spreads the pane's view over the window below
the title bar, transparent, so the dialog and its backdrop cover the window as devc web's own do;
it goes back to its place when the dialog closes. devc web's own views do the same within devc web's part of the
window: while `/sidebar` or `/main` has a dialog open (a task, Ask agent, the file palette), the
app spreads that view over the column above the pane and `/main` above the drawer, never over an
app view, and dims the rest of the window below it with a view of its own.

## The host terminal

Ctrl+`(or Cmd+J on macOS) opens a drawer under`/main`running your login
shell (`$SHELL -l`) in your home folder. Drag its **HOST** strip to resize it. The height is
remembered. Closing the drawer keeps the shell, so reopening it finds the same session.
Restarting`devc web` does not touch it. If the shell exits, a key press starts a new one.

A paste with a line break in it is shown in a bar first, and goes in only when you press
**Paste**.

Right-click in the host terminal for **`cd <folder>`**: the folder on this machine behind devc
web's focused terminal pane (the pane's own directory, through its container's bind mounts).
Clicking it clears whatever is typed at the prompt (Ctrl+E, Ctrl+U) and runs `cd '<folder>'`.
A second item, **`cd <folder> (primary)`**, goes to that pane's container's own folder on
this machine, the one it was created from. It is left out when it is the same folder. The item is
disabled, with the reason, when there is no such folder, and both are disabled while a program
runs in the shell (`(busy: vim)`). If devc web is open in a browser too, the window you used last
decides which pane counts.

### Host actions

devc web's page can **ask** for a push or a container start: **Push…** on a repo card's menu,
and, under `--live`, **Start** on a stopped project. It can never confirm one. The request shows
in the drawer's **Actions** column, 280 px to the left of the terminal and hidden when nothing is
pending. A request never opens the drawer or takes focus. With the drawer closed, only its
**HOST** strip shows at the bottom of the window, badged `1 request`, until you open it with
Ctrl+` (or Cmd+J). Each card shows what the app worked out itself:

- **Push:** the app checks the repo's folder (below) and runs `devc git push-plan` there with the
  same `devc` it runs `devc web` with. The card shows the branch → remote, the tip's short SHA,
  the commits (subject and author, as text), and warnings for the default branch, workflow
  changes, a non-fast-forward and an LFS pointer. **Push** runs `devc git push <folder> --sha
  <that SHA>`, its output streaming into the card. A commit made after the plan makes it fail with
  `the branch moved`; ask again for a new plan. With `desktopDevc: "devc2"` every push card says
  that devc runs from the checkout.
- **Start / Stop / Remove container:** the project's folder, and for a start `Runs its
  devcontainer.json's initializeCommand on this machine`. Confirming asks devc web's server
  (`POST /desktop/project`), its progress streaming into the card. Under `--live` this starts
  containers, never projects on this machine. Under `--live-yolo` devc web refuses it: start from
  the page there.

The confirm button is disabled until 1 s after the card's content last changed, and a click
counts only if its press began after that. **Dismiss** drops a request; **Close** clears a
finished one. A request that fails the checks is greyed with its reason and can't be confirmed.

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
It is checked again when you click, and nothing is typed if the folder changed. The primary
folder comes from the container's `devcontainer.local_folder` label, which is set on this machine
when the container is created, and gets the same checks. Anything holding the token (devc web's page,
an agent with it) can choose **which** pane counts.

**The Containers pane** is the one view that gets the desktop token, through its preload,
never in its URL. It is sandboxed in its own partition, is loaded only from the app's bundle and
can't navigate off it, and is granted copying and the local network access Chromium asks for
before a `file:` page reaches devc web on `127.0.0.1` (its CSP allows nothing else). Its code is
the checkout's at build time, never what `--live` serves. Container names, branches, folders and
the like are inserted as text only. It still trusts devc web's server for what it lists, as the
page does. `/sidebar` (an agent can control it) relays to it, as it does to devc web's own
`/containers` page: which card to reveal or fold, and which cards In use shows. The pane takes
those as data only.

**The overlay menu** is trusted, and drawn over devc web's views; never the reverse, since no
other views overlap. Only the Containers pane can open it, with labels it inserts as text (control,
bidi and zero-width characters replaced). devc web's views never reach it: a page's menu in
trusted-looking UI would let the page put words there.

**Host actions** extend this with a second token. `devc web --desktop-channel` prints a
**desktop token** on stdout only (`devc web: desktop <64 hex>`). The app reads it there and keeps
it in memory. It is never in a URL, a page or an environment variable (projects on this machine
inherit devc web's environment). devc web's server takes it, and only it, on
`/desktop/requests` and `/desktop/project`. It never takes the page token there, nor the desktop
token anywhere else. The page can only queue a request (`request_push`, `request_project`), which
names a kind and a folder and nothing else. The app reads the queue, and everything in it is
checked before it is shown. The answer must be well-formed, at most 20 requests, with printable
folders. Each folder's real path must be a folder with a showable name of at most 256 characters,
as for the `cd` item, without the mount part. The push plan comes from the app's own `devc git
push-plan`, never from devc web, and the push sends exactly the SHA shown. A commit's subject and
author are shown as text, with control, bidi and zero-width characters replaced. Confirming is a
click in the host view, which devc web cannot reach or focus.

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
- **Spoofing inside devc web's area.** devc web can draw something that looks like a terminal,
  a Containers pane or a menu in its own part of the window. The real ones are always under a
  **HOST** strip (or, for a menu, open from the pane), where devc web cannot draw.
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
- **What a host action asks for.** The page chooses which repo or project a request names, and
  can keep asking (rate-limited). It can't choose what the plan says, but a container can write
  the commits in it. Read the card before you confirm.
- **devc web's server for project actions.** Without `--live-yolo` it is the installed `devc`,
  and `POST /desktop/project` trusts it to start the project it names. A start runs the project's
  `initializeCommand` on this machine, whoever wrote it.
- **`devc2` pushes.** With `desktopDevc: "devc2"` the push runs devc from the checkout, which a
  container may have written. The card says so on every push.
- **A folder swapped between the plan and the push.** `devc git push` pushes the SHA shown, and
  refuses it when the branch has moved, but reads the folder again.

## Development

```sh
npm run check   # tsc over src/ and tests/
npm test        # node --test: launch, policy and PTY rules
npm start       # bundle and run from source
```

**Layout:**

- `src/main/`: the main process. `main.ts` holds the window, views, menus and IPC.
  `launch.ts` finds `devc`, runs `devc web` and reads its ready and desktop lines, and runs
  `devc git` for the host actions. `policy.ts` holds the pure rules (navigation, windows,
  permissions, IPC senders, drawer geometry, and the host actions' checks and cards). `pty.ts` is the host shell.
- `src/preload/`: the status, host, title bar, Containers pane, rail and overlay menu bridges.
- `src/renderer/`: the bundled pages. `containers.ts` is the Containers pane's entry: it imports
  devc web's own `containers.js` and what it imports (`devc-web/…`, mapped to
  `../devc/web/static/` by `build.mjs`). `actions.ts` draws the action cards the drawer and the
  pane share.

`build.mjs` bundles them with esbuild into `build/` (the pane, with devc web's `style.css`, into
`build/containers/`), which electron-builder packs.
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
