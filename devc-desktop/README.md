# devc-desktop

`devc web` in its own window instead of a browser tab. The app runs the installed
`devc web --no-open` as a child process. It shows a status page while that starts, then
points its window at the URL `devc web` prints. Everything else is `devc web` itself,
live mode (`--live`, `--live-yolo`) included.

It is a [`deno desktop`](https://docs.deno.com/runtime/desktop/) app with the CEF
(Chromium) backend, so the page renders as it does in Chrome. `deno desktop` is
experimental in Deno 2.9.

## Build

Requires Deno 2.9 or later. From this directory:

```sh
deno task build   # dist/devc.app on macOS; dist/devc/ (launcher and CEF) on Linux
```

The first build downloads the CEF backend. The bundle is about 310 MB on macOS (arm64)
and 450 MB on Linux, unpacked. A macOS app can be cross-built from Linux with
`--target aarch64-apple-darwin`, but only without `--icon`.

## Run

Open `dist/devc.app`, or run `dist/devc/devc` on Linux. A terminal launch passes its
arguments on to `devc web`:

```sh
dist/devc.app/Contents/MacOS/laufey --live-yolo   # laufey: deno desktop's launcher
```

Launched with no arguments (from the Dock or Finder), the app reads them from
`~/.config/devc/config.json`:

```json
{ "desktopWebArgs": ["--live-yolo"] }
```

`--no-open` is always added. The app never passes `--port`: it uses whichever port
`devc web` picks, read from the URL it prints.

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

- **`installed`:** `devc` on the app's `PATH`, else on your login shell's
  (`$SHELL -ilc`, else `/bin/zsh`).
- **`devc2`:** `$DEVC_BIN`, which sourcing
  [`scripts/bash_aliases.sh`](../scripts/bash_aliases.sh) exports as `devc2`'s
  from-source invocation (`deno run … devc/main.ts`), so no build of devc is needed.
  It comes from the app's environment, else your login shell's, so the shell that
  sets it must source that file.
- **`$DEVC_DESKTOP_DEVC`** (an absolute path) overrides `desktopDevc` for a terminal
  launch.

An app opened from the Dock gets a minimal `PATH` without `~/.local/bin`, `docker` or
`deno`, and none of your shell's variables, so the login shell is asked. Its `PATH` is
also passed on to `devc web`.

The app always passes `--no-open`, which `devc` has had only since the release after
0.10.0. An older installed `devc` refuses it, so use `devc2` until you update.

If `devc` can't be found or `devc web` exits, the window shows why, with the last lines
of its stderr and a **Restart devc web** button.

### Closing

Closing the window stops `devc web` (SIGTERM, then SIGKILL after 5 s) and then exits.
SIGINT or SIGTERM to the app does the same.

### The page URL

The window has no address bar. **Copy page URL** in the sidebar header copies the page's
URL, token included, for opening the same session in a browser or from a container.

## Development

```sh
deno task check   # launch.ts, status.ts and the tests
deno task test
```

`main.ts` uses `Deno.BrowserWindow`, which only `deno desktop` type-checks, so
`deno task build` is its check. The window logic is kept small. Finding `devc`, the
arguments, the child process and the status page live in `launch.ts` and `status.ts`,
which plain `deno` checks and tests.

On Linux without a display, `xvfb-run -a dist/devc/devc` runs the app headless. Point
`DEVC_DESKTOP_DEVC` at a stand-in script, or put a stub `docker` first on `PATH`, to try
it without Docker. `LAUFEY_REMOTE_DEBUGGING_PORT=9333` at launch exposes the window's
page to the Chrome DevTools Protocol (`http://127.0.0.1:9333/json/list`).

## Why not compile devc itself

A `deno desktop` binary started again with arguments is another GUI instance, not a CLI.
`devc` runs its own binary again to embed the devcontainer CLI
(`devc/devcontainer_selfexec.ts`), so devc can't be the desktop binary. The app runs
the installed `devc` instead. See `.plans/devc-desktop.md`.
