# agents (devcontainer Feature)

Installs coding-agent CLIs — the **Claude Code CLI**, and optionally the **GitHub Copilot
CLI**, the **pi coding agent CLI**, the **Herdr terminal multiplexer** and the
**agent-browser** browser-automation CLI — and keeps all of Claude Code's state in one
place, so one volume survives a rebuild and one host directory supplies your config.

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

| Option                | Default       | Meaning                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installClaudeCli`    | `true`        | Install the Claude Code CLI.                                                                                                                                                                                                                                                                                                                        |
| `installCopilotCli`   | `false`       | Install the GitHub Copilot CLI too.                                                                                                                                                                                                                                                                                                                 |
| `installPiCli`        | `false`       | Install the pi coding agent CLI too. **Requires Node.js in the image** — see [Node.js and pi](#nodejs-and-pi).                                                                                                                                                                                                                                      |
| `installHerdr`        | `false`       | Install the Herdr terminal multiplexer too. Ships a static binary — no extra prerequisite.                                                                                                                                                                                                                                                          |
| `piPackages`          | `""`          | Comma-separated pi package sources to install at container **create** time. **Requires `installPiCli: true`** — see [Packages and plugins](#packages-and-plugins).                                                                                                                                                                                 |
| `herdrPlugins`        | `""`          | Comma-separated Herdr plugins, in GitHub shorthand (`owner/repo[/subdir]`), installed at container **create** time. **Requires `installHerdr: true`**.                                                                                                                                                                                             |
| `installAgentBrowser` | `false`       | Install the [agent-browser](https://agent-browser.dev) CLI too. Installs with npm — see [Node.js and pi](#nodejs-and-pi); unlike pi, what lands on `PATH` is a native binary, not a node script — see [Why agent-browser does not have pi's `.nvmrc` problem](#why-agent-browser-does-not-have-pis-nvmrc-problem).                                  |
| `agentBrowserChrome`  | `"with-deps"` | What `agent-browser install` does at build time: also apt-install the Linux libraries Chrome needs (`"with-deps"`), download Chrome only (`"browser-only"`), or install no browser (`"none"`). **Read only when `installAgentBrowser: true`**, silently ignored otherwise — see [agent-browser's Chrome download](#agent-browsers-chrome-download). |

That is the whole option surface — there are no path options. Every path this Feature
touches is either fixed (the seed) or derived from the remote user's own home
(`~/.claude`), because Claude Code resolves its state directory as `$CLAUDE_CONFIG_DIR`
or, unset, `$HOME/.claude` — so there is exactly one correct answer and the Feature
derives it.

Each CLI is opt-in on its own. Enabling this Feature for Claude should not silently
install a second, third, fourth or fifth vendor's CLI, which is why only `installClaudeCli`
defaults true.

## Where Claude Code's state lives

Three paths, three lifetimes. Getting one confused for another is the whole failure mode
this Feature exists to prevent:

| Path                                                | What it is                                                                                               | Lifetime                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `~/.claude`                                         | Claude Code's own state — `projects/`, `todos/`, credentials, settings, and `.claude.json`.              | Backed by a volume this Feature declares, so it survives a rebuild. |
| `/usr/local/share/devc-features/agents/claude-seed` | **Fixed.** Where you bind-mount your own host config. Created empty; this Feature only ever reads it.    | Same as your bind mount; empty and harmless if you mount none.      |
| a host seed directory                               | **Your** config — `CLAUDE.md`, `settings.json`, `statusline.sh`. The one thing you decide, with a mount. | Lives on your host; the container only ever reads it.               |

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
2. **Seed links**, run twice — once for `claude-seed` → `~/.claude`, once for
   `herdr-seed` → `~/.config/herdr`. Every top-level _file_ in a seed directory is
   symlinked into its destination — host edits are live, host file modes (the statusline
   exec bit) survive, and deletions on the host prune the link on the next create.
   Directories are ignored by design: a `~/.claude/skills/` mount point would either get a
   nested `skills/skills` or fail on a busy mountpoint. An empty seed links nothing and
   moves on.
3. **`~/.claude.json`** is replaced with a symlink to `~/.claude/.claude.json`, seeded
   with `{}` if nothing is there yet.
4. **`piPackages`/`herdrPlugins`** are installed here, not at build time — see
   [Packages and plugins](#packages-and-plugins) for why. A failed entry warns and moves
   on rather than aborting.

Every skip path in steps 1-3 exits `0`. A failing `postCreateCommand` aborts container
creation, and none of those skips is worth an unbootable container. Step 4 is the one
exception with teeth: install.sh still hard-fails the *build* if `piPackages`/
`herdrPlugins` is set without its CLI option, exactly as before — only the actual fetch
moved, not the validation.

## What you mount

A Feature cannot declare a read-only bind mount or an `initializeCommand`, so both seed
mounts belong to your own `devcontainer.json`:

```jsonc
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed ${localEnv:HOME}/.config/herdr-seed",
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/devc-features/agents/claude-seed,readonly",
  "type=bind,source=${localEnv:HOME}/.config/herdr-seed,target=/usr/local/share/devc-features/agents/herdr-seed,readonly"
],
"features": {
  "ghcr.io/devc-tools/features/agents:0": {}
}
```

The host paths are yours — pick anything. The `initializeCommand` is what makes each
mount source exist; a bind mount with a missing source is a hard error, not an
auto-created directory.

Both seeds are optional and independent — mount either, both, or neither. An unmounted
seed links nothing and moves on. `herdr-seed` is what you'd put a Herdr `config.toml` in
— e.g. the `tab_bar_right` entry a plugin's status indicator needs — so it survives a
rebuild without living in a volume:

```jsonc
// ~/.config/herdr-seed/config.toml, linked to ~/.config/herdr/config.toml
[ui]
tab_bar_right = [
  { type = "command", command = "~/.local/state/herdr/plugins/bridge-keepawake/bridge-keepawake indicator", interval_seconds = 5, timeout_seconds = 2 },
]
```

`readonly` has one edge worth knowing: seeded files are symlinked into their
destination, so anything that writes to one of them in place (Claude Code's `/config`
changing `settings.json`, say) fails. Host edits reaching the container live, with no
rebuild, is the trade that buys.

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
member of it — and a volume can only mount at a _directory_, so it cannot be a mount
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

## agent-browser

[`agent-browser`](https://agent-browser.dev) is the browser-automation CLI for coding
agents. `installAgentBrowser: true` installs it with npm, the same shape as `installPiCli`:

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": { "version": "lts" },
  "ghcr.io/devc-tools/features/agents:0": { "installAgentBrowser": true }
}
```

It requires a node Feature in the image for the same reason `installPiCli` does — see
[Node.js and pi](#nodejs-and-pi) — and the minimum Node version enforced at build time is
the same `22.19.0` floor, not the `24.0.0` the package's own `engines` field declares:
that floor covers building the Rust CLI from source, `npm install -g` is measured working
on Node 22.23.2, `engine-strict` is off by default so npm does not enforce `engines`
anyway, and the artifact this installs has no Node dependency at run time at all (see
below). Raising the floor to match the package would refuse the build for every consumer
pinned to Node 22 LTS for no measured reason.

### Why agent-browser does not have pi's `.nvmrc` problem

The npm tarball **bundles** every platform's native Rust binary, and its postinstall step
replaces npm's own bin symlink with a direct symlink to the one matching this machine:
`~/.local/bin/agent-browser` → `~/.local/lib/node_modules/agent-browser/bin/agent-browser-linux-<arch>`.

Contrast that with `pi`'s own [`.nvmrc` problem](#pi-and-a-projects-nvmrc) above: `pi`'s
entry point is a script whose shebang is `#!/usr/bin/env node`, so which `pi` you get
depends on whichever `node` is first on `PATH` at the moment you run it. **agent-browser's
entry point is a native binary** — there is no shebang, no interpreter to resolve, and no
version to get wrong. [`node-nvmrc`](../node-nvmrc/README.md) switching the container's
active Node version between projects has no effect on it at all.

### agent-browser's Chrome download

`agentBrowserChrome` controls what `agent-browser install` does at build time:

| Value                   | What it installs                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `"with-deps"` (default) | Chrome for Testing, plus the ~36 shared libraries and fonts it needs on Linux.                                               |
| `"browser-only"`        | Chrome for Testing only — use this when the base image already has the libraries, or you would rather manage them yourself.  |
| `"none"`                | No browser at all — the right value when you drive a remote browser over `--cdp` or a cloud provider instead of a local one. |

Chrome for Testing is about **390 MB on disk** (185 MB downloaded) and lands in
`~/.agent-browser/browsers/`, alongside `agent-browser`'s daemon sockets, saved sessions,
auth vault and auto-generated encryption key. Like [`~/.pi`](#packages-and-plugins) and
`~/.claude` without its declared volume, **`~/.agent-browser` is not a mount** — it is
baked into the image at build time and is container-local at run time. A volume later
mounted at `~/.agent-browser` **shadows** this install and costs a fresh 185 MB re-fetch
on first use; there is no option to point it somewhere else.

`agentBrowserChrome` is read only when `installAgentBrowser: true`. Unlike `piPackages`/
`herdrPlugins`, setting it with `installAgentBrowser` left at its default `false` is
**not** a build failure — it has a non-empty default (`"with-deps"`), so this Feature
cannot tell an explicit value from the default it was handed, and a `die` here would fail
the build of every consumer who enables neither option. It is silently ignored instead.

## Packages and plugins

`piPackages` and `herdrPlugins` install at **container create time** — every container
creation, including a plain "Rebuild Container", not just an image build.

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

### Why create time, not build time

Neither `~/.pi` nor `~/.config/herdr` is a mount — that part hasn't changed, and still
means anything either CLI writes is gone on the next full rebuild either way. What moved
is *when* the actual install runs, because build time had a real staleness bug: a
build-time install sits inside a Docker `RUN` layer, and Docker's build cache keys that
layer on the instruction text and the option value. An unchanged `herdrPlugins`/
`piPackages` string on a plain "Rebuild Container" (not "Rebuild Without Cache") is a
cache hit — Docker never re-executes the layer, so you silently keep whatever commit was
cloned the *last time that layer actually ran*, even if a `git:` source's default branch
(or an `npm:` source floating on `latest`) has moved on since. `postCreateCommand` is not
a Docker layer at all — it unconditionally reruns on every container *creation*, which is
exactly what "Rebuild Container" performs (destroy the container, create a new one from
the image) — so a create-time install always re-resolves each source's current tip, with
no ref to pin and no `--no-cache` rebuild needed to see it.

This Feature still validates both options at **build** time, exactly as before: setting
either without its CLI's install option is a **build failure**, not a silent skip — a skip
would leave a container that looks configured and installed nothing. `install.sh`
persists the raw, validated strings to two fixed files under
`/usr/local/share/devc-features/agents/` for `post-create.sh` to read later, because
`postCreateCommand` does not receive a Feature's own options as environment variables —
only `install.sh`, at build time, does.

One consequence of moving to create time: a **failed** entry now warns and moves on to
the next one, rather than failing the build the way it used to. That's deliberate, not a
downgrade — this now runs on every container creation instead of only when you choose to
rebuild the image, so a transient network blip at create time no longer costs you the
ability to open the container at all. Check `herdr plugin list` / `pi list`, or a
plugin's own `doctor` command, to notice a skip after the fact.

- `piPackages` entries are passed to `pi install <entry>` unparsed. pi accepts `npm:`,
  `git:`, `https://`, `ssh://` and local-path sources; this option does not validate the
  form.
- `herdrPlugins` entries are installed with `herdr plugin install <entry> --yes` and are
  **GitHub shorthand only** (`owner/repo[/subdir]`) — Herdr's installer accepts nothing
  else, so a `git:`-style entry fails with Herdr's own error. Needs `git` and network in
  the running container. Plugin registration is global to the user, so one create-time
  install covers every session in the container until the next create. A plugin declaring
  a `min_herdr_version` newer than the installed Herdr fails that one entry (warn and
  move on), which is expected rather than a bug.

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
