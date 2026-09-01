# devcontainer Features

Drop-in Features for any devcontainer. Each one is published as its own OCI artifact and
declared in your `devcontainer.json`:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/bash-config:0": {}
}
```

Every Feature here works from a bare `{}` — no required options. Some want a mount from
your own `devcontainer.json` to be useful; each README carries the exact line to paste.

| Feature                                                | Ref                                                | What it does                                                                                                                                          |
| ------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agents](agents/README.md)                             | `ghcr.io/devc-tools/features/agents`               | Installs coding-agent CLIs — Claude Code, and optionally Copilot, pi and Herdr — and keeps all of Claude Code's state in one place.                   |
| [bash-config](bash-config/README.md)                   | `ghcr.io/devc-tools/features/bash-config`          | Sources your project's and your personal `bashrc_*.sh` scripts in every interactive shell.                                                            |
| [devc-bridge](devc-bridge/README.md)                   | `ghcr.io/devc-tools/features/devc-bridge`          | Installs the devc-bridge client, so code in the container can run allowlisted commands on your host.                                                  |
| [devc-config](devc-config/README.md)                   | `ghcr.io/devc-tools/features/devc-config`          | Runs your own `devc-post-create.sh` on every container create, and adds devc's bash prompt and terminal title.                                        |
| [git-container-config](git-container-config/README.md) | `ghcr.io/devc-tools/features/git-container-config` | Re-applies the user-scope git settings a container needs and cannot keep — LFS filters, `worktree.useRelativePaths`, `safe.directory`, your identity. |
| [node-nvmrc](node-nvmrc/README.md)                     | `ghcr.io/devc-tools/features/node-nvmrc`           | Makes the Node version your workspace pins in `.nvmrc` the one every process in the container gets.                                                   |
| [podman-as-docker](podman-as-docker/README.md)         | `ghcr.io/devc-tools/features/podman-as-docker`     | Makes `docker` commands work via Podman — no Docker daemon, no socket mount. **Read its privilege cost before enabling it.**                          |

## Version tags

The tag tracks **each Feature's own** version line, not the devc-tools release: `:0` while
that Feature is pre-1.0, `:1` at its first 1.x release. Two Features at different versions
is normal, not drift.

## A note on availability

These publish to `ghcr.io/devc-tools/features/*`. A newly created GHCR package is
**private** until it is made public in the repo's Packages settings, and `devc-bridge`
does not publish at all until its pinned devc-tools release is tagged — so a ref here may
not resolve for an anonymous `devcontainer up` yet.

## devc contributes `devc-config` for you

`devc up` adds `devc-config` to every container it starts, whether or not your
`devcontainer.json` mentions it — including a project with its own hand-written config
that has never heard of devc. Declaring it yourself, under any tag, replaces devc's entry
rather than adding a second one. To opt out of it and every other Feature devc contributes
on its own, set `"baselineFeatures": false` in a `devc.json` overlay.

A `devc init`-scaffolded project run with a plain `devcontainer up` and no `devc`
installed does **not** get it. Declare `"devc-config": {}` yourself if you want the
behavior without devc.

## Working on these

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, versioning, testing and publishing.
