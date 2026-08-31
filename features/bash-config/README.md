# bash-config (devcontainer Feature)

Two fixed directories of shell scripts, sourced by `~/.bashrc` in every
interactive bash shell this Feature can reach. Drop a file in, open a new
terminal, and it is there — the directories are read fresh by every shell, so
nothing is rebuilt and nothing is baked.

```jsonc
"features": { "ghcr.io/devc-tools/features/bash-config:0": {} }
```

That one line is the whole setup for the part most people want: every
`bashrc_*.sh` in your repo's own `.devcontainer/shell/`. No mounts, no options,
no environment variables, nothing host-side.

```sh
# .devcontainer/shell/bashrc_10-project.sh
alias t='deno task test'
export DATABASE_URL=postgres://localhost/dev
```

> The tag tracks **this Feature's** version line, not the repo's — Features
> version independently of the devc-tools release tag. It is `:0` while this
> Feature is pre-1.0; it becomes `:1` at its first 1.x release.

> **Not published yet.** `bash-config` is deliberately held off the publish
> allowlist while it is under development, so no `ghcr.io` ref resolves today.
> See [Publishing](#publishing).

## The two directories

Both live at fixed container paths, and neither is an option:

```
/usr/local/share/devc-features/bash-config/dirs/
  user/       a real, empty directory. Yours — mount onto it, copy into it, or ignore it.
  project     a symlink into your workspace, pointed at projectDir at create time.
```

`user/` is created empty at build time and this Feature **never writes into it
and never learns where its contents came from**. That is the whole interface: a
consumer's own `devcontainer.json` binds a host directory onto it, or a
`postCreateCommand` copies files in, or nothing happens and it stays empty.

`project` is a **symlink**, not a copy, so your workspace stays the source of
truth. Editing a file changes what the next shell sources; deleting one stops it
being read; nothing has to run again for either.

## Which files get sourced

Every `bashrc_*.sh` in each directory, in glob (name) order. Anything else is
ignored: a `README.md`, a `notes.txt`, an unprefixed `helpers.sh`, and a
subdirectory — even one named `bashrc_x.sh`.

### How far this actually reaches — and where it stops

This is the honest ceiling, and it is worth reading before wiring anything
important to it. **This Feature reaches exactly one audience: a plain
interactive bash shell** — the shape of shell a terminal in the container
actually starts.

| Shell                         | Gets          |
| ----------------------------- | ------------- |
| a terminal in the container   | `bashrc_*.sh` |
| `bash -lc '…'`                | **neither**   |
| `docker exec ctr bash -c '…'` | **neither**   |
| `sh -c '…'`, `sh script.sh`   | **neither**   |
| a binary exec'd by an editor  | **neither**   |

`~/.bashrc` reaches interactive shells only: the stock
`case $- in *i*) ;; *) return;; esac` guard at the top of it returns before
this Feature's block, for anything that is not interactive. Nothing here is
appended to a login profile, so a login shell (`bash -l`) gets nothing from
this Feature either — that used to work through a second block, dropped in
0.2.0 because it was never reaching the audience it was meant to: an agent or
a scripted tool invocation is typically neither interactive nor a login shell,
so it got nothing from either block anyway, and a real terminal in a
devcontainer is plain interactive, non-login bash, so `bashrc_*.sh` was
already the only pathway reached day to day.

The only thing that reaches a non-interactive process, agent tool call
included, is the container's environment, which is
`containerEnv`/`remoteEnv` in **your** `devcontainer.json`:

```jsonc
"containerEnv": { "DATABASE_URL": "postgres://localhost/dev" }
```

Put anything a tool or an agent must see regardless of how it was started
there. Keep these two directories for what a human actually looks at in a
shell: a prompt, an alias, a function — cosmetic scope, deliberately, not a
place to drive runtime behavior that has to be reliable.

## Ordering

**User directory first, project second**, so a project's committed settings win
on conflict — the same `system → global → local` order git uses. A project file
that _assigns_ rather than appends to a shared variable (`PS1`, `PATH`) therefore
overrides your personal one.

**Within a directory**, glob (name) order. Prefix with `bashrc_10-`, `bashrc_20-`,
… to control it.

A missing or empty directory is a silent no-op, and so is a `project` symlink
pointing at a directory that does not exist yet — it starts working the moment
something creates it. The Feature is safe to leave enabled in a repo that ships
no scripts.

## The personal directory, from your host

`dirs/user/` is a mount target. This Feature neither creates the host side nor
mounts anything — a Feature cannot declare an `initializeCommand`, and the
published Feature schema's `Mount` cannot express `readonly`
([why](../../.plans/design/devc-feature-split.md)). So the bind belongs to your
`devcontainer.json`, which is three lines you own:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/myshell",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/myshell,target=/usr/local/share/devc-features/bash-config/dirs/user,readonly"
],
"features": {
  "ghcr.io/devc-tools/features/bash-config:0": {}
}
```

The host path is **yours** — pick anything. Nothing in this Feature defaults to,
or knows about, any particular one.

The `initializeCommand` is what makes the mount source exist. A bind mount with a
missing source is a hard error, not an auto-created directory.

Mount it `readonly` if you can. Written as a **string** (as above) the devcontainer
CLI passes the spec through to `docker --mount` verbatim, so `readonly` survives;
the object form is re-serialized and drops it.

A mount is not the only way. `dirs/user/` is a plain directory owned by the remote
user — a `postCreateCommand` of your own can copy into it just as well.

## Options

| Option       | Default               | Meaning                                                                                                                             |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `projectDir` | `.devcontainer/shell` | Where in the workspace `dirs/project` points, resolved at create time. An absolute value is linked as-is. Empty creates no symlink. |

There is exactly one option because exactly one thing is genuinely per-project.
There is no `userDir`: that directory is a fixed path now. There is no off
switch: an empty or absent directory is already a silent no-op.

`PROJECT_PATH` is an **override, not a prerequisite**. The create-time hook
resolves `projectDir` against `$PROJECT_PATH` if you set it as `remoteEnv`, and
against its own cwd otherwise — the devcontainer CLI hands every lifecycle hook
the workspace folder. It then writes that path into `dirs/env.sh`, which every
shell sources, so `$PROJECT_PATH` is exported for your scripts to use whether or
not you declared it.

If the hook finds no `PROJECT_PATH` **and** a cwd equal to the home folder, it
declines and says so. That combination is exactly the CLI's
`remoteWorkspaceFolder || homeFolder` fallback firing, which means the container
has no workspace folder at all — and linking `~/.devcontainer/shell` would be
worse than linking nothing. Set `PROJECT_PATH` as `remoteEnv`, or give
`projectDir` an absolute path; both still work, and the user directory is
unaffected either way.

## What it does

At **build time** (as root) it fetches nothing and does four things: it copies
`init.sh`, `post-create.sh` and a generated `config.sh` into
`/usr/local/share/devc-features/bash-config/`; it creates `dirs/user/` and hands
`dirs/` to the remote user (`/usr/local/share` is root-owned, and the create-time
hook runs unprivileged); and it appends one marker-guarded block to `~/.bashrc`.

The block is **one static line**:

```sh
# >>> bash-config >>>
. /usr/local/share/devc-features/bash-config/init.sh
# <<< bash-config <<<
```

No option is substituted into it and nothing ever rewrites it — not at build
time, not at create time, not on a rebuild. Everything configurable lives in
files this Feature owns outright, which is the difference from
[`shell-dirs`](#relationship-to-shell-dirs).

At **create time** (as the remote user, before any `postCreateCommand` your own
`devcontainer.json` declares) `post-create.sh` points `dirs/project` at
`<workspace>/<projectDir>` and writes `dirs/env.sh`. It touches no startup file
and does not edit `init.sh`.

At **shell time** `init.sh` sources `dirs/env.sh`, then every
`bashrc_*.sh` in `dirs/user` and then in `dirs/project`, reading both directories
fresh. It leaves no helper function, no loop variable and no non-zero `$?` behind
— that last one matters because this is the final thing `~/.bashrc` runs, and a
prompt that renders `$?` would otherwise show an error on the first line of every
shell.

A `projectDir` containing `"`, `` ` ``, `$`, `\` or a newline **fails the build**,
naming the option. The value is written into a shell assignment, and a silently
mangled config would link somewhere other than what you asked for.

### bash only

`install.sh` writes `~/.bashrc`. zsh and fish get nothing — deliberately
unwritten rather than half-written. If your container's default shell is not
bash, this Feature does nothing for it.

### It runs last, which is usually what you want

Features install **after** the image's own Dockerfile, so this block lands at the
end of `~/.bashrc`, after anything the base image or another Feature put there.
A script can therefore override a prompt, a `cd` wrapper or an alias set earlier.

The one thing to avoid is **assigning `PROMPT_COMMAND` outright** — append to it
instead. Anything installed there before this block runs is dropped.

## Four things one word apart

Worth naming in full once, because they are easy to confuse:

- **`bash-config`** — this Feature.
- **`shell-dirs`** — the Feature this supersedes. Still in this collection; see
  below.
- **`devc:shell-dirs`** — a comment fence in devc's own baseline and in
  `shell-dirs`. **This Feature does not use it and is not pinned to it.**
- **`dirs/user`** — a fixed _path_ here. `shell-dirs` had a `userDir` _option_
  naming an arbitrary one. There is no such option here.

## Relationship to shell-dirs

This supersedes [`shell-dirs`](../shell-dirs/README.md), which is still in the
tree and still published-in-waiting. **Do not enable both.** They write different
blocks with different markers, so both would install, and a container with devc's
baseline as well would source the project directory more than once — idempotent
for aliases and `export`, and not for `PATH="…:$PATH"`.

The difference is structural, not cosmetic. `shell-dirs` puts its whole sourcing
loop _inside_ `~/.bashrc`, parameterized by two assignments in the middle of it —
so its `install.sh` substitutes into that block, its `post-create.sh` rewrites a
line back out of it at create time, and both halves verify their own rewrites.
Here the block names a fixed path and the configuration lives beside the code:
`config.sh` for the option, a symlink for the workspace, `env.sh` for the
environment. Nothing rewrites anything, so there is no rewrite that can silently
stop matching.

What `bash-config` adds beyond that: `PROJECT_PATH` exported for your scripts
rather than merely consumed, and the design that keeps `~/.bashrc` a static,
never-rewritten line.

devc's own baseline still carries its `devc:shell-dirs` block and is untouched by
this Feature. Swapping devc onto this one is a later change.

## Tests

No Docker needed:

```sh
bash features/bash-config/test/init_test.sh             # the sourcing logic
bash features/bash-config/test/install_options_test.sh  # the option and the block
bash features/bash-config/test/post_create_test.sh      # the symlink, env.sh, the refusal path
```

Needs Docker. The default scenario is the bare `{}` case — no options, no mounts,
no `remoteEnv` — and `test/scenarios.json` adds three more:

```sh
bash features/bash-config/test/run-features-test.sh
```

| Scenario      | What it pins                                                             |
| ------------- | ------------------------------------------------------------------------ |
| _(default)_   | A bare `{}` installs; the hook resolved a real symlink from its own cwd. |
| `bare_no_env` | No `remoteEnv`, a committed project folder — a new shell has it.         |
| `both_dirs`   | User directory before project; project wins on conflict.                 |
| `live_edit`   | A file added after create is sourced by the next shell.                  |

The default scenario is also what **measures** two things the offline harnesses
cannot: the cwd a Feature-declared `postCreateCommand` is given (the symlink can
only be an absolute workspace path if the CLI handed the hook the workspace
folder), and the `chown` of `dirs/` to the remote user (nothing else lets an
unprivileged hook create that symlink under a root-owned `/usr/local/share`).

Each scenario writes its fixtures from its own `onCreateCommand`, which runs
before every `postCreateCommand`, because `devcontainer features test` generates
the workspace folder itself — there is no committed fixture that could already be
there.

## Publishing

`bash-config` is **not on** [`PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) while it is
under development, so `.github/workflows/publish-feature.yml` builds it into no
matrix job and it is invisible to ghcr.io. Adding its id there is the whole of
publishing it. `version` is this Feature's own — bump it in the commit that
changes this Feature, and nothing else in the repo has to move. There is no
`DEVC_TOOLS_RELEASE` in `install.sh`: this Feature downloads no release asset, so
it pins none.
