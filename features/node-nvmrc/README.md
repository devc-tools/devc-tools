# node-nvmrc (devcontainer Feature)

Makes the Node version your workspace pins in `.nvmrc` the version **every process in the
container** gets — `bash -c`, `sh -c`, `docker exec`, an agent CLI, a task runner, an editor
extension.

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": {},
  "ghcr.io/devc-tools/features/node-nvmrc:0": {}
}
```

No options you have to set, nothing host-side. `.nvmrc` is read from the workspace, and
everything else is written inside the container. It declares one volume for `node_modules`
— see [The `node_modules` volume](#the-node_modules-volume).

It does **not** install Node or nvm. It drives an nvm that is already in the image; see
[What this is not](#what-this-is-not).

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Prerequisite: something has to provide nvm

The default `nvmDir` is `/usr/local/share/nvm`, which is where
[`ghcr.io/devcontainers/features/node`](https://github.com/devcontainers/features/tree/main/src/node)
puts nvm — so the two lines above are the whole setup. Any other source works too: point
`nvmDir` at it.

**If nothing provides nvm, the container still creates.** The create-time step warns on
stderr, naming the directory it searched, and exits 0:

```
node-nvmrc: /workspaces/yours/.nvmrc found, but there is no nvm at /usr/local/share/nvm.
node-nvmrc: add a Feature that provides one (ghcr.io/devcontainers/features/node),
node-nvmrc: or set this Feature's 'nvmDir' option. Nothing was installed.
```

That is deliberate: failing the create over a missing prerequisite turns a one-line
misconfiguration into a container you cannot open to fix it. No symlink is created, so the
PATH entry is inert and `node` resolves to whatever else provides it.

`nvm install` **failing** is a different matter and *is* fatal. Your `.nvmrc` asked for a
version that could not be installed, and a container that quietly comes up on the wrong Node
is worse than one that fails while you are still watching the log.

The prerequisite is documented rather than imposed with `dependsOn`, because `dependsOn`
would install the node Feature for you with *this* Feature choosing its `version`,
`pnpmVersion` and `nvmVersion` — exactly the things you want to choose. `installsAfter` only
orders this Feature behind the node Feature when you have asked for both.

## What reaches what

Everything:

| Invocation                                     | Sees the pin |
| ---------------------------------------------- | ------------ |
| `bash -c 'node -v'`                            | yes          |
| `sh -c 'node -v'`                              | yes          |
| `bash -lc` / `bash -ic` / a real terminal      | yes          |
| `docker exec <container> node -v`              | yes          |
| an agent CLI's tool shell (zsh, fish, `sh`)    | yes          |
| an editor extension host, a task, a `Makefile` | yes          |

The mechanism is a `containerEnv` PATH entry — the same one the upstream node Feature uses
to put `$NVM_DIR/current/bin` on PATH — so it reaches PID 1's environment and is inherited
by everything, with no startup file, no shell language and no interactivity involved.
Nothing is appended to `~/.bashrc`.

### Precedence

- **Container-wide, the pin wins.** `pin/bin` sits ahead of `$NVM_DIR/current/bin`, so
  nothing a human's `nvm use` does to nvm's global symlink can override the workspace pin
  for other processes.
- **Inside one interactive shell, you still win.** `nvm use` prepends the *versioned*
  directory to that shell's own PATH, ahead of `pin/bin`. It affects that shell and nothing
  else.
- **Interactive shells agree by default.** Images that source `nvm.sh` from
  `/etc/bash.bashrc` run `nvm_auto use`, which resolves the current version — now the pinned
  one — and re-selects it.

### Editing `.nvmrc` means a rebuild

The symlink is written once, at create time. Change `.nvmrc` and the container keeps the
version it was created with until you rebuild or recreate it. There is deliberately no
`postStartCommand` re-pointing it on every start: that would add a start-time network call
whenever the version is absent.

Until then, `nvm use` in a shell still does what it always did, for that shell.

## Options

| Option                    | Default                | Meaning                                                                                                           |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `nvmDir`                  | `/usr/local/share/nvm` | Directory holding `nvm.sh`.                                                                                       |
| `projectDir`              | `""` (workspace root)  | The directory that **is** the Node project: where `.nvmrc` is read and where `node_modules` is repaired.          |
| `installOnCreate`         | `true`                 | Run `nvm install` for the project's `.nvmrc` at create time. `false` creates no symlink, so the Feature is inert. |
| `fixNodeModulesOwnership` | `true`                 | `chown` an existing `./node_modules` to the create-time user before installing.                                   |

`nvmDir` and `projectDir` reject a value containing `"`, `` ` ``, `$`, `\` or a newline —
the build fails naming the option rather than silently producing a script that does
something else.

## What it does

At **build time** it places its create-time script and an empty, user-owned `pin/`
directory. The manifest's `containerEnv` puts `pin/bin` on `PATH`. A PATH entry naming a
directory that does not exist is silently skipped by every shell, so this stays safe to
leave enabled in a repo that pins nothing.

At **create time**, before any `postCreateCommand` of your own, it:

1. changes to the project directory — the workspace root by default, or wherever
   [`projectDir`](#projectdir--which-project-is-the-pin) points;
2. exits 0 **silently** if there is no `.nvmrc` there and `projectDir` was left alone;
3. loads nvm, or warns and exits 0 as above;
4. repairs `./node_modules` ownership, best-effort (see
   [below](#the-node_modules-chown));
5. runs `nvm install`, which installs the pinned version and exports `NVM_BIN`;
6. points `pin/bin` at `$NVM_BIN`, which is what makes the PATH entry live;
7. best-effort, sets nvm's own `default` alias to the pinned version, so nvm's state does
   not disagree with PATH.

No version string is ever extracted. `nvm install` runs with no arguments, so nvm's own
parser reads `.nvmrc` — comments and `key=value` lines included.

### `projectDir` — which project is the pin

Not every repo keeps its Node project at the workspace root. `projectDir` names the
directory that **is** the Node project, and the whole create-time step runs there: it is
where `.nvmrc` is looked for and where `node_modules` is repaired.

```jsonc
"ghcr.io/devc-tools/features/node-nvmrc:0": { "projectDir": "packages/app" }
```

- Workspace-relative by default; an **absolute** value is used as-is. Empty (the default) is
  the workspace root.
- It is a **directory, not a file**. There is deliberately no way to point at a
  differently-named version file: `nvm install` resolves `.nvmrc` by that name from its cwd
  and has no flag to override it, so an option that appeared to accept `.node-version` would
  silently install from something else.
- A `projectDir` that **does not exist** warns on stderr and exits 0. So does a `projectDir`
  with no `.nvmrc` in it — unlike the default, which stays silent, because you named a
  directory and silence would send you hunting for where Node came from.

**This is not monorepo support.** Exactly one `.nvmrc` is read, once, at create time;
`projectDir` chooses **which one**. A monorepo whose packages pin *different* versions is
out of scope — this Feature pins one version container-wide and does not make it vary by
directory.

**If you set it, mount your own `node_modules` volume where the project is.** The Feature's
declared volume cannot follow `projectDir`, so it would sit at the workspace root where
nothing writes to it. The create-time step warns and prints the mount line for you.

## The `node_modules` volume

This Feature declares its own:

```jsonc
{
  "type": "volume",
  "source": "node-modules-${devcontainerId}",
  "target": "${containerWorkspaceFolder}/node_modules"
}
```

Keeping `node_modules` in a named volume rather than the bind-mounted workspace is what
makes installs fast and keeps a Linux `node_modules` from colliding with whatever your host
put there.

`${devcontainerId}` keys it per devcontainer — not the workspace folder name, which collides
whenever two workspaces share one (a `<repo>.worktrees/<branch>` layout names the folder
after the branch, so `main` in three repos is one name). The trade is that the volume name
is opaque and **moving the workspace on disk starts a fresh one** — one `npm ci`, and the
old volume is left behind untouched.

**It does not follow `projectDir`.** A Feature option cannot substitute into that Feature's
own `mounts`, so the volume is always at the workspace root. With `projectDir` set, the
create-time step warns and gives you the line to paste:

```jsonc
"mounts": ["type=volume,source=node-modules-${devcontainerId},target=${containerWorkspaceFolder}/packages/app/node_modules"]
```

**You cannot remove a declared mount — only override it.** Mounts merge keyed on **target**,
with your own `devcontainer.json` merged last, so declaring the same target yourself wins
with no duplicate and no error.

`npm ci` over the mounted volume works — it removes `node_modules` before installing, and a
mount point can be emptied but not unlinked.

### The `node_modules` chown

A named volume mounted at `node_modules` first comes up root-owned, after which `npm ci` as
the remote user cannot write into it. The create-time step repairs that with
`sudo -n chown -R`, guarded on `sudo` existing and the directory existing, and best-effort
so it can never fail the create.

A volume is not the only way that directory can exist, and this is worth knowing before you
leave the option on: a bind-mounted workspace can already carry a `node_modules` from
host-side development, an `onCreateCommand` may have installed one, and an image can ship
one. In those cases the `chown` fires on files that are not a volume. It stays bounded the
same way regardless: only `node_modules`, only when it already exists, **never** the
workspace itself, `sudo -n` so it cannot hang. Set `fixNodeModulesOwnership` to `false` if
you would rather it never ran.

## What this is not

**`ghcr.io/devcontainers/features/node` installs Node and nvm. This Feature installs
neither.** It reads `.nvmrc` and drives the nvm that is already there. Use both: the node
Feature to get nvm and a baseline Node, this one to make the version your repo pins the
version you actually get. An issue that says "the node feature" could mean either, so the
two are worth naming in full.

**`pin/bin` is not `$NVM_DIR/current`.** Both are "the symlink". nvm's is container-global
and is moved by *any* `nvm use` in *any* shell; this Feature's is moved only by its own
create-time step. That is why the directory is called `pin/` and not `current/`.
