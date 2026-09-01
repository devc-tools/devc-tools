# node-nvmrc (devcontainer Feature)

Makes the Node version your workspace pins in `.nvmrc` the version **every process
in the container** gets — `bash -c`, `sh -c`, `docker exec`, an agent CLI, a task
runner, an editor extension.

It does **not** install Node or nvm. It drives an nvm that is already in the image;
see [What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": {},
  "ghcr.io/devc-tools/features/node-nvmrc:0": {}
}
```

No options, nothing host-side. `.nvmrc` is read from the workspace, and everything
else is written inside the container. One mount, which the Feature declares itself
— see [The `node_modules` volume](#the-node_modules-volume).

> The tag tracks **this Feature's** version line, not the repo's — Features
> version independently of the devc-tools release tag. It is `:0` while this
> Feature is pre-1.0; it becomes `:1` at its first 1.x release.

## New in 0.2.0: the `node_modules` volume is declared, not pasted

This Feature now declares its own `node_modules` volume, so persistence needs no
mount line in your `devcontainer.json`. It is keyed on `${devcontainerId}` and sits
at the workspace root — it **cannot** follow `projectDir`, and the create-time hook
warns when you set one. Full detail:
[The `node_modules` volume](#the-node_modules-volume).

## Earlier: the `autoUseOnCd` removal (breaking)

> Numbering note: the prose below calls this "0.2.0", which is what it was named
> before this Feature moved repos and was renumbered — it shipped as **0.1.0**, the
> first version published under `ghcr.io/devc-tools`. The section above is the real
> 0.2.0. `projectDir`, introduced with the removal, is 0.1.0 too.

**`autoUseOnCd` is gone, along with the `~/.bashrc` block it appended and the `cd`
override inside it.** Not deprecated, not defaulted to `false` — removed. A config
that still passes the option gets the CLI's unknown-option behavior, which is the
honest signal.

Why: that block reached **only interactive bash**. `~/.bashrc` opens with the stock
`case $- in *i*) ;; *) return;; esac` guard, so `bash -lc`, `sh -c`, `docker exec`
and every task runner got nothing from it — and the consumers that matter most here
are neither interactive nor bash. A coding-agent CLI's tool shell is typically a
non-interactive shell inheriting a PATH frozen when the CLI launched, so it saw one
Node version for its whole session no matter where it `cd`'d.

Worse, the `cd` hook fought the thing this Feature exists to do. `nvm use` rewrites
`$NVM_DIR/current`, which is **container-global** state — a `nvm use` in one
subshell was measured moving it for every other process in the container.

So the shell half is replaced by a mechanism that needs no shell at all: this
Feature declares its own `containerEnv` PATH entry, and its create-time hook points
a symlink at the pinned version. **Per-directory switching is dropped as a goal**,
not half-served — see [projectDir](#projectdir--which-project-is-the-pin) for what
replaces it in the case that actually comes up.

Introduced alongside it: **`projectDir`**, for a repo whose Node project is not at
the workspace root.

## Prerequisite: something has to provide nvm

The default `nvmDir` is `/usr/local/share/nvm`, which is where
[`ghcr.io/devcontainers/features/node`](https://github.com/devcontainers/features/tree/main/src/node)
puts nvm — so the two lines above are the whole setup. Any other source works too:
point `nvmDir` at it.

**If nothing provides nvm, the container still creates.** The create-time step warns
on stderr, naming the directory it searched, and exits 0:

```
node-nvmrc: /workspaces/yours/.nvmrc found, but there is no nvm at /usr/local/share/nvm.
node-nvmrc: add a Feature that provides one (ghcr.io/devcontainers/features/node),
node-nvmrc: or set this Feature's 'nvmDir' option. Nothing was installed.
```

That is deliberate: failing the create over a missing prerequisite turns a one-line
misconfiguration into a container you cannot open to fix it. No symlink is created,
so the PATH entry is inert and `node` resolves to whatever else provides it.

`nvm install` **failing** is a different matter and _is_ fatal. Your `.nvmrc` asked
for a version that could not be installed, and a container that quietly comes up on
the wrong Node is worse than one that fails while you are still watching the log.

## Why `installsAfter` and not `dependsOn`

`dependsOn` would install `ghcr.io/devcontainers/features/node` for you — with
_this_ Feature choosing its `version`, `pnpmVersion` and `nvmVersion`, which are
exactly the things you want to choose. So the prerequisite is documented rather than
imposed, and `installsAfter` only orders this Feature behind the node Feature when
you have asked for both.

That ordering now carries weight it did not in 0.1.0: it puts this Feature's `ENV`
line after the node Feature's, so this Feature's PATH entry lands **in front of**
`$NVM_DIR/current/bin`. See [Precedence](#precedence).

Nothing here needs nvm to exist at build time either, so providing it some other way
works.

## What it does

At **build time** (as root) it places two things and touches nvm not at all:

- `/usr/local/share/devc-features/node-nvmrc/post-create.sh`, with the options baked
  in — the manifest's `postCreateCommand` takes no arguments, so that is how they
  cross over.
- `/usr/local/share/devc-features/node-nvmrc/pin/`, an empty directory owned by the
  remote user. The manifest's `containerEnv` puts `pin/bin` on `PATH`.

Nothing is appended to any startup file. `~/.bashrc` is not touched.

At **create time** (as the remote user, before any `postCreateCommand` your own
`devcontainer.json` declares) `post-create.sh`:

1. changes to the project directory — the workspace root by default
   (`$PROJECT_PATH` if set, else the cwd the devcontainer CLI gave the hook), or
   wherever [`projectDir`](#projectdir--which-project-is-the-pin) points;
2. exits 0 **silently** if there is no `.nvmrc` there and `projectDir` was left
   alone, so the Feature is safe to leave enabled in a repo that pins nothing;
3. loads nvm, or warns and exits 0 as above;
4. repairs `./node_modules` ownership, best-effort (below);
5. runs `nvm install`, which installs the pinned version and — because it runs
   `nvm use` implicitly — exports `NVM_BIN` as that version's `bin` directory;
6. points `pin/bin` at `$NVM_BIN`, which is what makes the PATH entry live;
7. best-effort, sets nvm's own `default` alias to the pinned version, so nvm's state
   does not disagree with PATH. A failure here warns and does not fail the create.

No version string is ever extracted. `nvm install` runs with no arguments, so nvm's
own parser reads `.nvmrc` — comments and `key=value` lines included.

| Option                    | Default                | Meaning                                                                                                           |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `nvmDir`                  | `/usr/local/share/nvm` | Directory holding `nvm.sh`.                                                                                       |
| `projectDir`              | `""` (workspace root)  | The directory that **is** the Node project: where `.nvmrc` is read and where `node_modules` is repaired.          |
| `installOnCreate`         | `true`                 | Run `nvm install` for the project's `.nvmrc` at create time. `false` creates no symlink, so the Feature is inert. |
| `fixNodeModulesOwnership` | `true`                 | `chown` an existing `./node_modules` to the create-time user before installing.                                   |

### What reaches what

Everything. That is the whole point of 0.2.0.

| Invocation                                     | Sees the pin |
| ---------------------------------------------- | ------------ |
| `bash -c 'node -v'`                            | yes          |
| `sh -c 'node -v'`                              | yes          |
| `bash -lc` / `bash -ic` / a real terminal      | yes          |
| `docker exec <container> node -v`              | yes          |
| an agent CLI's tool shell (zsh, fish, `sh`)    | yes          |
| an editor extension host, a task, a `Makefile` | yes          |

The mechanism is a `containerEnv` PATH entry — the same one the upstream node
Feature uses to put `$NVM_DIR/current/bin` on PATH — so it reaches PID 1's
environment and is inherited by everything, with no startup file, no shell language
and no interactivity involved.

### Precedence

- **Container-wide, the pin wins.** `pin/bin` sits ahead of `$NVM_DIR/current/bin`,
  so nothing a human's `nvm use` does to nvm's global symlink can override the
  workspace pin for other processes.
- **Inside one interactive shell, you still win.** `nvm use` prepends the
  _versioned_ directory to that shell's own PATH, ahead of `pin/bin`. It affects
  that shell and nothing else.
- **Interactive shells agree by default.** Images that source `nvm.sh` from
  `/etc/bash.bashrc` run `nvm_auto use`, which resolves the current version — which
  is now the pinned one, because `pin/bin` won — and re-selects it. No block in
  `~/.bashrc` is needed to make a terminal consistent with everything else.

### Editing `.nvmrc` means a rebuild

The symlink is written once, at create time. Change `.nvmrc` and the container keeps
the version it was created with until you rebuild (or recreate) it. There is
deliberately no `postStartCommand` re-pointing the symlink on every start: it would
add a second lifecycle hook and a start-time network call whenever the version is
absent.

Until then, `nvm use` in a shell still does what it always did, for that shell.

### `projectDir` — which project is the pin

Not every repo keeps its Node project at the workspace root. `projectDir` names the
directory that **is** the Node project, and the whole create-time hook runs there:
it is where `.nvmrc` is looked for and where `node_modules` is repaired. One
directory, one `cd`, both halves following it.

```jsonc
"ghcr.io/devc-tools/features/node-nvmrc:0": { "projectDir": "packages/app" }
```

- Workspace-relative by default; an **absolute** value is used as-is. Empty (the
  default) is the workspace root, which is 0.1.0's behavior exactly.
- It is a **directory, not a file**. There is deliberately no way to point at a
  differently-named version file: `nvm install` resolves `.nvmrc` by that name from
  its cwd and has no flag to override it, so an option that appeared to accept
  `.node-version` would silently install from something else.
- A `projectDir` that **does not exist** warns on stderr and exits 0. So does a
  `projectDir` with no `.nvmrc` in it — unlike the default, which stays silent,
  because you named a directory and silence would send you hunting for where Node
  came from.
- Both are still exit 0. A missing pin is not worth an uncreatable container.

**This is not monorepo support.** Exactly one `.nvmrc` is read, once, at create
time; `projectDir` chooses **which one**. A monorepo whose packages pin _different_
versions is out of scope — this Feature pins one version container-wide and does not
make it vary by directory.

**If you set it, mount your own `node_modules` volume where the project is.** The
Feature's declared volume cannot follow `projectDir` (see
[The `node_modules` volume](#the-node_modules-volume)), and the repair below does
follow it — so the declared volume at the workspace root is repaired by nothing
and written to by nothing, while your project's `node_modules` is an ordinary
directory. The create-time hook warns and prints the mount line. There is
deliberately no second option and no second chown target.

### The `node_modules` volume

**New in 0.2.0: this Feature declares it.** You no longer paste a mount line for
it:

```jsonc
{
  "type": "volume",
  "source": "node-modules-${devcontainerId}",
  "target": "${containerWorkspaceFolder}/node_modules"
}
```

Keeping `node_modules` in a named volume rather than the bind-mounted workspace
is what makes installs fast and keeps a Linux `node_modules` from colliding with
whatever your host put there. `${devcontainerId}` keys it per devcontainer — not
`${localWorkspaceFolderBasename}`, which collides whenever two workspaces share a
folder name (a `<repo>.worktrees/<branch>` layout names the folder after the
branch, so `main` in three repos is one name). The trade is that the volume name
is opaque and **moving the workspace on disk starts a fresh one** — one `npm ci`,
and the old volume is left behind untouched.

**It does not follow `projectDir`.** A Feature option cannot substitute into that
Feature's own `mounts` — measured, and it fails hard rather than silently: the
literal `${projectDir}` would reach Docker and be rejected
([`declared-volume-spike`](../../.plans/implemented/declared-volume-spike.md),
M2). So the volume is always at the workspace root. With `projectDir` set, the
create-time hook warns and gives you the line to paste:

```jsonc
"mounts": ["type=volume,source=node-modules-${devcontainerId},target=${containerWorkspaceFolder}/packages/app/node_modules"]
```

The one the Feature declares still lands at the root, where nothing writes to it.
That is the cost of a static manifest, and it is a warning rather than an error
because it is a misconfiguration, not an unbootable container.

**You cannot remove a declared mount — only override it.** Mounts merge keyed on
**target**, with your own `devcontainer.json` merged last, so declaring the same
target yourself wins with no duplicate and no error.

`npm ci` over the mounted volume is measured to work — it removes `node_modules`
before installing, and a mount point can be emptied but not unlinked, so `EBUSY`
was the risk. Two consecutive `npm ci` runs pass on npm 10.9.8, and the
`with_nvmrc` scenario keeps checking it, since nothing pins npm.

### The `node_modules` chown

`sudo -n chown -R "$(id -u):$(id -g)" ./node_modules`, guarded by `command -v sudo`
and `[ -d node_modules ]`, and best-effort (`2>/dev/null || true`).

It exists because a **named volume** mounted at the project's `node_modules` first
mounts root-owned, after which `npm ci` as the remote user cannot write into it.
As of 0.2.0 that volume is **this Feature's own**, so the repair is no longer
belt-and-braces for someone else's mount — it is what makes the Feature's own
declaration usable. (It stays portable: anyone who mounts a volume there, at a
`projectDir` path for instance, hits the same thing.) `declared-volume-spike`
reproduced the unrepaired case standalone: a bare mount comes up `root:root` and
`npm install` fails `EACCES` before it can get anywhere near the `EBUSY` question.

A volume is not the only way that directory can exist, and this is worth knowing
before you enable the option: a bind-mounted workspace can already carry a
`node_modules` from host-side development, an `onCreateCommand` or
`updateContentCommand` runs before this hook and may have installed one, and an
image can ship one. In those cases the `chown` fires on files that are not a volume.
It stays bounded the same way regardless: only `node_modules`, only when it already
exists, **never** the workspace itself, `sudo -n` so it cannot hang, and
`2>/dev/null || true` so it cannot fail the create. Set `fixNodeModulesOwnership`
to `false` if you would rather it never ran.

## What this is not

**`ghcr.io/devcontainers/features/node` installs Node and nvm. This Feature installs
neither.** It reads `.nvmrc` and drives the nvm that is already there. Use both: the
node Feature to get nvm and a baseline Node, this one to make the version your repo
pins the version you actually get.

An issue that says "the node feature" could mean either, so the two are worth naming
in full.

**`pin/bin` is not `$NVM_DIR/current`.** Both are "the symlink". nvm's is
container-global and is moved by _any_ `nvm use` in _any_ shell; this Feature's is
moved only by its own create-time hook. That is why the directory is called `pin/`
and not `current/`.

## Relationship to devc

The logic here was copied out of [devc](../../devc/README.md)'s baseline —
`devc-core/default/scripts/node-setup.sh` and the nvm lines in
`scripts/bashrc-additions.sh` — and generalized: no `vscode` user, no `PROJECT_PATH`
requirement, no assumption that nvm or `sudo` exist. Those devc copies still run
unchanged, **devc's own unconditional `cd` override included**; swapping devc onto
this published Feature is a separate change. Until then, enabling this Feature in a
devc container is redundant for the create-time half — though the two no longer
collide in `~/.bashrc`, since this Feature writes nothing there at all.

## Tests

No Docker needed:

```sh
bash features/node-nvmrc/test/install_options_test.sh
bash features/node-nvmrc/test/post_create_test.sh
```

`install_options_test.sh` runs the real `install.sh` against temp directories: all
four options through to the baked `post-create.sh`, the values that must **fail the
build** (a `"`, a backtick, a `$`, a `\` or a newline in `nvmDir` or `projectDir`),
the ones that must survive **verbatim** (`&`, `|`), the empty-`projectDir`
distinction, the user-owned `pin/`, that no startup file is written under any option
combination, and that all four files naming
`/usr/local/share/devc-features/node-nvmrc` still agree.

`post_create_test.sh` runs the real installed hook against a fake `nvm.sh`: the
symlink and its second-run idempotency, every `projectDir` resolution, and the
grading of each failure path.

Needs Docker and a network:

```sh
bash features/node-nvmrc/test/run-features-test.sh
```

The default scenario is the bare `{}` case on a base image with **no nvm in it**,
which is the hostile one. `test/scenarios.json` adds `with_nvmrc`, `no_nvmrc`,
`project_subdir` and `pin_outranks_current` — that last one is the only test that
can isolate the `containerEnv` merge ordering, since every other scenario would pass
even if this Feature's PATH entry landed _behind_ `$NVM_DIR/current/bin`.

Those scenarios write their `.nvmrc` from their own `onCreateCommand` (which runs
before every `postCreateCommand`), because `devcontainer features test` generates the
workspace folder itself and copies the test directory in only after the container is
created — there is no committed fixture that could be in place when the hook looks.

### The cwd of a Feature-declared `postCreateCommand`

`post-create.sh` uses `${PROJECT_PATH:-$PWD}`, and the `$PWD` half carries a
consumer who is not devc. In the devcontainers CLI, `runLifecycleHook` computes
`remoteCwd = containerProperties.remoteWorkspaceFolder || containerProperties.homeFolder`
once and passes it to every hook, Feature-declared ones included
([`spec-common/injectHeadless.ts`](https://github.com/devcontainers/cli/blob/main/src/spec-common/injectHeadless.ts)),
so the cwd is the workspace folder whenever there is one.

That is read from the CLI's source, **not measured in a running container** — no
Docker was available where this Feature was written. The `with_nvmrc` scenario above
is what measures it: if the cwd were anything else, the hook would have found no
`.nvmrc` and its first check fails.

## Publishing

`.github/workflows/publish-feature.yml` publishes this folder to
`ghcr.io/devc-tools/features/node-nvmrc` on a push to `main` that touches
`features/`, in its own matrix job. `version` is this Feature's own — bump it in
the commit that changes this Feature, and nothing else in the repo has to move;
leave it and the publish is a no-op, since the CLI skips a version already in
the registry. There is no `DEVC_TOOLS_RELEASE` in `install.sh` — this Feature
downloads no release asset, so it pins none, and nothing here is coupled to a
devc-tools release at all.

0.2.0 adds a mount to a published Feature — new behaviour every consumer gets
whether or not they ask, which is why it is a version bump rather than a silent
edit. The `:0` tag is the documented license for that while this Feature is pre-1.0
([features/README.md](../README.md#versions)).
