# agents-update-tools-on-start

**Repo:** `devc-tools`
**Run on:** any checkout for everything offline (Steps 1–4, offline Validation); a **host** with
Docker for the container Validation.

After every `devc build`, Claude Code starts on the version baked into the image, then downloads
the latest version in the background and asks to be restarted. Copilot and Herdr have the same
problem. Add an `agents` option, `updateToolsOnStart` (default `true`), that updates each installed
agent CLI at container start, before anything launches it.

Repo touched: **`devc-tools`**, and within it **`features/agents/` only**.

> **Before you start — conventions that bind this plan.** See [PLAN.md](PLAN.md) § Standing rules
> for Feature work. Two of them apply here:
>
> - **`"agents": {}` must install cleanly and do something useful.** With the new default on, the
>   bare case now runs `claude update` at start. That must not fail the start offline.
> - **Bump the Feature's `version` in the commit that changes it.** Read the manifest's actual
>   `version` at edit time and do a minor bump (new option). It was `0.7.0` when this was written.
>
> **Sequencing.** This plan and `agents-agent-browser-arm64` (tracked in the `devc-dev`
> workspace's `.plans/pending/`) both edit `install.sh`,
> `devcontainer-feature.json`, `README.md` and `test/install_options_test.sh`. Do not run them at
> the same time. Either order works.

## Checklist

- [x] Step 1: `updateToolsOnStart` option and `update-tools.conf` written by `install.sh` (§ Step 1)
- [x] Step 2: `post-start.sh` and the manifest's `postStartCommand` (§ Step 2)
- [x] Step 3: Offline harness coverage (§ Step 3)
- [x] Step 4: Docker scenario, README, option description, version bump (§ Step 4)

---

## Why it happens (measured in `devc-dev`, 2026-10-09)

- `install_cli` runs the vendor installers inside a Docker build step. On a plain `devc build`
  Docker reuses the cached result of that step, so nothing is downloaded again. This container had
  `copilot` dated Sep 28 and `claude` 2.1.285 / `herdr` 0.9.3 dated Sep 30.
- `~/.local/bin` and `~/.local/share/claude` are not mounts, so every rebuild resets them to the
  version in the image.
- Claude's native install updates itself in the background (`autoUpdatesProtectedForNative: true`
  overrides `autoUpdates: false`). In this container 2.1.295 arrived 4 minutes after start. Claude
  then asks to be restarted.
- Nothing in devc, devc-core or any Feature runs an update command.

## Decisions taken

**A `postStartCommand` in the Feature, not in devc.** `devc attach` / `devc claude` run
`devcontainer up` before their `docker exec`, and `up` runs start-time commands when it starts a
stopped or new container. The update therefore finishes before the agent process exists. Start
time also covers VS Code and plain `devcontainer` users, and it covers a container restarted days
after its build. A `postCreateCommand` would miss that restart case. Updating from `devc attach`
would miss non-devc entry points and slow every attach.

**Which tools.**

| Tool            | Update command                                                                                                                               | Included |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `claude`        | `claude update`                                                                                                                              | yes      |
| `copilot`       | `copilot update`                                                                                                                             | yes      |
| `pi`            | `pi update` (no target updates only pi itself; `--extensions`/`--all` would also move packages, and those already re-resolve at create time) | yes      |
| `herdr`         | `herdr update` (never `--handoff`)                                                                                                           | yes      |
| `agent-browser` | none; it is an npm package whose Chrome download is tied to its version                                                                      | **no**   |

Herdr is safe to update at start: no Herdr server is running yet. devc starts its Herdr sidecar
after `up` returns.

**Only tools this Feature installed.** `install.sh` records which ones it installed, and
`post-start.sh` updates exactly those. A `claude` the consumer installed some other way is not
touched.

**Never fail the start.** A failed or timed-out update logs one line and moves on, as
`post-create.sh` already does for `piPackages`/`herdrPlugins`. An offline start must still bring
the container up on the image's version.

**Sequential, Claude first.** Updates run one after another in the order of the table above, so
the tool most often launched right after start is ready first.

## Contract

### Option

`features/agents/devcontainer-feature.json` → `options.updateToolsOnStart`:

```json
"updateToolsOnStart": {
  "type": "boolean",
  "default": true,
  "description": "<see Step 4>"
}
```

`install.sh` reads it as `UPDATE_TOOLS_ON_START_OPT="${UPDATETOOLSONSTART:-true}"`, next to the
other `_OPT` assignments.

### `update-tools.conf`

- Path: `/usr/local/share/devc-features/agents/update-tools.conf` (`$SHARE_DIR/update-tools.conf`).
- Contents: the tool binary names, space-separated, in the fixed order
  `claude copilot pi herdr`, filtered to the tools whose install option is `true`. No trailing
  newline (`printf '%s'`, the same as the other `.conf` files).
- Written when `updateToolsOnStart` is `true` **and** the list is non-empty. **Removed**
  (`rm -f`) otherwise, so a rebuild that turns the option off does not keep a file from an earlier
  build. This is the same removal pattern `claude-seed.conf` uses.

### `post-start.sh`

- Source: `features/agents/post-start.sh`. `install.sh` copies it to
  `$SHARE_DIR/post-start.sh`, mode `0755`, next to the `post-create.sh` copy.
- Manifest: `"postStartCommand": "bash /usr/local/share/devc-features/agents/post-start.sh"`.
- Runs as the remote user (the devcontainer CLI does this for Feature lifecycle commands).
- `set -u`, **not** `set -e`. **Every path exits 0.**
- No `update-tools.conf` → print `agents: updateToolsOnStart is off or no agent CLI is installed — nothing to update` and exit 0.
- For each name in the file, in order:
  1. Binary path is `$HOME/.local/bin/<name>`. Do not look it up on `PATH`, because the
     start-time shell's `PATH` is not guaranteed to include `~/.local/bin`. If that path is not
     executable: `agents: <name> not found at ~/.local/bin/<name> — skipping update`, then
     continue.
  2. **`pi` only:** if `node` is not on `PATH`, look for nvm the same way `install.sh`'s
     `node_prelude` does (`$NVM_DIR`, `/usr/local/share/nvm`, `$HOME/.nvm`; source `nvm.sh` with
     `set +e` around it). If node is still missing, print
     `agents: pi update skipped — node not found` and continue.
  3. `before` = first line of `<bin> --version 2>&1`.
  4. Run `timeout 120 <bin> update < /dev/null`. Keep its stdout/stderr out of the start log by
     writing them to `$HOME/.cache/devc-agents/update-<name>.log` (`mkdir -p` the directory,
     overwrite each start).
  5. `after` = first line of `<bin> --version 2>&1`.
  6. Print exactly one line:
     - non-zero exit (including `124` from `timeout`):
       `agents: <name> update failed (exit <code>) — see ~/.cache/devc-agents/update-<name>.log`
     - `before` ≠ `after`: `agents: <name> updated: <before> → <after>`
     - otherwise: `agents: <name> up to date: <after>`

Compare the whole first line of `--version` output instead of extracting a version number. The
formats differ between tools (`2.1.295 (Claude Code)`, `GitHub Copilot CLI 1.0.89.`,
`herdr 0.9.3`), and a string comparison is enough to tell whether something changed.

## Gotchas

- **`claude update` and `autoUpdates: false`.** A shared `~/.claude/.claude.json` can contain
  `"autoUpdates": false`. Validation measures whether `claude update` still installs a new
  version in that case. If it refuses, change Claude's command to `claude install latest`, which
  pins nothing and installs the newest release. Note the change in this plan's Completed entry.
- **`copilot update` with no terminal.** stdin is `/dev/null`. If it waits for confirmation, the
  120 s timeout catches it, but that is a failure. Validation checks that it updates without
  asking.
- **The CLI waits for start-time commands.** devc's first `docker exec` only gets the new binary
  if `devcontainer up` (CLI `0.88.0`, embedded in devc) waits for `postStartCommand` to finish
  before it returns. Validation measures this. If the CLI does not wait, record it in the
  Completed entry and leave the behaviour as it is; making `devc` wait is a separate plan.
- **Offline start.** With no network, each update fails quickly or hits its timeout, and the start
  still succeeds. The worst case adds 4 × 120 s, and only when a tool hangs instead of failing.
  That is accepted.

## Step 1 — option and conf file

- Add `updateToolsOnStart` to the manifest (§ Contract), placed after `installAgentBrowser` /
  `agentBrowserChrome` and before `claudeSeed`.
- `install.sh`: add the `_OPT` assignment. After the existing `.conf` writes, build the list from
  the four `INSTALL_*_OPT` values and write or remove `update-tools.conf` as § Contract describes.
- `install.sh`: copy `post-start.sh` beside `post-create.sh`, `0755`.

## Step 2 — `post-start.sh`

Write it as § Contract specifies. Give it a header comment in the style of `post-create.sh` and
`features/xvfb/post-start.sh`: what it is, who copies it where, why it runs at start, and why it
never fails. Add `postStartCommand` to the manifest.

## Step 3 — offline coverage

`features/agents/test/install_options_test.sh` (add cases next to the existing `.conf` cases):

- Defaults (`{}`): `update-tools.conf` is exactly `claude`, and `post-start.sh` is copied and
  executable.
- `installCopilotCli` + `installPiCli` + `installHerdr` all `true`: exactly
  `claude copilot pi herdr`.
- `installClaudeCli=false`, everything else default: no conf file.
- `updateToolsOnStart=false`: no conf file.
- A build with `true` followed by one with `false`: the stale file is removed.
- The manifest and `install.sh` agree on the option's name and default (copy case 13e).

New `features/agents/test/post_start_test.sh`, in the style of `post_create_test.sh`. It sets
`HOME` to a temp dir and puts stub tools in `$HOME/.local/bin`. Each stub reports a version that
changes after `update` runs, records how it was called, and can be told to exit non-zero or sleep.
Point the script at a temp conf file through an overridable variable
(`UPDATE_TOOLS_CONF="${UPDATE_TOOLS_CONF:-/usr/local/share/devc-features/agents/update-tools.conf}"`),
in the same style as `install.sh`'s `SHARE_DIR` override.

Cases:

1. No conf file → the "nothing to update" line, exit 0, and no stub is called.
2. `claude` whose version changes → `agents: claude updated: <a> → <b>`, exit 0, and the stub saw
   argv `update`.
3. `claude` whose version does not change → `agents: claude up to date: <a>`.
4. `claude` that exits 3 → the `update failed (exit 3)` line, exit 0, and the next tool in the
   conf still runs.
5. Conf lists `copilot` but no binary exists → the "not found" line, exit 0.
6. Order: conf `claude copilot pi herdr` → the stubs' call log shows exactly that order.
7. `herdr` is called with argv `update` only, never `--handoff`.
8. Timeout: run with `timeout` shadowed by a stub that records its first argument, and assert
   `120`.

Like the other harnesses in `features/agents/test/`, it is run directly. `tests/features_test.sh`
only checks manifests and does not run harnesses.

## Step 4 — Docker scenario, docs, version

- `features/agents/test/scenarios.json`: add `with_update_on_start`, a merge into the existing
  file:
  `{"image": "mcr.microsoft.com/devcontainers/base:ubuntu", "features": {"agents": {"installCopilotCli": true, "installHerdr": true}}}`.
  New `features/agents/test/with_update_on_start.sh` checks that `update-tools.conf` is
  `claude copilot herdr`, that `post-start.sh` is executable and root-owned, and that
  `bash /usr/local/share/devc-features/agents/post-start.sh` exits 0 and prints one `agents:` line
  for each of the three tools.
- `features/agents/test/test.sh` (the bare `{}` scenario): add a check that `update-tools.conf`
  is `claude`.
- Option description (manifest):
  `Update each agent CLI this Feature installed (claude, copilot, pi, herdr — not agent-browser) at every container start, before anything launches it, by running its own update command. Fixes the stale version a cached image build leaves behind, which Claude Code otherwise replaces in the background and then asks to be restarted for. Never fails the start: an offline or failed update logs one line and keeps the installed version. Each update is capped at 120 seconds; output goes to ~/.cache/devc-agents/update-<tool>.log.`
- Also edit `installClaudeCli`'s description: replace "Idempotent: a rebuild does not re-download
  when the binary is already there." with "A cached image build keeps the version it first
  installed; updateToolsOnStart brings it current at container start."
- Manifest top-level `description`: add one sentence saying that at start time it updates the
  installed agent CLIs (`updateToolsOnStart`).
- `features/agents/README.md`, § What it does: after the build-time paragraph, add an **At start
  time** paragraph covering what is updated, the order, the log line format, the log path, the
  120 s cap, never-fail, and how to turn it off (`"updateToolsOnStart": false`). Add the option
  to the README's options table if it has one.
- Bump `version` (minor).

## Validation

Offline, from the repo root, no Docker:

- [x] `bash features/agents/test/install_options_test.sh` passes, including the new cases
- [x] `bash features/agents/test/post_start_test.sh` passes, all 8 cases
- [x] Mutation check: making a failed update abort `post-start.sh` (`|| code=$?` → `|| exit $?`)
      turns case 4 red; dropping `install.sh`'s `update-tools.conf` removal arm turns case 13j red
- [x] `bash -n features/agents/post-start.sh features/agents/install.sh` clean
- [ ] `shellcheck features/agents/post-start.sh features/agents/install.sh` clean — not run:
      `shellcheck` is not installed in the `devc-dev` container
- [x] `bash tests/features_test.sh --feature agents` passes (manifest guards accept the new option and `postStartCommand`)
- [x] `deno fmt --check` clean on every touched `.md`/`.json`

On a **host** with Docker:

- [ ] `bash features/agents/test/run-features-test.sh --skip-autogenerated --filter with_update_on_start`
      passes, and the default scenario passes too
- [ ] **The original symptom is gone:** in a project using devc, `devc build`, then
      `devc claude`. Claude starts on the latest version (`claude --version` matches
      `npm view @anthropic-ai/claude-code version`), and no "restart to update" notice appears
      during the first 10 minutes
- [ ] The `devc build` output contains `agents: claude updated: …` or `agents: claude up to date: …`
- [ ] With `"autoUpdates": false` in `~/.claude/.claude.json`, `claude update` from a stale image
      still changes the version. If not, change the command to `claude install latest` (see
      § Gotchas) and repeat this item
- [x] `copilot update < /dev/null` updates without asking — measured 2026-10-09 in the
      `devc-dev` container by running the real `post-start.sh` with a conf of `claude copilot`:
      `agents: copilot updated: GitHub Copilot CLI 1.0.89. → GitHub Copilot CLI 1.0.95.`, exit 0,
      12.8 s total
- [ ] `herdr update < /dev/null` with no Herdr server running exits 0 without asking
- [ ] **`up` waits:** the timestamp of the `agents: claude …` line in `~/.cache/devc-agents/` (or
      the `up` log) comes before the `docker exec` that `devc claude` performs. Record the result
- [ ] Offline: with the network cut off (`docker network disconnect`, or a host with networking
      turned off), `devc up` on a stopped container still succeeds and logs `update failed` lines
- [ ] `"updateToolsOnStart": false` in `devc.jsonc` → rebuild → no `update-tools.conf`, and the
      start log shows the "nothing to update" line

### Measured so far (2026-10-09, `devc-dev` container, no Docker)

- The same run reported `agents: claude up to date: 2.1.295 (Claude Code)` with
  `"autoUpdates": false` in `~/.claude/.claude.json`. Its log shows `claude update` doing a real
  check (`Checking for updates to latest version...`), so the setting does not stop a manual
  update. The stale-image item above stays open until a version change is actually seen.
- Herdr was left out of that run: a Herdr server was running in the container (this session ran
  inside it). The no-server case stays a host item.

## Relevant Files

- `features/agents/devcontainer-feature.json` — new option, `postStartCommand`, top-level and
  `installClaudeCli` descriptions, `version` bump
- `features/agents/install.sh` — `_OPT` assignment, `update-tools.conf` write/remove,
  `post-start.sh` copy
- `features/agents/post-start.sh` — **new**
- `features/agents/README.md` — § What it does, the start-time paragraph, options table
- `features/agents/test/install_options_test.sh` — conf-file and copy cases
- `features/agents/test/post_start_test.sh` — **new**
- `features/agents/test/scenarios.json` — `with_update_on_start`
- `features/agents/test/with_update_on_start.sh` — **new**
- `features/agents/test/test.sh` — bare-case conf check

Read but **not** changed:

- `features/agents/post-create.sh` — style reference; create-time behaviour is unchanged
- `features/xvfb/post-start.sh` — the existing start-time script to match
- `features/PUBLISH_ALLOWLIST.txt` — `agents` is already listed
- `tests/features_test.sh` — manifest guards only; it does not run harnesses, so nothing is registered there
- `devc-core/default/devcontainer.json` — devc's bundled config enables `agents` without setting
  this option, so it gets the default `true`
