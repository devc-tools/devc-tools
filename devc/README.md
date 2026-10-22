# devc

`devc` is a thin orchestrator over
[`@devcontainers/cli`](https://github.com/devcontainers/cli), `docker`, and
`git` for managing the dev container of a project directory. It ships a bundled
default `devcontainer.json` + `Dockerfile` embedded in the binary, so a project
needs no `.devcontainer/` of its own to get a working container.

Every command operates on the current working directory by default; an optional
`[PATH]` positional overrides it. The resolved path identifies the project and
its container.

## Install

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
```

That drops a prebuilt `devc` into `~/.local/bin` (macOS and Linux, Intel and
ARM) — **Deno is not needed to use it**, only to develop it. See the
[install guide](../docs/install.md) for the env knobs and the `PATH` note.

**`docker` is the only thing `devc` needs on your `PATH`.** The
[`devcontainer` CLI](https://github.com/devcontainers/cli) is embedded in the
binary — see [The embedded devcontainer CLI](#the-embedded-devcontainer-cli).

To build it from a clone instead, see [Development](#development).

## Commands

```text
devc init    [PATH]                                   Scaffold the default `.devcontainer/` into the project
devc config  [PATH] [--global | --repo]               Configure the project's (or with --repo, the repo's) source/skills mounts (TUI)
devc up      [PATH] [--json] [--bridge-allow LIST [--bridge-repo PATH]...] Create/start the container; print its status
devc build   [PATH] [--no-cache] [--json] [--bridge-allow LIST [--bridge-repo PATH]...] Recreate the container from scratch
devc attach  [PATH] [--build] [--no-clear] [--cwd DIR] Start (creating if needed) and attach a login shell
devc claude  [PATH] [--cwd DIR] [-- ARGS...]          Start and run `claude` (+ forwarded args) in a login shell
devc copilot [PATH] [--cwd DIR] [-- ARGS...]          Start and run `copilot` (+ forwarded args) in a login shell
devc pi      [PATH] [--cwd DIR] [-- ARGS...]          Start and run `pi` (+ forwarded args) in a login shell
devc herdr   [PATH] [--cwd DIR] [-- ARGS...]          Start and run `herdr` (+ forwarded args) in a login shell
devc exec    [PATH] [--cwd DIR] [--env K=V]... -- CMD Start and run CMD directly (no shell)
devc mounts  [PATH] [--json]                          List the container's mounts
devc stop    [PATH]                                   Stop the container
devc down    [PATH]                                   Stop and remove the container (and its devc-bridge files)
devc prune   [--dry-run]                              Remove devc-bridge key dirs/policies no container uses
devc status  [PATH]                                   Print `running` / `stopped` / `missing`, then protection and bridge lines
devc web     [--port N] [--session NAME] [--no-open] [--live] [--live-yolo] [--source DIR] Serve a browser UI for the Herdr sessions in every running devcontainer
```

Run `devc --help` for the full command list, `devc <COMMAND> --help` for a
command's options, and `devc --version` to print the version.

Notes:

- `init` writes the bundled default into the project's `.devcontainer/` —
  `devcontainer.json` verbatim (comments kept, no mount fences) plus
  `Dockerfile` and `initialize-command.sh`, with the shell script executable.
  It is the same scaffolding `config` does on first creation, without the TUI:
  use it when you want the baseline on disk to hand-edit. Non-interactive — it
  never prompts, never builds, and never triggers the first-run roots wizard.
  It writes only into a **missing or completely empty** `.devcontainer/`: any
  existing content — a file, a subdirectory, a dotfile — makes it write
  nothing and exit 1, naming what it found. So does an existing config in
  either location (`.devcontainer/devcontainer.json` or a root
  `.devcontainer.json`), with a message pointing at `devc config`. The strict
  rule means what `init` leaves behind is exactly the bundle: it cannot
  silently overwrite a hand-written `Dockerfile`, and cannot strand unrelated
  files that the bundle does not replace.
- `up` prints `<containerId> running — workspace <remoteWorkspaceFolder>`, or
  the `ContainerInfo` JSON with `--json`.
- `build` recreates the container (`up --remove-existing-container`) without
  attaching, and prints the same line as `up`. Mounts are bound when the
  container is _created_, so this — not an image-only build — is what makes a
  `devcontainer.json` change take effect. `--no-cache` also rebuilds the image
  without the Docker layer cache.
- `attach --build` forces the same rebuild before attaching; `--no-clear` keeps
  the shell-init output on screen instead of clearing on the first prompt.
  `attach`/`claude`/`copilot`/`pi`/`herdr` exit with the attached shell/command's own
  exit code (e.g. 130 on a signal-driven detach); `devc`/`docker` infra
  failures exit 125.
- `claude`/`copilot`/`pi`/`herdr` forward everything after `--` to the command
  verbatim (passed as argv, never re-parsed by a shell): `devc claude -- --resume`,
  `devc herdr . -- session list`. Before `--`, only devc's own flags
  (`--build`, `--no-clear`, `--cwd`) and one PATH are accepted — anything else
  is an error rather than a guess, so a flag both devc and the command define
  always goes to devc before `--` and to the command after it. `--help` before
  `--` is devc's; `devc herdr -- --help` is herdr's. `attach` launches nothing,
  so it refuses args after `--`.
- `herdr` runs in a named session, `devc`, rather than Herdr's default one:
  `devc herdr` is `herdr --session devc`. A named session can be deleted
  outright (`herdr session stop devc && herdr session delete devc`) to recreate
  it from scratch; the default session cannot. Pass `--session NAME` to pick
  another one (`devc herdr -- --session NAME`); `--remote` or a subcommand
  (`devc herdr -- session list`) also suppress the default.
- `--cwd DIR` on `attach`/`claude`/`copilot`/`pi`/`herdr` starts in `DIR` instead of the
  container's workspace folder — how you attach into a git worktree under a
  `.worktrees` mount. It takes either a **container** path or a **host** one: a
  host path is translated through the container's own mount table
  (`docker inspect`, the same table `devc mounts` prints). When a value could be
  read either way, the host reading wins, because that is the one you cannot
  express any other way; a host path that no mount covers is refused before the
  attach starts rather than silently landing somewhere else. Both `--cwd DIR`
  and `--cwd=DIR` are accepted. Note `devc exec --cwd` is the older, narrower
  flag: it is a container path only, and does not translate.
- `exec` runs the command after `--` directly (no shell) and exits with the
  command's own exit code; `devc`/`docker` infra failures exit 125. `--env` is
  repeatable and a value without `=` is an error (exit 125).
- `mounts` prints `type\tsource -> destination\trw|ro` rows, or the
  `ContainerMount[]` JSON with `--json`. With no container it prints
  `No container for <path>` (text) / `[]` (json).
- `stop` prints `Stopped container for <path>`, or `No running container for
  <path>` when nothing was running. `down` prints `Removed container for
  <path>`, or `No container for <path>` when there was nothing to remove. Both
  exit 0 either way — neither is an error.
- `--bridge-allow LIST` on `up`/`build` grants the container devc-bridge
  capabilities — a comma-separated subset of `gh-push`, `gh-pr-read`,
  `gh-pr-reply`, `gh-pr-viewed`, `gh-pr-resolve`, `gh-pr-resolve-copilot` and
  `gh-pr-request-review` (every `gh-pr-` write requires `gh-pr-read`), or `gh` /
  `'gh-*'` for all of them — on its current branch, whose `origin` must be a github.com
  remote. `--bridge-allow none` revokes any earlier grant. **Flags given: exactly
  what you typed. No flags: the defaults.** `up`/`build` **without** the flag
  grant the defaults from the [global config](#the-global-config) — each repo's
  `bridgeRepoAllow` entry, else `bridgeDefaultAllow` — when either is set, and
  otherwise revoke; with it, neither key is read — see
  [A default grant](#a-default-grant-bridgedefaultallow) and
  [Per-repo defaults](#per-repo-defaults-bridgerepoallow). `--bridge-repo PATH`
  (repeatable, not with `--bridge-allow none`) pins an extra git-protected repo
  mount alongside the workspace repo, with the flag's LIST or, without it, the
  defaults; a repo that fails its checks is skipped with a notice, and an
  explicit grant fails only when none pass. No other command accepts either flag, and the old
  `--bridge-git-push` is refused with a pointer to `--bridge-allow gh-push` — see
  [Per-container identity](#per-container-identity-and-github-capabilities).
- `prune` removes every `~/.config/devc-bridge/keys/<key>/` and
  `policy/<key>.conf` that no container (running or stopped) maps to, printing
  `removed <path>` per entry (`would remove` with `--dry-run`, which removes
  nothing). It removes nothing and exits 1 if `docker ps` fails.
- Lookup commands (`status`/`stop`/`down`/`mounts`) locate the container by its
  `devcontainer.local_folder` label and never start anything. With `docker`
  itself missing from `PATH` they fail hard — `devc: docker not found on PATH`,
  exit 1 — rather than reporting the container as absent.
- `web` — see [`devc web`](#devc-web-browser-ui-for-in-container-herdr).

## How it works

- **Create / start** shells out to `devcontainer up --workspace-folder <PATH>`;
  the final line of its JSON output carries the `containerId`, `remoteUser`, and
  `remoteWorkspaceFolder`.
- **One effective config.** devc merges the layers into a single
  `devcontainer.json`, writes it to `~/.cache/devc/projects/<key>/`, and hands
  that to `devcontainer up`. The layers, lowest to highest, are
  `devc → base config → user devc.json → project devc.json` — see
  [the overlay](#optional-overlay-devcjson) for the merge rules. Nothing is ever
  written into the project.
- **The base config** is the project's own `.devcontainer/devcontainer.json` (or
  `.devcontainer.json`) when it has one, else the bundled default. A config that
  cannot be parsed fails the command naming the file, rather than building a
  container from something other than what the project asked for.
- **How the merged file is delivered** depends on which base won, and the
  difference matters:
  - **Project mode** → `--override-config`. The CLI reads the config's
    _content_ from the merged file but still records the project's own config as
    its path, so relative `build.dockerfile`/`context`/`dockerComposeFile` and
    local Features resolve where the project meant them to, and the container
    keeps the identity labels it has always had (VS Code still matches it).
  - **Zero-config** → `--config`, and the merged file is the config path for
    every purpose. `build.dockerfile` and `build.context` are rewritten to
    absolute paths into the materialized default tree, since a relative value
    would otherwise resolve into the cache directory beside the merged file.
- The **bundled default** is still materialized to a **content-addressed** cache
  dir, `~/.cache/devc/default-<key>/`, where the key is a hash of the bundled
  config tree and your
  [`templates/`](#default-overrides-configdevctemplates) overlay. Same inputs,
  same directory, and nothing is rewritten. Different inputs get their own
  directory, so two `devc` versions (or a `devc` and a program embedding the same
  library) cannot rewrite each other's config out from under it. A first write
  for a given key is staged in a sibling `.tmp-…/` and renamed into place, so a
  concurrent `devcontainer up` reading that config never sees a half-written
  tree.
- **The merged file's path is stable per project**, and that is load-bearing
  rather than tidy. The devcontainer CLI keys a container on
  `devcontainer.local_folder` + `devcontainer.config_file` and will not reuse one
  whose `config_file` differs — without removing it, even under
  `--remove-existing-container`. A config path that moved would strand a
  container per move, permanently.
- devc adds its own baseline Features (the
  [`devc-config` hook](#project-post-create-hook-devc-post-createsh) today) as
  the lowest layer, skipping any that your overlay or the base config already
  declares by name — so `:0` and a devc-pinned exact version never both install.
  Turn all of it off with the overlay's `"baselineFeatures": false`.
- **`devc up --print-config`** prints the merged config and starts nothing.
  Since the effective config lives in a cache rather than in the project, this
  is how you read what devc will actually run — including before the project has
  ever been started.
- **exec / attach** run via `docker exec` under `remoteUser` in
  `remoteWorkspaceFolder`. `remoteEnv` is not stored on the container — it is
  applied by the _client_ per connection (VS Code to its terminals,
  `devcontainer exec` to its child), so `docker exec` never sees it. `devc`
  therefore re-derives it from the merged config (one object; the overlay's own
  `remoteEnv` is already folded in) and passes `-e K=V` per entry. Values
  resolve `${containerWorkspaceFolder}`, `${localWorkspaceFolder}`,
  `${localWorkspaceFolderBasename}` and `${localEnv:VAR}`; other variables can't
  be resolved host-side and pass through literally. This is the one place devc
  substitutes variables itself — inside the merged config they are the
  devcontainer CLI's to resolve, which is why `${devcontainerId}` and
  `${containerEnv:…}` work there.
- **Every exec reaches the container the same way.** CLI commands and
  `devc web` alike carry `-u remoteUser`, the full `remoteEnv` and
  `-w remoteWorkspaceFolder`, built by one function (`dockerExecArgv` in
  `devc-core/container.ts`; a test fails on any other `docker exec` argv).
  `devc web` doesn't start containers, so it can't take these from
  `devcontainer up`. It gets them from `connectionFor` instead: the same
  merged config and `remoteEnv` derivation, with the workspace folder and
  `remoteUser` from `devcontainer read-configuration --container-id`. A Herdr
  server started from the page therefore gets the same `TZ`, `LANG` and
  `PROJECT_PATH` a `devc herdr` attach does. A server that is already running
  keeps the environment it started with.
- **The workspace mount is the git root, not `<PATH>`.** The CLI's
  `--mount-workspace-git-root` (on by default) mounts the nearest ancestor
  holding a `.git`. When that is an ancestor of `<PATH>` (a fresh project nobody
  has `git init`ed under a `~/code` that is itself a repo, say), every command
  that would _create_ the container (`up`, `build`, `attach`, `exec`, …) warns
  first and asks `Mount <root> anyway? [y/N]`. It asks only on create or
  rebuild: once the container exists, it is what you chose. Without a terminal
  it only warns. A config that sets `workspaceMount` (or uses Compose) is never
  asked about.
- **Git worktrees**: `up` passes `--mount-git-worktree-common-dir`. devc used to
  reimplement the CLI's own container-workspace-path algorithm to substitute
  `${containerWorkspaceFolder}` into `--mount` args; inside a config file the CLI
  resolves it itself, so that port is gone.
- After a successful `up`, the container is renamed to `devc-<basename>-<hash>`
  and its image is given a `<name>:latest` alias tag (both best-effort, never
  fatal).

`attach`/`claude`/`copilot`/`pi`/`herdr` also propagate the host terminal identity (`TERM`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `$TMUX`) and tint the terminal for the
duration of the attach so a container shell reads as visually distinct from a
local one.

### Herdr integration

A `devc attach`/`devc claude`/`devc copilot`/`devc pi`/`devc herdr` running in a
[Herdr](https://herdr.dev) pane shows the agent that is actually running
**inside** the container — `claude`, `copilot`, `pi`, `codex`, … — with
Herdr's own idle/working/blocked status, and
shows no agent at all when the container shell is sitting at a bare prompt.
No flag, no per-project config: it is driven entirely by environment,
gated on all of:

- **`HERDR_ENV=1`** — set by Herdr itself; devc does nothing outside a Herdr
  pane.
- **`HERDR_AGENT` unset** in devc's own environment. If you already run
  `HERDR_AGENT=claude devc attach` yourself, that keeps working unchanged and
  devc adds nothing — asserting a second identity in the same pane is
  undefined behavior in Herdr, so devc always defers to yours.
- **`DEVC_HERDR_AGENT` is not `off`** — the explicit opt-out.

When active, devc spawns two silent children beside the attach: a watcher
(`docker exec` polling the attach shell's `/proc/<pid>/stat` once a second for
its foreground process group) and a disposable **sidecar** process
(`devc __herdr-sidecar`) carrying `HERDR_AGENT=<kind>`, killed and respawned
as the container's foreground command changes. `DEVC_HERDR_AGENT=<kind>`
pins that kind for the whole attach instead — the sidecar is spawned once and
no watcher runs — the escape hatch for an agent devc's own mapping table
(`herdrAgentKindFor` in `herdr.ts`) doesn't know.

Herdr's own detection manifests keep deciding **state** (idle/working/blocked)
from the pane's terminal output, exactly as they do for an agent run on the
host — devc only ever asserts **identity**. Nothing here writes to Herdr's
config.

### `devc web`: browser UI for in-container Herdr

`devc web` serves one page, on `127.0.0.1` only, for the Herdr sessions running
**inside** every running devcontainer. It prints exactly one line,
`devc web: http://127.0.0.1:48228/#token=…`, opens the page in the default
browser, and runs until Ctrl-C. To open it elsewhere, use that URL (the
`#token=` part included). The browser is opened through a one-time
`/open/<nonce>` link that redirects to the URL, so the token never appears in
the opener's command line; without a display (Linux with no `DISPLAY` or
`WAYLAND_DISPLAY`) nothing is opened. `--no-open` skips it. Every run mints a new token and keeps it only in
memory, so a URL printed by an earlier run never works again; restarting
`devc web` is how to revoke one. Nothing
is published from any container: the host server finds devcontainers with
`docker ps` + `docker events` and reaches each container's Herdr through
`docker exec … herdr --session devc remote-api-bridge` and
`terminal session control`. Updates are pushed end to end; nothing is polled.

- **Sidebar:** each repo or worktree of a container is a **repo card**: its
  name, branch and sync mark on top, then its terminals (its tiles, then every
  pane in it no tile shows, shells too); terminals outside every repo get a
  card named after the container. A card's header buttons show its past agent
  sessions (a repo in several containers lists the same ones on each container's
  card, resumed in that container; a session open in a terminal is on none of
  them, its terminal's row stands for it), its pull request and its files under its terminals, and open a new
  terminal or task there; those open under the card until you click their
  button again or click the header, which closes them all; each scrolls in a
  box of capped height, so a long one doesn't stretch the sidebar. Under
  **Containers**, a worktree's card is indented under its repo's, joined by a
  rail; with nothing open, a click on that repo's header hides or shows them
  (its chevron, on the left, points down while they show). Anywhere else, with nothing open, the
  header's click does nothing. A card is **active** while it has a tile or an agent no tile
  shows (past sessions don't count): active cards are under **In use**, each container's in a
  card under its name, most urgent agent first (blocked, done, working, then idle; cards with no
  agent last, ties in layout order) and re-sorted as statuses change; the rest are under **Containers**, in their container's
  card, after its header and before its **Files** row (the container's own
  filesystem from `/`). A repo mounted in two containers has a card in each,
  each listing its past sessions. Click a tile or pane row to bring it
  forward. Click a container to collapse it; a collapsed one shows its most
  urgent agent status. A repo is named by its path under `/workspaces` in the
  container (`tools/devc-tools`), else by its folder's name. The window title follows the
  active tile: `<repo>:<branch> — <title> — devcd`, where `<repo>` is the
  folder name of the repo its terminal's current directory or its file is in (a
  worktree's main repo; the project's name outside every repo), `<branch>` is
  that folder's branch as last read, and `<title>` is the title the terminal's
  program sets (an agent's, as it works), as the tile's tab shows it. Which rows are open is remembered per browser; hover the **Tasks** or
  **Containers** heading for **Collapse all**, which closes every row under it,
  at every level; a click on either heading folds the whole section. The rules
  between Tasks, In use and Containers drag to resize them (double-click one to
  reset); the sizes are remembered per browser. Containers without a running Herdr server are grouped under
  **Not running** at the bottom; hover one for its play button,
  **Start Herdr** (`herdr --session devc server`, detached), and **Retry**. The same group
  lists **projects** whose container is stopped or was never created: every
  folder a devc command has started (kept, with your pins, in
  `~/.config/devc/projects.json`; the 20 most recent unpinned ones) and every
  folder you pinned. Hover one for its play button, **Start container** (the same start as `devc attach`,
  with its output under **Show output**); right-click any project for **Stop
  container**, **Remove container** (as `devc down`: stopped, then deleted),
  **Pin**/**Unpin** and **Forget**; hovering a running container's row shows a
  trash button for **Remove container** left of its stop button, the **+** on the Containers
  heading adds a folder, and its refresh button lists the containers and
  projects again (for a change devc web missed). A tile whose project is down offers **Start
  container**.
- **Menus:** right-click a tile (its tab, or its row in a repo card) for **Split
  vertically** (a new terminal to its right), **Split horizontally** (below),
  **New pane in this stack**, **Close** (the tile only) and **Kill pane** (ends
  the process and closes every tile showing it). Stacks, rows and columns offer a new shell inside them; a
  container or workspace row offers **New shell** in the focused stack; a pane
  row offers **Open in new tile**, **Rename** and **Kill**. A terminal's row
  in a repo card also offers **Open in Code** first, on the repo its current
  directory is in (none outside every repo). A new shell is
  always its own Herdr tab, created without moving the focus of a Herdr TUI
  attached to the same session. The focused tile's pane, though, is focused in
  its container's Herdr whenever the focused tile changes and when the window
  gains focus (so a Herdr TUI attached to that session follows it): that marks
  its agent's finished turn seen, so its status goes from **done** to **idle**.
  Hovering a tile's row shows **×** to close the
  tile (and, on a terminal's, a trash button left of it to kill the pane);
  hovering a pane's row shows a trash button to kill it.
- **Open in Jira:** with `"jira"` in the [global config](#the-global-config),
  a branch that holds an issue key (`feature/AB-12345-fix`) offers **Open
  AB-12345 in Jira** wherever devc web shows that branch: a terminal (right-click
  inside it, its tab or its row in a repo card — the branch of the repo it is
  in), a file tile (its file's repo) and a repo card's header. Up to three
  keys per branch, each its own item; it opens in your browser.

  ```json
  {
    "jira": {
      "pattern": "AB-\\d+",
      "url": "https://acme.atlassian.net/browse/{key}"
    }
  }
  ```

  `pattern` is a JavaScript regular expression for one key (`"(?:AB|CD)-\\d+"`
  for several projects), matched case-insensitively where no letter or digit
  adjoins it; the key is upper-cased. `url` is an http(s) URL in which `{key}`
  is replaced. Edits apply without a restart; a bad value prints a
  `devc web:` message and turns the items off.
- **Tiles:** click a pane to show it (bringing its tile forward if one already
  shows it, else opening it in the focused tile; Ctrl/⌘-click always opens a
  new tile), or drag it from the sidebar onto any tile's edge (a new split) or
  tab strip (a new tab in that stack). Drag a tile's tab to move it; rows,
  columns and tab stacks nest to any depth, the dividers resize, and each tab
  can be maximised or closed. The same pane may be open in several tiles. Tiles
  are the browser's own layout
  ([Golden Layout](https://github.com/golden-layout/golden-layout), vendored)
  and never change Herdr's. The layout is kept in the browser's
  `localStorage`; a tile whose pane has since closed shows "Pane gone".
- **Zen mode:** the sidebar header's corners button, a tile's menu, or
  **Ctrl+Alt+Z** (**⌘⌥Z** on a Mac, even while a terminal has focus) shows
  the focused tile alone, filling the tiling area with no tab header or frame.
  The sidebar keeps **Tasks** and the focused tile's repo card alone; the
  Containers section, the **In use** heading and pinned files are hidden. The
  card fills the sidebar under Tasks, which does not scroll; its open sections (files, pull request,
  past sessions) share the card's height, each scrolling on its own. Clicking a pane in the card
  switches the tile shown, and the card follows. The layout under it is kept,
  and comes back when zen mode is turned off the same way. Zen mode is kept
  across reloads.
- **Input:** keys go through as typed. A multi-line paste is sent as one
  bracketed paste, so a shell or agent prompt does not submit each line. Mouse
  clicks and drags go to the app (Herdr encodes them in the app's own mouse
  mode), except a right-click, which opens the tile's menu (the same one as
  its tab); **Shift+drag** selects locally and copies. The wheel scrolls the app
  when it tracks the mouse, and Herdr's scrollback otherwise.
- **Files and editing:** click a file to open it in a file tile, with syntax
  highlighting, search (Ctrl/⌘+F) and folding. While the project's container
  runs, the tile is an editor too: type, and **Ctrl+S** (**⌘S** or **Ctrl+S** on
  a Mac) saves, with a "Saved" toast. Its tab shows **●** until then, and editing a preview tile keeps it open. A save is
  written inside the container as its remote user, in place (owner and mode
  are kept). If the file changed on disk since the tile read it, you are asked
  before it is overwritten. Reloading or closing a tile with unsaved edits
  (its tab's ×, or **Close**) asks first, and so does leaving the page. While
  the container is stopped, the tile is read-only. Right-click a file for **Open in editor**, which runs
  `$EDITOR` on it in a new terminal named after the file (unset, the first of
  `micro`, `nano` and `vi` that the container has). Right-click a
  folder, a repo or a container's **Files** row for **New file…** or **New
  folder…**: type the name in the row that opens under it, Enter creates it
  (Escape cancels), and a new file opens in the editor. Entries are created
  inside the container as its remote user, so they have the owner the editor's
  saves will have; a name that is already taken is reported under the row. The
  container must be running. **Rename…** (the name is edited in place) and
  **Delete…** (after a confirmation; a folder goes with everything in it) are on
  every file and folder below a root, and run in the container the same way. An
  editor's terminal is named after its file, in the sidebar and on its tab. A
  container's **Files** row lists `/workspaces` and the remote user's home first,
  each a folder of its own, then everything under `/`. Every file and folder
  under a repo or **Files**, and the repo and **Files** rows themselves, offer
  **Copy path** (the host path), **Copy container path**, **Open in Code**,
  which runs VS Code's `code` on the host path (on macOS without `code` on
  `PATH`, the app itself), and **Reveal in Finder**, which shows the entry
  selected in the host's file manager (**Reveal in File Explorer** on Windows;
  **Open containing folder** on Linux, which tries the desktop's file manager
  over D-Bus and falls back to `xdg-open` on the folder). Each is there when its
  path is known: a container file has a host path only under a bind mount, and
  opens in Code or reveals only inside one of the project's repos. Menus group
  their items with dividers. Hovering shows the host path (a container file
  also shows its container path). See
  [Editing in a terminal](#editing-in-a-terminal) for the editor.
- **Images and HTML pages:** an image (`.png`, `.jpg`, `.gif`, `.webp`,
  `.avif`, `.bmp`, `.ico`) opens as an image rather than as text: scaled down
  to fit the tile, never up, over a checkerboard where it is transparent, with
  its size in the corner. Click it to toggle between fit and 1:1 (which
  scrolls); pixels stay crisp whenever it is drawn larger than it is. An HTML
  file or an SVG opens as text, and its menu adds **Preview** and **Preview to
  the right**, which render it in a tile (an HTML page in a sandboxed frame,
  with the files beside it); an HTML file also has **Open in browser**, which
  opens it in a browser tab instead. The source and its rendering can sit side
  by side: a rendering's tab menu has **Open as text**, a source's has
  **Preview**, and saving the source reloads its renderings. A rendering is
  read-only; its **Reload** reads the file again. A container file's rendering
  needs the container running.
- **Pinned files and notes:** the **Pinned** section at the top of the sidebar
  keeps repo files one click away. It appears once something is pinned:
  right-click a repo file (or a file tile) for **Pin file** / **Unpin file**.
  The section's **+** is **New note…** (so the first note needs one pin), which
  creates a file in a project's repo (`.plans/notes.md` when the repo has a
  `.plans/` folder, else `NOTES.md`; an existing file is pinned as it is, and a
  missing folder is reported, not created), pins it and opens it. Clicking a
  pin opens its file in the editor, or closes its tile again (a dot marks it
  open). Closing hides the tile only: the editor keeps running in Herdr, so the
  next click brings back the same buffer, unsaved edits included.
  **Ctrl+Alt+N** (**⌘⌥N** on a Mac) toggles the first pin, even while a
  terminal has focus. While the container is stopped a pin opens read-only in
  the file viewer, with a **Start** offer. A pin's menu has **Open to the
  right**, **Open read-only**, **Open in Code**, **Reveal in Finder**, **Copy
  path**, **Copy container path**, **Rename…** and **Unpin file**.
  Pins are kept in `~/.config/devc/pinned-files.json`, so a browser tab and the
  devc-desktop window show the same ones. They are not pinned projects (a
  project kept in the Containers list) and not a preview tile's **Keep open**.
- **Tasks:** the **Tasks** section, at the top of the sidebar,
  is a to-do list for agents. Its **+** opens a dialog: write the task (the
  first line is its title), optionally choose a project and repo, then **Save**
  it for later or send it straight away with the two icons at the dialog's top,
  **Send: plan** and **Send: implement**. **New task here…** on a folder (its
  hover button beside the new-terminal **+**, or its menu) opens the same
  dialog routed to that folder's project and repo. **Send: plan** asks the agent for an implementation plan (a
  `.plans/` doc if the repo has a `.plans/` folder); **Send: implement** asks
  it to do the task. The agent is Claude, Copilot or pi (opencode can't be
  given a session id), and the container must be running. Sending writes the
  text to `/tmp/devc-tasks/<id>.md` in the container, opens a new terminal in
  the repo named after the task, and starts the agent there with `<id>` as
  its session id. The task then moves under **Sent**: clicking it shows it
  read-only (its text, route, agent and when it was sent), and the dialog's
  **Open session** shows that terminal while it is still open, or resumes the
  session in a new one (`claude --resume <id>`, `copilot --resume <id>`,
  `pi --session-id <id>`).
  Tasks are grouped under a node per project and repo (ones with no project
  under **not routed**, last); a node's **New task here…** opens the dialog
  routed there. The pin beside the dialog's Agent makes its project, repo and
  agent the default for new tasks (click it again to clear it). The default is
  kept per window, so a browser tab and devc-desktop each have their own.
  Without one, a new task starts on the focused tile's project. Clicking a
  task edits it. Its hover icons send a routed task for a plan or to
  implement, to the default's agent (else the agent last chosen in the
  dialog), and the trash can deletes it.
  A sent task's menu also has **Open session**, **Back to tasks** and
  **Remove**. Sending is
  one-way: nothing in a container writes to the list. Tasks are kept in
  `~/.config/devc/tasks.json` (the 50 newest sent ones), shared by every
  devc web window.
- **Sessions:** each running container's **Sessions** row (between Terminals
  and its repos, closed until opened) lists the 20 most recent Claude, Copilot
  and pi sessions of each of the project's repos (those that started in it),
  newest first:
  the agent's icon, the session's title (its name, else Claude's own title or
  your last prompt, pi's first message) and how long ago it was used. Opening
  the row, or its refresh button, reads them again from the agents' folders in
  the container (`~/.claude/projects`, `~/.copilot/session-state`,
  `~/.pi/agent/sessions`). Clicking one resumes it in a new terminal in the
  folder it started in, named after it (the same commands as **Sent**); a
  session already resumed this way is shown in its terminal instead while that
  is still open. Its menu also copies the session id. devc web can't tell when
  a session is already open in some other terminal.
- **Pull requests:** under each repo of a running container, a **Pull request**
  row (its first child, closed until opened) shows the open PR of the repo's
  pinned branch: `#<n> <title>`, how many files you've marked Viewed, and the
  changed files as a tree with GitHub's own **Viewed** checkboxes. Clicking a
  file opens its unified diff in a tile (as a Files click opens a file), with
  the PR's review threads after their lines (by new-file line number; the rest
  under **File threads**), resolved ones folded under `Resolved (n)` (**Show
  resolved** opens them all). What works follows the grants of the repo's own line in the
  host-only policy, read on every message: reading needs `gh-pr-read`, the
  checkboxes `gh-pr-viewed`, **Reply** `gh-pr-reply` (posted as you with the
  bridge's `🤖` prefix), and **Resolve** `gh-pr-resolve` (any thread) or
  `gh-pr-resolve-copilot` (Copilot's only). Without `gh-pr-read` the row says
  which grant to add (`devc up --bridge-allow gh-pr-read`, or
  `"bridgeDefaultAllow"`). Everything goes through that container's
  devc-bridge (`gh-pr-files`, `gh-pr-comments`, `gh-pr-viewed`, `gh-pr-reply`,
  `gh-pr-resolve`), so the PR is always that pinned branch's, and nothing is
  polled: the row lists on opening and on its ⟳, a diff tile on opening, on its
  ⟳ and after each write. Needs a server with the `pr_*` messages
  (`--live-yolo`, or a `devc` built from this version).
- `--port N` picks another port (default 48228); `--session NAME` another Herdr
  session (default `devc`, the one `devc herdr` uses). A port already in use
  exits 1 with a `devc web:` message.
- `--live` serves the **page** of the devc-tools checkout named by
  `"webSource"` in the [global config](#the-global-config) live (`~` and `$VAR` expand; it
  must be absolute); `--live-yolo` runs its server code as well; `--source DIR`
  names a checkout for this run. Both imply `--live`. Neither: the built-in
  copy. See below.

Security: Herdr panes are shells, so `/ws` only accepts requests whose `Host`
is `127.0.0.1:<port>`, `localhost:<port>` or `host.docker.internal:<port>`,
whose `Origin` is that page or absent (a non-browser client), and that carry
the token. There is no remote access by design. Routes under `/desktop/` are
for devc-desktop's main process: they need `Authorization: Bearer <token>`
(never `?token=`) and refuse any request that has an `Origin`. The only one is
`GET /desktop/active-folder`, the host folder behind the terminal pane a page
last reported as focused, and that pane's container's own folder, for
devc-desktop's right-click `cd`. devc web runs no `gh`: its pull request reads
and writes are devc-bridge commands run in the container (`docker exec`, argv
only), so the page can do only what that container's bridge grant already
allows from its own terminals. Their output passes through the container, so
it is parsed with caps and shown as text only, with bidi and zero-width
characters as visible markers.

**From a container:** on Docker Desktop, a container reaches the server at
`host.docker.internal:<port>`. Give an agent the printed URL with the host
swapped, and it can connect any WebSocket client to
`ws://host.docker.internal:<port>/ws?token=<token>`. Anything in any container
that has the token can drive every pane, so restart `devc web` for a fresh
token when the agent is done. On Linux Docker, `host.docker.internal` is the
bridge gateway rather than the host's loopback, so this needs Docker Desktop.

#### The host status strip and usage limits

The sidebar's foot is a one-line strip of host-level indicators: the
account-wide agent usage limits (Claude's 5h window as used / time to reset,
`33%/3h10m`), then devc-bridge (`bridge ●` / `bridge ○ off`, `☕ awake` while
keepawake holds the host awake). Hover the usage for every window on its own
row (`5h 33%/3h10m`, `7d 18%/6d4h`). Usage is shown once for every session,
from whichever one reported last; once a window's reset time passes with no
newer report it shows as `—` rather than the old percentage. An observation
over 15 minutes old is dimmed, and the item is highlighted when any window,
shown or not, is at 90% or more.

Claude Code hands its usage limits only to the status line, so the status line
has to write them down. [`scripts/devc-usage-tap`](../scripts/devc-usage-tap)
(needs `jq`) reads one status-line input on stdin and replaces
`${CLAUDE_CONFIG_DIR:-~/.claude}/devc-usage.json`; it never prints, never fails,
and skips inputs without `rate_limits` (early in a session, or API-key auth).
`devc web` watches that file in the Claude home devc mounts into every container
(`~/.config/devc/.claude`) and in the host's own (`$CLAUDE_CONFIG_DIR`, default
`~/.claude`); the newer observation wins. To wire it up, copy the script next to
your `statusline.sh` in each Claude home whose sessions should report:

```sh
cp scripts/devc-usage-tap ~/.config/devc/.claude/   # every devc container
cp scripts/devc-usage-tap ~/.claude/                # sessions on the host
```

and add the tap to `statusline.sh` straight after it reads its input:

```bash
input=$(cat)
tap="$(dirname "$0")/devc-usage-tap"
[ -x "$tap" ] && printf '%s' "$input" | "$tap" >/dev/null 2>&1 &
```

Until a session reports, the strip shows no usage. Seeing usage needs a server
with the `usage` message (`--live-yolo`, or a `devc` built from this version).

#### Live mode: `devc web --live` and `--live-yolo`

Live mode serves a devc-tools checkout's `devc/` directory on the **host** (the
one holding `main.ts`), e.g. `~/code/tools/devc-tools/devc`, instead of the
built-in copy. It is the same checkout that containers with the `devc:source`
mount see read-write at `/workspaces/tools/devc-tools`: two names for one
directory, from either side. Name it once in the
[global config](#the-global-config) (`~/.config/devc/config.jsonc`, or
`config.json`):

```json
{ "webSource": "~/code/tools/devc-tools/devc" }
```

`devc config --global` keeps the key when it rewrites the file. `--source DIR`
names a checkout for one run instead. Without `--live`, `--live-yolo` or
`--source`, `devc web` serves the built-in copy, whatever the config says: any
agent that can write to the checkout can change what live mode runs, so it is
only ever on when asked for, run by run.

- **`devc web --live`: the page only.** The server is the built-in one; it
  serves and watches the checkout's `web/static/`. The page is the only
  checkout code that runs, in your browser tab, and the server will not act on
  its behalf beyond the containers already running: it starts no containers,
  adds no projects and pins none (the page hides those controls; start a
  project from a terminal). A page change that needs a server change the
  installed `devc` doesn't have needs `--live-yolo`, or a newer `devc`.
- **`devc web --live-yolo`: the page and the server code.** The `devc` you started
  becomes a supervisor: it runs `deno run … main.ts web` in `DIR` as a child,
  which serves the checkout's own server code, and restarts it on every change
  that passes `deno check`. That code runs on the host as you, so use it only
  while working on the server. Needs `deno` on the host `PATH`; a missing
  `DIR/main.ts` or `deno` exits 1 with a `devc web:` message.

Edits reach the open tab without a new URL:

- **Page** (`web/static/**`, both modes): the tab reloads (tile layout is in
  `localStorage`, terminal contents in Herdr), or for a CSS-only change swaps the
  stylesheet in place.
- **Server** (`.ts` under `devc/` or `devc-core/`, not `tests/`;
  `--live-yolo` only): the supervisor runs `deno check main.ts` while the old
  server keeps serving. If it fails, it prints
  `devc web: not restarting: deno check failed` and the errors, and keeps the
  old server. If it passes, it restarts the child; the page reconnects by itself
  within a few seconds.
- **A crash** (`--live-yolo` only): if the child exits on its own, the
  supervisor serves the built-in copy on the same port and token
  (`devc web: server exited (…); serving the built-in copy until the next
  change`) until a change passes `deno check` again.
- **A broken page** (both modes): an error before the page has rendered (or
  5 s without rendering) shows an overlay with **Reload** and **Load last
  good**. The latter opens `/safe/`, a snapshot of the last page a browser
  rendered (`~/.cache/devc/web/last-good/`), with a "Safe mode" banner and a
  link back.

Running `deno task run web` directly in a checkout (no `--live`) is not live:
it serves the files from disk, so a browser refresh shows page edits, but
nothing is watched.

#### Changing devc web while using it

For an agent in a pane of `devc web` asked to change the UI:

- **Where the code is:** the page is `devc/web/static/` (`app.js`, `layout.js`,
  `renderer.js`, `lib/`, `style.css`, `index.html`, `boot.js`); the server is
  `devc/web/*.ts`. From a container with the `devc:source` mount, that is
  `/workspaces/tools/devc-tools/devc/…`.
- **What happens on save:** a page file reloads the user's tab (a `.css` file
  swaps in place); a server `.ts` file restarts the server, but only once
  `deno check main.ts` passes. Your own pane reconnects too.
- **How to verify:** `deno task check` and `deno task test` in `devc/`.
- **If the UI breaks:** the user can click **Load last good** (or open
  `/safe/`), or fall back to `devc herdr` in a terminal. Fix forward, or
  `git checkout` the file. Keep page URLs relative (`./x.js`), so the page also
  works under `/safe/`. **Never edit `boot.js` together with other page
  files**: it is what shows the way out of a broken page.

Known limitations:

- **Application cursor key mode is not honored.** Herdr's frames are its own
  redraw and never carry the app's terminal modes, so arrow keys always go as
  `ESC [ A` and the like. vim, less, readline and the agent TUIs accept both.
- **A pane open in the browser takes the browser's size.** Herdr allows one
  controller per terminal, and a resize changes the pane's real pty size, which
  persists. A Herdr TUI (`devc herdr`) showing the same pane draws it at the
  browser's size until the TUI takes it back, and opening the pane elsewhere
  with `--takeover` disconnects the tile (it offers **Reconnect**).

#### Editing in a terminal

**Open in editor** runs `$EDITOR`. When that is unset, it runs the first of
`micro`, `nano` and `vi` that is installed in the container. The non-modal
editors come first, so you never land in `vi` without asking for it. The
[`micro`](../features/micro/README.md) Feature installs micro: typing inserts
text, Ctrl+S saves, Ctrl+Q quits (which closes the pane), and Ctrl+G shows the
help. To use another editor, set `EDITOR` in your shell prefs
(`~/.config/devc/shell/10-prefs.sh`, see
[Shell setup](#shell-setup-shell-folders)).

What reaches an editor through devc web and Herdr 0.9.5 (measured with Helix):

- **Colors** are truecolor: Herdr sets `COLORTERM=truecolor` in every pane.
- **Keys** reach the editor, except what the browser keeps for itself: off a
  Mac, `Ctrl+W` closes the browser tab. On a Mac, `Option+key` types a character, not `Alt+key`.
- **Mouse:** a click places the cursor and a drag selects, but the **wheel may
  not scroll the editor** (devc web's wheel scrolls Herdr's scrollback). Use the
  editor's page keys (micro: PageUp/PageDown).
- **Copying:** an editor's own copy (micro's Ctrl+C) stays inside the
  container. It cannot reach your clipboard, because Herdr does not pass OSC 52
  to devc web. A plain drag copies the screen text under it to your clipboard.
  **Shift+drag** selects without the editor seeing it. Pasting from the page
  inserts the text as it was copied.

### The library: `@devc-tools/core`

Everything above except attaching an interactive shell — start/rebuild/stop/down,
status, mounts, exec, the `devc.json` overlay, the config wizard's pure helpers —
lives in the sibling [`devc-core/`](../devc-core/README.md) package and is
consumed from source here. `devc` compiles unchanged into the same `deno compile`
binary described below; `devc-core` additionally publishes to npm as
`@devc-tools/core`, for a programmatic consumer (a coding-agent extension, a
script) that wants `ContainerInfo` back as a value instead of parsing a CLI's
stdout. See [`.plans/archived/devc-core-npm-library.md`](../.plans/archived/devc-core-npm-library.md)
for the design.

### The embedded devcontainer CLI

`devc` does not look for a `devcontainer` on your `PATH`. It depends on
`@devcontainers/cli` as a pinned npm package, which `deno compile` embeds in the
binary — so `devc up` works on a machine with only Docker installed, and can
never disagree with a differently-versioned CLI someone happened to install.

`@devcontainers/cli` publishes no programmatic API — its `package.json` declares
only `bin`, and importing its bundle _runs_ the CLI against `process.argv` and
then calls `process.exit()`. So `devc` re-execs **itself** with a hidden
`__devcontainer` subcommand: that child sets `process.argv` and imports the
bundle, becoming a devcontainer CLI, and the parent pipes its stdout exactly as
it piped the old PATH binary's. Nothing about the argv `devc` builds changed.

Two consequences worth knowing:

- **`devc` runs with an unscoped `--allow-run`**, where it used to allowlist
  `docker,devcontainer,git,tmux,tty`. A `devcontainer.json` may declare an
  `initializeCommand`, which the CLI runs on the **host** through `/bin/sh -c`
  (devc's own bundled default declares one), and an allowlist containing
  `/bin/sh` permits every host command anyway. It also gains `--allow-sys` and
  `--allow-net`, both the CLI's: `osRelease` at startup, and its own HTTPS
  fetches of Features from OCI registries during `up`. The
  `Info Failed to resolve '<name>' for allow-run` line Deno used to print for
  each missing allowlisted binary goes away with the allowlist.
- **Upgrading the CLI is a `devc` release.** The version is pinned in
  `devc/deno.json`'s `imports`, alongside the identical pin in
  `.github/workflows/publish-feature.yml`; bump both together.

## Optional overlay: `devc.json`

Whatever lands in `.devcontainer/` runs **without `devc` installed at all** —
that is the rule the whole tool is built around. `devc.json` does not weaken it:
the overlay is merged into an effective config written to `~/.cache/devc/`, and
_never_ into the project's own `devcontainer.json`. A checkout without `devc`
still builds and runs from the standard config; it just does not get the
overlay's contributions. Un-augmented, not broken.

**An overlay may set any `devcontainer.json` key**, plus devc's own keys:

```jsonc
{
  // Any devcontainer.json key. `mounts` takes the full spec vocabulary — including
  // `readonly`, which the old flag-based overlay could not express.
  "mounts": [
    "type=bind,source=${localEnv:HOME}/notes,target=${containerWorkspaceFolder}/../notes",
    "type=bind,source=${localEnv:HOME}/reference,target=/reference,readonly"
  ],
  "features": {
    "ghcr.io/devcontainers/features/rust:1": { "version": "latest" }
  },
  "remoteEnv": { "MY_VAR": "value" },
  "runArgs": ["--cap-add", "SYS_PTRACE"],
  "forwardPorts": [3000],

  // null deletes what the layers below set.
  "initializeCommand": null,

  // devc-only. false disables every Feature devc contributes on its own (devc-config
  // today — see "Project post-create hook" below). Default true. Unlike everything
  // else, this one is a *veto*: a user-level `false` wins even when a project sets it
  // back to `true` — see below.
  "baselineFeatures": true,

  // devc-only. false stops devc mounting the host's devc-bridge client into
  // bridge-enabled containers — see "The client mount" below. Default true; the
  // highest layer wins. Any non-boolean fails the command.
  "bridgeClientMount": true
}
```

Where it can live — **first hit wins per level, and the losers are not merged**:

```text
~/.config/devc/devc.jsonc               your own, applied to every project   (lowest precedence)
~/.config/devc/devc.json
~/.config/devc/repos/<key>/devc.jsonc   every checkout of one git repo
~/.config/devc/repos/<key>/devc.json
<project>/.devc/devc.jsonc              this project                         (highest precedence)
<project>/.devc/devc.json
<project>/.devcontainer/devc.jsonc
<project>/.devcontainer/devc.json
```

- **Both project locations are first-class**, and behave identically.
  `.devcontainer/devc.json` is often the better fit for a **gitignored local
  override** — one file to `.gitignore`, sitting beside the config it overlays —
  while `.devc/` suits a repo that wants `devc`'s files grouped in one place.
- **Committed or gitignored, both are valid.** Committed, it says the repo has
  adopted `devc` as a tool it depends on. Gitignored, it is a purely local
  override: you add bind mounts for your own machine in a repo that need not
  know `devc` exists, and the `.devcontainer/` your teammates check out is
  untouched by definition.
- **Applies in both modes** — a project with its own
  `.devcontainer/devcontainer.json` gets the overlay just like the zero-config
  path does.
- `.json` vs `.jsonc` is naming convention only; both are parsed as JSONC
  (comments, trailing commas).
- **`devc up --print-config`** prints the merged result, and starts nothing.
  That is the answer to "what did my overlay actually do".
- Container config is bound at create time, so run `devc build` after editing an
  overlay.
- `devc config` writes the `mounts` key's two managed fences here — see
  [which file it writes](#which-file-it-writes). The other keys are yours; the
  wizard never touches them.
- `devc init` is unaffected and still requires a **missing or empty**
  `.devcontainer/`: a lone `devc.json` in there counts as content. Move it
  aside, run `init`, move it back.

### Repo overlay: one file for every worktree

A **repo overlay** applies to a git repository's primary checkout and every
linked worktree of it, wherever those live, and is written into none of them:

```sh
cd ~/code/app                  # the primary, any worktree, or a subfolder of either
devc config --repo             # the usual wizard, writing the repo overlay
git worktree add ../app.worktrees/feat
devc up ../app.worktrees/feat  # picks the repo overlay up automatically
```

- **Which repo.** devc follows the checkout's `.git` (a directory, or a
  worktree's `gitdir:` file and the `commondir` beside it) to the git directory
  every checkout shares, e.g. `~/code/app/.git`, with symlinks resolved. It
  reads files only and runs no `git`. A submodule is its own repo, a worktree of a
  bare repo belongs to the bare repo, and two clones of the same remote are two
  repos.
- **Where.** `~/.config/devc/repos/<name>-<hash>/devc.jsonc`: `<name>` is the
  repo's folder name, `<hash>` the first 8 hex of the SHA-256 of that git
  directory's path. `devc status` prints the path for the current checkout —
  `repo overlay: ~/.config/devc/repos/app-1a2b3c4d/devc.jsonc`, or `none` and
  where it would go.
- **Same keys, same paths as the user overlay.** Relative paths are not
  resolved against `~/.config/devc/repos/<key>/`; use absolute paths,
  `${localEnv:HOME}`, or `${localWorkspaceFolder}`, which is the checkout being
  started, not the primary.
- **Config is shared, containers are not.** Every worktree keeps its own
  container, merged config and devc-bridge key. After editing the repo overlay,
  run `devc build` in each checkout whose container should pick it up.
- **To stop using it**, delete or rename its directory.
- **After moving the repo** the hash changes, so the old overlay no longer
  applies: run `devc status` in the moved repo and `mv` the old directory to the
  path it prints.
- A git directory devc cannot read (a dangling `gitdir:`, say) means no repo
  overlay, and one warning on start once `~/.config/devc/repos/` exists. An
  overlay file that exists but is invalid fails the start, as a broken user
  overlay does.

### How the layers merge

Lowest to highest: **devc → base config → user `devc.json` → repo `devc.json`
→ project `devc.json`**. Per key of each layer in turn:

| Kind                                              | Rule                          |
| ------------------------------------------------- | ----------------------------- |
| `null`                                            | Deletes the key, at any depth |
| A key named in that layer's `"$replace": ["key"]` | Set outright, no merging      |
| Two objects                                       | Merge recursively, per key    |
| Two arrays                                        | Append, lower layer first     |
| Anything else                                     | The higher layer wins         |

Then, once over the result: **`mounts` dedupe by target** — a later entry
sharing an earlier one's target replaces it in place, so the base's ordering
survives and the highest layer's value wins — and
`customizations.vscode.extensions` dedupe by id.

One deliberate exception:

- **`baselineFeatures` is a veto, not "project wins".** It is
  `user && repo && project`: a machine owner's `false` cannot be talked back on
  by a repo's `devc.json`. Any one layer can still turn it off on its own.

Target dedupe is what turns "append" into "override": pointing an overlay mount
at a target the base config already mounts replaces that mount rather than
colliding with it (two entries on one target used to reach Docker and fail the
create with `Duplicate mount point`). `$replace` is for the case none of that
covers — "throw away everything the layers under me said about this key" — and
is rarely the answer.

**Nothing is substituted by devc on the way in.** `${localEnv:HOME}`,
`${containerWorkspaceFolder}` and friends are written through verbatim and
resolved by the devcontainer CLI, so `${devcontainerId}` and
`${containerEnv:…}` work in an overlay value too.

### What an overlay can and cannot get away with

- **Errors are loud, with one exception.** A `devc.json` that doesn't parse
  fails the command, naming the file — this file exists only for `devc`, and
  silently starting a container without its contributions is worse. A key that
  is not a `devcontainer.json` key warns on stderr naming the key (so a typo like
  `"mount"` is visible) and is passed through, where the CLI ignores it. The one
  exception is a non-boolean `baselineFeatures`, which warns and falls back to
  the default (`true`) rather than failing the command — there is no
  container-missing-your-mounts asymmetry to justify a hard error either way.
- **`mounts` is shape-checked only.** An entry must be a string with a `target=`
  (or `dst=`) field, or an object with a `target` property; that check exists to
  give a better error than Docker's, not to constrain the vocabulary. Field
  order, `readonly`, `consistency` and the object form are all fine.
- **An overlay can replace the base config's shape.** Setting `image`, `build`
  or `dockerComposeFile` drops the other two (they are mutually exclusive in the
  spec) and warns naming what it replaced. So does replacing a lifecycle command
  — those are single-valued, so only the highest layer's runs. To _add_ a
  create-time step rather than replace one, use the
  [project post-create hook](#project-post-create-hook-devc-post-createsh).
- **`readonly` still does not survive on Docker Compose projects.** The CLI
  rewrites `mounts` into its generated compose file and drops the field on the
  way. That is a CLI limitation, not devc's.
- **`additionalFeatures` is gone.** The key is `features`, merged into the base
  config's own. An overlay still using the old name gets the unknown-key warning
  above.

## Project post-create hook: `devc-post-create.sh`

The overlay covers **declarative** extension — mounts, features, env. This is the
**imperative** half: a script that runs at container-create time, after devc's
own baseline setup. Together they let a project extend its container without
owning (or even being aware of) a `.devcontainer/` devc controls.

Drop an executable script at either location — first hit wins, same order and
same both-are-first-class rule as the overlay itself:

```
.devc/devc-post-create.sh
.devcontainer/devc-post-create.sh
```

It runs via the
[`devc-config` Feature](https://github.com/devc-tools/devc-tools/tree/main/features/devc-config),
which devc contributes to **every** container it starts — it is the lowest layer
of the merge that produces the effective config, with no configuration from you. That reaches every project devc starts, including one
with its own hand-written `.devcontainer/devcontainer.json` that devc has never
touched. devc's own baseline (the `agents` and `git-container-config`
Features) is ordered ahead of it via `installsAfter` in `devc-config`'s own
manifest, so `.claude` + seed links and git identity are already in place by
the time the hook runs — the same guarantee a prior version of this Feature
got from a top-level `onCreateCommand`, now expressed as Feature-to-Feature
ordering instead, since all three are Features competing in the same phase.
The same fence also carries devc's own prompt/title/`devc attach` first-prompt
clear `~/.bashrc` block, appended right after the hook — so a genuinely
project-owned `.devcontainer/devcontainer.json` gets that shell behavior too,
not just a zero-config or `devc init` one.

**The contribution is dynamic only — devc's own bundled `devcontainer.json` does
not declare this Feature.** That means it reaches every container `devc up`
starts, but not a `devc init`-scaffolded project run later with `devc`
uninstalled: what this Feature does (running a script
you wrote specifically for devc's own convention) is devc-specific, so it is
fine — deliberately — for that one case to lose it. Declare
`"devc-config": {}` yourself if you want it without devc.

Turn it off with `"baselineFeatures": false` in a `devc.json` overlay — see
[Optional overlay: `devc.json`](#optional-overlay-devcjson) — which also
disables any other Feature devc contributes on its own. If your own
`devcontainer.json` (or an overlay's `features`) already declares `devc-config`
under any tag, devc's contribution steps aside rather than installing a second
copy.

```bash
#!/bin/bash
set -e
# cwd is the project root, so relative paths work
cd tools/mycli && cargo install --path .
```

The contract:

- **cwd is the project root** (`$PROJECT_PATH`), so relative paths resolve
  against the repo. The Feature's own `post-create.sh` establishes this itself
  rather than inheriting it from anything devc runs.
- **It must be executable.** A hook that exists but is not executable — or is a
  dangling symlink — **fails the create** naming the path, rather than being
  skipped. A hook that never runs is the failure mode this is designed to
  prevent, so it is never silent.
- **No fall-through.** Existence selects the hook; if `.devc/`'s copy exists but
  cannot run, devc does not quietly fall back to `.devcontainer/`'s.
- **A nonzero exit fails the create.** The hook is invoked directly under
  `set -e`.
- **devc never writes or reads it.** The Feature it runs through gets installed
  by the devcontainer CLI, not by devc; the hook is yours. Like the overlay, it
  is equally at home committed (the repo depends on devc) or gitignored (one
  developer's local setup).
- Changes take effect on the next container **create**, so run `devc build` after
  editing one.

## Default overrides: `~/.config/devc/templates/`

A **sparse** per-file overlay on the bundled default. Any file you put here
replaces the same-named bundled one — everywhere the bundle is used:

```text
~/.config/devc/templates/Dockerfile           your build, for zero-config projects and
~/.config/devc/templates/devcontainer.json    what `devc init` scaffolds
```

- **Never created by `devc`.** It stays absent until you make it, and holds only
  the files you want to change.
- **Re-applied every run**, so a `devc` upgrade keeps shipping its new defaults
  for every file you have _not_ overridden. Delete a file from here and the
  bundled version is back on the next run.
- **Reaches project mode too.** `devc init` scaffolds from the same layered set,
  so a `Dockerfile` customization reaches a project's own `.devcontainer/` and
  not just the zero-config path. (`devc config` scaffolds nothing — it only
  writes the overlay — so nothing it does can disturb a template.)
- A template `devcontainer.json` still gets the zero-config path rewrite
  (`initializeCommand` → the cache dir), so keeping the standard in-project
  reference in it is fine.
- The one lifecycle entry script left (`initialize-command.sh`) gets its exec
  bit restored on scaffold.
- **`devc.json` does not belong here** — it is skipped, with a warning on
  stderr. The two are adjacent paths meaning opposite things: `templates/` holds
  files _copied into_ a project's `.devcontainer/`, which run without `devc`
  installed, while the [overlay](#optional-overlay-devcjson) is a devc-only
  layer applied as flags at launch. A `devc.json` left here would be copied to
  `<project>/.devcontainer/devc.json` and read back as that _project's own_
  overlay — the highest-precedence slot — putting your machine's bind mounts
  into every repo you scaffold. For mounts that apply to every project, the file
  goes one level up, at `~/.config/devc/devc.jsonc`.

## Claude config: `~/.config/devc/.claude` and `~/.config/devc/claude-seed`

devc creates two host directories and mounts both. They do very different
things, and only the first is the one you normally use:

| Host directory               | Where it lands in the container                          | What it is                                                                    |
| ---------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `~/.config/devc/.claude`     | `~/.claude` — bind, read-write                           | **Your Claude home.** Whatever is here _is_ `~/.claude` in every container.   |
| `~/.config/devc/claude-seed` | the `agents` Feature's fixed seed path — bind, read-only | Inert unless you set that Feature's `"claudeSeed": true`. Usually left empty. |

### The normal shape: one Claude home, shared

`~/.config/devc/.claude` is bind-mounted **as** the container's `~/.claude`.
Nothing is linked, nothing is copied, nothing runs at create time:

```text
~/.config/devc/.claude/CLAUDE.md      is  /home/vscode/.claude/CLAUDE.md
~/.config/devc/.claude/settings.json  is  /home/vscode/.claude/settings.json
~/.config/devc/.claude/statusline.sh  is  /home/vscode/.claude/statusline.sh
```

- **Every file, not just the top level**, and writable rather than read-only —
  Claude Code writes its own state back into it, including your login, so **one
  login covers every container on the machine**.
- **Live.** Host edits show up immediately; no rebuild, no recreate. File modes
  carry over, so `statusline.sh` keeps its exec bit.
- **Missing is fine.** `devc` creates the directory if absent, and says so the
  once. An empty one is valid.
- **Nothing is copied in for you**, and in particular your host `~/.claude` is
  never read. Whether your personal `CLAUDE.md`, `settings.json` or
  `statusline.sh` should reach every container is a decision only you can make,
  so making it means copying (or symlinking) the file in yourself:

  ```sh
  cp ~/.claude/CLAUDE.md ~/.config/devc/.claude/
  ```

What you give up, so it is a decision and not a surprise: `.claude.json`'s
`projects` entries are keyed on the container path, and devc lands every project
at `/workspaces/<folder basename>` — so two host projects sharing a basename
share one entry, and with it `hasTrustDialogAccepted`, `allowedTools` and
`mcpServers`. `docker volume rm` no longer resets one container's Claude state
either. If either matters to you, take the isolated shape below.

### The four shapes

| `~/.claude` mount       | `claudeSeed`          | Result                                                                                           |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| bind — **devc default** | `false` — **default** | One shared `~/.claude` across every container. Host files appear directly; no seed, no symlinks. |
| bind                    | `true`                | Shared `~/.claude` **plus** seed links written into it. Legal, rarely wanted.                    |
| volume — one added line | `false`               | Isolated per-container state, no shared config. This is the bare `agents` Feature's own shape.   |
| volume                  | `true`                | Isolated state, shared config via read-only links — what devc did before `devc-core` `0.2.0`.    |

Rows 3 and 4 are reached by adding **one** `mounts` entry to the project's
`devc.jsonc` naming the **same target** as devc's bundled bind:

```jsonc
"type=volume,source=claude-code-config-${devcontainerId},target=/home/vscode/.claude"
```

Same-target mount entries collapse keeping the later layer, so your overlay's
volume **replaces** the bundled bind. Add the line; do not try to delete the
inherited one.

Row 2 is legal but rarely wanted. The seed never overwrites a real file, so with
a bind in place it can only supply names that are _not_ already in your Claude
home — and since the bind _is_ your Claude home, a seed `CLAUDE.md` is skipped
every time. The links it does create point at a container path, so they read as
broken symlinks when you open the host directory.

### Migrating

**No files move.** `~/.config/devc/.claude` used to be the read-only seed source
and is now the container's real `~/.claude`, at the same path, and its contents
(`CLAUDE.md`, `settings.json`, `statusline.sh`) are already the right ones.
`~/.config/devc/claude-seed` is created empty. A `statusLine.command` pointing at
`"$HOME/.claude/statusline.sh"` resolves to a real file at the same container
path instead of a symlink into the seed.

**What is left behind:** the old per-devcontainer `claude-code-config-*` volume,
and with it `.credentials.json`, `.claude.json`, `projects/` and
`history.jsonl`. That means **one re-login per machine**, and the loss of
in-container prompt history. The volume is orphaned rather than deleted, so
anything you want back can be copied out by hand; `docker volume prune` reclaims
the rest.

Projects whose `.devcontainer/devcontainer.json` was written by an earlier `devc`
carry the old mount line — `devc` writes infra mounts once at creation and never
re-asserts them, so replace it by hand with:

```jsonc
"initializeCommand": "mkdir -p \"$HOME/.config/devc/.claude\" \"$HOME/.config/devc/claude-seed\"",
// …and in "mounts":
"type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/home/vscode/.claude,consistency=cached",
"type=bind,source=${localEnv:HOME}/.config/devc/claude-seed,target=/usr/local/share/devc-features/agents/claude-seed,consistency=cached,readonly",
```

The `initializeCommand` is what creates the mount sources on a machine without
`devc` installed (a bind mount with a missing source is a hard error, not an
auto-created directory). It has to be top-level — it is the only host-side
lifecycle hook — so a project that needs its own `initializeCommand` should keep
the `mkdir -p` in it.

## Shell setup: `shell/` folders

Every interactive container shell sources two optional layers of `*.sh`, after
devc's own additions (prompt, terminal title, `nvm` auto-use) and before the
`devc attach` first-prompt clear:

```text
~/.config/devc/shell/*.sh          your preferences, every project   (host, read-only mount)
<project>/.devcontainer/shell/*.sh this project's settings           (workspace)
```

```sh
# ~/.config/devc/shell/10-prefs.sh
alias ll='ls -alF'
export EDITOR=vim

# .devcontainer/shell/10-project.sh
alias t='deno task test'
export DATABASE_URL=postgres://localhost/dev
```

- **User first, then project**, so a project's committed settings win on
  conflict — the same `system → global → local` order git uses. A project that
  _assigns_ rather than appends to a shared variable (`PS1`, `PATH`) will
  therefore override your personal one.
- **Order within a layer** is glob (name) order. Prefix with `10-`, `20-`, … to
  control it.
- **Optional.** Missing or empty directories do nothing. Neither is created or
  written by `devc config`, and neither is ever overwritten, so both are yours —
  commit the project one or `.gitignore` it. Only `*.sh` is sourced; a
  `README.md` alongside is ignored.
- **Live.** Both layers are _sourced_ from `~/.bashrc`, not appended into it —
  edits apply to the next new shell, with no rebuild and no recreate. Deleting a
  file stops it being read. The user layer is a read-only bind mount, so host
  edits are picked up the same way.
- **Both modes.** The project layer works in the zero-config path too: a project
  can have only `.devcontainer/shell/` and no `devcontainer.json` and still get
  it, since it is found through the workspace mount at `$PROJECT_PATH`.
- **Interactive shells only.** The project layer additionally needs
  `PROJECT_PATH` — the workspace root devc sets as `remoteEnv` and re-passes on
  `exec`/`attach`; a raw `docker exec … bash` without it deliberately sources
  nothing. The user layer is at a fixed container path and does not depend on
  it.
- Avoid setting `PROMPT_COMMAND` outright (append to it instead) — replacing it
  drops the first-prompt clear that `devc attach` installs after these layers
  run.

`~/.config/devc/shell` is created by `initialize-command.sh`, because a bind
mount errors on a missing source rather than creating it. Projects whose
`.devcontainer/devcontainer.json` was written by an earlier `devc` predate the
mount — `devc` writes infra mounts once at creation and never re-asserts them —
so add it by hand to pick up the user layer:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/shell,target=/usr/local/share/devc/shell,consistency=cached,readonly",
```

## Git protection: frozen `.git/config` and `.git/hooks`

A devcontainer bind-mounts your repo, `.git` included — so everything in
`.git/config` and `.git/hooks` is writable by whatever runs in the container.
Both are **code**: they name programs git runs. A `pre-push` hook or a
`core.fsmonitor` written from inside executes **on your host, as you**, the next
time you or your editor runs git in that repo.

devc closes that by default. For every bind-mounted repo it can see, three
mounts are merged into the effective config:

```
type=bind,source=<repo>/.git,target=<target>/.git
type=bind,source=<repo>/.git/config,target=<target>/.git/config,readonly
type=bind,source=<repo>/.git/hooks,target=<target>/.git/hooks,readonly
```

This covers the **project itself** (whose repo the devcontainer CLI mounts on its
own, not as a `devc:source` row) and every `devc:source` row whose `.git` is a
real directory.

A row whose source **is** a git dir gets two mounts instead, because the row
itself is already the mountpoint that stops a rename:

```
type=bind,source=<gitdir>/config,target=<target>/config,readonly
type=bind,source=<gitdir>/hooks,target=<target>/hooks,readonly
```

That shape comes up three ways, two of them automatic:

- **A worktree as the project folder.** The devcontainer CLI mounts the primary
  repo's `.git` itself (`--mount-git-worktree-common-dir`), at a target it
  computes; devc computes the same target and freezes it. Without this, a
  worktree container's primary `config` and `hooks` were writable.
- **A worktree picked in `devc config` without its primary.** The wizard adds a
  row for the primary's `.git` alone.
- **A bare repo** you mount by hand.

A row is skipped when it has no `.git` and is not a git dir, when its `.git` is
a _file_ (a linked worktree — covered by its primary), or when the row is
already `readonly`. A git dir with no `hooks` directory is skipped too (a bind
mount with a missing source fails the whole `up`) and reported as
`UNPROTECTED`.

The first mount is read-write on purpose. `config` + `hooks` is the **maximum**
that can be frozen: git rewrites config by `config.lock` + rename and takes
`*.lock` files all over `.git/`, so `.git/`, `refs/`, `objects/` and `logs/`
must stay writable. Making `.git` itself a mountpoint is what stops
`mv .git .git-old` — a mountpoint cannot be renamed or unlinked (`EBUSY`), while
its non-mount parent can. `chmod` is no defence for either file: git only needs
the _directory_ write bit to replace them.

Everything still works. `commit`, `checkout -b`, `tag`, `stash`, `merge`,
`cherry-pick`, `rebase`, `reflog`, `pack-refs`, `gc` and `worktree add` were all
measured green with both files frozen. One pair on the primary repo covers every
**linked worktree**, including ones created after the container starts: worktree
`git config` writes the _common_ `.git/config` and worktree hooks resolve from
the common `.git/hooks`. (`git config --worktree` would escape that, but it is
refused without `extensions.worktreeConfig`, which lives in the frozen config
and so cannot be bootstrapped from inside.)

Check it with `devc status`, which reads the container's live mount table rather
than trusting the config:

```
$ devc status
running
git protection:
  /workspaces/proj: protected
  /workspaces/extra: MISMATCH
    /workspaces/extra/.git/config is mounted read-write
```

`UNSUPPORTED` marks an umbrella mount (see caveat 4) and `UNPROTECTED` a git
dir with no `hooks` directory; neither is ever protected. `MISMATCH` means devc
believes the repo is protected and the container disagrees — a mount you declared on the same target (which legitimately wins,
see below), or a container created before the mounts existed. `devc build`
recreates it.

### The operating rule: configure on the host, run in the container

Repo config is now **read-only from inside**. Anything that writes it is a
_setup_ step, so do it on the host and let the container inherit it — a frozen
config faithfully carries whatever the host already set. The ones that will bite
you, because the failure is a bare `EROFS`/`EBUSY` that a wrapping tool buries:

| Command                   | Why it fails, and what to do                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git submodule init`      | writes `submodule.<path>.url` and `.active`. Run it on the host.                                                                                  |
| `git lfs install --local` | unnecessary — `git-container-config` puts the LFS filters in the container's **global** config.                                                   |
| `git config user.email …` | per-repo identity. Set it on the host; the container's identity comes from `~/.config/devc/git-identity/gitconfig` (see [Git setup](#git-setup)). |
| `gh repo set-default`     | writes a remote config key. Run it on the host.                                                                                                   |
| pre-commit's `install`    | writes `core.hooksPath` and a hook file. Run it on the host.                                                                                      |
| husky's `prepare` script  | writes `core.hooksPath`. `HUSKY=0` disables it.                                                                                                   |

Freezing `hooks/` does **not** disable the hooks already there — devc-tools' own
`prepare-commit-msg` keeps running, for agent commits too. Only _installing_ a
new one is blocked.

Note also that the container's **global** `~/.gitconfig` stays fully writable.
That is deliberate: it is container-local and wiped on every rebuild, so nothing
written there reaches your host.

### Turning it off

`gitProtect` is a top-level key in any `devc.json` overlay, read from the merged
config, so a project can override the user level:

```jsonc
"gitProtect": true                                  // the default
"gitProtect": false                                 // off entirely
"gitProtect": { "exclude": ["/workspaces/foo"] }    // off for one row, by container path
```

An unrecognized value is an **error**, not a silent `true` — a security control
that reads as enabled while doing nothing is the one failure worth refusing to
start over. A single derived mount can also be replaced by declaring your own on
the same target, which wins through the overlay's normal `mounts` dedupe;
`devc status` then reports `MISMATCH` so the replacement is never silent.

### Docker Compose is refused, not degraded

The devcontainer CLI **drops `readonly`** when it generates the compose file, so
the mounts would come up writable while appearing frozen. devc fails the run
instead, and `"gitProtect": false` is the acknowledgement that unblocks it.

### Four things that will surprise you

1. **Submodules are unsupported.** Each submodule's config lives at
   `.git/modules/<name>/config` — inside the writable `.git`, created
   dynamically, so no static mount can cover it. Host git entering a submodule
   reads an agent-writable config. Three corollaries:

   - **Leave `gitProtect` on for such a repo; do not add it to `exclude`.**
     Excluding unfreezes the superproject's `config` and `hooks` too, which is
     strictly worse. Partial protection beats none.
   - **devc never auto-detects submodules from `.gitmodules`.** That is an
     ordinary worktree file and is not frozen, so a rule that skipped protection
     for repos containing one would hand the container a one-command opt-out of
     the whole control. The only trustworthy signal is the host-authored
     `exclude` list.
   - **The residual is the human-push path only**, and it is the same risk you
     have today without any of this: an agent edits a submodule's config, and
     _you_ run git in it. Don't use submodules, or accept that.

2. **Changing repo config needs a container restart.** A single-file bind mount
   binds an _inode_, and `git config` on the host writes by rename — so a host
   edit to `.git/config` leaves the running container bound to the old,
   now-deleted inode. `devc build` to pick it up. (`findmnt` shows it: the
   source reads `…//deleted`. The identity mount used to do the same, which is
   why it now binds a directory — see [Git setup](#git-setup).)

3. **On macOS, `.git` gains a `deny delete` ACL.** Docker Desktop puts
   `user:<you> deny delete` on a bind-mount source nested inside another bind
   mount, which is exactly this shape — so `rm -rf <repo>` on the host starts
   failing with `Permission denied` on `.git`. Clear it with
   `chmod -N <repo>/.git` (or `chmod -RN <repo>`) first. Measured on Docker
   Desktop 29.7.2; a lone, un-nested mount source does not get one.

4. **Umbrella mounts are unsupported.** Mounting a folder _of_ repos
   (`source=~/code`) protects none of them — only a row's own `.git` is looked
   at. devc detects the shape from the folder's immediate children and warns on
   every start, naming the repos:

   ```
   devc: git protection does not cover repos inside /workspaces/code (from ~/code): app, lib — bind each repo as its own mount
   ```

   It warns rather than refuses, so an umbrella you mount on purpose keeps
   working. Bind each repo (and its `.worktrees` folder) as its own row instead,
   which is what `devc config` writes anyway. Unlike submodules, this is
   detected: it needs only a stat of each child, nothing read from inside a
   repo.

## Git setup

`~/.gitconfig` is container-local and wiped on every rebuild, while the working
tree and `.git` are host bind mounts. The
[`git-container-config`](https://github.com/devc-tools/devc-tools/tree/main/features/git-container-config)
Feature re-applies the user-scope settings git needs each create:

- **Your identity.** `initialize-command.sh` extracts `user.name` / `user.email`
  from the host into `~/.config/devc/git-identity/gitconfig`; that directory
  binds in read-only and the file is picked up via `include.path`. It is
  rewritten on every `devc up` of any project, and a running container sees
  the new file — so a host identity change reaches it without a restart. Only those two keys cross the
  boundary — binding the whole host `~/.gitconfig` would drag in host-absolute
  paths, credential helpers and signing config that do not work in here. A host
  with no identity configured is a warning at create time, not a failure.
- **LFS filters,** because the `git-lfs` feature installs them as root, where
  the `remoteUser` never sees them; without them every LFS asset shows as
  modified. Installed with `--skip-smudge`, so **LFS objects are not
  materialized on checkout** — run `git lfs pull`, or
  `git lfs checkout --
  <path>`, when you need the real bytes.
- **`worktree.useRelativePaths`,** so a `git worktree add` run in here does not
  write container-absolute paths into a `.git` the host also reads.
- **`safe.directory=*`,** since the workspace mount can present a foreign owner
  and git otherwise refuses to operate on it.

Projects whose `.devcontainer/` was written by an earlier `devc` carry their own
copy of `initialize-command.sh` and their own mounts — `devc` writes infra
mounts once at creation and never re-asserts them — so they either predate the
identity mount or still bind the **file** `~/.config/devc/gitconfig-identity`.
That older shape breaks in a running container the moment any other project
runs `devc up`: a single-file bind pins the inode the host then replaces, and
on a native Linux daemon the container is left with no identity at all. The
create hook warns about it (`the identity file is bind-mounted on its own`). To
migrate, copy the identity block of the current
[`initialize-command.sh`](../devc-core/default/initialize-command.sh) over your
project's, and use this mount line in place of any `gitconfig-identity` one:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/git-identity,target=/usr/local/share/devc-features/git-container-config/identity,consistency=cached,readonly",
```

Then `devc build`. Both halves are needed: the new mount's source directory is
created by the new script, and Docker fails a bind whose source is missing.
The old `~/.config/devc/gitconfig-identity` file is left alone, since projects
not yet migrated still mount it.

## devc-bridge: the opt-in Feature

[devc-bridge](../devc-bridge/README.md) lets a container run an allowlisted
command on the host. Its container half is a **devcontainer Feature**, and it is
**opt-in** — devc's bundled config does not reference it, and a devc container
comes up fine on a host that has never heard of the bridge. That is deliberate:
a Feature ref in the bundled default would make every `devc up` anywhere depend
on that ref resolving.

Opt in for **every project** (user level, `~/.config/devc/devc.json`) or for
**one project** (`.devc/devc.json`, or `.devcontainer/devc.jsonc`):

```jsonc
{
  "features": {
    "ghcr.io/devc-tools/features/devc-bridge:0": {}
  }
}
```

Project level wins per feature id. A project that does not use devc at all opts
in with the same reference in its own `devcontainer.json` `features` block.

The Feature installs the client: it downloads the arch-matched Linux binary from
the matching release, verifies it, and symlinks `/usr/local/bin/devc-bridge` at
it. Nothing is compiled in the container. devc then mounts the **host's**
installed client over that download when it can — see
[The client mount](#the-client-mount). See
[the Feature's README](../features/devc-bridge/README.md) for what the Feature
does and why.

### The token mount

The bridge also needs a token, which does have to cross as a bind mount — and it
must be **read-only**, or a container can pin a token for the next restart. devc
contributes that mount itself whenever anything opts into the Feature, in
**both** modes, and it is **per workspace**:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/keys/<key>,target=/run/devc-bridge,readonly"
```

`<key>` is the same `<basename>-<8 hex>` that names the project's cache
directory (and, with a `devc-` prefix, its container), so every workspace
folder — every worktree — has its own. devc creates `keys/<key>/` before
`devcontainer up`, empty; the bridge mints a token into it. `devc status` prints
the key.

A **Feature** cannot declare the mount — the Feature schema's `Mount` has no
`readonly` field, and the CLI re-serializes object mounts without one — so a
`devcontainer.json` `mounts` array is the only place a read-only bind can be
expressed. It reaches one because devc contributes it as the lowest layer of the
merge, and the merged config is written to devc's own cache. **devc still does
not write into a project's `.devcontainer/` — not here, not anywhere.** Under
`~/.config/devc-bridge/` it writes only `keys/<key>/` and `policy/<key>.conf`,
and it never runs `devc-bridge`: the two tools share that directory and the
policy line's format, and nothing else.

A project that does not use devc at all declares the reference and the shared
`run/` mount in its own `devcontainer.json`, exactly as before — see the
[bridge README](../devc-bridge/README.md#the-container-client). That container
gets the **shared** token: `caffeinate` and `ping` work, and nothing that needs
an identity does.

**The host bridge need not be installed first** any more: devc creates the
mount's source itself, so a devc container comes up on a host that has never
run `devc-bridge`, minus bridge commands (the client's error names the cause).
Start the bridge whenever you like — it mints into every key directory it finds,
including ones created while it runs, and running containers pick the token up
with nothing restarted.

**If you already wired the bridge yourself** — a `run` mount you wrote in
`devc.json` or copied into `devcontainer.json` — it still wins, because the
merge dedupes `mounts` by target and devc's contribution is the lowest layer.
It still works for `caffeinate`, but it is the shared token, so
`--bridge-allow` refuses that container. Delete the hand-written line and
`devc build` to move to the per-workspace mount. A `devc-post-create.sh` that
builds the client should still be removed before opting in, since the Feature
installs its own.

A container created by an older devc also still mounts all of `run/`, and gets
the shared token until it is recreated.

### The client mount

The installer puts the Linux container client in
`~/.config/devc-bridge/client/`, and devc bind-mounts that directory
**read-only** over the Feature's client directory in every bridge-enabled
container it starts, after the token mount:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/client,target=/usr/local/share/devc-bridge/client,readonly"
```

So a devc container runs the client that matches your host bridge, not the one
the image was built with, and developing the client is just
`deno task build:client` on the host: every devc container sees the new binary
live, with no image rebuild. The directory is mounted, not the file, because
both `build:client` and `install.sh` replace the binary by rename (a new inode a
file mount would never show); the Feature's `/usr/local/bin/devc-bridge` symlink
follows it.

The mount is contributed only when all of these hold, checked on the host at
merge time. The first one that fails is the reason `devc status` prints:

| Condition                                                               | Reason when it fails                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `bridgeClientMount` is not `false`                                      | `bridgeClientMount is false`                                 |
| Not a Docker Compose project (Compose drops `readonly`)                 | `Docker Compose project — readonly would be dropped`         |
| `~/.config/devc-bridge/client/devc-bridge` exists and is a regular file | `no host client at ~/.config/devc-bridge/client/devc-bridge` |
| It is a Linux ELF binary (a leftover placeholder is not)                | `host client is not a Linux binary`                          |
| Its ELF arch matches the host's (`x86_64` / `aarch64`)                  | `host client is <elf-arch>, host is <host-arch>`             |

When any fails, the container keeps the client the Feature downloaded. Only the
default directory is ever mounted: a client installed with
`DEVC_BRIDGE_CLIENT_DIR` pointing elsewhere is not. Non-devc consumers are
unaffected: they always run the Feature's downloaded client.

- **Opt out** with `"bridgeClientMount": false` in any `devc.json` overlay, then
  `devc build`. It is a pure opt-out: `true` does not bypass the other
  conditions.
- **Override** with a mount of your own on target
  `/usr/local/share/devc-bridge/client`. It wins through the `mounts` target
  dedupe, like any other devc contribution.
- `devc status` prints either
  `client:    host copy, mounted read-only (~/.config/devc-bridge/client)` or
  `client:    Feature's copy — <reason>`. Mounts are fixed when a container is
  created, so a container that existed before you installed the client says
  `— not in this container yet; run \`devc build\``.
- **Deleting the host client after a container was created with the mount**
  leaves `/usr/local/bin/devc-bridge` dangling in that container, because the
  mount hides the downloaded copy. Reinstall it, or `devc build` (the merge then
  skips the mount).

### Per-container identity and GitHub capabilities

**One container, one branch per pinned repo.** The token identifies the
container; `~/.config/devc-bridge/policy/<key>.conf` names each repo its
capabilities act on — the workspace repo, plus any you named with
`--bridge-repo` — with its remote and branch, and which capabilities it has. One
line per pinned repo, the workspace repo first when it is pinned, at most 16:

```text
<host path of the repo><TAB><remote.origin.url><TAB><branch><TAB><grants><TAB><container path>
```

`<grants>` is comma-separated in canonical order, e.g. `gh-push,gh-pr-read`,
and each line's own: a repo's capabilities are the ones its line grants. An
explicit `--bridge-allow` writes the same list on every line; the defaults
([below](#per-repo-defaults-bridgerepoallow)) may give each repo its own.
`<container path>` is where the repo is mounted in the container (absolute, no
trailing `/`); it is what the bridge commands' `--repo <path>` selects. That
file is the whole grant, and no container can write it — `policy/` is never
mounted. A three- or four-field file from an older devc grants nothing: the next
refresh removes it and says so, and `devc up --bridge-allow …` writes a new
one.

| Capability              | Lets the container run                                         |
| ----------------------- | -------------------------------------------------------------- |
| `gh-push`               | `gh-push`, `gh-doctor`                                         |
| `gh-pr-read`            | `gh-pr-comments`, `gh-pr-files` (read only)                    |
| `gh-pr-reply`           | `gh-pr-reply` (needs `gh-pr-read`)                             |
| `gh-pr-viewed`          | `gh-pr-viewed` (needs `gh-pr-read`)                            |
| `gh-pr-resolve`         | `gh-pr-resolve` on any thread (needs `gh-pr-read`)             |
| `gh-pr-resolve-copilot` | `gh-pr-resolve` on Copilot's threads only (needs `gh-pr-read`) |
| `gh-pr-request-review`  | `gh-pr-request-review` (needs `gh-pr-read`)                    |

`gh-pr-review` no longer exists: it was split into `gh-pr-read,gh-pr-reply`,
and an old `gh-pr-resolve` (Copilot-only then) is `gh-pr-resolve-copilot` now.
A policy holding the old name, or a PR write without `gh-pr-read`, is malformed:
the next refresh removes it, and `--bridge-allow gh-pr-review` is refused with
`gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead`. See
[devc-bridge § Migrating](../devc-bridge/README.md#migrating-from-gh-pr-review).

**`gh` and `gh-*` mean all of them.** In a `--bridge-allow` list, the exact
entries `gh` and `gh-*` each expand to every capability whose name starts with
`gh-` — today, all seven — and mix freely with explicit names. No other pattern
is accepted (`*`, `gh-pr-*` and `GH` are unknown capabilities). devc expands
them when it parses the flag, so the policy always stores the explicit list: a
capability a later release adds is **not** granted to an existing container
until you re-run `devc up --bridge-allow gh`, which matters when one spends
quota the way `gh-pr-request-review` does. Quote the starred form — zsh (the
macOS default) aborts an unquoted `gh-*` with `zsh: no matches found: gh-*`
before devc runs:

```sh
devc up --bridge-allow gh        # every gh- capability
devc up --bridge-allow 'gh-*'    # the same
```

Old names (`git-push`, `pr-review`, …) are unknown capabilities, and a policy
file holding one is malformed: the next refresh removes it and says so.

The bridge ships all of them and checks the grant on every call — see the
[bridge README](../devc-bridge/README.md#capabilities).

**Extra repos are pinned by name, never by discovery.** The workspace repo is
always tried. To let the same grant act on another repo the container mounts —
a `devc:source` sibling, say — name it on the same command:

```sh
devc up ~/code/tools/devc-dev --bridge-allow gh --bridge-repo ~/code/tools/devc-tools
```

- `--bridge-repo PATH` is accepted by `up` and `build` only, never with
  `--bridge-allow none` (`devc: --bridge-repo requires --bridge-allow with
  capabilities`, exit 2), and repeats, one path each, at most 15 times. Without
  `--bridge-allow` it takes the defaults — its repo's `bridgeRepoAllow` entry,
  else `bridgeDefaultAllow` — and with neither key set it is refused before
  anything starts (`devc: --bridge-repo requires --bridge-allow,
  "bridgeDefaultAllow" or "bridgeRepoAllow"`, exit 2). Both `--bridge-repo PATH` and
  `--bridge-repo=PATH` work; the same repo twice is a usage error.
- `PATH` is a **host** path, as you wrote it in `devc:source`: a leading `~` or
  `~/` expands to `$HOME` (devc does this, so `--bridge-repo=~/x` and a quoted
  `'~/x'` work too; `~user` does not expand), a relative path resolves against
  the current directory, and symlinks are resolved.
- It must name a **git-protected repo mount** of this workspace — a bind-mounted
  row whose `.git` is a directory and that git protection froze — or a **linked
  worktree** (below). devc refuses, and grants nothing, for a path that does not
  exist, the workspace repo itself (`this is the workspace repo, which devc
  always tries to pin`), and anything else — that message lists the repo mounts you can pin.
- A **linked worktree** (its `.git` is a file) has no config or hooks of its
  own: git uses its primary's, so it is as protected as that primary. It can be
  pinned — another worktree of the workspace's own repo too — when each of these
  holds, or devc names the one that does not:
  1. it is inside a bind mount, such as a `<repo>.worktrees` row (`a linked
     worktree that is not inside any bind mount of this workspace`);
  2. its `gitdir:` pointer is relative (`its .git uses an absolute gitdir:
     path, …` — run `git worktree repair --relative-paths`);
  3. that pointer leads to `<primary>/.git/worktrees/<name>`, which points back
     at it, in a primary whose git dir is git-protected here: an extra repo
     mount, or the workspace's own primary when the workspace is a worktree
     (`its .git points at <dir>, which is not the worktrees/ dir of a
     git-protected repo here`);
  4. from the worktree's container path, the same pointer reaches that
     primary's git dir in the container too (`its gitdir: pointer resolves to
     <path> inside the container, not <path>`) — mount `<repo>.worktrees` beside
     `<repo>` as `devc:source` does.

  It is pinned on its own branch, with the primary's frozen `origin`.
- Every pinned repo passes the same checks as the workspace repo (below). Two
  pinned repos on the same GitHub `<owner>/<name>` — two worktrees of one repo —
  are fine on different branches; they are refused on the same branch
  (`<PATH-a> and <PATH-b> both push branch <branch> to github.com/<owner>/<name>`)
  or through two different URLs for the repo (`… reach github.com/<owner>/<name>
  through different URLs (…)`).
- A repo whose config turns on `extensions.worktreeConfig` is never pinned,
  the workspace repo included: git would then also read a per-worktree
  `config.worktree`, which is not frozen. Unset it on the host to pin the repo.
- **Each repo on its own.** The grant considers the workspace repo, then each
  `--bridge-repo` in order, and pins each one that passes its own checks
  (below: a branch `HEAD`, one GitHub `origin`, protection in force). One that
  fails is skipped, and `up` says so before the grant lines:

  ```
  devc: --bridge-allow: not pinning the workspace repo: the repo has no remote.origin.url
  devc: devc-bridge capabilities granted: gh-push, gh-pr-read, gh-pr-reply, gh-pr-resolve-copilot, gh-pr-request-review
  devc:   /workspaces/extra: feat/x → git@github.com:acme/extra.git (/Users/me/code/extra)
  ```

  So a workspace that is not itself pushable — no `origin`, a local-path
  remote — can still grant its `--bridge-repo`s. These still fail the whole
  grant (no policy is written, any earlier one is removed):
  - **no repo passing.** Without `--bridge-repo` that is the workspace repo's
    own reason, as before; with it, `no repo can be pinned — the workspace
    repo: <reason>; <PATH>: <reason>; …`;
  - a **container-wide** check (1, 2 and the key-directory half of 5 below);
  - a `--bridge-repo` that names **nothing pinnable** (the refusals above —
    a typo is never silently dropped);
  - two pinned repos that **conflict** on one GitHub repo (above).

| Command                                              | With `--bridge-allow LIST [--bridge-repo PATH]...`                      | Without it                                                                                                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `up`, `build`                                        | write the policy with exactly LIST and the repos that pass (no merging) | grant the defaults when `bridgeDefaultAllow` or `bridgeRepoAllow` is set ([below](#a-default-grant-bridgedefaultallow)); otherwise, and with `--bridge-allow none`, **delete** this workspace's policy |
| `attach`, `claude`, `copilot`, `pi`, `herdr`, `exec` | refused — not accepted                                                  | re-check an existing policy; revoke it if any pinned repo's repo, origin or branch changed                                                                                                             |

Both are **flags, deliberately not devc config keys**: every `devc.jsonc` layer
with the priority to set them lives inside the bind-mounted workspace, where an
agent could grant itself the capability, or widen it to another repo, before
your next `up`. A flag is typed per invocation and never persisted.

#### A default grant (`bridgeDefaultAllow`)

To stop typing the same grant on every `up`, name it once in the
[global config](#the-global-config), `~/.config/devc/config.jsonc` (or
`config.json`):

```jsonc
{
  // Every container I `devc up` may read PRs and mark files Viewed.
  "bridgeDefaultAllow": ["gh-pr-read", "gh-pr-viewed"]
}
```

or, for an agent's review loop on every container:

```jsonc
{
  // Push, read, reply, resolve Copilot's threads, and re-request its review.
  "bridgeDefaultAllow": [
    "gh-push",
    "gh-pr-read",
    "gh-pr-reply",
    "gh-pr-resolve-copilot",
    "gh-pr-request-review"
  ]
}
```

`devc up` and `devc build` grant that list whenever `--bridge-allow` is not
given — to the workspace repo and each `--bridge-repo`, unless its repo has a
[`bridgeRepoAllow`](#per-repo-defaults-bridgerepoallow) entry; the flag still
replaces it, and `--bridge-allow none` grants nothing.
Every other start path — `attach`, `herdr`, devc web's **Start container**, the
TUI — still only re-checks an existing policy and never creates one.

- **Only this file.** The key is never read from `devc.jsonc` or any repo
  overlay. No container mounts `config.jsonc` or `config.json` (devc mounts only
  `~/.config/devc/.claude`, `shell/` and `git-identity/`), and only `devc config`
  writes it — keeping it verbatim. **devc web never writes it**, and must not:
  an agent can drive devc web's page.
- **`gh` and `gh-*` mean all of them**, as on the flag, here and in
  `bridgeRepoAllow`. Unlike the flag, the config is expanded again on **every**
  `up`, so a `gh-*` capability a later release adds is granted at the next `up`
  without your editing anything. List names instead to keep a fixed set.
  Entries are trimmed, duplicates dropped, and the list put in canonical order;
  absent, `null` or `[]` is no default.
- **Any capability can be a default — your call.** A write capability in it
  (`gh-push`, `gh-pr-reply`, `gh-pr-viewed`, `gh-pr-resolve`,
  `gh-pr-resolve-copilot`, `gh-pr-request-review`) is granted to **every** container you `devc up`,
  on whatever branch it has checked out. The read tier (`gh-pr-read`, plus
  `gh-pr-viewed`, which only marks files Viewed for you) is what devc web needs
  to show a PR.
- **It never fails the start for a repo's preconditions.** A value that is not
  valid exits 2 before anything starts, as `devc: ~/.config/devc/config.jsonc:
  bridgeDefaultAllow: <reason>` (naming the file in use) (`must be an array of capability names`, `unknown capability <name> —
  valid: …`, `gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead`,
  or `<cap> requires <needed>`). A repo that cannot be pinned — no GitHub
  origin, a detached `HEAD`, protection not in force — is skipped with
  `devc: defaults: not pinning <repo>: <reason>`; a container-wide failure (git
  protection off, the token mount) removes any earlier policy and logs
  `devc: defaults: not granted: <reason>`; either way the start succeeds. When
  nothing at all is pinned, any earlier policy is removed. A workspace without
  the devc-bridge Feature gets no line at all. When it pins, `up` logs the skips,
  then one line per pinned repo with its own grants:

  ```
  devc: devc-bridge capabilities granted (defaults):
  devc:   /workspaces/app: feat/x → git@github.com:acme/app.git (/Users/me/code/app): gh-pr-read
  devc:   /workspaces/shared-lib: main → git@github.com:acme/shared-lib.git (/Users/me/code/shared-lib): gh-pr-read, gh-pr-reply
  ```

  A `--bridge-repo` typo (or anything else that names nothing pinnable) still
  fails the command, before `up` and after.
- The policy file does not record whether a grant came from the flag or the
  default.

#### Per-repo defaults (`bridgeRepoAllow`)

`bridgeDefaultAllow` is one list for every container. To trust one repo more —
or less — than the rest, map it to its own list:

```json
{
  "bridgeDefaultAllow": ["gh-pr-read"],
  "bridgeRepoAllow": {
    "~/code/shared-lib": ["gh-pr-read", "gh-pr-reply"],
    "~/code/secrets": []
  }
}
```

- **A key names a repo, not a checkout.** Any host path of one of its checkouts
  works (`~` and `$VAR` expand); devc resolves it to the repo's git common dir,
  so the entry applies to the primary checkout and every linked worktree of it.
  `[]` means "no default for this repo" — not even `bridgeDefaultAllow`. There
  is no per-worktree entry: use the flags for that.
- **One key can list several repos**, separated by `;`, to give them all the
  same list: `"~/code/app; ~/code/app-docs": ["gh-pr-read", "gh-pr-reply"]`.
  Spaces around each path are dropped. Each path is resolved, ignored or
  refused on its own, and messages name the one path they are about. A path
  that itself contains `;` can't be written as a key.
- **Who gets what**, without `--bridge-allow`: the workspace repo, then each
  `--bridge-repo` in order, then every other git-protected repo mount of the
  workspace whose repo has a **non-empty** entry — pinned without being named.
  Each gets its repo's entry, else `bridgeDefaultAllow`, else nothing; a repo
  with nothing is not pinned (silently for the workspace; a `--bridge-repo`
  logs `devc: not pinning <PATH>: no default grants for it — pass
  --bridge-allow`). Then, for each such repo, every linked worktree of it
  that sits inside a bind mount of the workspace — a `<repo>.worktrees`
  mirror, say — gets the same entry, also unnamed; a worktree that fails a
  check is skipped with `devc: defaults: not pinning <path>: <reason>`. A
  worktree created after `up` is pinned at the next `up`. Past 16 pins, the rest are skipped with `devc: defaults:
  not pinning <repo>: a policy pins at most 16 repos`. Two pins that conflict on
  one GitHub repo fail the command when a `--bridge-repo` was given, and are
  logged as `devc: defaults: not granted: <reason>` otherwise.
- **With `--bridge-allow`, only the flags count.** Every pin gets the LIST and
  neither key is read — so a flagged `up` drops the mapped repos' pins until the
  next unflagged `up`, since every `up` rewrites the whole policy.
- **The entry follows the frozen config.** A pin's repo is the one whose frozen
  `config` its remote is read from — the host source of the container's
  read-only `config` mount — never a container-writable `.git` file or
  `commondir`, so an agent cannot repoint a worktree at a repo whose entry
  grants more.
- **Nothing checks who wrote a repo's `.git/config`.** The remote is read from
  the repo's own config on the host. A repo the agent created and got mounted —
  a sibling it cloned, say, then named by `--bridge-repo` or added to
  `bridgeRepoAllow` — carries a remote the agent chose. Map and name only repos
  you made.
- **When it is invalid** — not an object, a key that is not absolute after
  expansion, an unset `$VAR`, a value that is not an array of capability
  names, a bad capability (`bridgeDefaultAllow`'s reasons), or two keys naming
  one repo — `up`/`build` exit 2 before anything starts, as
  `devc: ~/.config/devc/config.jsonc: bridgeRepoAllow: <key>: <reason>`, naming
  the file in use (or
  `<key1> and <key2> name the same repo`). A key whose folder is gone, or is not
  in a git repo, is ignored with `devc: bridgeRepoAllow: ignoring <key>:
  <reason>`: the list is global, and repos move. Like `bridgeDefaultAllow` it is
  read only by `up`/`build` without the flag, only from this file, and the
  config wizard keeps it verbatim.

Before writing (or refreshing) a policy devc checks the following — 1, 2 and
the key-directory half of 5 once for the container, first, failing the grant;
the rest for every candidate repo, where a failure skips that repo (see above):

1. a `devc-bridge` Feature is declared;
2. `gitProtect` is not off;
3. the repo is a bind-mounted repo whose `HEAD` names a branch (a detached
   `HEAD` fails) and whose config has exactly one `remote.origin.url` (none,
   two, or any `[include]` fails);
4. that `remote.origin.url` is a github.com remote — `git@github.com:<owner>/<name>`,
   `ssh://git@github.com/<owner>/<name>` or `https://github.com/<owner>/<name>`
   (optionally `.git`, and `github.com-<alias>` for an ssh host alias), refused
   as `origin <url> is not a github.com remote`. Every capability acts through
   the host's `gh` login, so a local-path or other-host remote cannot be granted;
5. **the running container** has that repo's `.git/config` and `.git/hooks`
   mounted read-only, and its own `keys/<key>/` at `/run/devc-bridge`.

The last one is checked against the container's live mount table, not against
the `gitProtect` setting: `devc up` reuses an existing container, whose mounts
were fixed when it was created, and the setting can be edited from inside the
workspace. The remote URL is read from the host file behind the container's read-only
`config` mount — the one actually frozen — so it is trustworthy. For a **linked
worktree** that is the primary repo's git dir, as the devcontainer CLI mounts
it; a worktree with an absolute `gitdir:` (which the CLI does not mount) is
refused.

devc reads `HEAD`, the worktree `gitdir:` pointer and the remote as **files**;
it never runs `git` in the repo, since `git -C <repo>` on the host fires a
planted `core.fsmonitor`.

**Refresh** re-checks an existing policy on each `attach`/`claude`/… and never
rewrites it. `HEAD` is writable from inside the container, so a pin that
followed it would let an agent choose the branch it publishes to. Every line is
re-derived — the line at the workspace's container path as the workspace repo,
any other by finding its mount again at the stored host path and container path.
A grant that skipped the workspace repo has no line for it, and refresh never
adds one: re-run `devc up --bridge-allow …` once the workspace is pushable. Lines
with different grants are re-derived the same way; their hint is a plain
`devc up`, which re-applies the defaults. When any pin derived now differs from the stored one — the
workspace repo, the origin or the branch changed — or can no longer be derived
at all — a detached `HEAD`, protection gone, an origin that stopped being
GitHub, the mount gone, a malformed file — the refresh **removes** the whole
policy and says so:

```
devc: devc-bridge capabilities revoked — the branch is now feat/next, but they were granted for feat/x. Run `devc up --bridge-allow gh-push,gh-pr-read` to grant it.
```

With more than one repo pinned, the message starts with the repo's host path; the
hint carries `--bridge-repo …` whenever an extra repo is pinned:

```
devc: devc-bridge capabilities revoked — /Users/me/code/tools/devc-tools: the branch is now main, but they were granted for feat/x. Run `devc up --bridge-allow gh --bridge-repo …` to grant it.
```

To publish another branch, check it out on the host and run
`devc up --bridge-allow …` again; `up` reuses the running container. An
unchanged pin is left exactly as it is, with nothing logged.

**Revocation needs no restart.** The policy is read per request, not cached, so
removing the file stops the next call from a running container. That is also a
panic button that involves no devc at all:

```sh
rm ~/.config/devc-bridge/policy/<key>.conf
```

This is **bearer** identity, not attestation: a process that obtained another
container's token could act as that container. Each container mounts only its
own key directory, so there is no ambient channel between them — but that is
the whole of the guarantee.

`devc down` removes the workspace's `keys/<key>/` and policy; `devc prune`
removes the ones that leaked. `devc status` reports the key, whether its token
is present, and the pins in force — `absent` when there are none. A grant logs,
and `devc status` shows, the capabilities and then one line per pinned repo:

```
devc: devc-bridge capabilities granted: gh-push, gh-pr-read, gh-pr-reply, gh-pr-resolve-copilot, gh-pr-request-review
devc:   /workspaces/devc-dev: feat/x → git@github.com:acme/devc-dev.git (/Users/me/code/tools/devc-dev)
devc:   /workspaces/tools/devc-tools: feat/y → git@github.com:acme/devc-tools.git (/Users/me/code/tools/devc-tools)
```

When the lines hold different grants, `devc status` has no single grants line;
each repo line ends with its own:

```
bridge:
  /workspaces/app: feat/x → git@github.com:acme/app.git (/Users/me/code/app): gh-pr-read
  /workspaces/shared-lib: main → git@github.com:acme/shared-lib.git (/Users/me/code/shared-lib): gh-pr-read, gh-pr-reply
```

On **Docker Compose** devcontainers the CLI drops `readonly` when it rewrites
mounts into the generated compose file, so the token mount ends up writable
whichever way it is declared. The bridge is hardened against that — it
regenerates the token on every start and never writes through a symlink — so this
is a caveat, not an exclusion.

## Development

Requires Deno 2.9+. This is the from-a-clone path; users install the prebuilt
binary instead (see [Install](#install)).

```sh
deno task run    -- <command> [args]   # run from source
deno task test                         # unit tests
deno task check                        # type-check
deno task build                        # compile the `devc` binary (embeds ../devc-core/default)

# `--version` on a non-release build appends its `git describe` distance from the release tag:
#   devc 0.3.0+6.g0222e50.dirty (source)   from `deno task run`
#   devc 0.3.0+6.g0222e50 (local build)    from `deno task build`

# What the release workflow calls: same flags, cross-compiled, into the repo-root dist/.
DEVC_TARGET=aarch64-apple-darwin deno task build:release

# The lifecycle logic devc compiles from — startContainer, the devc.json overlay, the config
# wizard's pure helpers — lives in the sibling `devc-core/` package (see its own README and
# .plans/archived/devc-core-npm-library.md), checked and tested the same way:
cd ../devc-core && deno task check && deno task test

# The devc-core baseline no longer has any bash scripts of its own — agents-setup.sh,
# git-setup.sh and bashrc-additions.sh all retired onto Features (agents,
# git-container-config, devc-config). What is left is covered by shell harnesses rather than
# `deno task test`. Each extracts a fenced block from the real script and runs it against temp
# dirs, so the tests cannot drift from the implementation:

# shell_dirs_test.sh takes the script path so it can run against the shell-dirs Feature's
# devc:shell-dirs block (devc's own copy is gone, per copy-don't-move having nothing left to
# copy from):
bash tests/shell_dirs_test.sh ../features/shell-dirs/install.sh             # devc:shell-dirs

# devc no longer carries its own copy of the devc-config block — devc contributes the
# devc-config Feature to every container it starts instead (see devc-core/overlay.ts's
# DEVC_CONFIG_FEATURE and devcContributions), so this is the only copy left to test:
bash tests/devc_config_test.sh ../features/devc-config/post-create.sh       # devc:devc-config

# devc's own scripts/bashrc-additions.sh is gone too — its content moved into devc-config's
# post-create.sh as a second fence, run right after the one above:
bash tests/bashrc_additions_test.sh ../features/devc-config/post-create.sh  # devc:bashrc-additions

# seed_link_test.sh takes the script path too — devc's own agents-setup.sh is gone, so the
# agents Feature's post-create.sh is the only copy left to test:
bash tests/seed_link_test.sh ../features/agents/post-create.sh         # devc:seed-link

# The seed fence is wrapped by the agents Feature's claudeSeed guard, and the cleanup that
# runs whether or not the guard is true sits outside it — that half has its own harness:
bash ../features/agents/test/post_create_test.sh       # devc:seed-cleanup + the guard

# The bridge's PATH symlink is no longer devc's — it lives in the devc-bridge Feature:
bash ../features/devc-bridge/test/install_link_test.sh   # devc:bridge-client-link

# The release installer has its own harness at the repo root (offline, no network):
bash ../tests/install_test.sh ../install.sh
```

`deno task test` spawns the runtime: `tests/devcontainer_cli_test.ts` runs the
[embedded devcontainer CLI](#the-embedded-devcontainer-cli) for real — a
`--version` and an `up` against a Docker path that cannot exist — because
nothing else would notice if the pin, the argv shim or the embedding broke. It
needs no Docker, and on a cold cache it fetches the pinned npm package like any
other dependency.

### `devc config`

`devc config [PATH]` is a picker-driven flow for the project's
[`devc.json` overlay](#optional-overlay-devcjson). You _select_ folders — no
typing paths:

- **Source folders** and **skills folders** are each chosen with a multi-select,
  type-to-filter picker: `↑/↓` move, `→` open a folder, `←` (or backspace on an
  empty filter) go up, `space` ticks/unticks (selection persists across
  folders), `⏎` confirms, `esc` cancels. Type any characters to filter the
  current folder.
- Each picker screen (see `.plans/design/wizard/` for the reference frames) is a
  banner naming the screen — `WORKSPACE CONFIG` or `GLOBAL CONFIG` — over two
  labelled lists: what is picked so far (`Source Folders`, `Skills`,
  `Source Folder Roots`, `Skills Folder Roots`) and the browser you add from
  (`Add Source Folders`, `Add Skills`, `Add Roots`), with the key legend under a
  rule at the foot.
- The **project folder is pinned** in the source picker (`◎` — a `◉` you cannot
  untick — labelled "this project (always mounted)"): the dev container binds it
  on its own, so it heads the picked list and picking nothing still mounts it.
  It also appears in the review, above the `devc:source` rows.
- Markers: `◯` not picked · `◉` picked · `◎` mounted regardless (the project
  folder, or a mount another pick drags in — such as a picked worktree's primary
  repo `.git`).
- Your configured roots are **shortcuts, not boundaries**: the picker opens on
  the list of roots, but `←` walks above a root like any other folder, and at
  the filesystem root it wraps back to the shortcut list — so you can mount a
  folder from anywhere on the machine. The roots themselves aren't selectable;
  tick one from its parent folder.
- A **review** summary then a single `Apply?` confirm writes the two managed
  mount blocks (`devc:source`, `devc:skills`); everything else in the file —
  hand-written mounts, `features`, `remoteEnv`, comments — is left untouched.
- Afterwards, `devc config` compares what it wrote to what was already on disk
  and only then offers a rebuild, since mounts take effect at container-create
  time:
  - **Changed**, container exists → `Rebuild now? [Y/n]`, which runs the same
    recreate as `devc build`.
  - **Changed**, no container yet → `Build it now? [Y/n]`.
  - **Unchanged** → `No config changes — no rebuild needed.` and no prompt.
    Ticking a folder off and back on ends at the same bytes, so it counts as no
    change and the file is not even rewritten. Declining a rebuild prints a
    reminder to run `devc build` later.

**Roots** (where the pickers are scoped) live in the
[global config](#the-global-config), stored folded to `~/…`. On first run — or
any time roots are missing — `devc config` collects them first with a
free-navigation picker. Run **`devc config --global`** to reconfigure them at
any time.

#### The global config

devc's own settings — the roots above, and `bridgeDefaultAllow`,
`bridgeRepoAllow`, `webSource`, `jira` (devc web's
[Open in Jira](#devc-web-browser-ui-for-in-container-herdr)), devc-desktop's
`desktopWebArgs` and `desktopDevc` — live in one host-only file that no container mounts:
`~/.config/devc/config.json`, which the first run creates, or
**`~/.config/devc/config.jsonc`**. Rename it to `config.jsonc` to keep comments
(`//`, `/* */`) and trailing commas in it:

- **`config.jsonc` wins.** When it exists it is the config and `config.json` is
  ignored — the two are never merged — with one notice:
  `devc: ~/.config/devc/config.json is ignored because ~/.config/devc/config.jsonc exists`.
- **Saves keep your edits.** `devc config` changes only the arrays it owns
  (`codeRoots`, `skillsRoots`, `recentSkills`) and only when their values
  change; every other byte of a `config.jsonc` — comments, formatting, the keys
  devc does not know — stays exactly as you wrote it. A `config.json` is
  rewritten as pretty JSON, its unknown keys kept.
- **A file that does not parse** loads as empty, with
  `devc: <file>: not valid JSONC (<reason>), ignored`, so a typo never drops
  every key silently. Messages about a key name the file in use.

#### Which file it writes

Extra bind mounts are **machine-specific**: another checkout of the same repo
will not have your sibling repos at the same host paths, so the mount cannot be
committed and be correct for anyone else. That is why they go in the overlay and
not in `devcontainer.json`.

`devc config` **never writes `.devcontainer/`** — not the config, not the
scaffold. Creating `.devcontainer/` is `devc init`'s job, so recording one mount
on a zero-config project does not saddle it with a `Dockerfile` and lifecycle
scripts to maintain. The target is picked like this:

```text
an existing overlay, in the usual first-hit order   → written in place
  .devc/devc.jsonc · .devc/devc.json
  .devcontainer/devc.jsonc · .devcontainer/devc.json
otherwise, the project has a .devcontainer/         → .devcontainer/devc.jsonc
otherwise                                           → .devc/devc.jsonc
```

An existing overlay always wins, and a second one is never created beside it —
only the first hit is ever read, so the loser would silently do nothing.

**`devc config --repo`** writes the [repo overlay](#repo-overlay-one-file-for-every-worktree)
instead — `~/.config/devc/repos/<key>/devc.jsonc`, created on first use — and
nothing in the checkout. The wizard is the same; its header names the repo, the
rebuild offer covers the current checkout only, and a changed overlay ends with
a reminder that other checkouts pick it up on their next `devc build`. Outside a
git repository it exits 1 and writes nothing.

Upgrading from a `devc` that wrote fences into `devcontainer.json`: **delete the
`devc:source` and `devc:skills` blocks there by hand**, then run `devc config`.
There is no automatic migration. Left in place, those mounts are applied
_as well as_ the overlay's — same target fails container creation with Docker's
`Duplicate mount point`, a different target just mounts the folder twice.
