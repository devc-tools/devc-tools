# Installing devc-tools

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
```

## What it installs

Prebuilt binaries for your machine go into `~/.local/bin`. **No Deno needed**,
and the installer never uses `sudo`.

| Platform | On your `PATH`                   | Also installed                       |
| -------- | -------------------------------- | ------------------------------------ |
| macOS    | `devc`, `devc-bridge` (host CLI) | Linux `devc-bridge` container client |
| Linux    | `devc`                           | Linux `devc-bridge` container client |

The container client goes in `~/.config/devc-bridge/client/`. devc mounts it
read-only into every bridge-enabled container it starts, so those containers
always run the client that matches your host bridge. Any other container that
uses the [bridge Feature](../features/devc-bridge/README.md) gets the client the
Feature downloads when the image is built.

## Options

The installer is piped to `sh`, so it takes env vars instead of flags:

| Variable           | Default            | Does                                          |
| ------------------ | ------------------ | --------------------------------------------- |
| `DEVC_VERSION`     | the latest release | Install a specific tag, e.g. `v0.1.0`         |
| `DEVC_INSTALL_DIR` | `~/.local/bin`     | Where `devc`/`devc-bridge` go                 |
| `DEVC_TOOLS`       | all that apply     | Subset to install: `devc`, `bridge`, `client` |

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | DEVC_VERSION=v0.5.0 sh
```

The header comment of [`install.sh`](../install.sh) lists a few more variables
meant for mirrors and the test harness.

## Upgrading and uninstalling

- **Upgrade:** run the installer again. It downloads, verifies and replaces.
  On macOS, a running `devc-bridge` is **stopped** once its binary is replaced,
  so the old version can't keep serving containers the new `devc` has granted
  capabilities it doesn't know about. Start it again yourself
  (`devc-bridge start`). Running containers reconnect as they were, so there is
  nothing to re-up.
- **Uninstall:** delete the files the installer printed.

## Requirements and platform notes

- **`PATH`:** if `~/.local/bin` isn't on your `PATH`, the installer says so and
  prints the line to add. It still installs.
- **Docker is the only runtime dependency.** The
  [`devcontainer` CLI](https://github.com/devcontainers/cli) is embedded in the
  `devc` binary, so you don't need it or Node.js on your `PATH`. The installer
  warns if Docker is missing and installs anyway.
- **Windows is not supported.** The `devc-bridge` **host** CLI is macOS-only,
  because every command it ships is macOS (`caffeinate`). `devc` and the
  container client work on Linux.
- **Gatekeeper:** `curl` does not set `com.apple.quarantine`, so a macOS binary
  installed this way runs. One downloaded through a browser would not.
- **The macOS binaries are unsigned.** `release.yml` cross-compiles them on a
  Linux runner. GitHub's macOS runners kept becoming unavailable to this repo,
  and these two binaries were the only reason the pipeline needed macOS at all,
  so there is no `codesign` step and no native run to check them against. If
  Gatekeeper still complains on your setup, run
  `xattr -d com.apple.quarantine <path>` to clear it.

## Integrity

Every archive is checked against the release's `checksums.txt` before anything
is written. The script itself is a release asset, so the URL above always
serves the copy that release was built and tested with, not whatever `main`
currently holds. [`install.sh`](../install.sh) at the repo root is the source
of truth for that script.

## Building from source

See each tool's README: [devc](../devc/README.md#development),
[devc-bridge](../devc-bridge/README.md#from-a-clone-instead).
