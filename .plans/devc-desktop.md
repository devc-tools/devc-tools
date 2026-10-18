# devc-desktop

**Repo:** `devc-tools`
**Run on:** a **macOS host** with Docker and an installed `devc` for Step 0 and the
Validation; any checkout for Steps 1–3 and the offline tests (`xvfb-run` works in the
devcontainer for the CEF window, see § Tests).

`devc web` in its own desktop window instead of a browser tab: a small `deno desktop` app
(CEF backend) that runs the real `devc web --no-open …` as a child process and points its
window at the URL that child prints. Live mode (`--live`, `--live-yolo`) works unchanged,
because the supervisor, its child swaps and its fallback all stay inside `devc`.

The app is a **thin shell**. It contains no devc code, does not import `devc/`, and never
re-executes itself. `devc` does not change, apart from one page action (Step 3).

## Checklist

- [ ] Step 0: host checks on macOS that decide the open questions (§ Step 0)
- [x] Step 1: `devc-desktop/` app: launch `devc web`, status page, navigate, stop (§ Step 1)
- [x] Step 2: build task, icon, `.gitignore` (§ Step 2)
- [ ] Step 3: "Copy page URL" action in the `devc web` page (§ Step 3)
- [x] Tests (§ Tests): unit tests, and the end-to-end run on Linux under Xvfb
- [ ] Validation on the host (§ Validation)

## What the spike established (2026-10-18, Deno 2.9.7, Linux container under Xvfb)

The probe apps are throwaway and not in the repo. Results:

- `deno desktop --backend cef` builds and runs. The Linux bundle is 438 MB unpacked (a
  `libcef.so` and Chromium resources beside a small launcher and an `app.so`). The window is
  Chrome 149. The default (webview) backend needs WebKitGTK 4.1 on Linux; **this plan uses
  CEF only**, for rendering identical to the user's Chrome tab.
- The app inherits the launching environment (`PATH` included), and `Deno.Command` and
  `node:child_process` `spawn` work.
- **`DENO_SERVE_ADDRESS`:** the desktop runtime sets it (`tcp:127.0.0.1:<random>`), and it
  redirects the **first** `Deno.serve` in a process to that address, ignoring the port passed.
  Later `Deno.serve` and `Deno.listen` calls keep their own ports. The variable has the same
  effect under a plain `deno run`, so **a child that inherits it has its first server moved**
  off its port. The app must delete it from every child's environment.
- With **no** server in the main process, `new Deno.BrowserWindow()` adopts the startup window,
  and `navigate("http://127.0.0.1:<fixed port>/#token=…")` loads a different process's server.
  The page kept `#token`, its WebSocket passed the existing Host, Origin and token checks
  (`devc/web/server.ts` `authorize`) with **no changes**: Origin and Host were
  `127.0.0.1:<fixed port>`.
- Killing that child and starting another on the same port: the page reconnected on its own
  with the same token, as a browser tab does across a `--live-yolo` swap.
- `win.close()` on the last window ends the process **at once**: code after it does not run.
  No children were left behind in the probe, but the probe's child was not `detached`.
  Cleanup belongs in the window's `close` event (`preventDefault`, stop, then exit).
- **Re-executing the desktop binary does not work.** `Deno.execPath()` is the GUI binary.
  Spawning it with arguments garbled them (`["--workspace-folder __devcontainer up /x", …]`),
  and each copy started another full desktop instance (nine levels deep before the probe was
  killed). With no display it exits silently. So devc's self-exec of the embedded devcontainer
  CLI (`devc/devcontainer_selfexec.ts`, used by `devc/web/project_control.ts`) cannot run
  inside a desktop binary, which is why the app runs the separately installed `devc` instead
  of compiling devc into the app.
- Documented API (docs.deno.com/runtime/desktop/windows): `BrowserWindow` options `title`,
  `width`, `height`, `x`, `y`, `resizable`, …; methods `navigate(url)`, `executeJs(code)`,
  `close()`, `setTitle()`, `openDevtools()`, …; events `close` (user-requested, cancelable),
  `keydown`, `keyup`, `focus`, `blur`, … . The first `new Deno.BrowserWindow()` adopts the
  window opened at startup.

## Step 0: host checks (macOS)

Build the app on the Mac with `deno task build` in `devc-desktop/` (output `dist/devc.app`)
and answer each of these. Record the answers in this section, and adjust Steps 1–2
where an answer says to.

1. **Keyboard.** In a Herdr pane in the window: do Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+R, Ctrl+L
   reach the terminal (as they do not in a browser tab)? Which of Cmd+W, Cmd+Q, Cmd+R, Cmd+C,
   Cmd+V does the app or CEF act on itself, and does Cmd+Q quit cleanly (see 4)? Is there an
   Edit menu, so copy and paste work at all?
2. **`PATH` from the Dock or Finder.** Launched by double-click, does the app's environment
   find `devc`, `docker` and `deno` (the latter only for `--live-yolo`)? Expected: no, since
   GUI apps get launchd's minimal `PATH`. If so, Step 1's login-shell lookup is required;
   otherwise it is a fallback.
3. **Arguments.** Launched from a terminal as `dist/devc.app/Contents/MacOS/laufey
   --live-yolo`, does `Deno.args` arrive intact? (They do on Linux.) If not, the app reads its `devc web` arguments from config
   only (§ Contracts, `desktopWebArgs`).
4. **Closing.** Do the red close button and Cmd+Q fire the window's `close` event, so the app
   can stop `devc` first? After each, is any `devc` or `deno` process left (`pgrep -fl devc`)?
5. **Gatekeeper.** Does the unsigned `.app` open after `xattr -d com.apple.quarantine`, or
   with no step at all when built locally? (Locally built apps are usually not quarantined.)
6. **Clipboard and selection.** Does the page's copy-on-select (`navigator.clipboard`) work in
   the window as in Chrome?

## Built and checked on Linux (2026-10-18)

Steps 1–2 ran end to end in the devcontainer under `xvfb-run`, with `DEVC_DESKTOP_DEVC`
pointing at a stand-in `devc` that serves a token-checked page on a fixed port and swaps its
server on demand, as `--live-yolo`'s supervisor does:

- Launched as `dist/devc/devc --live-yolo`: the stand-in got `web --no-open --live-yolo`
  (**arguments arrive intact on Linux**) and no `DENO_SERVE_ADDRESS`. The window navigated
  to the printed URL, its WebSocket passed the token check, and after a server swap it
  reconnected by itself.
- SIGTERM to the app: the stand-in got SIGTERM, and no process was left.
- A stand-in that exits 1: `/state` reported `failed`, `devc web exited (1)` and its stderr.
  `POST /restart` without the header got 403, with it 204 and a second run.
- `loginPath()` read the login shell's `PATH`, and returned `null` for a missing shell.
- **Not covered here:** closing the window by hand (no input injection in the container).
  In one run where the shell that launched `xvfb-run` was killed by mistake, the app's main
  process was gone afterwards but the stand-in and CEF helper processes were still running.
  The cause was not pinned down. So an app that dies without an orderly stop (crash,
  SIGKILL) can leave `devc web` running, and the next start would then find its port in use.


### Layout

```
devc-desktop/
  deno.json   tasks: build (and run, for a dev loop without packaging)
  main.ts     the app
  README.md   what it is, how to build and launch it, the config key
  icon.png    (Step 2)
```

`devc-desktop/` is a sibling of `devc/`, `devc-bridge/` and `devc-core/`. It imports nothing
from them: it is separately built and has no shared code with devc.

### Which `devc` it runs

In order, first hit wins:

1. `DEVC_DESKTOP_DEVC`, if set: an absolute path to the `devc` binary.
2. `devc` on the app's `PATH`.
3. `devc` as resolved by the user's login shell: `$SHELL -lc 'command -v devc'` (or
   `/bin/zsh` when `SHELL` is unset). The same lookup supplies the `PATH` the child gets,
   so `docker` and `deno` resolve too (`$SHELL -lc 'printf %s "$PATH"'`).

None found: the status page says so and names the three places looked.

### Arguments passed to `devc web`

`devc web --no-open` followed by:

- the app's own `Deno.args`, if Step 0.3 shows they arrive intact and any are given; else
- `desktopWebArgs` from `~/.config/devc/config.json`: a string array, default `[]`. Example:
  `"desktopWebArgs": ["--live-yolo"]`. The app reads only this key, and does not validate the
  rest of the file. devc's own config reader must tolerate the key; check that it ignores
  unknown keys, and if it does not, add the key to its known set.

`--port` is never added by the app: it uses whatever port devc picks (default 48228) and learns
it from the printed URL.

### Child process

- Spawned with stdout and stderr piped, stdin `null`, and the environment of the app (or of
  the login shell, per above) **minus `DENO_SERVE_ADDRESS`**.
- **Ready:** the first stdout line matching
  `^devc web: (http://127\.0\.0\.1:\d+/#token=[0-9a-f]{64})$`. That line is printed by
  `devc/main.ts` (plain and `--live`) and by `devc/web/supervisor.ts` `announce`
  (`--live-yolo`). Both stdout and stderr keep being read for the life of the child, so a full
  pipe never blocks it. The token is read from the pipe only, never logged, and never put in
  any process's argv.
- **Stop:** SIGTERM, then SIGKILL after 5 s. devc's `runUntilSignal` and the supervisor
  already stop their servers and children on SIGTERM.

### Window and status page

- The app's own `Deno.serve` (its first, so it takes `DENO_SERVE_ADDRESS`) serves one status
  page, which the startup window shows while `devc` starts. It shows what the app is doing
  ("starting devc web…") and, on failure, the reason and the last ~40 lines of the child's
  stderr. It is the app's page, not devc's: no token, no WebSocket. It may poll a JSON
  endpoint on the same server for state.
- On ready: `win.navigate(url)` with the printed URL, exactly.
- Child exits before ready, or after: navigate back to the status page, showing the exit code
  and stderr tail, with a "Restart devc web" button (a POST to the status server) that starts
  a new child.
- Window `close` event: `preventDefault()`, stop the child (§ Child process), then
  `Deno.exit(0)`. SIGTERM or SIGINT to the app does the same.
- Window title: `devc web`.

## Step 1: the app

`devc-desktop/main.ts` as specified in § Contracts. Keep the pieces that can be tested without
a window (finding `devc`, building the argument list, matching the ready line, the child's
environment) as exported functions that take their inputs as parameters, so § Tests can call
them under `deno test`.

## Step 2: build

- `devc-desktop/deno.json` task `build`:
  `deno desktop --backend cef --allow-run --allow-read --allow-env --allow-net
  --icon icon.png --output dist/devc main.ts`. `deno desktop` appends `.app` itself on macOS
  (`-o devc.app` gives `devc.app.app`), and the bundle's executable is
  `Contents/MacOS/laufey`. Cross-building for macOS from Linux works only without `--icon`
  (a PNG icon fails with "No such file or directory").
- `.gitignore`: add `devc-desktop/dist/`.
- Release packaging (adding the app to `release.yml` and `install.sh`) is **out of scope**.
  The CEF bundle is hundreds of MB, and whether it ships, compressed or not, is decided after
  the user has lived with a local build.

## Step 3: "Copy page URL" in the page

The window hides the URL, which a container, another browser or an agent may still need. Add a
button to the sidebar header in `devc/web/static/index.html` (beside `#conn`), id `copy-url`,
`title`/`aria-label` "Copy page URL". On click, `devc/web/static/app.js` copies
`location.href` (which includes `#token=…`) with `navigator.clipboard.writeText`, and toasts
"Copied page URL", **not** the URL itself, so the token is not shown on screen. It is present
in the browser too, where it is equally useful. Follow the `devc-web` skill for how this
reaches a running `devc web --live` session.

## Concept boundaries

- **`--open`, `openNonce`, `/open/<nonce>`, `devc/web/browser.ts`:** devc's way of opening a
  *browser* without putting the token in argv. The app passes `--no-open` and does not use
  them; it reads the token-bearing URL from the child's stdout instead. Do not remove them:
  they still serve `devc web` in a terminal.
- **"Child":** in `devc/web/supervisor.ts`, the child is the `deno run main.ts web` that
  serves a checkout (`DEVC_WEB_CHILD`). The app's child is the `devc web` process. With
  `--live-yolo` there are three levels: app → `devc web` (supervisor) → `deno run …` child.
  The app manages only its own child.
- **`DENO_SERVE_ADDRESS`** is Deno's (desktop runtime), not devc's. devc never reads it, but
  devc's `Deno.serve` obeys it when inherited. Hence the env rule in § Child process.
- **`deno desktop` vs `deno compile`:** devc's `build` task is `deno compile`. The app is
  built with `deno desktop`, a different subcommand with different output (a bundle
  directory or `.app`, not one file).
- **`Deno.execPath()`** inside the app is the GUI binary. Never spawn it.

## Tests

- `devc-desktop/tests/` under `deno test`: the ready-line match (accepts the two printed
  forms, rejects a malformed token or a non-loopback host), the argument list (`--no-open`
  first, args vs `desktopWebArgs` precedence), the child's environment (no
  `DENO_SERVE_ADDRESS`), and finding `devc` (each of the three sources, with the lookups
  injected).
- An end-to-end check in the devcontainer is possible without Docker by pointing
  `DEVC_DESKTOP_DEVC` at a stub script that prints a ready line and serves a page on a fixed
  port, then running the built Linux app under `xvfb-run -a` and reading the page's state with
  `win.executeJs`. Worth doing once; not required in CI.
- `devc` page: if `devc/tests/` has a static-markup test for `index.html`, extend it for
  `#copy-url`.

## Validation (macOS host)

1. `deno task build` in `devc-desktop/`, then open `dist/devc.app` from Finder: the status
   page shows, then the `devc web` page, connected, with Herdr panes working.
2. Quit Docker Desktop and relaunch: the status page shows devc's error and stderr. Start
   Docker, press Restart: the page loads.
3. With `"desktopWebArgs": ["--live-yolo"]`: edit a `devc/web/*.ts` file in the checkout; the
   supervisor swaps servers and the window reconnects with no action from the user.
4. Close the window, and separately Cmd+Q: no `devc` or `deno` process remains.
5. Copy page URL, paste into Chrome: the same page connects there.
