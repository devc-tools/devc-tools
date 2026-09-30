# devc-tools

Run any project in a dev container with one command. If the project already
has a `.devcontainer/`, devc uses it. If it doesn't, devc supplies a default
container with coding agents (Claude Code, pi, Herdr) already installed.

```sh
cd ~/code/my-project
devc claude
```

## Quick start

**You need:** Docker, on macOS or Linux.

### 1. Install

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
```

This puts `devc` (and, on macOS, `devc-bridge`) in `~/.local/bin`. If that
directory isn't on your `PATH`, the installer prints the line to add. See
[docs/install.md](docs/install.md) for options, upgrading and platform notes.

### 2. Start a container and work in it

From any project directory:

```sh
devc claude       # start the container and run Claude Code in it
devc attach       # ...or just open a shell
```

The first run builds the image, which takes a few minutes. Later runs reuse it.

**`.devcontainer/` is supported, not required.**

- **Project has a config** (`.devcontainer/devcontainer.json` or a root
  `.devcontainer.json`): devc builds from it, the same config VS Code would
  use. devc adds only its small `devc-config` Feature on top. For
  `devc claude` / `pi` / `herdr` to work, the config has to install that agent.
  The [`agents` Feature](features/agents/README.md) is the easy way.
- **Project has none:** devc uses its bundled default, which includes Node,
  Deno, git-lfs, Claude Code, pi and Herdr.

Claude Code signs in on first use. Its state lives in `~/.config/devc/.claude`
on the host, so **one login covers every devc container**. To share your
personal `CLAUDE.md` or settings with every container, copy them there:

```sh
cp ~/.claude/CLAUDE.md ~/.config/devc/.claude/
```

### 3. Everyday commands

| Command                        | Does                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `devc attach`                  | Start the container if needed and open a shell in it                                                     |
| `devc claude` / `pi` / `herdr` | Same, but run that agent. Pass its own args after `--`: `devc claude -- --resume`                        |
| `devc exec -- CMD`             | Run one command in the container                                                                         |
| `devc status`                  | `running` / `stopped` / `missing`                                                                        |
| `devc build`                   | Recreate the container. Run this after changing its config                                               |
| `devc config`                  | Pick sibling repos and skill folders to mount into the container ([details](devc/README.md#devc-config)) |
| `devc init`                    | Copy the default config into `.devcontainer/` so you can edit it ([details](devc/README.md#commands))    |
| `devc stop` / `devc down`      | Stop the container / stop and remove it                                                                  |

Every command works on the current directory, or on a path you pass
(`devc attach ~/code/other`). `devc --help` lists everything. The full reference
is in the [devc README](devc/README.md#commands).

## Next steps

**Mount sibling repos or skill folders.** Run `devc config` for a picker that
chooses folders to bind-mount into the container, then offers to rebuild. It
saves your picks in a `devc.json` overlay. See
[`devc config`](devc/README.md#devc-config).

**Customize the container.** Run `devc init` to copy the bundled default into
`.devcontainer/` so you can edit it. For personal, uncommitted tweaks, see
[the `devc.json` overlay](devc/README.md#optional-overlay-devcjson),
[shell setup](devc/README.md#shell-setup-shell-folders) and the
[post-create hook](devc/README.md#project-post-create-hook-devc-post-createsh).

**Let the container reach the host (macOS).** `devc-bridge` lets code in a
container run allowlisted host commands, such as keeping the Mac awake while an
agent works, or pushing a branch with your host's `gh` login. Start it once:

```sh
devc-bridge start
```

Then see [devc-bridge setup](devc-bridge/README.md#setup-macos-host) and
[pushing and PR review from a container](docs/bridge-github.md).

**Use the Features in your own devcontainers.** The agent, shell and git setup in
devc's default container is published as standalone
[devcontainer Features](features/README.md), so you can add them to any
`devcontainer.json`.

## What's in the box

| Tool                                   | What it is                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`devc`](devc/README.md)               | Dev container lifecycle CLI (`up`, `attach`, `claude`, `exec`, `build`, …) plus the `devc config` mount picker.                                |
| [`devc-bridge`](devc-bridge/README.md) | A headless host daemon (macOS) and container client that let a container invoke allowlisted host commands. A menu-bar tray is an opt-in extra. |
| [Features](features/README.md)         | Published devcontainer Features: `agents`, `bash-config`, `devc-bridge`, `git-container-config`, `node-nvmrc` and more.                        |
| [`devc-core`](devc-core/README.md)     | `devc`'s lifecycle logic as an npm library, `@devc-tools/core`, for programmatic use.                                                          |

## How devc works

devc wraps the [`devcontainer` CLI](https://github.com/devcontainers/cli),
which is embedded in the binary. On every start it merges the bundled default
or your project's config, devc's own baseline Features, and any `devc.json`
overlays into one effective config under `~/.cache/devc/`. It then runs
`devcontainer up` against that config. `devc up --print-config` shows the
result. For the details, see [How it works](devc/README.md#how-it-works) and
[Git protection](devc/README.md#git-protection-frozen-gitconfig-and-githooks),
which covers why `.git/config` is read-only inside the container.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
tests and how versions and releases are handled.
