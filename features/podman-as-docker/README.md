# podman-as-docker (devcontainer Feature)

Makes `docker` commands work inside a devcontainer by installing **Podman** and the
`podman-docker` shim — no Docker daemon, no `/var/run/docker.sock` bind mount, no
privileged sibling container.

## Read this before enabling it: the privilege cost

**This is not the secure option.** It is a meaningfully better trade than the
alternatives, not a free one:

| Approach | What it grants | Cost of abuse |
| --- | --- | --- |
| `docker-outside-of-docker` | the host Docker API | **Immediate, trivial, total.** `docker run -v /:/host alpine chroot /host sh`. No exploit required. |
| `docker-in-docker` | `--privileged` — all caps, all devices | Immediate and total, by a slightly longer road. |
| **`podman-as-docker`** | **`CAP_SYS_ADMIN`** plus three Docker/runc `securityOpt` flags (below) | Escape requires an actual kernel/mount exploit, and on Docker Desktop lands in the LinuxKit VM, not on macOS. Nothing on the host is reachable *by design*. |

This Feature declares all four **unconditionally**, the moment you add it:

```jsonc
"capAdd": ["SYS_ADMIN"],
"securityOpt": ["systempaths=unconfined", "apparmor=unconfined", "seccomp=unconfined"]
```

`SYS_ADMIN` is a Linux capability. The other three are not capabilities and add no
capability beyond `SYS_ADMIN` — they are Docker/runc flags that each remove one
specific piece of Docker's default hardening, and all three are **measured
required**, not defensive boilerplate, each found by hitting its own specific
failure rather than added speculatively:

- **`systempaths=unconfined`** removes the default read-only bind-mount Docker
  applies over `/proc/asound`, `/proc/bus`, `/proc/fs`, `/proc/irq`, `/proc/sys` and
  `/proc/sysrq-trigger`. Without it, every `podman run` — in every network mode,
  `--network=host` included — fails immediately trying to write a network sysctl.
- **`apparmor=unconfined`** removes the `docker-default` AppArmor profile, which
  carries a blanket `deny mount,` rule with no exception for `CAP_SYS_ADMIN`.
  Without it, Podman's own storage setup fails with
  `mount ...: permission denied` — on a **native Linux Docker host**, specifically;
  invisible on Docker Desktop, which enforces no AppArmor profile at all.
- **`seccomp=unconfined`** removes the `docker-default` seccomp filter. With just
  the two flags above, Podman gets past its own mount setup and then `crun` fails
  creating the container's session keyring — `Operation not permitted` on the
  `keyctl()` syscall, which that filter blocks. Also invisible on Docker Desktop
  (`Seccomp: 0` there — no filter to begin with).

The last two were found *after* the Feature's initial release, by
[`.github/workflows/test-podman-as-docker.yml`](../../.github/workflows/test-podman-as-docker.yml)
running on a real Linux Docker Engine host (a GitHub-hosted `ubuntu-latest`
runner) — see [What's actually been tested](#whats-actually-been-tested) below for
why the original measurement missed both.

And `SYS_ADMIN` itself: every rootless container fails to even map its own user
namespace without it. See
[`feature-podman-as-docker`](https://github.com/devc-tools/devc-dev/blob/main/.plans/implemented/feature-podman-as-docker.md)
§ Step 1, in the sibling `devc-dev` repo, for those original measurements — this
Feature's plan lives there, not in this repo, since `devc-dev` is where this
workspace's plans are indexed. This repo's own
[`docs/manual-verification.md`](../../docs/manual-verification.md) §13 has the
reproduction commands for `SYS_ADMIN`/`systempaths`; the CI workflow above is the
reproduction for the other two.

**`privileged` is never declared.** That is the line this Feature exists not to cross.
If that trade is still unacceptable for a given container, put the privilege in a
container that is not the agent's — the dind-rootless sidecar recipe in
[`.plans/design/devcontainer-agent-sandbox-hardening.md`](../../.plans/design/devcontainer-agent-sandbox-hardening.md)
is the right answer there.

## Usage

```jsonc
"features": {
  "ghcr.io/devc-tools/features/podman-as-docker:0": {}
}
```

That's it — no `runArgs`, no mount to paste. A bare `{}` container already gets a
working `docker run`, because the two things that gate it are both Feature-declared:
the privilege above, and a per-devcontainer storage volume (below). The only thing
you might still add is a `runArgs` device grant, and only if you want real network
isolation for nested containers — see [Networking](#networking).

## What it does

**At build time** (as root): installs `podman`, `uidmap`, `slirp4netns`,
`fuse-overlayfs`, and `podman-docker` (unless `dockerShim: false`); ensures
`/etc/subuid`/`/etc/subgid` carry a range for the remote user; writes the registry
search path and network-backend defaults under `/etc/containers/`; refuses the build
if a non-podman `/usr/bin/docker` already exists (see
[Mutual exclusion](#mutual-exclusion-with-docker-in-docker--docker-outside-of-docker));
places the create-time and start-time scripts.

**At create time** (as the remote user, via `postCreateCommand`): repairs the
graphroot volume's ownership (a first-use named volume mounts root-owned), then
writes `~/.config/containers/storage.conf` — this is where the storage driver is
actually decided, because it depends on a run-time fact the build cannot know (see
[Storage](#storage)).

**At every start** (via `postStartCommand`): starts `podman system service` on a
fixed socket path, backgrounded and idempotent. Never fails the start — the `docker`
CLI shim works without it; only a `DOCKER_HOST` consumer needs it.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dockerShim` | boolean | `true` | Install `podman-docker`, providing `/usr/bin/docker`. Also pulls in Compose v1 (`docker-compose` 1.29.2, the abandoned Python implementation) as a package dependency on Ubuntu — see `composeProvider`. |
| `storageDriver` | enum `auto`\|`vfs`\|`overlay` | `auto` | `auto` probes the graphroot's **backing filesystem** at create time. A real filesystem (the normal case — this Feature declares its own volume there) gets plain `overlay`: native kernel overlay, no `/dev/fuse`, no `mount_program`. An overlay-on-overlay backing (no volume present) gets `vfs`, because `overlay` there does not merely get slow — it fails every container start outright. `overlay` forces the driver regardless of the probe: safe when a volume is present, a hard failure (`exec ...: Invalid argument`) otherwise. `vfs` always works but copies every layer. |
| `rootlessNetworkCmd` | enum `host`\|`slirp4netns`\|`pasta` | `host` | Rootless network backend. Defaults to `host` — the nested container shares the devcontainer's own network namespace — because both userspace backends need `/dev/net/tun`, which is absent by default and **not grantable by a Feature**; defaulting to either would fail every `docker run` out of the box, with no `runArgs` line to search for. See [Networking](#networking) for the opt-in. |
| `unqualifiedSearchRegistries` | string | `"docker.io"` | Comma-separated. Written to a `registries.conf` drop-in so `docker run ubuntu` resolves the way Docker does. Stock Podman leaves this unset and a bare image name then fails or prompts. |
| `dockerApiSocket` | boolean | `true` | Run `podman system service` at start time on the fixed socket path, and export `DOCKER_HOST` naming it. `false` skips starting the service; `DOCKER_HOST` is still exported (`containerEnv` cannot be conditional on an option) and names a path nothing serves — unset it in your own `remoteEnv` if you turn this off. |
| `composeProvider` | enum `none`\|`podman-compose`\|`docker-compose` | `none` | What backs `docker compose`. `none` installs nothing extra — `dockerShim` already pulls in Compose v1 as a package dependency on Ubuntu, so `docker compose`/`docker-compose` may already work even at `none`. |
| `silenceEmulationNotice` | boolean | `true` | Create `/etc/containers/nodocker`, suppressing the `Emulate Docker CLI using podman` banner `podman-docker` prints on every `docker` invocation. Scripts that parse `docker` output break without it. |

## Storage

This Feature declares its own volume:

```jsonc
"mounts": [{
  "type": "volume",
  "source": "podman-storage-${devcontainerId}",
  "target": "/var/lib/devc-features/podman-as-docker/storage"
}]
```

`${devcontainerId}` is the devcontainer spec variable meant for exactly this — a
stable, unique id for a Feature naming its own per-devcontainer volume — and it is
confirmed to substitute correctly (see
[`mount-substitution-spike`](https://github.com/devc-tools/devc-dev/blob/main/.plans/implemented/mount-substitution-spike.md)
in the sibling `devc-dev` repo, and `.plans/design/devc-feature-split.md` open
question 2 in this repo). **Never** a static volume name: one shared graphroot
across every devcontainer on the machine would be a locking and corruption hazard,
not merely untidy.

Podman's default graphroot (`~/.local/share/containers`) is relocated to this fixed
path for the same reason `agents` fixes its seed path rather than naming
`~/.claude` directly: a Feature's `mounts` cannot interpolate the remote user's home.

**Why the volume matters more than it looks like it should:** it is not just about
surviving a rebuild. Podman's `overlay` storage driver needs a real filesystem
underneath it — on an overlay-on-overlay backing (the container's own writable
layer, when no volume is mounted), every container start fails outright with
`exec ...: Invalid argument`, and `fuse-overlayfs`/`/dev/fuse` does not rescue that
case either (measured). So without this volume, `storageDriver: auto` falls back to
`vfs` — slow, but the only thing that actually works there. With the volume (the
default), you get native `overlay` with zero devices.

Editing your devcontainer configuration can change `${devcontainerId}`, which yields
a fresh empty volume and a one-time loss of the image cache. Cheap, but worth
knowing before it surprises you.

## Networking

Defaults to `--network=host`: the nested container shares the devcontainer's own
network namespace. No isolation between nested containers, real port collisions —
but zero devices needed, so `docker run` works out of the box.

For real network-namespace isolation, set `rootlessNetworkCmd` to `slirp4netns` or
`pasta` **and** paste the device grant into your own `devcontainer.json`:

```jsonc
"runArgs": ["--device=/dev/net/tun"]
```

Both — the option and the device. The option alone, without the device, fails every
`docker run` loudly (`Failed to open() /dev/net/tun`) rather than silently falling
back to `host`. See [Troubleshooting](#troubleshooting) if you hit that.

## Mutual exclusion with docker-in-docker / docker-outside-of-docker

All three Features provide `/usr/bin/docker`, and whichever installs last wins
silently. **Do not combine them.** `install.sh` refuses the build if a non-podman
`/usr/bin/docker` already exists on the image, naming the conflict rather than
letting one Feature silently shadow another.

## Compose-file consumers get neither the capabilities nor the runArgs

A `dockerComposeFile`-based devcontainer gets **neither** this Feature's `capAdd`/
`securityOpt` **nor** any `runArgs` you paste — both are `docker run` flags with
nowhere to go under Compose. Set the equivalents on the service in your own compose
file instead:

```yaml
services:
  app:
    cap_add: ["SYS_ADMIN"]
    security_opt: ["systempaths=unconfined", "apparmor=unconfined", "seccomp=unconfined"]
    # Only if you also want real network isolation (see Networking above):
    devices: ["/dev/net/tun"]
```

Without this, the failure mode is "I added the Feature and nothing changed" — no
error to search for, because the container this Feature configured never gets the
privilege it needs.

## Troubleshooting

**`newuidmap: write to uid_map failed: Operation not permitted`** — has two distinct
causes that print the identical string:

1. `capAdd: ["SYS_ADMIN"]` is missing or was stripped (some CI runners and older
   Docker versions ignore Feature-declared `capAdd`). Confirm with
   `capsh --decode=$(cat /proc/self/status | grep CapBnd | cut -f2)` and look for
   `cap_sys_admin`.
2. `/etc/subuid`/`/etc/subgid` has no range for the remote user. `install.sh` adds
   one at build time, but a base image that renumbers the remote user's UID *after*
   the image builds (the devcontainer CLI's UID-remap step) can orphan that range.
   Check `grep "^$(id -un):" /etc/subuid /etc/subgid`.

**`Failed to open() /dev/net/tun: No such file or directory`** — `rootlessNetworkCmd`
is set to `slirp4netns`/`pasta` without the matching `--device=/dev/net/tun` in your
own `runArgs`. See [Networking](#networking).

**`mount ...: permission denied`** during Podman's own storage setup — the
`docker-default` AppArmor profile is enforced and `apparmor=unconfined` from the
manifest did not reach the running container. This shows up if something strips or
overrides Feature-declared `securityOpt` (some CI runners and older Docker versions
do this to `capAdd` too — see the `newuidmap` entry above). Confirm with
`cat /proc/self/attr/current` inside the container; `docker-default (enforce)`
there means the flag did not take.

**`crun: create keyring '...': Operation not permitted: OCI permission denied`** —
the `docker-default` seccomp profile is enforced and `seccomp=unconfined` did not
reach the running container. Same diagnosis as the AppArmor entry above; confirm
with `grep Seccomp: /proc/self/status` — `1` or `2` there means a filter is active
and the flag did not take (`0` is what you want).

**A container starts but every `docker run` fails with
`exec container process: Invalid argument`** — `storageDriver` is forced to
`overlay` (or was auto-chosen before a volume existed) while the graphroot sits on
an overlay-on-overlay backing. Mount a real volume there (the default, unless you
overrode `mounts` yourself), or set `storageDriver: vfs`.

**`.../podman-as-docker/service.log: Permission denied`**, and the API socket never
appears — `/run/devc-features/podman-as-docker` is owned by a UID that no longer
matches the remote user. `install.sh` chowns it once at build time; the devcontainer
CLI's UID-remap step (the normal case on a Linux host whose UID differs from the
image's baked-in one) renumbers the remote user *after* the image builds and repairs
only `$HOME`, orphaning this directory. `post-start.sh` repairs it on every start, so
this should self-heal — if it doesn't, `sudo` may not be available or may require a
password (the repair is `sudo -n`, so it skips rather than hangs). Check ownership
with `stat -c '%U' /run/devc-features/podman-as-docker`.

## What this deliberately does not solve

- **It costs `CAP_SYS_ADMIN`, `systempaths=unconfined`, `apparmor=unconfined`, and
  `seccomp=unconfined`.** See the top of this file.
- **Not a Docker daemon.** Anything talking to `dockerd` internals rather than the
  REST API may not work; Buildx is the usual casualty.
- **Not host Docker.** Containers here are invisible to the host's `docker ps` and
  vice versa. That is the security property, not a bug.
- **`vfs` is slow** and copies every layer — the fallback whenever the graphroot is
  not on a real filesystem, which the Feature's own volume makes the uncommon case.
- **Networking defaults to `host`, not real isolation** — see
  [Networking](#networking).
- **`rootlessNetworkCmd` needs a package matching what your base image ships.** This
  Feature was measured against podman 4.9.3 (Ubuntu 24.04, default rootless backend
  `slirp4netns`) and podman 5.7.0 (Ubuntu 26.04, default `pasta`) — both packages are
  always installed regardless of which one is the upstream default, so setting
  `rootlessNetworkCmd` explicitly works on either.
- **SELinux is untested.** Some upstream "podman in a devcontainer" examples also
  carry `--security-opt label=disable`. That is SELinux-specific and irrelevant on
  Docker Desktop or plain Ubuntu — everything this Feature has been tested on — but
  would matter on a Fedora/RHEL/CentOS host running SELinux in enforcing mode. If you
  hit an `avc: denied` in `dmesg`/`audit.log` on such a host, that flag is the
  starting point; nobody has confirmed whether it is actually needed.

### What's actually been tested

0.1.0's manifest (`capAdd:["SYS_ADMIN"]`, `securityOpt:["systempaths=unconfined"]`,
nothing else) was measured entirely on **Docker Desktop's LinuxKit VM**, which —
unlike a normal Linux Docker Engine host — already runs with no seccomp filter and
no AppArmor profile applied. That made the 0.1.0 finding true on Docker Desktop and
silently untested against the two restrictions a stock Linux host adds on top.

[`.github/workflows/test-podman-as-docker.yml`](../../.github/workflows/test-podman-as-docker.yml)
(`workflow_dispatch`, manual) exists to close exactly that gap: it runs on a
GitHub-hosted `ubuntu-latest` runner — a real Linux Docker Engine host — and first
asserts the `docker-default` seccomp and AppArmor profiles are actually enforced
there, before running all five Docker scenarios. **It did its job, twice**:

1. 0.1.0 failed with `mount ...: permission denied` — the `docker-default`
   AppArmor profile's blanket `deny mount,` rule. `apparmor=unconfined` (0.1.1)
   cleared it, but the very next check hit a **second** wall:
2. `crun: create keyring '...': Operation not permitted` — the `docker-default`
   seccomp profile blocking the `keyctl()` syscall `crun` uses to create the
   container's session keyring. `seccomp=unconfined` (0.1.2) cleared that too.
3. With both privilege walls down, a third, unrelated bug surfaced: the API
   socket's directory is owned by a UID the devcontainer CLI's post-build UID
   remap never repairs (it only repairs `$HOME`) — see the
   `service.log: Permission denied` entry in
   [Troubleshooting](#troubleshooting). Also fixed in 0.1.2.

All five scenarios pass on that runner as of 0.1.2. Each addition above was found
by actually hitting its specific failure, not added on suspicion — worth noting
since it means the manifest could plausibly need a *fourth* thing on some other
environment neither Docker Desktop nor a GitHub Actions runner represents; nothing
found so far, but "measured on two hosts" is not "proven for all hosts." Run the
workflow yourself against your own hosts if that matters to you: from the Actions
tab, or `gh workflow run test-podman-as-docker.yml`.

**Still not run against:** SELinux (a Fedora/RHEL/CentOS host) — see the bullet
above.

## Concept boundaries

- **`docker-in-docker` / `docker-outside-of-docker`** — mutually exclusive with this
  Feature; see above.
- **`DOCKER_HOST`.** The sandbox-hardening design doc uses `tcp://dind:2375` for its
  sidecar recipe; this Feature sets a unix socket. Two strategies for one variable;
  they cannot both be in effect.
- **`devc-bridge`.** Reaching the *host's* Docker through the bridge is a different,
  unrelated answer. This Feature is entirely container-local.
- **"rootless"** here means rootless *inside the container*, as the remote user. It
  does not mean rootless Docker on the host, and — given `capAdd` — it does not mean
  the devcontainer itself is unprivileged.
- **`/etc/containers/nodocker`** is `podman-docker`'s own convention, not a
  `devc-features` invention.

## Tests

No Docker needed:

```sh
bash features/podman-as-docker/test/install_options_test.sh
```

Runs the real `install.sh` against temp directories with `apt-get` stubbed: every
option's effect on the generated config files, the validation guards, subuid/subgid
handling, and the mutual-exclusion check.

Needs Docker and a network:

```sh
# The default scenario needs a base image that actually carries a podman package —
# `ubuntu:focal` (the test command's own default) predates Ubuntu's own packaging of it.
bash features/podman-as-docker/test/run-features-test.sh \
  --base-image mcr.microsoft.com/devcontainers/base:ubuntu-24.04
```

The default scenario is the strongest claim this Feature makes: `docker run` has to
work with **zero** `runArgs`. `test/scenarios.json` adds `with_tun` (real network
isolation), `with_socket`, `with_volume`, and `no_shim`. All five ran on Docker
Desktop while writing this Feature, and again on a native Linux Docker host via
[the CI workflow](../../.github/workflows/test-podman-as-docker.yml) — which is
where 0.1.1's `apparmor=unconfined` and 0.1.2's `seccomp=unconfined` and
socket-ownership fix came from; see
[What's actually been tested](#whats-actually-been-tested).

## Publishing

On `features/PUBLISH_ALLOWLIST.txt` as of 0.1.2, once all five Docker scenarios ran
green on both Docker Desktop and a native Linux Docker host (see
[What's actually been tested](#whats-actually-been-tested)). Publishes to
`ghcr.io/devc-tools/features/podman-as-docker` on the next push to `main` that
touches `features/`, from `publish-feature.yml`'s own matrix job.

A newly published GHCR package is **private** by default — an anonymous
`devcontainer up` cannot pull it until it is made public in the repo's Packages
settings. That is a one-time, manual step; check the package's visibility before
assuming a fresh publish is actually reachable.
