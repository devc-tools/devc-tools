# devc-bridge (devcontainer Feature)

Gives a devcontainer the [devc-bridge](../../devc-bridge/README.md) client, so
code inside the container can invoke allowlisted commands on the **host** (e.g.
`caffeinate` the Mac while a Claude Code session runs).

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
[Why the mount is not in the Feature](#why-the-mount-is-not-in-the-feature). No
post-create step and no env vars: `DEVC_BRIDGE_ADDR` and
`DEVC_BRIDGE_TOKEN_FILE` already default to the address and the mount target
above.

> The tag tracks **this Feature's** version line, not the repo's — Features
> version independently of the devc-tools release tag. It is `:0` while this
> Feature is pre-1.0; it becomes `:1` at its first 1.x release.

## Install the host bridge first

**Prerequisite: `~/.config/devc-bridge/run` must already exist on the host.** It
does as soon as you have run `devc-bridge start` once — see
[devc-bridge Setup](../../devc-bridge/README.md#setup-macos-host).

If it does not, container creation **fails** on _your_ mount with a Docker error
like:

```
Error response from daemon: invalid mount config ...
bind source path does not exist: /Users/you/.config/devc-bridge/run
```

`--mount type=bind` errors on a missing source rather than creating it, and
nothing in the container can fix that: a Feature's five lifecycle hooks all run
_inside_ the container, and Features cannot declare an `initializeCommand`, the
one hook that runs on the host.

devc projects have the same prerequisite — devc creates no bridge directories
either. What devc does do is write the mount line for you, in zero-config mode
only; see [devc and the bridge](../../devc/README.md#the-token-mount-and-the-one-place-devc-does-something-for-you).

**If you omit the mount line entirely,** the container builds fine and
`devc-bridge` is on PATH, but the first call fails with:

```
devc-bridge: cannot read token /run/devc-bridge/token: ...
devc-bridge: is the host server running and the run dir bind-mounted?
```

## What it does

Downloads the Linux `devc-bridge` client for the container's architecture from
the matching devc-tools release, verifies it against the release's
`checksums.txt`, installs it at
`/usr/local/share/devc-bridge/client/devc-bridge`, and symlinks
`/usr/local/bin/devc-bridge` at it. Nothing is mounted.

| Option          | Default | Meaning                                                                        |
| --------------- | ------- | ------------------------------------------------------------------------------ |
| `clientVersion` | `""`    | devc-tools release to install the client from. Empty means the pinned release. |

Deliberate details:

- **The client is a root-owned file in an image layer, not a shared host file.**
  That is what replaced `readonly` on the old client mount: rather than blocking
  one container from rewriting a binary every _other_ container executes, there
  is no longer any shared artifact to rewrite.
- **A failed or unverifiable download fails the build.** Better than a container
  that looks fine until the first `devc-bridge` call.
- **The install path is unchanged from when it was a mount,** so the developer
  override still works: bind-mount a locally built client _directory_ over
  `/usr/local/share/devc-bridge/client` and it shadows the downloaded copy, live.

Smoke test, from inside the container:

```sh
devc-bridge ping test    # → pong
```

## Why the mount is not in the Feature

Because a Feature **cannot** declare a read-only mount, and this one has to be
read-only.

The published Feature schema types `mounts` as objects only, and its `Mount` is
`additionalProperties: false` over `source`/`target`/`type` — there is no
`readonly` field. The CLI matches: an object mount is re-serialized as
`type=…,src=…,dst=…`, dropping everything else. A _string_ mount does survive
verbatim, which is how this Feature used to do it — but that is off-schema and
undocumented, so a CLI that ever normalized string mounts would silently make the
token writable.

`devcontainer.json` is different, and says so: its schema takes
`anyOf: [Mount, string]` and defers to _"Docker's documentation for the --mount
option"_. There, `readonly` is specified rather than accidental. So the mount
belongs to you, not to the Feature.

Two bonuses: you can adjust the mount without fighting the Feature (a
Feature-declared mount plus your own is Docker's `Duplicate mount point`, a hard
create failure), and the security-relevant line is text you can see rather than
something inherited invisibly.

**Why read-only matters:** a writable `run/` lets a container pin the host's
token for the next restart, and hands the host a symlink to write the new token
through. The host hardens against both (it regenerates on every start and never
writes through a symlink), so an omitted `readonly` is not a disaster — but it is
the difference between one guarantee and two.

## Docker Compose

Works, with one caveat: for a compose-based devcontainer the CLI rewrites mounts
into the generated compose file and **drops `readonly`** whichever form you
write — see [devcontainers/cli#881](https://github.com/devcontainers/cli/issues/881).
Your token mount will be writable. The host-side hardening above is what makes
that survivable; the residual is that `run/` is then a shared writable directory
between containers that mount it.

## Maintainer notes

**Do not add a `mounts` key to `devcontainer-feature.json`.** It would
reintroduce the off-schema dependency this Feature was rewritten to shed _and_
collide with the consumer's own mount. `devc/tests/default_config_test.ts`
asserts the key is absent.

**`DEVC_TOOLS_RELEASE` in `install.sh` is not this Feature's version.** It names
the devc-tools release the client is downloaded from, and the two are
independent: bump `version` when this Feature changes, bump
`DEVC_TOOLS_RELEASE` when you want a newer client — which is itself a Feature
change, so it bumps both. Pinning it means the Feature ships a client that was
tested against this `install.sh` rather than whatever is newest.

`bash tests/features_test.sh --check-release-pins` fails the publish if it names
a release that does not exist. That is a guard the old `v*` tag trigger used to
provide by accident; publishing from `main` needs it spelled out.

### Tests

No Docker needed. The symlink block, extracted from the real `install.sh`:

```sh
bash features/devc-bridge/test/install_link_test.sh features/devc-bridge/install.sh
```

The download — arch → asset mapping, and the failure paths (bad checksum, missing
asset, unsupported arch) that must abort with nothing installed — against a
fixture release served over `file://`:

```sh
bash features/devc-bridge/test/install_download_test.sh features/devc-bridge/install.sh
```

Needs Docker and a network, but **no host bridge** any more, since nothing is
mounted. Builds a real container and asserts, _inside_ it, that the client is
installed, root-owned, on PATH and reports the expected version:

```sh
bash features/devc-bridge/test/run-features-test.sh
```

### Publishing

`.github/workflows/publish-feature.yml` publishes this folder to
`ghcr.io/devc-tools/features/devc-bridge` on a push to `main` that touches
`features/`, in its own matrix job. Bump `version` in
`devcontainer-feature.json` in the same commit as the change, or the publish is
a no-op: the CLI skips a version already in the registry, so nothing is pushed
and the run says so.
