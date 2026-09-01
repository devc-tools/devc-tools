# devc-tools

A collection of small tools for working with **devcontainers** — each one
self-contained in its own subfolder, with its own docs and build tasks.

## Install

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
```

Installs the prebuilt binaries for your machine into `~/.local/bin` — **no Deno
needed**, and never `sudo`. On macOS that is `devc` and the `devc-bridge` host
CLI; on Linux, `devc`. Both also get a copy of the Linux `devc-bridge`
**container client** in `~/.config/devc-bridge/client/`, which is a _developer
override_ only — a container with the
[bridge Feature](features/devc-bridge/README.md) downloads its own client at
image build time rather than mounting one from the host.

Every archive is checked against the release's own `checksums.txt` before
anything is written. The script itself is a release asset, so the URL above
always serves the copy that release was built and tested with — not whatever
`main` currently holds.

Knobs, as env vars (it is piped to `sh`, so there are no flags):

| Variable           | Default            | Does                                          |
| ------------------ | ------------------ | --------------------------------------------- |
| `DEVC_VERSION`     | the latest release | Install a specific tag, e.g. `v0.1.0`         |
| `DEVC_INSTALL_DIR` | `~/.local/bin`     | Where `devc`/`devc-bridge` go                 |
| `DEVC_TOOLS`       | all that apply     | Subset to install: `devc`, `bridge`, `client` |

Re-run it to upgrade — download, verify, replace. To uninstall, delete the files
it printed.

Notes:

- **Add `~/.local/bin` to your `PATH`** if it isn't already; the installer says
  so and prints the line to add rather than installing something unreachable.
- `devc` needs `docker` at run time, and nothing else. The
  [`devcontainer` CLI](https://github.com/devcontainers/cli) is **embedded in
  the binary**, so neither it nor the Node.js it would otherwise need has to be
  on your `PATH`. The installer reports Docker if it is missing and installs
  anyway.
- Gatekeeper: `curl` does not set `com.apple.quarantine`, so an installed macOS
  binary runs. One downloaded through a browser would not.
- **The macOS binaries (`devc`, the `devc-bridge` host CLI) are unsigned.**
  `release.yml` builds them by cross-compiling from a Linux runner rather than
  a real Mac — GitHub's macOS-hosted runners kept becoming unavailable out
  from under this repo (a retired label, then a deprecation window, in the
  same week) for two binaries that are the only reason this pipeline needed
  macOS runners at all — so there is no `codesign` step and no native
  execution to verify against. If Gatekeeper still complains for your setup,
  `xattr -d com.apple.quarantine <path>` clears it.
- **Windows is out of scope**, and the `devc-bridge` **host** CLI is macOS-only
  — every command it ships is macOS (`caffeinate`). Its container client and
  `devc` itself are fine on Linux.

To build from source instead, see each tool's README; `install.sh` at the repo
root is the source of truth for the script above.

## Tools

| Tool                                    | What it does                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`devc-bridge/`](devc-bridge/README.md) | Lets a devcontainer invoke allowlisted commands on the host (e.g. `caffeinate` the Mac while a Claude Code session runs). Runs headless; `devc-bridge status` reports idle/active, and a menu-bar tray is an opt-in extra.                                                                      |
| [`devc/`](devc/README.md)               | Dev container lifecycle CLI (`up`, `attach`, `claude`, `exec`, `build`, …) over a bundled default config, plus `devc config` — a TUI that bind-mounts sibling projects, Git worktrees, and agent skill folders into the project's `.devcontainer/`, editing only its own comment-fenced blocks. |
| [`devc-core/`](devc-core/README.md)     | `devc`'s lifecycle logic (`startContainer`, the `devc.json` overlay, …) as a runtime-neutral library, published to npm as `@devc-tools/core` for programmatic consumers. Not a separate tool to install — `devc` compiles it in unchanged.                                                      |

## Repo layout

| Path                        | Role                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `devc-bridge/`              | The host command bridge — see its [README](devc-bridge/README.md)                        |
| `devc/`                     | The dev container CLI + config TUI — see its [README](devc/README.md)                    |
| `devc-core/`                | `devc`'s lifecycle logic, as an npm library — see its [README](devc-core/README.md)      |
| `features/`                 | Published devcontainer Features — see its [README](features/README.md)                   |
| `install.sh`                | The `curl \| sh` installer — source of truth; shipped as a release asset                 |
| `tests/install_test.sh`     | Its shell harness (`bash tests/install_test.sh install.sh`) — offline, no network        |
| `.github/workflows/`        | `release.yml` (binaries from a `v*` tag) and `publish-feature.yml` (Features, on `main`) |
| `scripts/bash_aliases.sh`   | Shell functions to run each tool from source (no build) — source it from `~/.bashrc`     |
| `.devc/`                    | Devcontainer config for developing _this_ repo (bind mounts, env, post-create)           |
| `.plans/`                   | Plan docs; `.plans/PLAN.md` is the status index                                          |
| `devc-tools.code-workspace` | VS Code workspace file                                                                   |

Each tool owns its setup instructions; start with the tool's own README.

## Releasing

**One version for both binaries, moving in lockstep.** A single `vX.Y.Z` tag
gates `devc` and `devc-bridge` together, because the installer fetches all eight
tarballs from one release and must not reason about compatible pairs. The tag is
the source of truth and nothing rewrites a version during the build — a tag that
disagrees with any hand-maintained version fails the workflow before anything is
compiled.

**The Features in `features/` are not part of that.** Each carries its own
`version` and publishes on its own cadence, from a push to `main` that touches
`features/` — a Feature is pulled from ghcr by a consumer's `devcontainer.json`,
not installed by `install.sh`, so a one-line fix to one ships without a binary
release and an untouched Feature never gets a new digest. Bump the `version` of
whatever Feature you changed, in the same commit; anything you do not bump simply
does not publish. See
[`features/CONTRIBUTING.md`](features/CONTRIBUTING.md#versions).

One exception: `devc-config` is pinned at an exact version by
`devc-core/overlay.ts`'s `DEVC_CONFIG_FEATURE`, since devc injects it into every
container it starts. Bumping that Feature means bumping the pin in the same
commit — and only a devc release delivers it.

**A Feature also has to be on the allowlist to publish at all.**
[`features/PUBLISH_ALLOWLIST.txt`](features/PUBLISH_ALLOWLIST.txt) is what keeps a
Feature under active development off ghcr.io until it's ready — see
[The publish allowlist](features/CONTRIBUTING.md#the-publish-allowlist).

**`@devc-tools/core` is not published by any workflow.** It is a manual
`npm publish`, and `devc-core/package.json` has no `prepublishOnly` hook while
its `files` is `["dist"]` — so an unbuilt `dist/` publishes an empty package.
Run [`scripts/preflight-core-publish.sh`](scripts/preflight-core-publish.sh)
**on the host** first: it checks the same preconditions `release.yml` would
refuse a tag over, runs the guards below, builds and smoke-tests the real
tarball, and prints the two commands left — the tag, then the publish. It never
tags, pushes or publishes.

**Tag before you `npm publish`.** The two are independent (`devc` imports
`devc-core` from source, not from the registry), so the only question is which
is recoverable: a tag and its release can be deleted and re-cut, an npm version
can never be republished. Let `release.yml` go green first.

To cut a release:

1. Bump the version in **all three binaries** — `VERSION` in `devc/help.ts`,
   `devc-bridge/host/version.ts` and `devc-bridge/client/version.ts` — guarded by
   `release.yml`. Prereleases are no exception: to tag `v0.1.0-rc.1`, every one of
   those versions must be `0.1.0-rc.1`, so nothing claims a version its release
   does not have. Nothing under `features/` moves for a release; if a Feature
   pins a devc-tools release in its `install.sh` (`DEVC_TOOLS_RELEASE`, only
   `devc-bridge` today), pointing it at a newer one is a change to that Feature,
   with its own version bump, on its own schedule.
2. Commit, then `git tag v0.1.0 && git push --tags`.
3. [`release.yml`](.github/workflows/release.yml) builds each of the eight
   archives on a runner of its own architecture, runs `--version` on what it
   built, writes `checksums.txt`, stamps the tag into `install.sh` and publishes.
   Assets are named `<tool>-<version>-<triple>.tar.gz` — the version sits in the
   middle so the assets group by tool on the release page (digits sort before
   letters, so `devc-bridge-*` cannot wedge into the middle of `devc-*`) and a
   downloaded archive says which version it is. `install.sh` and `checksums.txt`
   stay version-free: the former is served from `releases/latest/download/`, so
   its name cannot move. It publishes no Features —
   [`publish-feature.yml`](.github/workflows/publish-feature.yml) does that on a
   push to `main`, one job per Feature, to `ghcr.io/devc-tools/features/<id>`.

Neither workflow has ever run, and the release path crosses machines this repo
is not developed on. Before the first real tag, work through
[docs/manual-verification.md](docs/manual-verification.md) — the checks that
need GitHub Actions, a Docker host or a Mac, ordered cheapest-and-most-
informative first.

A tag with a `-suffix` publishes as a prerelease, so
`releases/latest/download/install.sh` keeps pointing at the last stable one. To
exercise the whole matrix before tagging, run `release.yml` from the Actions tab
with `dry_run` — it builds and uploads everything as workflow artifacts without
creating a release.
