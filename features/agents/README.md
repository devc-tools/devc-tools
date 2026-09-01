# agents (devcontainer Feature)

Installs coding-agent CLIs — the **Claude Code CLI**, and optionally the **GitHub Copilot
CLI**, the **pi coding agent CLI** and the **Herdr terminal multiplexer** — and keeps all
of Claude Code's state in one place, so one volume survives a rebuild and one host
directory supplies your config.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/agents:0": {}
}
```

No mounts, no options you have to set. A bare `{}` installs the Claude CLI, leaves an
empty seed directory for you to mount onto, and points `~/.claude.json` at
`~/.claude/.claude.json`.

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Options

| Option              | Default | Meaning                                                                                                                                 |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `installClaudeCli`  | `true`  | Install the Claude Code CLI.                                                                                                            |
| `installCopilotCli` | `false` | Install the GitHub Copilot CLI too.                                                                                                     |
| `installPiCli`      | `false` | Install the pi coding agent CLI too. **Requires Node.js in the image** — see [Node.js and pi](#nodejs-and-pi).                          |
| `installHerdr`      | `false` | Install the Herdr terminal multiplexer too. Ships a static binary — no extra prerequisite.                                              |
| `piPackages`        | `""`    | Comma-separated pi package sources to install. **Requires `installPiCli: true`** — see [Packages and plugins](#packages-and-plugins).   |
| `herdrPlugins`      | `""`    | Comma-separated Herdr plugins, in GitHub shorthand (`owner/repo[/subdir]`). **Requires `installHerdr: true`**.                          |

That is the whole option surface — there are no path options. Every path this Feature
touches is either fixed (the seed) or derived from the remote user's own home
(`~/.claude`), because Claude Code resolves its state directory as `$CLAUDE_CONFIG_DIR`
or, unset, `$HOME/.claude` — so there is exactly one correct answer and the Feature
derives it.

Each CLI is opt-in on its own. Enabling this Feature for Claude should not silently
install a second, third or fourth vendor's CLI, which is why only `installClaudeCli`
defaults true.

## Where Claude Code's state lives

Three paths, three lifetimes. Getting one confused for another is the whole failure mode
this Feature exists to prevent:

| Path                                                | What it is                                                                                                        | Lifetime                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `~/.claude`                                         | Claude Code's own state — `projects/`, `todos/`, credentials, settings, and `.claude.json`.                        | Backed by a volume this Feature declares, so it survives a rebuild. |
| `/usr/local/share/devc-features/agents/claude-seed` | **Fixed.** Where you bind-mount your own host config. Created empty; this Feature only ever reads it.             | Same as your bind mount; empty and harmless if you mount none. |
| a host seed directory                               | **Your** config — `CLAUDE.md`, `settings.json`, `statusline.sh`. The one thing you decide, with a mount.          | Lives on your host; the container only ever reads it.          |

`~/.claude.json` is a symlink into `~/.claude`, with no lifetime of its own — see
[`~/.claude.json`](#claudejson).

## What it does

At **build time** it installs the CLIs you asked for, as the remote user rather than root,
into `~/.local/bin` — so you can later run `claude update` / `copilot update` / `pi
update` / `herdr update` yourself. A rebuild does not re-download a binary that is already
there. **Network is required** when any install option is true: a failed download fails
the build, rather than leaving a container that looks fine until the first `claude`.

At **create time**, before any `postCreateCommand` of your own:

1. **Ownership repair.** If `~/.claude` is not owned by you, a non-recursive `sudo chown`
   fixes it. Non-recursive on purpose — subpaths like `skills/` may be host bind mounts
   and must not be chowned.
2. **Seed links.** Every top-level *file* in the seed directory is symlinked into
   `~/.claude` — host edits are live, host file modes (the statusline exec bit) survive,
   and deletions on the host prune the link on the next create. Directories are ignored by
   design: a `~/.claude/skills/` mount point would either get a nested `skills/skills` or
   fail on a busy mountpoint. An empty seed links nothing and moves on.
3. **`~/.claude.json`** is replaced with a symlink to `~/.claude/.claude.json`, seeded
   with `{}` if nothing is there yet.

Every skip path exits `0`. A failing `postCreateCommand` aborts container creation, and
none of these skips is worth an unbootable container.

## What you mount

A Feature cannot declare a read-only bind mount or an `initializeCommand`, so the seed
mount belongs to your own `devcontainer.json`:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/devc-features/agents/claude-seed,readonly"
],
"features": {
  "ghcr.io/devc-tools/features/agents:0": {}
}
```

The host path is yours — pick anything. The `initializeCommand` is what makes the mount
source exist; a bind mount with a missing source is a hard error, not an auto-created
directory.

The seed is optional. Omit it and the Feature links nothing and moves on.

`readonly` has one edge worth knowing: seeded files are symlinked into `~/.claude`, so
Claude Code writing to one of them (a `/config` change, a plugin install touching
`settings.json`) fails. Host edits reaching the container live, with no rebuild, is the
trade that buys.

## The `~/.claude` volume

**This Feature declares its own volume** — persistence needs no mount line from you:

```jsonc
{
  "type": "volume",
  "source": "claude-code-config-${devcontainerId}",
  "target": "/home/vscode/.claude"
}
```

Three things about it are not guessable:

**It is keyed on `${devcontainerId}`.** That is unique per devcontainer, where a workspace
folder name is not — a `<repo>.worktrees/<branch>` layout names the folder after the
branch, so worktrees called `main` in three different repos would have shared one
`~/.claude`. The trade: the volume name is opaque, and **moving a workspace on disk
changes the id**, so the old volume is left behind and you log in to Claude once more. To
map volumes back to workspaces, ask the container rather than the name:

```sh
docker inspect $(docker ps -q) \
  --format '{{index .Config.Labels "devcontainer.local_folder"}} {{json .Mounts}}'
```

**The target is the literal `/home/vscode/.claude`.** No `devcontainer.json` variable
names the remote user's home inside a Feature's own `mounts`, so it is a fixed path. On an
image whose remote user is not `vscode`, the volume lands somewhere Claude Code never
reads — the create-time step warns, names your real home and the mount line that fixes it,
and still exits `0`.

**You cannot remove a declared mount, only override it.** Mounts merge keyed on target,
with your own `devcontainer.json` merged last, so declaring the same target yourself wins
with no duplicate and no error. That is the opt-out, and it is also how you point
`~/.claude` somewhere else entirely.

First-use ownership needs no action from you: `~/.claude` is pre-created in the image
owned by the remote user, so Docker seeds the empty volume from it.

## `~/.claude.json`

Claude Code resolves its config and auth file as `$CLAUDE_CONFIG_DIR/.claude.json`,
falling back to `$HOME/.claude.json`. It is therefore a **sibling** of `~/.claude`, not a
member of it — and a volume can only mount at a *directory*, so it cannot be a mount
target on its own. Symlinking it into `~/.claude` is what lets one mount capture
everything, and puts it next to the `.credentials.json` and `history.jsonl` it belongs
with.

This is unconditional. With no volume mounted it is an indirection inside one home
directory, which costs nothing.

Two consequences:

- **A pre-existing real `~/.claude.json` is moved, not deleted.** If
  `~/.claude/.claude.json` does not exist yet and `~/.claude.json` is a real file, it is
  `mv`d into place and you keep your session.
- **A symlink pointing somewhere else is repointed.** The check compares the link's
  target, not just whether it is a link.

## Node.js and pi

`claude`, `copilot` and `herdr` ship self-contained installers that drop a binary. **pi
installs itself with `npm`**, so `installPiCli: true` requires **Node.js 22.19.0 or newer
and npm** in the image. Add a node Feature alongside this one:

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": { "version": "lts" },
  "ghcr.io/devc-tools/features/agents:0": { "installPiCli": true }
}
```

Ordering is handled for you — this Feature's `installsAfter` already names the node
Feature and `node-nvmrc`. Without a node Feature the build fails naming the requirement,
rather than producing a container that looks fine until the first `pi`. It also refuses a
too-old Node up front, naming the version it needs and the one it found.

`pi` is installed into `~/.local/bin`, beside `claude` and `copilot`, so it stays on PATH
across Node version switches.

### pi and a project's `.nvmrc`

`~/.local/bin/pi` is a symlink to a script whose shebang is `#!/usr/bin/env node` — so
**pi runs under whatever `node` is first on `PATH` when you run it, not the one it was
installed with.** With [`node-nvmrc`](../node-nvmrc/README.md) that is the version your
workspace's `.nvmrc` pins.

`pi` itself is always found, so this is a version question, never a "command not found"
one:

| `.nvmrc` pins       | Result                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| ≥ 22.19.0 (any LTS) | Works.                                                                      |
| < 22.19.0           | **pi fails at runtime**, with a raw `SyntaxError`, not a version complaint. |

`engines` is enforced by npm at install time, not by node at run time, so nothing
intercepts this with a readable message. In practice every current LTS line satisfies it
(`lts/jod` is 22.23.2, `lts/krypton` is 24.20.0) — a project would have to pin Node 20 or
older to hit it. If yours must, run pi from outside the container, or give it its own Node
via a wrapper on `PATH` ahead of `pin/bin`.

## Packages and plugins

`piPackages` and `herdrPlugins` install at **build time**, because neither `~/.pi` nor
`~/.config/herdr` is a mount: anything either CLI installs in a *running* container lives
only in that container's writable layer and is gone on the next rebuild.

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": { "version": "lts" },
  "ghcr.io/devc-tools/features/agents:0": {
    "installPiCli": true,
    "piPackages": "npm:@andrewjacop/pi-herdr,git:github.com/bmingles/pi-dev-extensions@main",
    "installHerdr": true,
    "herdrPlugins": "bmingles/herdr-plugins/agent-caffeinate"
  }
}
```

Both are plain comma-separated lists. Empty entries — from a leading, trailing or doubled
comma, or stray whitespace — are dropped, so a messy value is harmless.

Setting either without its CLI's install option is a **build failure**, not a silent
skip — a skip would leave a container that looks configured and installed nothing.

- `piPackages` entries are passed to `pi install <entry>` unparsed. pi accepts `npm:`,
  `git:`, `https://`, `ssh://` and local-path sources; this option does not validate the
  form.
- `herdrPlugins` entries are installed with `herdr plugin install <entry> --yes` and are
  **GitHub shorthand only** (`owner/repo[/subdir]`) — Herdr's installer accepts nothing
  else, so a `git:`-style entry fails with Herdr's own error. Needs `git` and network in
  the image. Plugin registration is global to the user, so one build-time install covers
  every session in the container. A plugin declaring a `min_herdr_version` newer than the
  installed Herdr fails the build, which is expected rather than a bug.

Reinstalling an already-installed pi package is a genuine no-op, so a rebuild does not pay
for one.

**A volume mounted at `~/.pi` or `~/.config/herdr` shadows whatever this installed** —
there is no option to point either install somewhere else.

## What this is not

**Not the `anthropic.claude-code` VS Code extension** — that is a
`customizations.vscode.extensions` entry, unrelated to installing the CLI. This Feature
could declare that extension and deliberately does not: a config Feature that silently
installs editor extensions is a surprise you did not ask for.

**Not a way to share one `.claude.json` across projects.** Folding it into `~/.claude`
ties its lifetime to whatever you mount there.
