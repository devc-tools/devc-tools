# devc CLI Design

## Source layout: `devc-core/` and `devc/`

Everything this doc describes is still true of `devc` as a whole, but the
source behind it lives in two packages (see
[`.plans/devc-core-npm-library.md`](../devc-core-npm-library.md)):

- **`devc-core/`** — the container lifecycle: start/rebuild/stop/down, status,
  mounts, exec, the `devc.json` overlay, and the config wizard's pure helpers
  (worktree resolution, mount-row serialization, the JSONC fence editor).
  Written against `node:` builtins only, so it runs unchanged on Deno and Node;
  published to npm as `@devc-tools/core` for a programmatic consumer, and
  consumed from source by `devc` itself.
- **`devc/`** — everything that touches a raw TTY: attaching an interactive
  shell (tmux window titles, the OSC background tint, terminal identity
  propagation), argument parsing, help text, and the `config`/`init` TUI's
  imperative shell. Also the one thing that has to differ by host: running the
  devcontainer CLI. `devc-core` defaults to spawning it as an ordinary Node
  child process; `devc`'s compiled binary has no such file on disk to spawn, so
  it binds a different `DevcontainerRunner` — a hidden `__devcontainer`
  subcommand that re-execs itself (`devcontainer_selfexec.ts`).

The split follows the TTY, not a rewrite: `devc` still ships as the same single
`deno compile` binary via the same `install.sh`, with byte-identical behavior.
`@devc-tools/core` is an additional distribution channel for the logic
underneath it, not a new tool.

## Project directory semantics

All `devc` commands operate on the **current working directory** by default. The
cwd is treated as the project directory, and the dev container associated with
that project directory is the target of the command.

- If a command accepts an optional `PATH` argument, `PATH` overrides the cwd,
  but the semantics are the same: the resolved path identifies the project and
  its container.
- If the container for the project directory does not exist or is not running,
  commands that need a running container will create and/or start it
  automatically before doing their work.
- If the container is already running, commands simply use it.

## How it works

`devc` is both a CLI and a TUI. The CLI surface area documented here is the
primary interface, but some commands (starting with `config`) launch an
interactive TUI wizard.

The tool ships with a **default `Dockerfile` + `devcontainer.json`** bundled
inside the binary/installation. All container-related CLI commands (`up`,
`attach`, `exec`, etc.) use this bundled configuration by default to create or
start the project container.

When a user wants to add source or skills mounts for a particular project, they
run `devc config`. This opens a TUI that edits that project's `devc.json`
overlay. Scaffolding a project-specific `.devcontainer/devcontainer.json` and
`.devcontainer/Dockerfile` is `devc init`'s job — `devc config` never writes
there (see **Where the wizard writes** below).

### Container engine

`devc` is a thin orchestrator over the
[`@devcontainers/cli`](https://github.com/devcontainers/cli) and `docker`; it
does not talk to the Docker daemon's build/run APIs directly.

- **Create / start** (`up`, and the auto-start inside `attach`/`claude`/`exec`):
  shells out to `devcontainer up --workspace-folder <PATH>`. The final line of
  its JSON output carries the `containerId`, `remoteUser`, and
  `remoteWorkspaceFolder` used by the rest of the command. Build/`postCreate`
  output is streamed through, and dumped on failure.
- **Identify**: a container is located by its `devcontainer.local_folder` label
  matching the resolved project path (via `docker ps`/`docker inspect`), so
  `status`, `stop`, `down`, and `mounts` never need to start anything.
- **exec / attach**: `docker exec` (`-i` for `exec`, `-it` for `attach`),
  running under `remoteUser` in `remoteWorkspaceFolder`.
- **Git worktrees**: when the project is a git worktree, `up` passes
  `--mount-git-worktree-common-dir` and the container-side workspace path is
  computed to match the CLI's own algorithm.
- **Cosmetic reconciliation** (best-effort, never fatal): after a successful
  `up`, the container is renamed to a deterministic `devc-<basename>-<hash>` and
  its image is given a `<name>:latest` alias tag.

### No hidden abstraction

A guiding principle: **the config `devc` produces is a standard, spec-compliant
`.devcontainer/` that a developer can read, understand, and hand-edit without
learning anything `devc`-specific.** `devc init` writes a plain
`devcontainer.json` + `Dockerfile`, and from that point on the project is a
normal dev container that any devcontainer-aware tool (VS Code, the CLI, CI)
understands. **Whatever lands in `.devcontainer/` runs without `devc` installed
at all.** That invariant is unconditional: `devc` never writes a `devc`-specific
key into that folder, and the launch-time merge never mutates it — the effective
config it produces is written to `~/.cache/devc/projects/<key>/`, outside the
project entirely.

The cost of that merge, stated plainly: the config `devcontainer up` runs is now
_generated_, so reading `.devcontainer/` no longer tells you the whole story of a
devc-started container. `devc up --print-config` is what closes that gap — it
prints the merged result and starts nothing. `devc`'s own
baseline behavior is carried by the bundled `Dockerfile` (build-time) plus a
top-level `postCreateCommand` running `post-create.sh` (create-time) — both
standard, inspectable devcontainer mechanisms with no `devc`-specific
indirection.

The optional `devc.json` overlay sits outside that contract rather than
weakening it, and serves two shapes. **Committed**, it declares that the repo
has adopted `devc` as a tool it depends on, much as it might depend on a
Makefile or a task runner. **Gitignored**, it is a purely local override — an
individual dev adding bind mounts for their own machine, in a repo that need not
know `devc` exists and whose `.devcontainer/` no one else sees changed.

Either way a checkout without `devc` still builds and runs from the standard
config, merely without the overlay's extra mounts, features and env. Nothing is
broken, only un-augmented.

**Managed mount blocks.** So that reconfiguring a project is surgical rather
than destructive, the wizard marks the two mount groups it owns — extra source
mounts and skills mounts — with comment fences inside the overlay's `mounts`
array (`// devc:source … // /devc:source` and
`// devc:skills … // /devc:skills`). These are ordinary JSONC comments, so the
file remains directly hand-editable — this is not a hidden abstraction, it is a
bookmark. `devc config` only ever rewrites the contents of its two fences.
Everything else in the overlay — hand-written mounts, `features`, `remoteEnv`,
comments, formatting, and any keys `devc` knows nothing about — is preserved
byte-for-byte and **never re-asserted**.

**Where the wizard writes.** The fences live in the project's `devc.json`
overlay, not in `devcontainer.json`. Extra bind mounts are machine-specific —
another checkout will not have the same host paths — so committing them cannot
be correct for anyone but their author. Putting them in the devc-only file also
makes the standalone invariant structural rather than conventional: `devc config`
has no code path that writes `.devcontainer/` at all, so there is nothing to
audit. The target is an existing overlay if there is one (in
`findProjectOverlayPath` order), else `.devcontainer/devc.jsonc` when that
directory exists, else `.devc/devc.jsonc`.

The consequence is that the infra mounts, `Dockerfile`, and lifecycle scripts
are written exactly once — by `devc init` — and `devc config` cannot disturb
them. There is no migration from the era when the fences lived in
`devcontainer.json`; those blocks are deleted by hand.

**Mount spec vocabulary.** Overlay mounts land in the merged config's `mounts`
array, so the full `devcontainer.json` vocabulary applies — `readonly`,
`consistency`, object form, any field order. That was not always true: they used
to become `devcontainer up --mount` args, whose grammar is a strict subset with
no `readonly` at all, and devc validated against the CLI's own regex so a
rejected spec could name the file. All that is left of that check is a shape
test (an entry must name a target), for the sake of a better error than
Docker's.

**What the wizard writes is still read-write**, deliberately: this change makes
a read-only skills mount _expressible_, and turning one on is a behavior change
to overlays people already have. That is its own follow-up, not a side effect of
the merge.

### Configuration precedence

One effective `devcontainer.json` is produced per project by merging four
layers, lowest to highest, and written to
`~/.cache/devc/projects/<key>/devcontainer.json`:

1. **devc's own layer** — the baseline Features, and the devc-bridge token mount
   when something opts into that Feature. Lowest, so everything else can
   override it.
2. **The base config**, first hit wins — `PATH/.devcontainer/devcontainer.json`,
   `PATH/.devcontainer.json`, else the materialized default (the bundled
   `devcontainer.json` + `Dockerfile`, with any same-named file from
   `~/.config/devc/templates/` overriding it per file). Once a project has its
   own config — scaffolded by `devc init` or hand-written — subsequent commands
   automatically use it.
3. `~/.config/devc/devc.jsonc`, else `~/.config/devc/devc.json`
4. `PATH/.devc/devc.jsonc`, `.devc/devc.json`, `.devcontainer/devc.jsonc`,
   `.devcontainer/devc.json` — first hit only, the rest are not consulted

An overlay may set **any `devcontainer.json` key**, plus the devc-only
`baselineFeatures`. Objects merge recursively per key, arrays append, `null`
deletes, a layer's `"$replace": ["key"]` opts that key out of merging, and
anything else is replaced by the higher layer. Then `mounts` dedupe by target
(highest wins, position preserved) — which is what lets an overlay _replace_ a
mount the base config declares rather than collide with it — and
`customizations.vscode.extensions` dedupe by id.

One exception: `baselineFeatures` is `user && project` (a veto, not
"project wins").

**Delivery** differs by which base won, and the difference is load-bearing:

- **Project mode** → `--override-config`. The CLI takes the config's content
  from the merged file but still records the project's own config as its path,
  so relative `build.dockerfile`/`context`/`dockerComposeFile` and local
  Features resolve where the project meant them to, `.devcontainer-lock.json` is
  still found beside it, and the container keeps the identity labels it has
  always had.
- **Zero-config** → `--config`. The merged file is the config path for every
  purpose, so `build.dockerfile` and `build.context` are rewritten to absolute
  paths into the materialized default tree. Deliberately _not_
  `--override-config`: that would record `<project>/.devcontainer/devcontainer.json`
  — the same identity a later `devc init` produces — so devc would silently
  reuse the zero-config container for a project that had since gained its own
  config.

The merged file's path is stable per project because container identity depends
on it: the devcontainer CLI keys a container on `devcontainer.local_folder` +
`devcontainer.config_file` and will not reuse one whose `config_file` differs,
without removing it even under `--remove-existing-container`. A path that moved
would strand a container per move.

Both project overlay locations are first-class and behave identically.
`.devcontainer/devc.json` often suits a gitignored local override — one file to
ignore, beside the config it overlays — and `.devc/` suits a repo that prefers
`devc`'s files grouped in one place.

### Bundled default: baseline via devcontainer Features

`devc`'s create-time baseline is delivered entirely by devcontainer Features
now, not by a devc-owned orchestrator script. Two are declared statically in
the bundled `devcontainer.json`, the same way `bash-config`/`node-nvmrc`
already are:

- **[`agents`](../../features/agents/README.md)** — installs the Claude Code
  (and optionally Copilot) CLI at build time, then at create time links the
  `~/.claude` seed and folds `~/.claude.json` into the same volume.
- **[`git-container-config`](../../features/git-container-config/README.md)**
  — re-applies user-scope git settings (identity include, LFS filters,
  `worktree.useRelativePaths`, `safe.directory`) on every create.

A third, **[`devc-config`](../../features/devc-config/README.md)**, is
contributed _dynamically_ to every container `devc` starts as the lowest layer
of the merge (see `overlay.ts`'s `devcContributions`, and
[devc/README.md's Project post-create hook section](../../devc/README.md#project-post-create-hook-devc-post-createsh))
rather than declared in the bundled config — it runs the project's own
`devc-post-create.sh`, and also carries devc's own prompt/title/`DEVC_ATTACH`
`~/.bashrc` block (the `devc:bashrc-additions` fence), which used to live in a
devc-owned `scripts/bashrc-additions.sh`.

`devc-config`'s manifest orders itself after the other two via
`installsAfter: ["…/agents", "…/git-container-config"]`, so `.claude` + seed
links and git identity are already in place by the time its hook (and the
bashrc block) run — the phase-level `onCreateCommand`-before-`postCreateCommand`
trick a prior design used no longer applies once every step is a Feature
competing in the same phase; `installsAfter` is the lever that does.

The `.devcontainer/` layout that is left follows from what remains: the
bundled `Dockerfile` (base image + `ripgrep` only — a preference, not a
dependency, kept only until it is removed by hand) and the one host-side
lifecycle entry script, `initialize-command.sh`, which `initializeCommand`
still runs on the **host**, before the container exists, to seed the
`~/.claude` mount source and extract git identity into
`~/.config/devc/gitconfig-identity`. There is no create-time orchestrator on
the container side any more — no `post-create.sh`, no `scripts/`, no
`onCreateCommand` — so a developer who wants a devc-owned create-time step
back adds `onCreateCommand` + a script, which is cheap to redo but not worth
keeping inert in the meantime.

**Shell customization is still a distinct tier — shell-start time — but it
runs through `bash-config`'s own `containerEnv`-declared sourcing now, not
through a devc-owned append.** `bash-config` sources every `*.sh` from
`/usr/local/share/devc-features/bash-config/dirs/user` (the host's
`~/.config/devc/shell`, bind-mounted read-only) and the project's own
`.devcontainer/shell/`, entirely independent of `devc-config`'s
`devc:bashrc-additions` fence — the two are unrelated Features, and neither
depends on the other's presence or ordering.

**Edits to the baseline now mean editing a Feature, not a project-local
script.** There is no in-project copy of the baseline to hand-edit the way
`post-create.sh`/`scripts/` used to be — `agents`, `git-container-config` and
`devc-config` are consumed as published, at the floating `:0` tag (`:0.2.0`
exact-pinned for `devc-config`, since devc forces it on every container it
starts with no opt-in). A user who wants different behavior overrides
`~/.config/devc/templates/devcontainer.json` to change which Features (or
options) the bundled config declares — the same sparse-overlay mechanism that
already applies to every other bundled file.

Consequences for the generated config:

- The bundled default `devcontainer.json` carries `agents` and
  `git-container-config` directly in `features`; the ghcr feature list
  (deno/go/node/python) is unchanged. Neither `onCreateCommand` nor
  `postCreateCommand` appears at the top level.
- The bundled `Dockerfile` holds only the base image and `ripgrep` — nothing
  in it is a dependency any Feature or devc itself relies on, deliberately, so
  removing it later (a manual step, not scheduled) changes only which base
  image is used.

### Host `~/.claude` config: the seed directory

The user's Claude config reaches the container through **one read-only directory
bind mount** of `~/.config/devc/.claude` onto the `agents` Feature's fixed
seed path, not through per-file bind mounts of `~/.claude/*`. That Feature's
own `post-create.sh` then symlinks every top-level _file_ from the seed into
the `~/.claude` volume, pruning links whose seed file has gone away.

Why a directory plus symlinks rather than per-file binds or a copy:

- **Per-file binds assume the files exist.** `mounts` takes Docker `--mount`
  semantics, where a missing bind source is a hard create-time error (unlike
  `-v`, which auto-creates a directory). A user lacking any one file could not
  create a container. A directory source can always be created ahead of time,
  and an empty one is valid.
- **Symlinks, not copies.** `~/.claude` is a persistent per-workspace volume, so
  a copy would be additive — a file deleted on the host would survive in the
  container forever, and recovering deletion would need a manifest of what was
  copied. Symlinks make deletion fall out of pruning, and preserve the live-edit
  and read-only semantics of the original binds along with host file modes.
- **Files only; directories ignored.** The `devc:skills` fence mounts per-skill
  binds under `~/.claude/skills/`, and Docker materializes that intermediate
  directory at create time — before `postCreate` runs. Linking or copying a seed
  `skills/` over it would silently nest, or fail on a busy mountpoint or a
  read-only bind. Ignoring directories removes the whole class of conflict;
  directory-shaped config is added later as its own fence, not by recursing
  here.

The part of the baseline that has to run **before** mounts are established is
`initializeCommand`, which runs `initialize-command.sh` to create the seed mount
source on machines without `devc` (`--mount type=bind` errors on a missing
source). It is the only host-side lifecycle hook — the container-side hooks all
run after mounts are established, structurally too late — so it sits top-level
in the bundled default and is single-valued (a `devcontainer.json` key, not a
Feature); a project overriding it keeps the call or drops the seed mount with
it. Because it
runs on the _host_, the config references the script via
`${localWorkspaceFolder}/.devcontainer/initialize-command.sh` — correct for a
project whose own `.devcontainer/` holds it; in the zero-config path, where the
workspace is the user's project (no `.devcontainer/`),
`materializeDefaultConfig` rewrites that one host path to the cache copy (the
keyed one it will end up in, not the staging directory it is written to). This
is the _only_ transform applied to the materialized config. `devc` also calls
`ensureClaudeSeedDir` on every `up`, which owns what a shell one-liner cannot:
the not-a-directory guard and the created-it-just-now notice — so in the
`devc`-driven path the hook is belt-and-suspenders. The directory is created
empty and nothing is ever copied into it from the host's real `~/.claude`:
whether a machine's personal `CLAUDE.md`/`settings.json` should reach every
container is the user's decision, expressed by putting the file there.

## Global user configuration

The first time any `devc` command is executed, the tool enters a one-time
**global config mode** before running the requested command. This mode prompts
the user for:

- **Code folder roots** — one or more directories where code projects live.
- **Skills folder roots** — one or more directories where agent skills live.

These values are saved as lists in a global config file at
`~/.config/devc/config.json`. Once that file exists, the global config prompt no
longer runs automatically before other commands. The user can re-run it later
via `devc config` (global settings step) if they want to change the root lists.

Example global config:

```json
{
  "codeRoots": ["~/code", "~/work"],
  "skillsRoots": ["~/.agents/skills", "~/team-skills"]
}
```

**Namespace.** One namespace throughout: `devc` — binary name, container-name
prefix, image path under `/usr/local/share/devc`, and the global config
directory `~/.config/devc/` (a single code-level constant, `CONFIG_DIR`). An
earlier revision parked the config directory at `~/.config/devc-tui/` to avoid
colliding with other `devc` tooling; that is gone, and any doc still saying
`devc-tui` predates the move.

**No global template overrides for now.** The bundled default config is
materialized directly (embedded assets → a cache dir passed to
`devcontainer up --config`). There is no user-editable global template directory
in this version; customization happens per-project via `devc config`.
(Superseded twice since: `~/.config/devc/templates/` is that global overlay, and
the cache dir is now content-addressed — `~/.cache/devc/default-<key>/`, keyed on
the bundled tree, the templates overlay and the bridge flag, written once per
distinct key and never rewritten. See
[`../archived/devc-core-consumer-prep.md`](../archived/devc-core-consumer-prep.md).)

## First-run flow

1. User runs `devc <command>` for the first time.
2. If `~/.config/devc/config.json` does not exist, the TUI global config prompt
   appears.
3. User adds one or more code roots and one or more skills roots.
4. The global config file is saved.
5. The originally requested command continues.

## `config` (TUI)

The `config` command is the first TUI feature. It opens an interactive wizard
for configuring the dev container of the current project.

```text
Usage: devc config [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

### Wizard layout

The flow is **picker-driven and sequential**, not a sidebar wizard: the
folder-selection steps each take the full screen, and the surrounding steps
(overview, review, confirm, rebuild prompt) are ordinary inline prompts on the
normal screen, the way a shell tool scrolls. The reference frames live in
`.plans/design/wizard/` and are authoritative for the picker screens.

A picker screen is:

- **Banner** — line 1, uppercase: `WORKSPACE CONFIG` (project steps) or
  `GLOBAL CONFIG` (roots).
- **Picked list** — a Title Case heading (`Source Folders`, `Skills`,
  `Source Folder Roots`, `Skills Folder Roots`) over the absolute paths ticked
  so far.
- **Browser** — an `Add …` heading (`Add Source Folders`, `Add Skills`,
  `Add Roots`) carrying the current directory, a `>` filter line, then the
  subfolders of that directory.
- **Footer** — one full-width rule and a key legend for whichever list holds the
  cursor.

The two lists are separated by whitespace, not rules or boxes, and neither is
styled by focus — the `▸` row cursor alone says which one the keys drive.

Markers: `◯` not picked · `◉` picked · `◎` mounted regardless of the selection
(the project folder — see Step 2). Keys:

- `↑` / `↓` — move; `↑` off the top of the browser steps into the picked list,
  `↓` off its bottom returns (`Tab` toggles too).
- `→` open a folder · `←` (or backspace on an empty filter) go up · type to
  filter.
- `Space` — tick/untick in the browser; remove in the picked list.
- `Enter` — done with this step · `Esc` — cancel the flow.

### Starting the wizard

When the user runs `devc config [PATH]`:

1. Resolve the project directory (`PATH` or cwd).
2. If `~/.config/devc/config.json` is missing, run the **Global config** step
   first and persist the code/skills root lists.
3. Resolve the overlay to write (`resolveProjectOverlayTarget`) and load its
   current contents into memory, or start from an empty selection when there is
   no overlay yet.
4. Proceed to the **Project overview** step.

### Step 1: Project overview

Two inline lines before the first picker: the overlay path being written, and
whether this run is creating a new overlay or updating the existing one.

### Step 2: Source code mounts

The current project directory is always mounted as the devcontainer workspace.
This step lets the user add **extra source code folders** that should also be
available inside the container.

- Screen `WORKSPACE CONFIG` / `Source Folders` / `Add Source Folders`, opening
  on the configured **code folder roots**. The roots are shortcuts, not
  boundaries: `←` walks above a root like any other folder, and at the
  filesystem root it wraps back to the shortcut list, so any folder on the
  machine can be mounted. The roots themselves are not selectable — tick one
  from its parent.
- The **project folder is pinned** at the head of the picked list with `◎` and
  the note "this project (always mounted)", and is inert in the browser — the
  container binds it either way, so ticking it would only add a second bind on
  the same target. It is not written to the fence.
- Container paths are derived, not edited: `/workspaces/<basename>`, keeping the
  folder's sub-path under the code root it falls under (so `~/code/a/b` →
  `/workspaces/a/b`). Source mounts are read-write. Duplicate container paths
  are skipped with a note.
- A picked **git worktree** additionally contributes a mount of its primary
  repo's `.git`. Both container targets mirror from one shared base — the
  configured code root when it holds the primary, otherwise the worktree/primary
  **common ancestor** (what the devcontainer CLI does for a worktree opened as
  the project folder) — so the worktree's relative `gitdir:` link still resolves
  inside the container. A worktree whose `gitdir:` is _absolute_ cannot work
  whatever is mounted, and is flagged inline in the browser instead.
- That primary `.git` mount is **shown in the picked list the moment its
  worktree is ticked** (and on the first frame for a worktree pre-ticked from
  the fence), indented under the worktree that requires it, marked `◎` with the
  note "required by worktree `<name>`". Like the pinned project folder it is
  inert — the picks cursor steps over it, so it cannot be unticked while a
  worktree needing it is picked; unpicking the last such worktree removes it.
  Two worktrees of one primary show the row once, under the first of them, and
  picking the primary's whole working tree removes it (that mount already covers
  the `.git`). Because the wizard writes that mount into the same fence it
  reads, reopening a config preselects it _and_ re-derives it — the pick is
  **absorbed** into the derived row, so the path is listed once, and it is inert
  in the browser as well.

### Step 3: Skills mounts

Configure which agent skills folders are mounted into the container. Skills are
**opt-in**: the bundled zero-config default mounts no skills, so a project gets
skills only after they are configured here.

- Screen `WORKSPACE CONFIG` / `Skills` / `Add Skills`, opening on the configured
  **skills folder roots** — shortcuts, with the same free navigation as Step 2.
- Container paths are derived, not edited: `~/.claude/skills/<basename>`.
  Duplicate container paths are skipped with a note. The mount is read-write:
  `devcontainer up --mount` has no read-only form (see "Mount spec
  vocabulary"), and the review says so before anything is written.
- **Remembered selection.** When the wizard applies, the resulting skills list
  is persisted as the user's _most recent_ skills selection. A **new** project's
  Skills step is pre-seeded from that remembered list (entries whose host path
  no longer exists are dropped), so a user who mounts the same skills across
  projects does not re-pick them every time. Reconfiguring an existing project
  seeds from that project's own `devc:skills` fence instead. (Source mounts are
  not remembered — they are project-specific — so Step 2 starts empty for new
  projects.)

### Step 4: Review & apply

An inline summary printed before anything is written to disk: the serialized
contents of the two managed fences (`devc:source`, `devc:skills`) — the only
regions the wizard writes — with the implicitly mounted project folder listed
above the source rows so an empty fence never reads as "no source mounts", and a
note that overlay mounts are read-write. Then a single `Apply? [Y/n]` confirm;
declining writes nothing.

When the user accepts:

1. **First creation** (no overlay anywhere in the project): seed
   `.devcontainer/devc.jsonc` — or `.devc/devc.jsonc` when the project has no
   `.devcontainer/` — with a minimal object carrying an empty `mounts` array,
   creating the parent directory, then splice both fences into it.
2. **Update in place** (an overlay exists): rewrite only the `devc:source` and
   `devc:skills` fence contents; preserve everything else byte-for-byte
   (hand-written mounts, `features`, `remoteEnv`, comments, unknown
   keys).
3. Persist the applied skills list as the remembered selection (see Step 3).
4. Report whether the overlay actually changed, and offer a rebuild when it did
   (see below).
5. Return to the shell with a success message.

Nothing in this sequence reads or writes `.devcontainer/`.

### Rebuild prompt

Mounts are bound at container-create time, so a config change is inert until the
container is recreated. `config` therefore ends by comparing the bytes it would
write against the bytes already on disk — an exact comparison that needs no
separate model diffing — and reports one of three outcomes:

| Situation                                | Message                                                                                 | Prompt                |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| Text identical to what is on disk        | `No config changes — no rebuild needed.`                                                | none                  |
| Changed, container `running` / `stopped` | `Config changed — the dev container must be rebuilt for the new mounts to take effect.` | `Rebuild now? [Y/n]`  |
| Changed, container `missing`             | `No dev container exists for this project yet.`                                         | `Build it now? [Y/n]` |

Accepting runs the same recreate as [`build`](#build) and prints its summary
line; declining prints a reminder to run `devc build` later. A failed rebuild is
reported but does not fail `devc config` — the config was still written.

The "no changes" case is the point of the comparison: a user who ticks a folder
off and back on, or re-runs `config` and confirms the same selection, ends at
byte-identical text. That is not a change, the file is not even rewritten (its
mtime does not move), and no rebuild is offered. Only genuine edits prompt, so
the prompt stays meaningful.

Global roots (`devc config --global`) never prompt — `codeRoots`/`skillsRoots`
and the remembered skills list scope the pickers and do not affect the
container.

If the user selects **Cancel** or quits, no files are written and the in-memory
changes are discarded.

### Reconfiguring a project

Running `devc config` again on a project that already has an overlay reads its
`devc:source` / `devc:skills` fences to recover the current selection, lets the
user edit it, and on Apply rewrites only those fences. Everything else in the
overlay is preserved and never re-asserted (see "No hidden abstraction").

Fences left in a `devcontainer.json` by an older `devc` are **not** read and not
migrated — delete them by hand, or their mounts are applied on top of the
overlay's (a matching target fails create with Docker's `Duplicate mount point`;
a differing one just mounts the folder twice).

## Top-level help

```text
$ devc --help
Usage: devc [OPTIONS] <COMMAND>

Options:
  -h, --help     Print help
  -V, --version  Print version

Commands:
  init     Scaffold the default dev container config into the project
  config   Configure the dev container for the current project (TUI)
  attach   Attach to the dev container for the current project
  claude   Launch Claude inside the dev container for the current project
  copilot  Launch GitHub Copilot CLI inside the dev container for the current project
  pi       Launch pi inside the dev container for the current project
  herdr    Launch herdr inside the dev container for the current project
  up       Start the dev container for the current project
  build    Rebuild the dev container for the current project
  exec     Execute a command inside the dev container for the current project
  mounts   List container mounts for the current project
  stop     Stop the dev container for the current project
  down     Remove the dev container for the current project
  status   Show dev container status for the current project

Run "devc <COMMAND> --help" for more information on a command.
```

## `init`

Write the bundled default `.devcontainer/` into the project and exit — the same
scaffolding [`config`](#config-tui) does on first creation, without the TUI and
without the two managed mount fences. It is the non-interactive way to get the
baseline on disk to hand-edit, for a user who wants the files rather than the
picker.

```text
Usage: devc init [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

Writes `devcontainer.json` verbatim from the bundled default (comments
preserved) plus `Dockerfile`, `post-create.sh`, `initialize-command.sh` and
`scripts/`, with the two entry scripts and every `scripts/*.sh` made executable
— one shared `installBundledAssets` does the asset half for both `init` and
`config`, so the two cannot drift. No fences are written: `config` inserts them
into a fence-less config when the user later picks mounts.

**Refuses to clobber — `.devcontainer/` must be missing or empty.** Two guards,
each writing nothing and exiting 1:

- An existing devcontainer config, in _either_ location —
  `.devcontainer/devcontainer.json` or a root `.devcontainer.json`. Both count
  because creating the directory form beside an existing root form would leave
  two configs and make which one applies ambiguous. The message points at
  `devc config`, which adds mounts to a project that already is a dev
  container.
- _Any_ other content in `.devcontainer/` — a file, a subdirectory, a dotfile —
  reported with what was found.

The second guard is deliberately stricter than "don't overwrite what I provide".
`installBundledAssets` replaces exactly the bundle's own paths, so a laxer rule
would silently overwrite a hand-written `Dockerfile` or `scripts/*.sh` _and_
leave everything the bundle does not cover sitting there as stale debris — a
`.devcontainer/` that is half old config, half new, with no signal that it
happened. Requiring an empty directory makes the postcondition exact: what
`init` leaves behind is the bundle and nothing else. An empty directory is
accepted, since there is nothing to lose and someone may simply have `mkdir`'d
it.

**Non-interactive by construction.** `init` never prompts, never offers a
rebuild, and is dispatched _before_ the first-run global-config hook, so a user
with no `~/.config/devc/config.json` is not sent through the roots wizard for a
command that has no use for roots.

## `attach`

Attach to the dev container for the project in the current working directory.

- If the container is not running, `devc` creates/starts it first and then
  attaches.
- If the container is already running, it attaches immediately.

```text
Usage: devc attach [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --build      Force a rebuild before attaching
      --no-clear   Do not clear the screen before starting the TUI
  -h, --help       Print help
```

On attach, `devc` drops into an interactive login shell in the container. It
does **not** offer tmux or terminal control-mode (`--tmux` / `--CC`) attach
modes — these are intentionally out of scope (see Implementation notes). The
attach retains the terminal-quality behaviors described in Implementation notes
(terminal identity propagation, session-distinguishing tint).

## `claude`

Launch Claude inside the dev container for the project in the current working
directory, creating/starting the container if necessary.

```text
Usage: devc claude [PATH] [EXTRA_ARGS...]

Arguments:
  [PATH]         Path to the project (default: current directory)
  [EXTRA_ARGS]   Additional arguments forwarded to Claude

Options:
  -h, --help     Print help
```

## `copilot`

Launch the GitHub Copilot CLI inside the dev container for the project in the
current working directory, creating/starting the container if necessary. Same
shape as [`claude`](#claude), for the `copilot` binary the
[`agents` Feature](../../features/agents/README.md) optionally installs
(`installCopilotCli`).

```text
Usage: devc copilot [PATH] [EXTRA_ARGS...]

Arguments:
  [PATH]         Path to the project (default: current directory)
  [EXTRA_ARGS]   Additional arguments forwarded to Copilot

Options:
  -h, --help     Print help
```

## `pi`

Launch the pi coding agent CLI inside the dev container for the project in the
current working directory, creating/starting the container if necessary. Same
shape as [`claude`](#claude), for the `pi` binary the
[`agents` Feature](../../features/agents/README.md) optionally installs
(`installPiCli`).

```text
Usage: devc pi [PATH] [EXTRA_ARGS...]

Arguments:
  [PATH]         Path to the project (default: current directory)
  [EXTRA_ARGS]   Additional arguments forwarded to pi

Options:
  -h, --help     Print help
```

## `herdr`

Launch the Herdr terminal multiplexer inside the dev container for the project
in the current working directory, creating/starting the container if
necessary. Same shape as [`claude`](#claude), for the `herdr` binary the
[`agents` Feature](../../features/agents/README.md) optionally installs
(`installHerdr`).

```text
Usage: devc herdr [PATH] [EXTRA_ARGS...]

Arguments:
  [PATH]         Path to the project (default: current directory)
  [EXTRA_ARGS]   Additional arguments forwarded to herdr

Options:
  -h, --help     Print help
```

## `up`

Start the dev container for the project in the current working directory.

```text
Usage: devc up [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --json   Output container status as JSON
  -h, --help   Print help
```

## `build`

Recreate the dev container for the project in the current working directory,
without attaching.

Bind mounts are established when a container is **created**, so a
`devcontainer.json` change only takes effect after a recreate — `build` is that
operation (`devcontainer up --remove-existing-container`), not an image-only
build. `--no-cache` additionally passes `--build-no-cache` for the case where
the image itself must be rebuilt from scratch (a changed base image, a stale
layer).

```text
Usage: devc build [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --no-cache   Rebuild the image without the Docker layer cache
      --json       Output container status as JSON
  -h, --help       Print help
```

Output matches `up`:
`<containerId> running — workspace <remoteWorkspaceFolder>`, or the
`ContainerInfo` JSON with `--json`. `attach --build` performs the same recreate
before attaching.

## `exec`

Execute a command inside the dev container for the project in the current
working directory, creating/starting the container if necessary.

```text
Usage: devc exec [PATH] [OPTIONS] -- <CMD...>

Arguments:
  [PATH]          Path to the project (default: current directory)
  <CMD>...        Command (with arguments) to execute in the container

Options:
      --cwd <DIR>   Working directory inside the container
      --env K=V     Environment variable(s) to set (repeatable)
  -h, --help        Print help
```

## `mounts`

List container mounts for the project in the current working directory.

```text
Usage: devc mounts [PATH] [OPTIONS]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
      --json   Output mounts as JSON
  -h, --help   Print help
```

## `stop`

Stop the dev container for the project in the current working directory.

```text
Usage: devc stop [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## `down`

Remove the dev container for the project in the current working directory.

```text
Usage: devc down [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## `status`

Show dev container status for the project in the current working directory.

```text
Usage: devc status [PATH]

Arguments:
  [PATH]  Path to the project (default: current directory)

Options:
  -h, --help  Print help
```

## Implementation notes

These behaviors are part of the intended implementation even though most are
invisible in normal use. They are carried over from prior art and kept
deliberately.

**Kept — terminal quality on `attach`/`claude`:**

- **Terminal identity propagation.** `docker exec -t` hardcodes `TERM=xterm` and
  strips the host's terminal identity. `devc` forwards `TERM`, `TERM_PROGRAM`,
  and `TERM_PROGRAM_VERSION` (each only when set on the host) so key handling
  negotiated against the outer terminal (e.g. shift+enter) keeps working inside
  the container.
- **Session-distinguishing tint.** For the lifetime of an attach, the terminal
  is tinted so a container shell reads as visually distinct from a local one,
  and reset on detach.
- **First-prompt clear.** A plain attach clears the noisy shell-init output on
  the first prompt (suppressible with `--no-clear`).

**Kept — container lifecycle correctness:**

- **Git worktree mounting** (`--mount-git-worktree-common-dir`) with a matching
  container-side workspace path.
- **Deterministic container naming** (`devc-<basename>-<hash>`) and an image
  alias tag, reconciled best-effort after `up` and never fatal.

**Dropped:**

- **tmux and control-mode attach** (`--tmux`, `--CC`). The prior art supported
  attaching via an in-container tmux session and iTerm2/WezTerm control mode;
  `devc` only does a plain interactive login shell.

## Self-containment

`devc` is fully self-contained. At runtime it depends only on external CLIs it
shells out to — `docker`, `devcontainer` (`@devcontainers/cli`), and `git` —
plus its own embedded assets (the bundled default `devcontainer.json`,
`Dockerfile`, `post-create.sh`, `initialize-command.sh`, and `scripts/`). The
embedded assets ship inside the binary (`deno compile --include`), so no part of
the tool reaches outside the repository or the installed binary to find
configuration or scripts it needs.
