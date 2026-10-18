# devc-web-editor

- [x] Step 0: measure Helix in a devc web pane (§ Step 0) and record the answers here
- [x] `features/helix` Feature (0.1.0): Helix release binary + runtime, with a scenario test
- [x] Server: `create_file` (file or folder, in the container as the remote user), with tests
- [x] Page: **New file…** / **New folder…** on folder and root rows; a new file opens in the editor
- [x] Editor panes are named after the file they edit
- [x] `devc/README.md` (devc web section) and `.plans/devc-web.md` protocol section updated
- [x] Verify (below) and ask the user to try it in their open tab

Make editing files in containers a first-class path in `devc web`: a terminal editor that is
good out of the box, and creating files and folders from the Files trees. Opening a file in an
editor already exists ([devc-web-files](../devc-web-files.md): `open_file`, `editorCommand`,
`${EDITOR:-vi}` in a new pane). This plan does not change that mechanism. It supplies the
editor, adds creation, and names the panes.

Read `.claude/skills/devc-web/SKILL.md` (the `devc-web` skill) before touching `devc/web/**`, and
the "Standing rules for Feature work" in `.plans/PLAN.md` before touching `features/`.

## Editor choice: Helix

**Helix (`hx`)** is the recommendation:

- Its LSP client and tree-sitter highlighting are built in, with no plugin manager and no config
  file. A language server on `PATH` is picked up as it is (`hx --health <lang>` shows which).
  Neovim can do the same, but only with a config that someone has to maintain. Micro is the
  easiest to learn (non-modal, Ctrl+S), but its LSP support is a plugin.
- Release tarballs are static binaries for `x86_64-linux` and `aarch64-linux`, with the
  grammars prebuilt in `runtime/`, so the install needs no compiler and no distro package.
  Debian and Ubuntu package Helix late or not at all.
- It is modal (Kakoune-style select-then-act). If that is unwanted, the same Feature shape works
  for `micro`. Only the Feature changes: devc web runs `$EDITOR` either way.

**The editor is chosen in the container, not by devc web.** devc web keeps running
`${EDITOR:-vi}`. The user selects Helix the way they already set shell preferences
(`devc/README.md`, the `~/.config/devc/shell/10-prefs.sh` example): `export EDITOR=hx`. There is
no new devc config key.

## Step 0: measure (do this first, record answers here)

In a container with Helix installed by hand (the release tarball, under `~/.local`), open a
file from the Files tree with `EDITOR=hx`, then answer:

1. **Colors.** Does the theme render in truecolor? If not, is `COLORTERM` unset in the pane, and
   does `export COLORTERM=truecolor` fix it? If it does, the Feature's `containerEnv` sets it.
2. **Keys.** Do Helix's common keys reach it through xterm.js → devc web → Herdr: `Esc`,
   `Ctrl+C`, `Ctrl+W` (window mode), `Space` menus, `Alt+` motions, `Ctrl+Z`? List any that
   don't arrive, and what takes them (the browser, devc web, Herdr).
3. **Mouse.** Does click-to-place-cursor and scroll work (devc web forwards mouse; see the
   `mouse` message)? With Helix capturing the mouse, does devc web's copy-on-select
   (`read_selection`) still copy anything? Is there a modifier that bypasses capture?
4. **Clipboard.** Herdr sends no OSC 52 to a control client (`copySelection` in
   `devc/web/static/app.js`), so Helix's `Space y` cannot reach the host clipboard. Confirm that,
   and confirm that pasting from the page (bracketed paste) inserts the text as typed, without
   auto-indent staircasing.
5. **LSP.** In a Deno project, does `typescript-language-server` (if present) or `deno lsp`
   attach? Helix maps `.ts` to `typescript-language-server` by default. Deno needs a
   `.helix/languages.toml` in the project. Record what `hx --health typescript` says.

Change the steps below where an answer says to. Clipboard gaps found in 3–4 are documented in
the README, not fixed here.

### Step 0 answers (measured 2026-10-18)

Helix 25.07.1 (`helix-25.07.1-x86_64-linux.tar.xz`, unpacked under `~/.local/lib/helix`,
`HELIX_RUNTIME` set) in a throwaway Herdr 0.9.5 session inside the devc-tools container,
driven the way devc web's server drives a pane: `herdr terminal session control <pane>
--takeover` with `terminal.input` / `terminal.mouse` / `terminal.scroll` JSON lines, frames
decoded from its output, and `pane.selection.read` through `remote-api-bridge`. The file was
opened with devc web's own command shape, `exec "${EDITOR:-vi}" -- '<path>'` (`hx` accepts the
`--`). The Herdr server was started with `COLORTERM` unset, as a `docker exec` gives it. What
xterm.js and the browser do with keys was not measured: nothing here can drive the user's tab.

1. **Colors: truecolor, no change needed.** Herdr sets `COLORTERM=truecolor` (and
   `TERM=xterm-256color`) in every pane's environment itself, so Helix draws its default theme
   in 24-bit SGR (`38;2;…`/`48;2;…`), and those sequences reach the control client's frames
   unchanged. **The Feature does not set `COLORTERM`.** Rendering in xterm.js: not verified —
   needs the user's tab.
2. **Keys, Herdr leg: all arrive.** `Esc`, `Ctrl+C` (toggled comments), `Ctrl+W` (the Window
   popup), `Space` (the Space menu), `Alt+o` (expand selection), `Ctrl+B` (page up) and `Ctrl+Z`
   (suspends to the shell; `fg` resumes) all reach Helix through `terminal session control`.
   Herdr's own prefix keys (`Ctrl+B`) belong to its TUI client and do not apply on this path.
   One quirk: an `Esc` and the next key sent in the **same** `input` message read as `Alt+key`
   (Helix's escape timeout); the page sends each keystroke on its own, so typing is unaffected.
   **Browser leg, from the code, not verified — needs the user's tab:** the page itself swallows
   no keys (its document `Escape` handler closes menus without `preventDefault`; right-click
   opens the tile menu and is not sent). The browser keeps its reserved shortcuts: `Ctrl+W`
   (and `Ctrl+T`/`Ctrl+N`) off a Mac close or open browser tabs, so Helix's window mode is not
   reachable from a browser tab there (the desktop window may differ); on a Mac `Ctrl+W` is
   free and `Cmd+W` is the browser's. xterm.js runs without `macOptionIsMeta`, so on a Mac
   `Option+key` types a character instead of Helix's `Alt+key`. **`Ctrl+Alt+N` is free** on the
   Helix and Herdr legs (Helix binds nothing to it, measured): devc-web-pinned-files can use it.
3. **Mouse: click and drag work; wheel does not.** A click places the cursor (cell → line and
   column checked in the status line) and a drag selects (Helix also yanks it to its primary
   register). devc web's wheel becomes Herdr's `terminal.scroll`, which scrolls Herdr's own
   scrollback and is **not** forwarded to an alternate-screen app with mouse reporting on: the
   Helix view did not move (a raw SGR wheel sequence typed as input does scroll it, so Helix
   itself is fine). Scroll with `Ctrl+D`/`Ctrl+U`/`Ctrl+B`/`Ctrl+F` instead; documented in the
   README, not fixed here. **Copy-on-select still copies:** a plain drag goes to Helix _and_ the
   page's `read_selection` copies that screen range from Herdr's buffer, so the clipboard gets
   the screen text, gutter line numbers included on multi-row drags, not Helix's selection.
   **Shift+drag** is the bypass: it is xterm.js's local selection and never reaches Helix.
4. **Clipboard: confirmed, no OSC 52.** `hx --health` reports the clipboard provider `termcode`
   (OSC 52), and after `Space y` no `ESC ]52` appears in any frame Herdr sends the control
   client, so Helix's yank cannot reach the host clipboard. **Paste:** a bracketed paste
   (`ESC[200~ … ESC[201~`, lines joined with `\r`, as `wrapPaste` builds it) of indented lines
   in insert mode lands as typed; only the first line takes the cursor's current indent, with
   no staircasing.
5. **LSP.** With no `.helix/languages.toml`, `hx --health typescript` reports
   `✘ typescript-language-server: 'typescript-language-server' not found in $PATH` (grammar,
   highlight, textobject and indent queries ✓). With a project `.helix/languages.toml` mapping
   `typescript` to `deno lsp` (the README's example), `hx --health typescript` shows
   `✓ deno-lsp: /usr/local/bin/deno`, and opening a `.ts` file with a type error from the
   project's folder attached it (Helix's log shows `TS server started`, and the gutter marks
   the error). Helix 25.07.1 reads a workspace's `.helix/languages.toml` without a trust prompt.

**Changes to the steps below:** the Feature's `containerEnv` is `HELIX_RUNTIME` only. The
README (devc web section) documents the wheel, clipboard and copy-on-select behaviour, the
browser-reserved `Ctrl+W`, and the Deno `languages.toml`. The binary is not fully static: it
links glibc (`libc`, `libm`, `libgcc_s`), so the Feature refuses a musl (Alpine) base.

## Concept boundaries

- **`create_file` vs `open_file` vs `open`.** `open` attaches a tile to an existing pane's
  stream. `open_file` creates a pane running the editor. `create_file` creates a file or folder
  on disk and starts no pane. When the page creates a file it then sends `open_file` as a
  separate step.
- **Which side writes.** Repo trees (`list_dir`) are read from the **host** side of the bind
  mount. `create_file` still writes **inside the container** as the remote user (`docker exec`,
  via `dockerExecArgv`), so the new file has the same owner as the files the editor saves. Never
  write with `Deno.writeFile` on the host side: on Linux hosts, the uid would not match.
- **The Feature's `containerEnv` vs the user's `EDITOR`.** The Feature sets `HELIX_RUNTIME`
  (and `COLORTERM` if Step 0 calls for it), never `EDITOR`. A Feature cannot set an env var
  depending on an option, and choosing the editor is the user's call.
- **A pane name vs a Herdr tab name.** "Terminals are named after their folder" (commit
  507167f) names panes from their cwd. Editor panes are named after the file. Find the naming
  hook that commit added and give it the file's basename when the pane comes from `open_file`.
  Don't add a second naming mechanism.

## Existing touchpoints

| File                             | Role                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `features/xvfb/`                 | The shape to copy for a new Feature: `devcontainer-feature.json`, `install.sh`, `README.md`, `test/`.    |
| `features/README.md`             | Gains a row for `helix`.                                                                                 |
| `features/PUBLISH_ALLOWLIST.txt` | Gains `helix`, so a push to `main` publishes it.                                                         |
| `devc/web/protocol.ts`           | New `create_file` `ClientMessage` variant and its parser case, using the same addressing as `open_file`. |
| `devc/web/server.ts`             | The `create_file` handler, beside `openFile` and `repoContainerPath`.                                    |
| `devc/web/container_files.ts`    | `createArgv` and the runner, beside `listArgv`, run through `dockerExecArgv`.                            |
| `devc/web/files.ts`              | `confine` (for the parent directory) and `FilesError` codes.                                             |
| `devc/web/static/app.js`         | `dirMenuItems` and root row menus gain the new items. Inline name entry in the tree.                     |
| `devc/web/static/lib/files.js`   | Pure name validation, shared by the page and its tests.                                                  |

## Contracts

### Feature `helix` (`features/helix/`, version `0.1.0`)

| Option    | Type   | Default    | Meaning                                                                                           |
| --------- | ------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `version` | string | `"latest"` | A Helix release tag (`25.07.1`), or `latest`, resolved from `helix-editor/helix` GitHub releases. |

- Installs `/usr/local/lib/helix/` (the tarball's `hx` and `runtime/`) and the symlink
  `/usr/local/bin/hx`. Arch from `uname -m`: `x86_64` → `x86_64-linux`, `aarch64` →
  `aarch64-linux`. Anything else fails the install with a message naming the arch.
- `containerEnv`: `{"HELIX_RUNTIME": "/usr/local/lib/helix/runtime"}`.
- Installs no language servers and writes no user config.
- **`"helix": {}` must install cleanly and give a working `hx`.** That is the standing rule. The
  scenario test runs `hx --version` and `hx --health` as the remote user.
- Not added to devc's baseline (`devc-core/default/devcontainer.json`) in this plan. Users add it
  in their own config. Whether devc's baseline should declare it is a separate decision for
  after it has been in use.

### Browser → server: `create_file`

```ts
| {
    type: 'create_file';
    id: string;
    container: string;
    /** A repo folder `path` is relative to; without one, `path` is a container path. */
    root?: string;
    /** The new entry's path. Its parent must exist. */
    path: string;
    kind: 'file' | 'dir';
  }
```

- **Validation (parser):** `kind` is `'file'` or `'dir'`, else `bad_request`. The last segment of
  `path` is non-empty, not `.` or `..`, and contains no NUL. With `root`, `path` is relative and
  has no `..` segment. Without `root`, `path` is absolute (`containerPath(m)`, as in `open_file`).
- **Resolution (server):** with `root`, `confine(root, dirname(path))` confines the **parent**,
  because the new path does not exist yet. Then translate to a container path the way
  `repoContainerPath` does. Without `root`, the path is used as given: the container is the
  boundary, as for `list_container_dir`.
- **Creation:** `docker exec` as the remote user (`dockerExecArgv`). A file is created with
  `sh -c 'set -C; : > "$1"' sh <path>` (noclobber: it fails if anything exists there). A folder
  is created with `mkdir -- <path>` (no `-p`).
- **Reply:** `result {ok: true, result: {path: string}}`, where `path` is the container path.
  Errors use `code`: `exists`, `not_found` (missing parent), `forbidden` (permission, or outside
  the root), `not_running`, `bad_request`.
- **Tests:** the parser (each rejection above), `createArgv` for both kinds (argv exact, path
  never interpolated into the script), and error mapping from stderr/exit code to `code`.

### Page

- Folder rows and root rows in both Files trees (repo trees and the container's Files node)
  get **New file…** and **New folder…**. Each opens an inline text row under that folder, in
  the tree. Enter submits and Escape cancels. It never uses `prompt()`. Name validation (the
  rules above) runs in `lib/files.js` before sending.
- On success, refresh that folder, select the new row, and for a file send `open_file` (placed
  as **Open in editor** places it, `'stack'`). On `exists`, keep the inline row open with the
  error shown under it.
- Needs a running container, the same as Open in editor. Otherwise show the existing toast,
  "Start the container first".

**Not in this plan:** rename, delete, move, file watching, an in-browser editor, installing
language servers.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc && deno task check && deno task test
cd .. && deno fmt --check
```

The Feature: run its scenario test the way the other Features' tests run (see
`features/CONTRIBUTING.md`).

Then ask the user to check, in their open tab, with `export EDITOR=hx` in their shell prefs:

1. Open a `.ts` file: Helix opens in a tile named after the file, in color, and `hx --health`
   shows the language server they expect.
2. **New file…** on a folder creates the file, it appears in the tree, and Helix opens it.
   Creating it again shows "exists" inline.
3. **New folder…** in the container's Files node (outside the repo) creates the folder as the
   remote user (`ls -l` shows the owner).

## Verification (2026-10-18)

- `deno task check`, `deno task test` (430 passed) and `deno check main.ts` in `devc/`.
  `deno fmt --check` at the root passes for every file this plan touched; it still reports
  `.plans/devc-desktop-host-terminal.md` and `.plans/archived/devc-desktop.md`, which were
  unformatted before this plan (commit 2293efb) and are left alone.
- The Feature: `bash tests/features_test.sh` and the offline
  `features/helix/test/install_options_test.sh` pass, and a real `install.sh` run (network, a
  scratch `HELIX_PREFIX`) installed 25.07.1 with working `hx --health`. **The Docker scenario
  test (`features/helix/test/run-features-test.sh`) was not run**: this container has no Docker.
- The page, in headless Chromium (agent-browser) against the checkout's `devc/web/static` over
  `python3 -m http.server` with a fake WebSocket: **New file…** on a repo root and on a repo
  subfolder, **New folder…** on the container's Files root; the inline row at the right depth
  and focused, its text and focus surviving a re-render, `A name cannot contain /` for `a/b`,
  `README.md already exists` for an `exists` reply (row kept open), Escape removing the row,
  the exact `create_file` messages sent, the folder listed again with the new row, a new file
  sending `open_file` (and its tile taking the focus), a new folder selected in the tree.
- Pane naming: `pane.rename {pane_id, label}` against a throwaway Herdr 0.9.5 session sets the
  pane's `label`, which `paneLabel` already shows.
- **Not verified — needs the user's tab:** everything in the plan's three user checks (Helix in
  a tile named after the file, in color; New file/New folder against a real container and its
  `ls -l` owner; `exists` from a real container), the browser's own key handling (§ Step 0, 2),
  and the Docker scenario test. The user's `devc web` was serving this checkout's page during
  the work; under `--live` (not `--live-yolo`) its installed server does not know `create_file`
  yet, so **New file…** shows the server's "unknown message type" under the row until it runs
  `--live-yolo` or an updated `devc`.
