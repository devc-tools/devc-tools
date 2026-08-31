# agents (devcontainer Feature)

Installs coding-agent CLIs at build time — the **Claude Code CLI**, and optionally
the **GitHub Copilot CLI**, the **pi coding agent CLI** and the **Herdr terminal
multiplexer** — and at create time links a host config seed into `~/.claude` and
folds `~/.claude.json` into `~/.claude`, so **one** volume captures all of Claude
Code's state and **one** host directory supplies all of your config. It can also
install a declared set of **pi packages** and **Herdr plugins** at build time, for
the same reason the CLIs themselves install at build time rather than create time
— see [Why `piPackages`/`herdrPlugins` run at build
time](#why-pipackagesherdrplugins-run-at-build-time). Named for the plural: four
CLIs today, and the install-guard shape each one uses (idempotent, remote-user,
network-required-or-fail-the-build) is meant to take a fifth without a rename.
**Not** the `anthropic.claude-code` VS Code extension — see
[What this is not](#what-this-is-not).

```jsonc
"features": {
  "ghcr.io/devc-tools/agents:0": {}
}
```

No mounts, no options you have to set. A bare `{}` installs the Claude CLI,
leaves an empty seed directory for you to mount onto, and points
`~/.claude.json` at `~/.claude/.claude.json`.

> The tag tracks **this Feature's own** version line, not the repo's — see
> [../README.md#versions](../README.md#versions). It is `:0` while this Feature is
> pre-1.0.

## The three Claude paths

Three paths, three lifetimes — reproduced here rather than paraphrased, because
getting one of these confused for another is the whole failure mode this Feature
exists to prevent:

| Path                                                | What it is                                                                                                                 | Lifetime                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `~/.claude`                                         | Claude Code's own state directory — `projects/`, `todos/`, credentials, settings, and now `.claude.json` too.              | Per-workspace, if you mount a volume there (your choice).      |
| `/usr/local/share/devc-features/agents/claude-seed` | **Fixed.** Where you bind-mount your own host config. Created empty at build time; this Feature only ever reads it.        | Same as your bind mount; empty and harmless if you mount none. |
| a host seed directory                               | **Your** config — `CLAUDE.md`, `settings.json`, `statusline.sh`. The one thing you decide, and you decide it with a mount. | Lives on your host; the container only ever reads it.          |

`~/.claude.json` is deliberately **not** in that table any more: it is now a
symlink into `~/.claude`, with no lifetime of its own. See
[Why `~/.claude.json` moves](#why-claudejson-moves).

## What it does

At **build time** (as root):

1. Installs the Claude CLI (when `installClaudeCli`, default `true`), the
   GitHub Copilot CLI (when `installCopilotCli`, default `false`), the pi
   coding agent CLI (when `installPiCli`, default `false`), and Herdr (when
   `installHerdr`, default `false`) — as the **remote user**, not root, into
   `~/.local/bin`. pi has an extra prerequisite the others do not — see
   [Why pi needs Node.js](#why-pi-needs-nodejs); Herdr ships a static binary
   and needs nothing extra. Installing as root would put the binary somewhere
   the remote user cannot later update (`claude`/`copilot update`/`pi update`/
   `herdr update`) — the same reason
   [`devc-core/default/Dockerfile`](../../devc-core/default/Dockerfile) switches
   `USER` before its own two equivalent `RUN` lines, which this Feature copies
   the install guards from verbatim. Idempotent: a rebuild does not re-download
   when the binary is already there. **Network is required** when any install
   option is true — a failed download fails the build, rather than leaving a
   container that looks fine until the first `claude`.
2. Installs any `piPackages` (when `installPiCli` is also true) and any
   `herdrPlugins` (when `installHerdr` is also true) — see
   [Why `piPackages`/`herdrPlugins` run at build
   time](#why-pipackagesherdrplugins-run-at-build-time).
3. Pre-creates `$_REMOTE_USER_HOME/.claude` owned by the remote user. See
   [The volume question](#the-volume-question) for why.
4. Pre-creates the seed directory, empty. It is this Feature's published
   surface — the same shape as `bash-config`'s `dirs/user`.

At **create time** (as the remote user, before any user `postCreateCommand`),
`post-create.sh` runs three steps:

1. **Ownership repair.** If `~/.claude` is not owned by the current user, a
   non-recursive `sudo chown` fixes it (best-effort; a missing `sudo` only
   warns). Non-recursive is a hard requirement, not a style choice — subpaths
   like `skills/` may be host bind mounts and must not be chowned. Expected to
   be a no-op given step 2 above; kept because it is cheap and the alternative
   is unverified — see [The volume question](#the-volume-question).
2. **Seed links.** Every top-level _file_ in the seed directory is symlinked
   into `~/.claude` — host edits are live, host file modes (the statusline exec
   bit) survive, deletions on the host prune the link on the next create.
   Directories are ignored by design: a `~/.claude/skills/` mount point
   (something else's job, not this Feature's) would either get a nested
   `skills/skills` or fail on a busy mountpoint if this tried to link over it.
   An empty seed — nothing mounted — links nothing and moves on.
3. **`~/.claude.json`.** Replaced with a symlink to `~/.claude/.claude.json`,
   seeded with `{}` if nothing is there yet. Unconditional. See
   [below](#why-claudejson-moves).

Every skip path exits `0`. A `postCreateCommand` that fails aborts container
creation, and none of these skips (an empty seed, ownership already correct) is
worth an unbootable container.

| Option              | Default | Meaning                                                                                                                                                                                              |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `installClaudeCli`  | `true`  | Install the Claude Code CLI at build time, as the remote user.                                                                                                                                       |
| `installCopilotCli` | `false` | Install the GitHub Copilot CLI too. Defaults false — see [below](#why-installcopilotcli-defaults-false).                                                                                             |
| `installPiCli`      | `false` | Install the pi coding agent CLI too. Defaults false, same reasoning as `installCopilotCli`. **Requires Node.js in the image** — see [below](#why-pi-needs-nodejs).                                   |
| `installHerdr`      | `false` | Install the Herdr terminal multiplexer too. Defaults false, same reasoning as `installCopilotCli`. Ships a static binary — no extra prerequisite.                                                    |
| `piPackages`        | `""`    | Comma-separated pi package sources to install at build time. **Requires `installPiCli: true`** — see [below](#why-pipackagesherdrplugins-run-at-build-time).                                         |
| `herdrPlugins`      | `""`    | Comma-separated Herdr plugins to install at build time, in GitHub shorthand (`owner/repo[/subdir]`). **Requires `installHerdr: true`** — see [below](#why-pipackagesherdrplugins-run-at-build-time). |

That is the whole option surface.

### Why there are no path options

Versions before `0.2.0` had three: `claudeDir`, `seedDir` and `claudeJsonDir`.
All three are gone, and each for its own reason:

- **`claudeDir`** was a footgun rather than a capability. Claude Code resolves
  its own state directory as `$CLAUDE_CONFIG_DIR`, or `$HOME/.claude` when that
  variable is unset — so any value other than the remote user's own
  `~/.claude` pointed this Feature at a directory Claude Code never reads, and
  did it silently. There is exactly one correct answer, and the Feature now
  derives it.
- **`seedDir`** existed because the Feature "never invents a path only the
  consumer can mount." But the consumer does not need to _name_ the path to
  mount onto it — `bash-config` already fixes `dirs/user` and asks you to
  mount there. Fixing the path deletes the option **and** the class of bug
  where the mount target and the option disagree.
- **`claudeJsonDir`** is answered by [the section below](#why-claudejson-moves).

With no path options left, `install.sh` has nothing to validate and nothing to
bake: the injection guard and the `bake()` rewriting earlier versions carried
are gone with them. What replaced the bake guard is a pair of `grep`s in
`test/install_options_test.sh` asserting that the seed path `install.sh`
creates and the one `post-create.sh` reads are still the same string.

### Why `~/.claude.json` moves

Claude Code resolves its config/auth file as `$CLAUDE_CONFIG_DIR/.claude.json`,
falling back to `$HOME/.claude.json`. It is therefore a **sibling** of
`~/.claude`, not a member of it — the one piece of Claude Code state that a
volume mounted at `~/.claude` does not capture. And a volume can only mount at a
_directory_, so `~/.claude.json` cannot be a mount target on its own.

Earlier versions solved that with a second volume and the `claudeJsonDir`
option naming where it was mounted. Symlinking the file into `~/.claude`
instead solves it with no volume and no option: **one** mount now captures
everything, and `.claude.json` sits next to the `.credentials.json` and
`history.jsonl` it belongs with.

This is unconditional — there is nothing left to opt into. With no volume
mounted it is an indirection inside one home directory, which costs nothing and
keeps one code path instead of two.

Two consequences worth knowing:

- **A pre-existing real `~/.claude.json` is _moved_, not deleted.** The step
  used to run only when you opted in, so deleting the file it replaced was
  defensible; unconditional, it would be data loss. If
  `~/.claude/.claude.json` does not exist yet and `~/.claude.json` is a real
  file, it is `mv`d into place and you keep your session.
- **A symlink left by an older version is repointed, not kept.** The check
  compares the link's _target_, not just whether it is a link. Upgrading from
  `0.1.x` with a `claudeJsonDir` volume therefore starts a fresh
  `.claude.json` in the `~/.claude` volume — one re-login, once. The old
  volume is left untouched on disk; nothing deletes it for you.

### Why pi needs Node.js

`claude` and `copilot` ship self-contained installers that drop a binary. **pi
installs itself with `npm`**, so `installPiCli: true` requires **Node.js
22.19.0 or newer and npm** in the image. Add a node Feature alongside this one:

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": { "version": "lts" },
  "ghcr.io/devc-tools/agents:0": { "installPiCli": true }
}
```

This Feature's `installsAfter` already names `ghcr.io/devcontainers/features/node`
and `ghcr.io/devc-tools/node-nvmrc`, so ordering is handled for you.
Without a node Feature the build fails naming the requirement, rather than
producing a container that looks fine until the first `pi`.

Two things `install.sh` has to do for this that are worth knowing, because
neither is obvious and both are easy to break:

- **It sources nvm itself.** Ordering alone is not enough. The devcontainers
  node Feature wires nvm into `/etc/bash.bashrc`, and bash sources that file
  only for _interactive_ shells (`/etc/profile` guards it on `$PS1`). The
  build-time install runs a non-interactive shell, so node is on disk and
  invisible to it — `installsAfter` fixes the install _order_, not the `PATH`.
  The installer script therefore sources `$NVM_DIR/nvm.sh` (falling back to
  `/usr/local/share/nvm` and `~/.nvm`) when `node` is not already found.
- **It pins npm's global prefix to `~/.local`.** Under nvm, npm's global prefix
  is the _active node version's own directory_
  (`/usr/local/share/nvm/versions/node/<version>`). Left unpinned, `pi` would
  land there — and drop out of `PATH` the moment
  [`node-nvmrc`](../node-nvmrc/README.md) switched the container onto a
  different version for a project's `.nvmrc`, with the idempotency guard
  (`[ ! -x "$HOME/.local/bin/pi" ]`) never seeing it on a rebuild either.
  `npm_config_prefix=$HOME/.local` puts it beside `claude` and `copilot`
  instead, where it is stable across version switches.

The build also refuses a too-old Node.js up front, naming the version it needs
and the one it found. That gate should never fire with the node Feature at its
default `"version": "lts"` — it is there for a hand-lowered one, and so that
the failure is not reported as a network error, which is what pi's own preflight
exit code would otherwise look like from here.

#### pi and a project's `.nvmrc`

`~/.local/bin/pi` is a symlink to `dist/bundle/cli.js`, whose shebang is
`#!/usr/bin/env node` — so **pi runs under whatever `node` is first on `PATH` at
the time you run it, not the one it was installed with.** With
[`node-nvmrc`](../node-nvmrc/README.md) that is the version your workspace's
`.nvmrc` pins, because that Feature's `containerEnv` puts its `pin/bin` ahead of
everything else.

The pin only decides which `node` is found — `pi` itself is still found in
`~/.local/bin`, so this is a version question, never a "command not found" one:

| `.nvmrc` pins       | Result                                                                      |
| ------------------- | --------------------------------------------------------------------------- |
| ≥ 22.19.0 (any LTS) | Works.                                                                      |
| < 22.19.0           | **pi fails at runtime**, with a raw `SyntaxError`, not a version complaint. |

Measured on pi 0.84.3 under Node 20.20.2:

```
SyntaxError: The requested module 'node:fs' does not provide an export named 'globSync'
```

`engines` is enforced by npm at install time, not by node at run time, so
nothing intercepts this with a readable message. In practice every current LTS
line satisfies it (`lts/jod` is 22.23.2, `lts/krypton` is 24.20.0) — a project
would have to pin Node 20 or older to hit it.

There is no fix for this inside the Feature that does not trade one problem for
another: pinning pi's launcher to the Node it was installed with would decouple
it from `.nvmrc`, but leaves a dangling interpreter if that version is ever
removed. If a project must pin an older Node **and** wants pi, run pi from
outside the container, or give it its own Node via a wrapper on `PATH` ahead of
`pin/bin`.

### Why `installCopilotCli` defaults `false`

devc's own baseline installs both CLIs unconditionally today, and will pass
`installCopilotCli: true` when it eventually swaps onto this Feature (see
[Relationship to devc](#relationship-to-devc)). Even though this Feature is
named and scoped for agent CLIs plural, a consumer who enables it for Claude
should not silently get a second vendor's CLI too — each install stays
opt-in per CLI, so the default here is the narrower one and devc opts in
explicitly. `installPiCli` defaults `false` for the identical reason: enabling
this Feature for Claude must not silently install a third vendor's CLI either.
`installHerdr` defaults `false` for the same reason again — a fourth tool,
still opt-in on its own.

### Why `piPackages`/`herdrPlugins` run at build time

Both options exist because of one shared fact: **neither `~/.pi` nor
`~/.config/herdr` is a mount.** `pi install <source>` writes
`~/.pi/agent/settings.json` and clones or links the package; `herdr plugin
install <entry> --yes` registers the plugin under `~/.config/herdr`. Anything
either command does in a **running** container lives only in that container's
writable layer and is gone on the next rebuild. Installing them here, at
**build** time, is the only way either survives one — the same reasoning that
already puts the CLIs themselves in `install.sh` rather than
`post-create.sh`.

Both are plain comma-separated lists, split and trimmed the same way (empty
entries — from a leading/trailing/doubled comma or stray whitespace — are
silently dropped, so a messy value is harmless rather than a build failure):

```jsonc
"features": {
  "ghcr.io/devcontainers/features/node:1": { "version": "lts" },
  "ghcr.io/devc-tools/agents:0": {
    "installPiCli": true,
    "piPackages": "npm:@andrewjacop/pi-herdr,git:github.com/bmingles/pi-dev-extensions@main",
    "installHerdr": true,
    "herdrPlugins": "bmingles/herdr-plugins/agent-caffeinate"
  }
}
```

Each has its own hard dependency, and each is a **build failure**, not a
silent skip, when it is missing — a silent skip would leave a container that
looks configured (the option is set) and installs nothing, which is worse
than refusing to build:

- `piPackages` requires `installPiCli: true`. Each entry is passed to
  `pi install <entry>` as one argument, unparsed — pi itself accepts `npm:`,
  `git:`, `https://`, `ssh://` and local-path sources, and this option does
  not validate the form.
- `herdrPlugins` requires `installHerdr: true`. Each entry is installed with
  `herdr plugin install <entry> --yes` — **GitHub shorthand only**
  (`owner/repo[/subdir]`). Herdr's installer accepts nothing else, so a
  `git:`-style entry here fails with Herdr's own error, not this Feature's.
  `--yes` is required because `plugin install` otherwise shows a trust
  preview meant for an interactive terminal, and there is none at build time.
  Installing also needs `git` and network in the image; a build that fails
  here says so. Plugin registration is **global to the user, not per
  session**, so one build-time install covers every session in the
  container — and if the plugin declares a `min_herdr_version` newer than
  the Herdr this Feature installed, the install (and therefore the build)
  fails there too, which is expected, not a bug in this option.

Both are idempotent in practice: reinstalling an already-installed pi
package is a genuine no-op (verified — npm reports "up to date" and
`~/.pi/agent/settings.json` gains no duplicate entry), so a rebuild does not
pay for one.

**A volume mounted at `~/.pi` (or `~/.config/herdr`) shadows whatever this
installed**, the same footgun this Feature already documents for `~/.claude`
in [The volume question](#the-volume-question) — there is no `piDir` or
equivalent option to point either install somewhere else.

## What a consumer mounts

A Feature can declare no read-only mount and no `initializeCommand` (see
[../README.md](../README.md#layout)), so both mounts below are, unavoidably,
your own `devcontainer.json` — but neither needs a matching option any more:

```jsonc
"mounts": [
  // persistence: per-workspace Claude state that survives a rebuild — one volume,
  // and ~/.claude.json rides along inside it
  "type=volume,source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude",
  // seed: your own host config, read-only and live
  "type=bind,source=${localEnv:HOME}/.config/claude-seed,target=/usr/local/share/devc-features/agents/claude-seed,readonly"
],
"initializeCommand": "mkdir -p ${localEnv:HOME}/.config/claude-seed",
"features": {
  "ghcr.io/devc-tools/agents:0": {}
}
```

Each piece is independent — mount only the volume you want, or only the seed,
or neither. `${localWorkspaceFolderBasename}` substitution inside a
**consumer's own** `mounts` (as above) is ordinary, documented devcontainer
behavior — nothing about the open question below affects it. So per-workspace
isolation is available to every consumer **today**, however that question
eventually lands; it costs one line in your own config, not a missing
capability.

The seed bind is `readonly` on purpose, and that has one edge: seeded files are
symlinked into `~/.claude`, so Claude Code writing to one of them (a `/config`
change, a plugin install touching `settings.json`) fails. Host edits reaching
the container live, with no rebuild, is the trade that buys.

## The volume question

devc's baseline names its volumes per workspace — and a Feature _can_ declare
`type=volume` mounts (no `readonly` needed, so the object form is legal in the
published Feature schema). Doing so would make this Feature self-sufficient for
persistence, with no paste required.

It turns on one fact nobody has measured yet: **does
`${localWorkspaceFolderBasename}` substitute inside a Feature's own `mounts`
array?** `${localEnv:HOME}` is measured working (see
[`.plans/archived/devc-bridge-feature.md`](../../.plans/archived/devc-bridge-feature.md)),
but that is a different variable class, and nobody has run a container to
check this one — no Docker in the environment this Feature was written in.

If it substitutes, declaring the volume here is strictly better and a later
version of this Feature should do it. If it does not, declaring it anyway
would silently give **every project one shared volume** — worse than declaring
nothing, since two unrelated repos would share Claude auth and history with no
way to tell. That asymmetry is why this version takes the safe path: **no
`mounts` are declared**, and the line above is a paste instead of a default.
See
[`.plans/design/devc-feature-split.md`](../../.plans/design/devc-feature-split.md)
(open question 2) for the note recording this as still unmeasured, and open
question 3 for a related, also-unmeasured question about first-use volume
ownership — which is why the ownership-repair step in `post-create.sh` stays,
belt-and-braces, regardless of how question 2 eventually lands.

Note that this question got **cheaper** at `0.2.0`, not harder: there is one
volume to declare now instead of two.

## Relationship to devc

**devc no longer carries its own copy of this script.** It used to run an
equivalent `devc-core/default/scripts/agents-setup.sh` against its own
`/usr/local/share/devc/claude-seed` and `/usr/local/share/devc/claude-json`
paths; that script is retired, and devc now declares this Feature directly
in its bundled `devcontainer.json` (see
[`.plans/archived/devc-swap-baseline-features.md`](../../.plans/archived/devc-swap-baseline-features.md)),
with its seed bind retargeted onto this Feature's fixed path and the second,
`claude-json-*` volume dropped outright — `0.2.0`'s fold of `~/.claude.json`
into `~/.claude` left nothing for it to back.

This Feature is named for _agents_ plural (the original id was
`claude-config`, renamed before any consumer depended on it — see
[../README.md](../README.md)) — `post-create.sh` is namespaced under
`/usr/local/share/devc-features/agents/`.

devc's own `~/.claude` seed is documented in
[`devc/README.md`](../../devc/README.md#claude-config-configdevcclaude); its
`ensureClaudeSeedDir` (in
[`devc-core/default_config.ts`](../../devc-core/default_config.ts)) is why the
host seed directory always exists before devc ever binds it in. That function
has a `seedDir` parameter of its own — it names a **host** path and is
unrelated to the Feature option of the same name that `0.2.0` removed.

## What this is not

**Not the `anthropic.claude-code` VS Code extension** — that is a
`customizations.vscode.extensions` entry in devc's own
`devcontainer.json`, unrelated to installing the CLI. This Feature could
declare that extension too; it deliberately does not, without deciding that
separately — a config Feature that silently installs editor extensions is a
surprise a consumer did not ask for.

**Not a place for the `devc:skills` per-skill bind mounts** either — those are
wizard output `devc config` writes into `devc.json` as overlay mounts, not
baseline config, and nothing about them is Feature-shaped. They are also why
the seed step ignores directories.

**Not a way to share one `.claude.json` across projects.** Folding it into
`~/.claude` ties its lifetime to whatever you mount there — a per-workspace
volume keeps it per-workspace, exactly as the separate volume did.

## Tests

No Docker needed:

```sh
bash devc/tests/seed_link_test.sh features/agents/post-create.sh
bash features/agents/test/install_options_test.sh
bash features/agents/test/claude_json_test.sh
```

`seed_link_test.sh` is devc's own shared harness (see
[`devc/README.md`](../../devc/README.md#development)), reused unmodified
against this Feature's copy of the `devc:seed-link` block — the drift guard.
The block is byte-identical to devc's across `0.2.0` apart from its two
parameterizing assignments, which is the whole point of the fence.
`install_options_test.sh` runs the real `install.sh` with `curl` and `runuser`
stubbed on `PATH` (no network, no real privilege switch — that half needs
Docker), covering the two fixed paths, the already-installed idempotent skip,
that a failed download fails the build, the `piPackages`/`herdrPlugins`
comma-splitting (trailing commas and stray whitespace included), and both
`die` paths (`piPackages` without `installPiCli`, `herdrPlugins` without
`installHerdr`). `claude_json_test.sh` runs the
real, installed `post-create.sh` against a temp `HOME` with `stat`/`sudo`
stubbed, covering ownership repair and every `~/.claude.json` case including
the move-don't-delete and repoint-a-stale-link paths.

Needs Docker and a network:

```sh
bash features/agents/test/run-features-test.sh
```

The default scenario (`test.sh`) is the bare `{}` case: `claude` on `PATH` and
executable by the remote user, `~/.claude` owned by the remote user, an empty
seed directory with nothing linked out of it, `~/.claude.json` a symlink into
`~/.claude` reading back `{}`, and `copilot`/`pi`/`herdr` all absent with no
pi packages or Herdr plugins installed — the assertion that catches any of
these defaults flipping. `test/scenarios.json` adds `with_seed` (a populated
seed written into the fixed container path by the scenario's own
`onCreateCommand`, the same technique `git-container-config`'s
`mounted_identity` scenario uses to stand in for a mount a Feature cannot
declare — asserting top-level seed files land as symlinks and a seed
subdirectory does **not**), `with_copilot` (`installCopilotCli: true` puts
`copilot` on `PATH` alongside `claude`), `with_pi` (`installPiCli: true` plus
a node Feature — it puts `pi` on `PATH` alongside `claude`, and is the only
scenario that exercises the node prelude against a real container, asserting
`pi` resolves to `~/.local/bin/pi`), `with_herdr` (`installHerdr: true` puts
`herdr` on `PATH`, at `~/.local/bin/herdr`, with `herdr --version` working),
`with_pi_packages` (`installPiCli: true` plus a node Feature plus one
`piPackages` entry — asserts the package appears in `pi list` and
`~/.pi/agent/settings.json` exists, owned by the remote user), and
`with_herdr_plugins` (`installHerdr: true` plus one `herdrPlugins` entry —
asserts the plugin appears in `herdr plugin list`). The latter two hit the
network by design, as `with_pi` already does. None of these scenarios pass a
path option, because there are none: `with_seed` differs from the default
scenario only by what it writes into the seed.

## Publishing

This Feature **is** on
[`features/PUBLISH_ALLOWLIST.txt`](../PUBLISH_ALLOWLIST.txt) and publishes to
ghcr.io. `0.1.0` is the first version published under this org — the version
history from before the move does not exist in this registry, so there is no
earlier tag to upgrade from. See
[../README.md#the-publish-allowlist](../README.md#the-publish-allowlist) for
what that gate is and isn't.
