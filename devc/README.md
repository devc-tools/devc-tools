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
[repo README](../README.md#install) for the env knobs and the `PATH` note.

**`docker` is the only thing `devc` needs on your `PATH`.** The
[`devcontainer` CLI](https://github.com/devcontainers/cli) is embedded in the
binary — see [The embedded devcontainer CLI](#the-embedded-devcontainer-cli).

To build it from a clone instead, see [Development](#development).

## Commands

```text
devc init    [PATH]                                   Scaffold the default `.devcontainer/` into the project
devc config  [PATH]                                   Configure the project's source/skills mounts (TUI)
devc up      [PATH] [--json]                          Create/start the container; print its status
devc build   [PATH] [--no-cache] [--json]             Recreate the container from scratch
devc attach  [PATH] [--build] [--no-clear]            Start (creating if needed) and attach a login shell
devc claude  [PATH] [EXTRA_ARGS...]                   Start and run `claude` (+ forwarded args) in a login shell
devc copilot [PATH] [EXTRA_ARGS...]                   Start and run `copilot` (+ forwarded args) in a login shell
devc pi      [PATH] [EXTRA_ARGS...]                   Start and run `pi` (+ forwarded args) in a login shell
devc exec    [PATH] [--cwd DIR] [--env K=V]... -- CMD Start and run CMD directly (no shell)
devc mounts  [PATH] [--json]                          List the container's mounts
devc stop    [PATH]                                   Stop the container
devc down    [PATH]                                   Stop and remove the container
devc status  [PATH]                                   Print `running` / `stopped` / `missing`
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
  `attach`/`claude`/`copilot`/`pi` exit with the attached shell/command's own
  exit code (e.g. 130 on a signal-driven detach); `devc`/`docker` infra
  failures exit 125.
- `exec` runs the command after `--` directly (no shell) and exits with the
  command's own exit code; `devc`/`docker` infra failures exit 125. `--env` is
  repeatable and a value without `=` is an error (exit 125).
- `mounts` prints `type\tsource -> destination\trw|ro` rows, or the
  `ContainerMount[]` JSON with `--json`. With no container it prints
  `No container for <path>` (text) / `[]` (json).
- Lookup commands (`status`/`stop`/`down`/`mounts`) locate the container by its
  `devcontainer.local_folder` label and never start anything.

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
- **Git worktrees**: `up` passes `--mount-git-worktree-common-dir`. devc used to
  reimplement the CLI's own container-workspace-path algorithm to substitute
  `${containerWorkspaceFolder}` into `--mount` args; inside a config file the CLI
  resolves it itself, so that port is gone.
- After a successful `up`, the container is renamed to `devc-<basename>-<hash>`
  and its image is given a `<name>:latest` alias tag (both best-effort, never
  fatal).

`attach`/`claude`/`copilot`/`pi` also propagate the host terminal identity (`TERM`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `$TMUX`) and tint the terminal for the
duration of the attach so a container shell reads as visually distinct from a
local one.

### Herdr integration

A `devc attach`/`devc claude`/`devc copilot`/`devc pi` running in a
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

**An overlay may set any `devcontainer.json` key**, plus one devc-only key:

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
  "baselineFeatures": true
}
```

Where it can live — **first hit wins per level, and the losers are not merged**:

```text
~/.config/devc/devc.jsonc          your own, applied to every project   (lowest precedence)
~/.config/devc/devc.json
<project>/.devc/devc.jsonc         this project                         (highest precedence)
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

### How the layers merge

Lowest to highest: **devc → base config → user `devc.json` → project
`devc.json`**. Per key of each layer in turn:

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
  `user && project`: a machine owner's `false` cannot be talked back on by a
  repo's `devc.json`. A project can still turn it off on its own.

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

## Claude config: `~/.config/devc/.claude`

Anything you want the in-container agent to see goes in
`~/.config/devc/.claude` — **you put it there, and nothing else gets in.** The
directory is bind-mounted read-only onto the
[`agents`](https://github.com/devc-tools/devc-tools/tree/main/features/agents)
Feature's fixed seed path, and on every container create that Feature's own
`post-create.sh` symlinks each entry into the container's `~/.claude`:

```text
~/.config/devc/.claude/CLAUDE.md      →  /home/vscode/.claude/CLAUDE.md
~/.config/devc/.claude/settings.json  →  /home/vscode/.claude/settings.json
~/.config/devc/.claude/statusline.sh  →  /home/vscode/.claude/statusline.sh
```

- **Top-level files only.** Directories are ignored — the `devc:skills` fence
  owns `~/.claude/skills/`, and per-skill mounts are configured through
  `devc config` instead.
- **Read-only, and live.** Edits on the host show up immediately; no rebuild, no
  recreate. File modes carry over, so `statusline.sh` keeps its exec bit.
- **Deletions are honored.** Remove a file here and its link disappears on the
  next container create.
- **Missing is fine.** `devc` creates the directory if absent, and says so the
  once. An empty one is valid — files that aren't there simply aren't linked.
- **Nothing is copied in for you**, and in particular your host `~/.claude` is
  never read. Whether your personal `CLAUDE.md`, `settings.json` or
  `statusline.sh` should reach every container is a decision only you can make,
  so making it means copying (or symlinking) the file in yourself:

  ```sh
  cp ~/.claude/CLAUDE.md ~/.config/devc/.claude/
  ```

  Copy, and the container gets a snapshot you can diverge from the host's. Symlink
  (`ln -s`), and the two stay identical — the seed mount is live, so either way
  edits land without a rebuild.
- The container's own `~/.claude` stays a per-workspace volume, so `projects/`,
  `todos/`, and credentials persist per project and are never touched by this —
  and, as of `agents` `0.2.0`, that is now the whole story: `~/.claude.json`
  (auth) is symlinked into the same volume rather than living in a second one,
  so one volume captures all of Claude Code's state. **One cost from that
  fold, once:** an existing workspace's `~/.claude.json` was in its own
  `claude-json-*` volume before this change, and nothing migrates its
  contents across, so you re-login to Claude Code once per workspace on the
  first container create after upgrading. The orphaned `claude-json-*`
  volumes are left on disk — `docker volume prune` to reclaim them.

Migrating from an older `devc`: nothing is migrated automatically. Copy in
whichever of `~/.claude/CLAUDE.md`, `~/.claude/settings.devc.json` (→
`settings.json`) and `~/.claude/statusline.sh` you actually want — the `.devc`
suffix existed only to avoid colliding with the real `~/.claude/settings.json`,
and a dedicated directory removes the collision. Projects whose
`.devcontainer/devcontainer.json` was written by an earlier `devc` also still
carry three per-file binds — `devc` writes infra mounts once at creation and
never re-asserts them, so replace them by hand with:

```jsonc
"initializeCommand": "mkdir -p \"$HOME/.config/devc/.claude\"",
// …and in "mounts", replacing the three ~/.claude/* bind lines:
"type=bind,source=${localEnv:HOME}/.config/devc/.claude,target=/usr/local/share/devc-features/agents/claude-seed,consistency=cached,readonly",
```

The `initializeCommand` is what creates the mount source on a machine without
`devc` installed (a bind mount with a missing source is a hard error, not an
auto-created directory). It has to be top-level — it is the only host-side
lifecycle hook — so a project that needs its own `initializeCommand` should
either keep the `mkdir -p` in it or drop the seed mount alongside it.

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

## Git setup

`~/.gitconfig` is container-local and wiped on every rebuild, while the working
tree and `.git` are host bind mounts. The
[`git-container-config`](https://github.com/devc-tools/devc-tools/tree/main/features/git-container-config)
Feature re-applies the user-scope settings git needs each create:

- **Your identity.** `initialize-command.sh` extracts `user.name` / `user.email`
  from the host into `~/.config/devc/gitconfig-identity`, which binds in
  read-only and is picked up via `include.path`. Only those two keys cross the
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

Projects whose `.devcontainer/devcontainer.json` was written by an earlier
`devc` predate the identity mount — `devc` writes infra mounts once at creation
and never re-asserts them — so add it by hand to get your identity in the
container:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc/gitconfig-identity,target=/usr/local/share/devc-features/git-container-config/identity/gitconfig,consistency=cached,readonly",
```

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
it. Nothing is mounted for the client, and nothing is compiled in the container.
See [the Feature's README](../features/devc-bridge/README.md) for what it does
and why.

### The token mount

The bridge also needs the host's shared-secret token, which does have to cross as
a bind mount — and it must be **read-only**, or a container can pin the host's
token for the next restart. devc contributes that mount itself whenever anything
opts into the Feature, in **both** modes:

```jsonc
"type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly"
```

A **Feature** cannot declare it — the Feature schema's `Mount` has no `readonly`
field, and the CLI re-serializes object mounts without one — so a
`devcontainer.json` `mounts` array is the only place a read-only bind can be
expressed. It reaches one because devc contributes it as the lowest layer of the
merge, and the merged config is written to devc's own cache. **devc still does
not write into a project's `.devcontainer/` — not here, not anywhere.**

This used to be the one asymmetry between a devc project and a non-devc one: the
mount was spliced into the config devc materialized for the zero-config path, so
project-mode users had to copy the line into their own `devcontainer.json` by
hand. As a merge layer it reaches both, and the hand-written line is no longer
needed (one you already have is harmless — see below).

A project that does not use devc at all still declares the reference and the
mount in its own `devcontainer.json`, exactly as before.

**Install the host bridge first.** A Feature cannot create its own mount sources
— its lifecycle hooks all run inside the container, and `--mount type=bind`
errors on a missing source — so opting in on a host with no
`~/.config/devc-bridge/` fails the create with Docker's `bind source path does
not exist`. Running `devc-bridge start` once seeds that directory. devc does
**not** pre-create it, in either mode: a host that never uses the bridge should
not carry directories for it. That prerequisite is identical for devc and
non-devc projects; only who writes the mount line differs.

**If you already wired the bridge yourself** — a `run` mount you wrote in
`devc.json` or copied into `devcontainer.json` — you can leave it: the merge
dedupes `mounts` by target, and since devc's contribution is the lowest layer,
yours wins. A `devc-post-create.sh` that builds the client should still be
removed before opting in, since the Feature installs its own.

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

**Roots** (where the pickers are scoped) live in `~/.config/devc/config.json`,
stored folded to `~/…`. On first run — or any time roots are missing —
`devc config` collects them first with a free-navigation picker. Run
**`devc config --global`** to reconfigure them at any time.

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

Upgrading from a `devc` that wrote fences into `devcontainer.json`: **delete the
`devc:source` and `devc:skills` blocks there by hand**, then run `devc config`.
There is no automatic migration. Left in place, those mounts are applied
_as well as_ the overlay's — same target fails container creation with Docker's
`Duplicate mount point`, a different target just mounts the folder twice.
