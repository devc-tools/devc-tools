# Installing devc-tools

```sh
curl -fsSL https://github.com/devc-tools/devc-tools/releases/latest/download/install.sh | sh
```

## What it installs

Prebuilt binaries for your machine go into `~/.local/bin`.

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
  On macOS, upgrading **stops** a running `devc-bridge`, so the new version
  takes over. Run `devc-bridge start` again. Running containers reconnect on
  their own.
- **Uninstall:** delete the files the installer printed.

## Requirements and platform notes

- **`PATH`:** if `~/.local/bin` isn't on your `PATH`, the installer says so and
  prints the line to add. It still installs.
- **Docker:** `devc` runs containers through Docker, so install it first. The
  installer warns if it's missing.
- **Platforms:** macOS and Linux. The `devc-bridge` host CLI is macOS-only,
  because every command it ships is macOS (`caffeinate`). Windows is not
  supported.
- **Gatekeeper (macOS):** the macOS binaries are unsigned. Installed with the
  `curl` command above, they run as-is. If Gatekeeper blocks one (for example,
  an archive you downloaded through a browser), clear the quarantine flag:
  `xattr -d com.apple.quarantine <path>`.

## Integrity

Every archive is checked against the release's `checksums.txt` before anything
is written. The script itself is a release asset, so the URL above always
serves the copy that release was built and tested with.
[`install.sh`](../install.sh) at the repo root is the source
of truth for that script.

## Building from source

See each tool's README: [devc](../devc/README.md#development),
[devc-bridge](../devc-bridge/README.md#from-a-clone-instead).
