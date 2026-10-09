# `headless-vscode` Feature — Electron runtime libraries plus a headless VS Code launcher

> **Not ready to implement until every decision in [Decisions to resolve](#decisions-to-resolve)
> is answered.** An implementing agent's **first** action is the first Checklist item: ask the
> user. Do not start any later item that a still-open decision blocks.

Replaces the earlier `feature-electron-deps` placeholder (this file was renamed from it). The
name is settled: **`headless-vscode`**. The Electron libraries live in this Feature, not in a
separate `electron-deps` Feature. Split them out only if a second Electron application needs
them.

## Checklist

- [ ] **Resolve the decisions.** Use `AskUserQuestion` for D1–D9 below, at most 4 questions per
      call, so 3 calls. Put each decision's **Recommended** option first, labelled
      `(Recommended)`, and put the alternatives listed under it after that. Record each answer in
      this file: replace that decision's `**Status:** open` line with
      `**Decided (YYYY-MM-DD):** <answer>`, then edit every contract section the decision feeds
      (named under its **Feeds**) so that section states the single chosen behavior. If the user
      defers a decision, leave it `open`, tell the user which Checklist items it blocks, and stop
      before the first blocked item.
- [ ] `features/headless-vscode/devcontainer-feature.json`, per [Manifest](#manifest)
- [ ] `features/headless-vscode/install.sh`, per [install.sh](#installsh)
- [ ] The launcher `features/headless-vscode/headless-vscode`, per [The launcher](#the-launcher)
      (command name per D1)
- [ ] `features/headless-vscode/README.md`, per [README contents](#readme-contents)
- [ ] Offline tests: `test/install_options_test.sh` and `test/launcher_test.sh`, per
      [Tests](#tests)
- [ ] Docker scenarios: `test/test.sh`, `test/scenarios.json` plus one script per scenario, and
      `test/run-features-test.sh` (copied from `features/xvfb/test/`), per [Tests](#tests)
- [ ] `features/README.md`: add a row for `headless-vscode`
- [ ] `features/CONTRIBUTING.md`: a testing paragraph for `headless-vscode` (beside the `xvfb`
      one) and a `### headless-vscode` per-feature note (dependsOn dedupe, seed-once settings,
      `--no-sandbox`)
- [ ] `xvfb` follow-ups, per D9
- [ ] Run all of [Validation](#validation). Docker scenarios included.
- [ ] Add `headless-vscode` to `features/PUBLISH_ALLOWLIST.txt`, **only after** the Docker
      scenarios have passed
- [ ] Run `deno fmt` on every touched `.md` and `.json` file (the repo's commit gate)

## Decisions to resolve

Each decision: the question, the recommended answer, the alternatives, and the contract sections
it feeds. The facts behind the recommendations are in
[Verified facts](#verified-facts-2026-10-09).

### D1. Launcher command name

**Status:** open\
**Recommended:** `headless-vscode`, the same as the Feature id. This follows `xvfb`, which ships
`xvfb-ensure` under its own prefix. Environment variables use the prefix `HEADLESS_VSCODE_`.\
**Alternatives:** `vscode-headless`; `code-headless`.\
**Feeds:** every mention of the command and the `HEADLESS_VSCODE_` prefix in this file. If the
answer is not the recommendation, change all of them.

### D2. How the profile's `settings.json` is written

The file is `<stateDir>/user-data/User/settings.json`, the isolated profile's user settings. It
can be changed in three ways: by hand, by VS Code's Settings UI (an agent can drive it over
CDP), or by the launcher. VS Code writes it as JSONC.

**Status:** open\
**Recommended:** **seed once.** If the file is missing, write the built-in defaults merged with
the project's seed file (D6), as plain JSON. If the file exists, never touch it.
`start --reseed` deletes it first. Per-run values, such as a server URL, are the project
wrapper's job; the wrapper may use its own `jsonc-parser`. The launcher needs no JSONC parser.\
**Alternatives:** (a) rewrite the file from defaults plus the seed file on every start. Simple,
but it discards changes made through the Settings UI. (b) Merge on every start while preserving
JSONC. That needs a vendored `jsonc-parser`, installed at build time with `npm`, so the Feature
would need `installsAfter` node.\
**Feeds:** [Settings](#settings).

### D3. Options passed to `xvfb` through `dependsOn`

The devcontainer CLI (0.88.0, verified in source) installs a Feature once only when the ref
**and the options** are identical. Different options produce two installs of `xvfb`: `install.sh`
runs twice and the last run's baked `display`/`screen` wins.

**Status:** open\
**Recommended:** `dependsOn` `{"ghcr.io/devc-tools/features/xvfb:0": {}}`, and this Feature
installs `imagemagick` and `xdotool` itself. A project that declares `"xvfb": {}` then gets a
single install. Only a project that declares `xvfb` with non-default options gets two installs,
and the README says so.\
**Alternatives:** (a) `dependsOn` with `{"tools": true}`. Nothing is duplicated, but every
project that declares `xvfb` itself gets two installs. (b) `installsAfter` `xvfb` only, with the
project adding `xvfb` by hand. One install always, but the Feature is no longer a one-line
addition.\
**Feeds:** [Manifest](#manifest), [install.sh](#installsh), the `with_xvfb_declared` scenario.

### D4. Where the downloaded VS Code (~350 MB) lives

**Status:** open\
**Recommended:** a named volume that the Feature declares:
`{"type": "volume", "source": "devc-${devcontainerId}-headless-vscode-cache", "target": "/var/cache/headless-vscode"}`.
`install.sh` creates `/var/cache/headless-vscode` with mode `1777`. Docker (and Podman, which
does the same by default) copies the image directory's mode into a new empty named volume, so
the remote user can write to it without a chown hook. A scenario must verify this. It survives
rebuilds. The profile (`user-data`, `extensions`) stays in the state directory, so a rebuild
still resets it.\
**Alternatives:** (a) keep it under the state directory in `$HOME`, so every rebuild downloads
it again. (b) reuse the project's `.vscode-test/` download cache, which ties the launcher to
`@vscode/test-electron`'s folder layout.\
**Feeds:** [Manifest](#manifest), [install.sh](#installsh), [Getting VS Code](#getting-vs-code).

### D5. Build step before launch

**Status:** open\
**Recommended:** `--build <cmd>` / `HEADLESS_VSCODE_BUILD`, default `npm run compile`. An empty
value skips the build. The command runs in the extension folder through `bash -c`. Before it
runs: if `package-lock.json` exists and `node_modules/.package-lock.json` is missing or not
newer than it, run `npm i` first.\
**Alternatives:** (a) no build step; the project builds before calling `start`. (b) the build
command only, without the `npm i` staleness check.\
**Feeds:** [start](#start).

### D6. What the project controls, and how

**Status:** open\
**Recommended:** flags, each with an environment variable as a fallback (the flag wins). No
config file and no build-time Feature options in 0.1.0.

| Flag                          | Env var                         | Default                                                                           |
| ----------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `--extension <dir>`           | `HEADLESS_VSCODE_EXTENSION`     | nearest folder at or above `$PWD` with a `package.json` that has `engines.vscode` |
| `[WORKSPACE]` (positional)    | `HEADLESS_VSCODE_WORKSPACE`     | the extension folder                                                              |
| `--cdp-port <n>`              | `HEADLESS_VSCODE_CDP_PORT`      | `9222`                                                                            |
| `--state-dir <dir>`           | `HEADLESS_VSCODE_HOME`          | `~/.headless-vscode`                                                              |
| `--seed-settings <file.json>` | `HEADLESS_VSCODE_SEED_SETTINGS` | none                                                                              |
| `--version <latest\|x.y.z>`   | `HEADLESS_VSCODE_VERSION`       | `latest`                                                                          |
| `--quality <stable\|insider>` | `HEADLESS_VSCODE_QUALITY`       | `stable`                                                                          |
| `-- <args…>`                  | `HEADLESS_VSCODE_EXTRA_ARGS`    | none; extra VS Code arguments, appended last                                      |

**Alternatives:** (a) also read a project config file such as `.headless-vscode.json`; (b) make
some of these Feature options baked at build time, the way `xvfb` bakes `display`.\
**Feeds:** [The launcher](#the-launcher), [Settings](#settings), [Getting VS Code](#getting-vs-code).

### D7. `status` output and finding the extension's MCP server

**Status:** open\
**Recommended:** `status` prints one JSON object on stdout:
`{"running":bool,"pid":int|null,"display":str|null,"cdpEndpoint":str|null,"extensionPath":str|null,"workspace":str|null,"log":str}`.
`start` and `status` accept an optional `--mcp-name <serverName>`. When it is given, the
launcher looks at each listening TCP port owned by VS Code's process tree, skipping the CDP
port. It POSTs a JSON-RPC `initialize` to `http://localhost:<port>/mcp` and matches
`result.serverInfo.name`. The result is added as `"mcpUrl"`, or `null` if nothing matches.
`start --mcp-name` waits up to 30 s for the server; if it times out, it logs `INFO` and still
exits 0. This generalizes vscode-deephaven's lookup, which hardcodes
`Deephaven VS Code MCP Server`.\
**Alternatives:** (a) no MCP lookup; projects do it themselves. (b) report every listening port
in the process tree and let the project probe them.\
**Feeds:** [status](#status), [start](#start). With the recommended option, the Feature installs
`iproute2` (for `ss`).

### D8. Detecting drift against new VS Code / Electron releases

No CI workflow runs Feature scenarios today; only `test-podman-as-docker.yml` exists.

**Status:** open\
**Recommended:** a `vscode_launch` scenario in `scenarios.json`. It downloads the latest stable
VS Code, so drift shows up whenever the scenarios run. Scenarios run on demand through
`run-features-test.sh`, as for every other Feature. No new workflow.\
**Alternatives:** (a) also add a weekly scheduled workflow that runs this Feature's scenarios;
(b) pin a VS Code version in the scenario, which makes it reproducible but blind to drift.\
**Feeds:** [Tests](#tests); if (a) is chosen, `.github/workflows/test-headless-vscode.yml` joins
Relevant Files.

### D9. What changes outside this Feature

**Status:** open\
**Recommended, all in this plan:**

- In `features/xvfb/README.md`, replace the body of the "VS Code extension tests" recipe with a
  pointer to `headless-vscode`. Update the `extraPackages` description in
  `devcontainer-feature.json`, which mentions the README's list, and the comment in `install.sh`
  that mentions the README's VS Code recipe. Bump `xvfb` to `0.1.1`.
- Case 6 of `features/xvfb/test/install_options_test.sh` currently reads the Electron list out
  of the `xvfb` README. Change it to an inline list, so `xvfb`'s `t64` tests stay
  self-contained. The `debian` scenario keeps its inline list unchanged.
- In `features/CONTRIBUTING.md`, change the `xvfb` note "Electron's runtime list … is a README
  `extraPackages` recipe" so it says the list belongs to `headless-vscode`.

**Out of scope, for the user to do:** move `devc-vscode` from `xvfb.extraPackages` to
`"headless-vscode": {}`. Its `xvfb` declaration is not in that repo, so ask the user where it
lives (probably the devc global config). Turn vscode-deephaven's `vscode-dev.sh` into a thin
wrapper; that repo is mounted read-only here.\
**Alternatives:** (a) leave `xvfb` untouched for now and keep both recipes; (b) do the xvfb
change as a separate plan.\
**Feeds:** Relevant Files (the `xvfb` rows), [Validation](#validation) V-9.

## Settled (from the 2026-10-09 discussion)

- **Name:** `headless-vscode`. Directory `features/headless-vscode/`, version `0.1.0`.
- **Scope:** Electron's runtime libraries; `dependsOn` `xvfb`; a launcher that downloads and
  runs a real VS Code against an extension under development, with a CDP port. VS Code is
  **not** installed at build time.
- **No `DISPLAY` and no `containerEnv`**, for the same reason as `xvfb` (see that Feature's
  CONTRIBUTING note). The launcher gets a display from `xvfb-ensure` on each start.
- **No lifecycle hooks:** no `postCreateCommand` and no `postStartCommand`.
- **chrome-devtools-mcp registration belongs to the consuming project**, not the Feature. The
  README carries the recipe for three cases:
  - a project with its own `.devcontainer/`: put it in its post-create script;
  - a devc zero-config project: put it in `.devc/devc-post-create.sh`, which the `devc-config`
    Feature runs (see `features/devc-config/README.md`);
  - any other project: put it in its `postCreateCommand`.

  The `--browserUrl` port must equal the launcher's CDP port.
- **Deephaven-specific behavior stays in vscode-deephaven:** `DH_SERVER_URL` →
  `deephaven.coreServers`, `deephaven.mcp.enabled`, the default workspace `e2e-testing/test-ws`,
  `DH_E2E_HEADLESS`, the `host.docker.internal` run argument.

## Verified facts (2026-10-09)

- **`xvfb` is published:** `ghcr.io/devc-tools/features/xvfb` has tags `0`, `0.1`, `0.1.0` and
  `latest`. So `dependsOn` can be tested as it will ship.
- **How `dependsOn` dedupes** (`@devcontainers/cli` 0.88.0 in `devc-core/node_modules`, functions
  `RQ`/`Yb` in `dist/spec-node/devContainersSpecCLI.js`): two references count as the same
  Feature only when the manifest digest **and** the options compare equal, or when the tags match
  and the options compare equal. Different options produce two worklist entries, so two installs.
- **VS Code download URL:** `https://update.code.visualstudio.com/<latest|x.y.z>/linux-<x64|arm64>/<stable|insider>`.
  It answers with a 302 to a `.tar.gz`. The quality is **`insider`** (singular) in the URL. Both
  architectures and both qualities were checked.
- **Tarball layout:** the top folder is `VSCode-linux-<arch>/` for both qualities. The stable
  binary is `code` and its CLI is `bin/code`. The insider binary is `code-insiders` and its CLI
  is `bin/code-insiders`.
- **`--no-sandbox` is required, and `--disable-chromium-sandbox` breaks VS Code.** Measured in
  devc-dev's agent-sandbox VM: with the latter, Electron aborts creating shared memory in
  `/dev/shm`, and the extension host never starts.
- **The 11-package Electron list works:** with it, `vscode-test` ran 197 tests green on noble
  under `xvfb-ensure` (measured during `feature-xvfb`). It is not known to be minimal. A
  different list used in devc-dev's agent-sandbox VM, kept here as a cross-check if a scenario
  fails:
  `libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libdrm2 libdbus-1-3 libatspi2.0-0t64 libsecret-1-0`.

## Contracts

### Manifest

`features/headless-vscode/devcontainer-feature.json`:

- `"id": "headless-vscode"`, `"version": "0.1.0"`, `"name": "Headless VS Code"`, plus
  `documentationURL` and `licenseURL` following `xvfb`'s pattern.
- A `description` that says: it installs Electron's runtime libraries and a launcher that
  downloads VS Code at run time and runs it on an `xvfb` display with a CDP port; it sets no
  `DISPLAY`.
- `"dependsOn"`: per D3.
- `"mounts"`: per D4. Omit the key if D4 is not a volume.
- `"options"`: per D6. With the recommended answer, the manifest has no options and
  `"options": {}` is omitted.
- No `containerEnv`, no `postCreateCommand`, no `postStartCommand`.

### install.sh

POSIX `sh`, `set -e`, `LC_ALL=C`; it runs as root at build time. Mirror `xvfb/install.sh`'s
structure:

1. **Package set.** The Electron list, in Ubuntu 24.04 names, always installed:
   `libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libxshmfence1 libdrm2 libatk-bridge2.0-0t64 libcups2t64`.
   Add the launcher's runtime tools: `curl ca-certificates procps`, plus `imagemagick xdotool`
   (D3 recommended) and `iproute2` (D7 recommended).
2. **`t64` fallback:** copy `xvfb/install.sh`'s block. A name ending in `t64` is used as written
   if `apt-cache show` knows it, otherwise without the suffix. If neither name exists, fail and
   name both. Features in this repo don't share code, so copying it is expected.
3. **One** `apt-get update` and **one** `apt-get install -y --no-install-recommends`. Fail with
   `headless-vscode: needs apt-get — this Feature supports Debian and Ubuntu base images only`
   if `apt-get` is missing.
4. Copy the launcher to `/usr/local/share/devc-features/headless-vscode/bin/headless-vscode`
   (mode 0755) and always symlink it as `/usr/local/bin/headless-vscode`. Make the paths
   overridable for the offline harness through `SHARE_DIR` and `HEADLESS_VSCODE_LINK`, the way
   `xvfb` does.
5. D4 recommended: `mkdir -p /var/cache/headless-vscode && chmod 1777 /var/cache/headless-vscode`,
   with the path overridable through `CACHE_DIR`.
6. Print one summary line for each step, prefixed `headless-vscode:`.

### The launcher

Bash (`#!/usr/bin/env bash`, `set -euo pipefail`). stdout carries only the command's result
(JSON or a path). All diagnostics go to stderr, prefixed `INFO` or `ERR`. Exit codes: `0` for
success, `1` for failure, `2` for usage errors.

```
headless-vscode start   [options] [WORKSPACE] [-- <vscode args>]
headless-vscode restart [options] [WORKSPACE] [-- <vscode args>]   # stop, then start
headless-vscode stop    [--state-dir <dir>]
headless-vscode status  [--state-dir <dir>] [--mcp-name <name>]
headless-vscode screenshot [--state-dir <dir>] [OUT.png]
```

The options are listed in D6. `start` also takes `--reseed` (D2) and `--build` (D5).

**Files in the state directory:** `vscode.pid`, `display` (for example `:99`),
`launch.json` (holds `extensionPath`, `workspace` and `cdpPort`, so that `status` can report
them), `vscode.log`, `user-data/`, `extensions/`, `screenshots/`.

**Is the recorded pid ours?** A process counts as running only if the pid in `vscode.pid` is
alive **and** its `/proc/<pid>/cmdline` contains the argument `--user-data-dir=<stateDir>/user-data`.
Do **not** compare `/proc/<pid>/exe` with the binary, as vscode-deephaven's script does: a fake
`code` script in the offline harness shows up as `/bin/bash`, and the `user-data-dir` argument
identifies this launcher's instance in both cases.

#### start

1. If already running: log `INFO VS Code already running.`, print status, exit 0.
2. Resolve the extension folder and workspace (D6). If either doesn't exist, fail. If the CDP
   port already answers `GET http://127.0.0.1:<port>/json/version`, fail with a message that
   names the `--cdp-port` flag.
3. **Display:** `eval "$(env -u DISPLAY xvfb-ensure)"`. Clearing `DISPLAY` stops `xvfb-ensure`
   from reusing a display forwarded from the host, so the window always lands on the virtual
   one. Write `$DISPLAY` to `display`.
4. Build, per D5.
5. Get VS Code, per [Getting VS Code](#getting-vs-code).
6. **`extensionDependencies`:** read them with
   `node -p "(require('<ext>/package.json').extensionDependencies||[]).join('\n')"`. If node is
   missing and the list can't be read, fail. Install each one not already listed by
   `<cli> --user-data-dir … --extensions-dir … --list-extensions` (compare case-insensitively),
   using `--install-extension <id>`.
7. Settings, per [Settings](#settings).
8. Launch with `nohup <bin> … >vscode.log 2>&1 &`, write `$!` to `vscode.pid`, then `disown`.
   Arguments, in this order:
   `--extensionDevelopmentPath=<ext> --user-data-dir=<state>/user-data --extensions-dir=<state>/extensions --remote-debugging-port=<port> --no-sandbox --disable-dev-shm-usage --disable-gpu --password-store=basic --disable-workspace-trust --disable-updates --disable-telemetry --skip-welcome --skip-release-notes --new-window <extra args…> <workspace>`.
9. Poll CDP once a second for up to 60 s, stopping early if the process dies. On failure, write
   the last 20 lines of the log to stderr and exit 1.
10. **Fill the screen:** bare Xvfb has no window manager, so "maximized" does nothing. Run
    `timeout 20 xdotool search --sync --onlyvisible --name 'Visual Studio Code'`; that title also
    matches Insiders. Then `windowmove 0 0 windowsize <W> <H>`, using W and H from
    `xdpyinfo -display $DISPLAY` (`dimensions:`). If no window is found, log `INFO` and continue.
11. MCP wait, per D7.
12. Print status.

#### stop

Send `TERM` to the recorded pid. Wait up to 5 s, checking every 0.5 s, then send `KILL`. Remove
`vscode.pid`. If nothing is running: log `INFO`, exit 0.

#### status

The JSON from D7. Fields are `null` when not running. `log` is always set.

#### screenshot

Fail unless the recorded display answers `xdpyinfo`. Run
`import -window root -display <display> <out>`. The default `<out>` is
`<state>/screenshots/<date -u +%Y%m%d-%H%M%S>.png`. Print `realpath <out>`.

### Getting VS Code

- **Architecture:** `uname -m` `x86_64|amd64` → `x64`, `aarch64|arm64` → `arm64`; anything else
  fails with `unsupported architecture`.
- **Install folder:** `<cache>/<quality>-<version>-<arch>/VSCode-linux-<arch>/`. `<cache>` is
  per D4. A folder for `latest` is reused until someone deletes it; the README gives the
  `rm -rf` to refresh it.
- **Download:** `curl -fL --retry 3 <URL>` (URL in Verified facts) into a temporary file in
  `<cache>`. Extract into `<cache>/.tmp.<pid>/`, then `mv` it into place, so an interrupted
  download never leaves a half-extracted install. Remove the tarball afterwards.
- **Binary:** `code` for stable, `code-insiders` for insider. **CLI:** `bin/code` or
  `bin/code-insiders`.

### Settings

Per D2. With the recommended answer, if `<state>/user-data/User/settings.json` is missing (or
`--reseed` was passed), write the defaults below with the seed file's keys merged over them
(a shallow merge where the seed file wins), as pretty-printed JSON:

```json
{
  "window.titleBarStyle": "custom",
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "git.openRepositoryInParentFolders": "never"
}
```

The first two keep the title bar and dialogs in the DOM, where CDP can see them. The seed file
is plain JSON. Read it with `node`; if it fails to parse, exit 1 with an error that names the
file.

### README contents

`features/headless-vscode/README.md`, in the same style as `xvfb`'s README:

- What it is; the one-line install (`"ghcr.io/devc-tools/features/headless-vscode:0": {}`); the
  `:0` tag note.
- **Two uses:** (1) `vscode-test` / `@vscode/test-electron` runs, which need only the libraries
  plus `eval "$(xvfb-ensure)" && npm test` or `xvfb-run -a npm test`; (2) a live instance an
  agent drives, using the launcher.
- The full launcher reference: commands, flags and env vars, state files, status JSON.
- **The `xvfb` relationship:** it comes in through `dependsOn`. Explain what happens if the
  project also declares `xvfb` with its own options (per D3).
- **The chrome-devtools-mcp recipe,** with the three places it can go (see Settled):
  ```sh
  claude mcp remove --scope local chrome-devtools >/dev/null 2>&1 || true
  claude mcp add --scope local chrome-devtools -- \
    npx -y chrome-devtools-mcp@1.10.1 --browserUrl http://127.0.0.1:9222 \
    --no-usage-statistics --no-performance-crux
  ```
- **Agent notes** (observed with chrome-devtools-mcp 1.10.1):
  - Use chrome-devtools-mcp, not Playwright MCP, which loses the workbench once a webview
    opens.
  - Pass `pageId: 1`, the workbench, on every call.
  - Canvas content is not in snapshots; take a screenshot instead.
  - Click a workbench element before sending keyboard shortcuts when a webview has focus.
- **Example project wrapper:** a short script that sets a per-run setting with the project's
  own `jsonc-parser`, then calls `headless-vscode start --mcp-name '<name>'`. This is the shape
  vscode-deephaven's script should take.
- **Expected noise:** `Failed to connect to the bus` lines in `vscode.log` are harmless.
- **What this is not:** no VNC, no GPU, not Wayland, not a VS Code server/Remote install.

## Tests

**Offline** (bash, no Docker; same style as `xvfb`'s):

- `test/install_options_test.sh` runs the real `install.sh` with `apt-get`/`apt-cache` stubbed,
  using 24.04 and pre-`t64` fixture lists. Cases:
  - the full package set on each fixture;
  - the `t64` fallback for each of the four `t64` names;
  - neither form known → the build fails and names both;
  - the launcher and symlink are placed;
  - the cache folder is created with mode 1777 (D4 recommended).
- `test/launcher_test.sh` puts fakes on `PATH`: `xvfb-ensure`, `xdpyinfo`, `xdotool`, `import`,
  `curl` and `node`. The fake `curl` serves a tarball holding a fake `code` script, which sleeps
  and records its arguments. Cases:
  - stdout is exactly one JSON object for `status` and `start`, and one path for `screenshot`;
  - stdout is empty on every failure;
  - `start` when already running;
  - the CDP port already taken;
  - the launch arguments, including `--no-sandbox`, in the stated order;
  - `DISPLAY` is cleared before `xvfb-ensure` is called;
  - settings are seeded once, a later start leaves them alone, and `--reseed` rewrites them;
  - a seed file that won't parse;
  - `stop` escalates `TERM` to `KILL`;
  - a recycled pid (no `--user-data-dir` match) counts as not running;
  - the stable/insider binary names;
  - an unsupported architecture;
  - usage errors exit 2.

**Docker** (`test/run-features-test.sh`, copied from `features/xvfb/test/`; base image
`mcr.microsoft.com/devcontainers/base:ubuntu` unless noted):

- `test.sh`, the default `{}` scenario:
  - every Electron package is installed;
  - `xvfb-ensure` and `headless-vscode` are on `PATH`;
  - `DISPLAY` is unset;
  - nothing is listening on 9222.
- `debian`: `mcr.microsoft.com/devcontainers/base:bookworm`. The `t64` names fell back to the
  bare ones.
- `with_xvfb_declared`: the project declares `"xvfb": {}` next to this Feature. Assert that
  `xvfb` installed once: `xvfb-ensure` has `DEFAULT_DISPLAY="99"` baked in, and the build log has
  exactly one `xvfb: installed` line. The scenario script can't see the build log, so record
  that count by hand in this plan's Implementation notes.
- `vscode_launch` (needs network; D8). `onCreateCommand` writes a minimal extension with
  `package.json` (`engines.vscode: "^1.90.0"`, `main: "extension.js"`, `activationEvents: ["*"]`)
  and an `extension.js` that does nothing. Then, as the remote user:
  - `headless-vscode start --build ''` exits 0;
  - `status` shows `"running":true`, and `cdpEndpoint` answers `/json/version`;
  - `screenshot` writes a PNG with more than one colour (`identify -format %k` > 1), because a
    blank frame is the typical silent failure;
  - `stop` exits 0, and `status` then shows `"running":false`;
  - D4 recommended: `/var/cache/headless-vscode` is writable by the remote user and holds the
    install.

## Validation

- [ ] V-1. `bash features/headless-vscode/test/install_options_test.sh` → all cases pass, exit 0.
- [ ] V-2. `bash features/headless-vscode/test/launcher_test.sh` → all cases pass, exit 0.
- [ ] V-3. `bash features/headless-vscode/test/run-features-test.sh` → the default, `debian`,
      `with_xvfb_declared` and `vscode_launch` scenarios pass.
- [ ] V-4. `bash features/xvfb/test/install_options_test.sh` and
      `bash features/xvfb/test/xvfb_ensure_test.sh` still pass (after the D9 changes).
- [ ] V-5. `shellcheck features/headless-vscode/install.sh features/headless-vscode/headless-vscode features/headless-vscode/test/*.sh`
      → no findings, or each one has a `# shellcheck disable=` with a reason, matching `xvfb`.
- [ ] V-6. `jq -e '.id == "headless-vscode" and .version == "0.1.0" and (.containerEnv == null)' features/headless-vscode/devcontainer-feature.json`
      → `true`.
- [ ] V-7. `grep -qx 'headless-vscode' features/PUBLISH_ALLOWLIST.txt`, run only after V-3
      passes.
- [ ] V-8. `grep -n 'headless-vscode' features/README.md features/CONTRIBUTING.md` → a README
      row, a testing paragraph and a `### headless-vscode` note.
- [ ] V-9. With D9 recommended: `jq -r .version features/xvfb/devcontainer-feature.json` →
      `0.1.1`, and `grep -c 'libgtk-3-0t64' features/xvfb/README.md` → `0`.
- [ ] V-10. `deno fmt --check` on every touched `.md`/`.json` file → clean.

## Relevant Files

New:

- `features/headless-vscode/devcontainer-feature.json`
- `features/headless-vscode/install.sh`
- `features/headless-vscode/headless-vscode` (launcher; renamed per D1)
- `features/headless-vscode/README.md`
- `features/headless-vscode/test/install_options_test.sh`
- `features/headless-vscode/test/launcher_test.sh`
- `features/headless-vscode/test/run-features-test.sh`
- `features/headless-vscode/test/test.sh`
- `features/headless-vscode/test/scenarios.json`
- `features/headless-vscode/test/debian.sh`
- `features/headless-vscode/test/with_xvfb_declared.sh`
- `features/headless-vscode/test/vscode_launch.sh`

Changed:

- `features/README.md`: the collection table row
- `features/CONTRIBUTING.md`: testing paragraph, `### headless-vscode` note, the `xvfb` note
  (D9)
- `features/PUBLISH_ALLOWLIST.txt`
- `features/xvfb/README.md` (D9)
- `features/xvfb/devcontainer-feature.json` (D9: version and `extraPackages` description)
- `features/xvfb/install.sh` (D9: comment only)
- `features/xvfb/test/install_options_test.sh` (D9: case 6 uses an inline list)
- `.plans/PLAN.md`

If D8 (a) is chosen: `.github/workflows/test-headless-vscode.yml`.

## Gotchas

- **Two installs from different options:** see D3. Even a different tag (`xvfb:0` vs
  `xvfb:0.1`) makes two entries.
- **Feature options reach `install.sh` uppercased, with non-word characters stripped**
  (`cdpPort` → `CDPPORT`). This only matters if D6 adds options.
- **`xvfb-ensure` reuses any live `$DISPLAY` first;** hence `env -u DISPLAY` in `start`.
- **VS Code blocks on an "OS keyring couldn't be identified" dialog** without
  `--password-store=basic`.
- **A fresh `--extensions-dir` has none of the extension's `extensionDependencies`,** and VS Code
  then refuses to activate it ("Cannot activate … depends on …"). Installing them needs
  marketplace access at run time.
- **`run-features-test.sh` stages only this Feature,** so `dependsOn` pulls `xvfb` from ghcr.io,
  not from the working tree. Local `xvfb` changes (D9) aren't exercised by this Feature's
  scenarios; `xvfb`'s own tests cover them.

## Implementation notes

(Filled in during implementation: measurements, the `with_xvfb_declared` build-log count, and
anything that differed from this plan.)
