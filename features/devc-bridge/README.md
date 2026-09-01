# devc-bridge (devcontainer Feature)

Gives a devcontainer the [devc-bridge](../../devc-bridge/README.md) client, so code inside
the container can run allowlisted commands on your **host** — for example `caffeinate` the
Mac while a Claude Code session runs.

Two lines, and **both are required**:

```jsonc
"features": {
  "ghcr.io/devc-tools/features/devc-bridge:0": {}
},
"mounts": [
  "type=bind,source=${localEnv:HOME}/.config/devc-bridge/run,target=/run/devc-bridge,readonly"
]
```

The Feature installs the client. The **mount is yours to declare** — see
[Why the mount is not in the Feature](#why-the-mount-is-not-in-the-feature). No post-create
step and no env vars: `DEVC_BRIDGE_ADDR` and `DEVC_BRIDGE_TOKEN_FILE` already default to
the address and the mount target above.

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Install the host bridge first

**Prerequisite: `~/.config/devc-bridge/run` must already exist on your host.** It does as
soon as you have run `devc-bridge start` once — see
[devc-bridge Setup](../../devc-bridge/README.md#setup-macos-host).

If it does not, container creation **fails** on *your* mount with a Docker error like:

```
Error response from daemon: invalid mount config ...
bind source path does not exist: /Users/you/.config/devc-bridge/run
```

`--mount type=bind` errors on a missing source rather than creating it, and nothing in the
container can fix that: a Feature's lifecycle hooks all run *inside* the container, and
Features cannot declare an `initializeCommand`, the one hook that runs on the host.

devc projects have the same prerequisite — devc creates no bridge directories either. What
devc does do is write the mount line for you, in zero-config mode only; see
[The token mount](../../devc/README.md#the-token-mount).

**If you omit the mount line entirely,** the container builds fine and `devc-bridge` is on
PATH, but the first call fails with:

```
devc-bridge: cannot read token /run/devc-bridge/token: ...
devc-bridge: is the host server running and the run dir bind-mounted?
```

## What it does

Downloads the Linux `devc-bridge` client for the container's architecture from the matching
devc-tools release, verifies it against the release's `checksums.txt`, installs it at
`/usr/local/share/devc-bridge/client/devc-bridge`, and symlinks
`/usr/local/bin/devc-bridge` at it. Nothing is mounted.

| Option          | Default | Meaning                                                                        |
| --------------- | ------- | ------------------------------------------------------------------------------ |
| `clientVersion` | `""`    | devc-tools release to install the client from. Empty means the pinned release. |

Two details worth knowing:

- **A failed or unverifiable download fails the build.** Better than a container that looks
  fine until the first `devc-bridge` call.
- **You can shadow the client with a local build.** Bind-mount a locally built client
  *directory* over `/usr/local/share/devc-bridge/client` and it replaces the downloaded
  copy, live — the symlink follows it.

Smoke test, from inside the container:

```sh
devc-bridge ping test    # → pong
```

## Why the mount is not in the Feature

Because a Feature **cannot** declare a read-only mount, and this one has to be read-only.

The published Feature schema types `mounts` as objects only, and its `Mount` is
`additionalProperties: false` over `source`/`target`/`type` — there is no `readonly` field.
The CLI matches: an object mount is re-serialized as `type=…,src=…,dst=…`, dropping
everything else.

`devcontainer.json` is different, and says so: its schema takes `anyOf: [Mount, string]`
and defers to *"Docker's documentation for the --mount option"*. There, `readonly` is
specified rather than accidental. So the mount belongs to you.

Two bonuses: you can adjust the mount without fighting the Feature (a Feature-declared
mount plus your own is Docker's `Duplicate mount point`, a hard create failure), and the
security-relevant line is text you can see rather than something inherited invisibly.

**Why read-only matters:** a writable `run/` lets a container pin the host's token for the
next restart, and hands the host a symlink to write the new token through. The host hardens
against both (it regenerates on every start and never writes through a symlink), so an
omitted `readonly` is not a disaster — but it is the difference between one guarantee and
two.

## Docker Compose

Works, with one caveat: for a compose-based devcontainer the CLI rewrites mounts into the
generated compose file and **drops `readonly`** whichever form you write — see
[devcontainers/cli#881](https://github.com/devcontainers/cli/issues/881). Your token mount
will be writable. The host-side hardening above is what makes that survivable; the residual
is that `run/` is then a shared writable directory between containers that mount it.
