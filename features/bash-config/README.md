# bash-config (devcontainer Feature)

Two directories of shell scripts, sourced by `~/.bashrc` in every interactive bash shell.
Drop a file in, open a new terminal, and it is there — the directories are read fresh by
every shell, so nothing is rebuilt and nothing is baked.

```jsonc
"features": { "ghcr.io/devc-tools/features/bash-config:0": {} }
```

That one line is the whole setup for the part most people want: every `bashrc_*.sh` in
your repo's own `.devcontainer/shell/`. No mounts, no options, no environment variables,
nothing host-side.

```sh
# .devcontainer/shell/bashrc_10-project.sh
alias t='deno task test'
export DATABASE_URL=postgres://localhost/dev
```

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## The two directories

Both live at fixed container paths, and neither is an option:

```
/usr/local/share/devc-features/bash-config/dirs/
  user/       a real, empty directory. Yours — mount onto it, copy into it, or ignore it.
  project     a symlink into your workspace, pointed at projectDir at create time.
```

`user/` is created empty and this Feature **never writes into it and never learns where
its contents came from**. That is the whole interface: bind a host directory onto it, or
copy files in from a `postCreateCommand` of your own, or leave it empty.

`project` is a **symlink**, not a copy, so your workspace stays the source of truth.
Editing a file changes what the next shell sources; deleting one stops it being read;
nothing has to run again for either.

## Which files get sourced

Every `bashrc_*.sh` in each directory, in glob (name) order. Anything else is ignored: a
`README.md`, a `notes.txt`, an unprefixed `helpers.sh`, and a subdirectory — even one
named `bashrc_x.sh`.

### How far this reaches — and where it stops

Worth reading before wiring anything important to it. **This Feature reaches exactly one
audience: a plain interactive bash shell** — the shape of shell a terminal in the
container actually starts.

| Shell                         | Gets          |
| ----------------------------- | ------------- |
| a terminal in the container   | `bashrc_*.sh` |
| `bash -lc '…'`                | **nothing**   |
| `docker exec ctr bash -c '…'` | **nothing**   |
| `sh -c '…'`, `sh script.sh`   | **nothing**   |
| a binary exec'd by an editor  | **nothing**   |

`~/.bashrc` reaches interactive shells only: the stock
`case $- in *i*) ;; *) return;; esac` guard at the top of it returns before this Feature's
block for anything that is not interactive. Nothing is appended to a login profile either,
so `bash -l` gets nothing from this Feature.

The only thing that reaches a non-interactive process — an agent tool call included — is
the container's environment, which is `containerEnv`/`remoteEnv` in **your**
`devcontainer.json`:

```jsonc
"containerEnv": { "DATABASE_URL": "postgres://localhost/dev" }
```

Put anything a tool or an agent must see regardless of how it was started there. Keep
these two directories for what a human actually looks at in a shell: a prompt, an alias, a
function. Cosmetic scope, deliberately — not a place to drive runtime behavior that has to
be reliable.

## Ordering

**User directory first, project second**, so a project's committed settings win on
conflict — the same `system → global → local` order git uses. A project file that
_assigns_ rather than appends to a shared variable (`PS1`, `PATH`) therefore overrides your
personal one.

**Within a directory**, glob (name) order. Prefix with `bashrc_10-`, `bashrc_20-`, … to
control it.

A missing or empty directory is a silent no-op, and so is a `project` symlink pointing at
a directory that does not exist yet — it starts working the moment something creates it.
The Feature is safe to leave enabled in a repo that ships no scripts.

## Your personal directory, from your host

`dirs/user/` is a mount target. This Feature neither creates the host side nor mounts
anything — a Feature cannot declare an `initializeCommand`, and the published Feature
schema cannot express a read-only mount. So the bind belongs to your `devcontainer.json`,
which is three lines you own:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/myshell",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/myshell,target=/usr/local/share/devc-features/bash-config/dirs/user,readonly"
],
"features": {
  "ghcr.io/devc-tools/features/bash-config:0": {}
}
```

The host path is **yours** — pick anything. Nothing in this Feature defaults to, or knows
about, any particular one.

The `initializeCommand` is what makes the mount source exist. A bind mount with a missing
source is a hard error, not an auto-created directory.

Mount it `readonly` if you can. Written as a **string** (as above) the devcontainer CLI
passes the spec through to `docker --mount` verbatim, so `readonly` survives; the object
form is re-serialized and drops it.

A mount is not the only way. `dirs/user/` is a plain directory owned by the remote user —
a `postCreateCommand` of your own can copy into it just as well.

## Options

| Option       | Default               | Meaning                                                                                                                             |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `projectDir` | `.devcontainer/shell` | Where in the workspace `dirs/project` points, resolved at create time. An absolute value is linked as-is. Empty creates no symlink. |

One option, because exactly one thing is genuinely per-project. There is no `userDir` —
that is a fixed path. There is no off switch — an empty or absent directory is already a
silent no-op.

`PROJECT_PATH` is an **override, not a prerequisite**. The create-time step resolves
`projectDir` against `$PROJECT_PATH` if you set it as `remoteEnv`, and against its own cwd
otherwise — the devcontainer CLI hands every lifecycle hook the workspace folder. It then
writes that path into `dirs/env.sh`, which every shell sources, so `$PROJECT_PATH` is
exported for your scripts whether or not you declared it.

If it finds no `PROJECT_PATH` **and** a cwd equal to your home folder, it declines and says
so. That combination means the container has no workspace folder at all, and linking
`~/.devcontainer/shell` would be worse than linking nothing. Set `PROJECT_PATH` as
`remoteEnv`, or give `projectDir` an absolute path; the user directory is unaffected either
way.

A `projectDir` containing `"`, `` ` ``, `$`, `\` or a newline **fails the build**, naming
the option — the value is written into a shell assignment, and a silently mangled config
would link somewhere other than what you asked for.

## What it does

At **build time** it copies its three scripts into
`/usr/local/share/devc-features/bash-config/`, creates `dirs/user/`, hands `dirs/` to the
remote user, and appends one marker-guarded block to `~/.bashrc`. The block is **one
static line**:

```sh
# >>> bash-config >>>
. /usr/local/share/devc-features/bash-config/init.sh
# <<< bash-config <<<
```

No option is substituted into it and nothing ever rewrites it — not at build time, not at
create time, not on a rebuild.

At **create time**, before any `postCreateCommand` of your own, `dirs/project` is pointed
at `<workspace>/<projectDir>` and `dirs/env.sh` is written. No startup file is touched.

At **shell time** `init.sh` sources `dirs/env.sh`, then every `bashrc_*.sh` in `dirs/user`
and then in `dirs/project`, reading both directories fresh. It leaves no helper function,
no loop variable and no non-zero `$?` behind — that last one matters because this is the
final thing `~/.bashrc` runs, and a prompt that renders `$?` would otherwise show an error
on the first line of every shell.

### bash only

This Feature writes `~/.bashrc`. zsh and fish get nothing — deliberately unwritten rather
than half-written. If your container's default shell is not bash, this Feature does nothing
for it.

### It runs last, which is usually what you want

Features install **after** the image's own Dockerfile, so this block lands at the end of
`~/.bashrc`, after anything the base image or another Feature put there. A script can
therefore override a prompt, a `cd` wrapper or an alias set earlier.

The one thing to avoid is **assigning `PROMPT_COMMAND` outright** — append to it instead.
Anything installed there before this block runs is dropped.
