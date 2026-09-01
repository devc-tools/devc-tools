# podman-as-docker (devcontainer Feature)

Makes `docker` commands work inside a devcontainer by installing **Podman** and the
`podman-docker` shim — no Docker daemon, no `/var/run/docker.sock` bind mount, no privileged
sibling container.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/podman-as-docker:0": {}
}
```

That's it — no `runArgs`, no mount to paste. A bare `{}` container already gets a working
`docker run`, because the two things that gate it are both Feature-declared: the privilege
below, and a per-devcontainer storage volume. The only thing you might add is a `runArgs`
device grant, and only if you want real network isolation for nested containers — see
[Networking](#networking).

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Read this before enabling it: the privilege cost

**This is not the secure option.** It is a meaningfully better trade than the alternatives,
not a free one:

| Approach                   | What it grants                                                         | Cost of abuse                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-outside-of-docker` | the host Docker API                                                    | **Immediate, trivial, total.** `docker run -v /:/host alpine chroot /host sh`. No exploit required.                                                         |
| `docker-in-docker`         | `--privileged` — all caps, all devices                                 | Immediate and total, by a slightly longer road.                                                                                                             |
| **`podman-as-docker`**     | **`CAP_SYS_ADMIN`** plus three Docker/runc `securityOpt` flags (below) | Escape requires an actual kernel/mount exploit, and on Docker Desktop lands in the LinuxKit VM, not on macOS. Nothing on the host is reachable _by design_. |

This Feature declares all four **unconditionally**, the moment you add it:

```jsonc
"capAdd": ["SYS_ADMIN"],
"securityOpt": ["systempaths=unconfined", "apparmor=unconfined", "seccomp=unconfined"]
```

`SYS_ADMIN` is a Linux capability. The other three are not capabilities and add no
capability beyond `SYS_ADMIN` — they are Docker/runc flags that each remove one specific
piece of Docker's default hardening, and all three are **required**, not defensive
boilerplate:

- **`systempaths=unconfined`** removes the default read-only bind-mount Docker applies over
  `/proc/asound`, `/proc/bus`, `/proc/fs`, `/proc/irq`, `/proc/sys` and
  `/proc/sysrq-trigger`. Without it, every `podman run` — in every network mode,
  `--network=host` included — fails immediately trying to write a network sysctl.
- **`apparmor=unconfined`** removes the `docker-default` AppArmor profile, which carries a
  blanket `deny mount,` rule with no exception for `CAP_SYS_ADMIN`. Without it, Podman's own
  storage setup fails with `mount ...: permission denied` — on a **native Linux Docker
  host** specifically; invisible on Docker Desktop, which enforces no AppArmor profile.
- **`seccomp=unconfined`** removes the `docker-default` seccomp filter. With just the two
  flags above, Podman gets past its own mount setup and then `crun` fails creating the
  container's session keyring — `Operation not permitted` on the `keyctl()` syscall. Also
  invisible on Docker Desktop.

And `SYS_ADMIN` itself: every rootless container fails to even map its own user namespace
without it.

**`privileged` is never declared.** That is the line this Feature exists not to cross.

### Compose-file consumers get neither the capabilities nor the runArgs

A `dockerComposeFile`-based devcontainer gets **neither** this Feature's
`capAdd`/`securityOpt` **nor** any `runArgs` you paste — both are `docker run` flags with
nowhere to go under Compose. Set the equivalents on the service in your own compose file
instead:

```yaml
services:
  app:
    cap_add: ['SYS_ADMIN']
    security_opt: [
      'systempaths=unconfined',
      'apparmor=unconfined',
      'seccomp=unconfined',
    ]
    # Only if you also want real network isolation (see Networking below):
    devices: ['/dev/net/tun']
```

Without this, the failure mode is "I added the Feature and nothing changed" — no error to
search for, because the container this Feature configured never gets the privilege it needs.

## What it does

**At build time:** installs `podman`, `uidmap`, `slirp4netns`, `fuse-overlayfs`, and
`podman-docker` (unless `dockerShim: false`); ensures `/etc/subuid`/`/etc/subgid` carry a
range for the remote user; writes the registry search path and network-backend defaults
under `/etc/containers/`; refuses the build if a non-podman `/usr/bin/docker` already exists
(see [Mutual exclusion](#mutual-exclusion-with-docker-in-docker--docker-outside-of-docker)).

**At create time:** repairs the graphroot volume's ownership (a first-use named volume
mounts root-owned), then writes `~/.config/containers/storage.conf` — this is where the
storage driver is decided, because it depends on a run-time fact the build cannot know (see
[Storage](#storage)). It will not rewrite `storage.conf` out from under existing images: if
the graphroot already holds something under a different driver, it leaves the file alone and
says so, because Podman cannot read images written under a driver it is no longer using.

**At every start:** starts `podman system service` on a fixed socket path, backgrounded and
idempotent. Never fails the start — the `docker` CLI shim works without it; only a
`DOCKER_HOST` consumer needs it.

## Options

| Option                        | Type                                            | Default       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dockerShim`                  | boolean                                         | `true`        | Install `podman-docker`, providing `/usr/bin/docker`. Also pulls in Compose v1 (`docker-compose` 1.29.2, the abandoned Python implementation) as a package dependency on Ubuntu — see `composeProvider`.                                                                                                                                                                                                   |
| `storageDriver`               | enum `auto`\|`vfs`\|`overlay`                   | `auto`        | `auto` probes the graphroot's **backing filesystem** at create time. A real filesystem (the normal case) gets plain `overlay`: native kernel overlay, no `/dev/fuse`, no `mount_program`. An overlay-on-overlay backing (no volume present) gets `vfs`, because `overlay` there fails every container start outright. `overlay` forces the driver regardless of the probe. `vfs` always works but is slow. |
| `rootlessNetworkCmd`          | enum `host`\|`slirp4netns`\|`pasta`             | `host`        | Rootless network backend. Defaults to `host` — the nested container shares the devcontainer's own network namespace — because both userspace backends need `/dev/net/tun`, which is absent by default and **not grantable by a Feature**. See [Networking](#networking).                                                                                                                                   |
| `unqualifiedSearchRegistries` | string                                          | `"docker.io"` | Comma-separated. Written to a `registries.conf` drop-in so `docker run ubuntu` resolves the way Docker does. Stock Podman leaves this unset and a bare image name then fails or prompts.                                                                                                                                                                                                                   |
| `dockerApiSocket`             | boolean                                         | `true`        | Run `podman system service` at start time on the fixed socket path, and export `DOCKER_HOST` naming it. `false` skips starting the service; `DOCKER_HOST` is still exported (`containerEnv` cannot be conditional on an option) and names a path nothing serves — unset it in your own `remoteEnv` if you turn this off.                                                                                   |
| `composeProvider`             | enum `none`\|`podman-compose`\|`docker-compose` | `none`        | What backs `docker compose`. `none` installs nothing extra — `dockerShim` already pulls in Compose v1 as a package dependency on Ubuntu, so `docker compose` may already work even at `none`.                                                                                                                                                                                                              |
| `silenceEmulationNotice`      | boolean                                         | `true`        | Create `/etc/containers/nodocker`, suppressing the `Emulate Docker CLI using podman` banner `podman-docker` prints on every `docker` invocation. Scripts that parse `docker` output break without it.                                                                                                                                                                                                      |

## Storage

This Feature declares its own volume:

```jsonc
"mounts": [{
  "type": "volume",
  "source": "podman-storage-${devcontainerId}",
  "target": "/var/lib/devc-features/podman-as-docker/storage"
}]
```

`${devcontainerId}` keys it per devcontainer. Never a static volume name: one shared
graphroot across every devcontainer on the machine would be a locking and corruption hazard,
not merely untidy.

Podman's default graphroot (`~/.local/share/containers`) is relocated to this fixed path
because a Feature's `mounts` cannot interpolate the remote user's home.

**Why the volume matters more than it looks like it should:** it is not just about surviving
a rebuild. Podman's `overlay` storage driver needs a real filesystem underneath it — on an
overlay-on-overlay backing (the container's own writable layer, when no volume is mounted),
every container start fails outright with `exec ...: Invalid argument`, and
`fuse-overlayfs`/`/dev/fuse` does not rescue that case either. So without this volume,
`storageDriver: auto` falls back to `vfs` — slow, but the only thing that actually works
there. With the volume (the default), you get native `overlay` with zero devices.

Editing your devcontainer configuration can change `${devcontainerId}`, which yields a fresh
empty volume and a one-time loss of the image cache. Cheap, but worth knowing before it
surprises you.

## Networking

Defaults to `--network=host`: the nested container shares the devcontainer's own network
namespace. No isolation between nested containers, real port collisions — but zero devices
needed, so `docker run` works out of the box.

For real network-namespace isolation, set `rootlessNetworkCmd` to `slirp4netns` or `pasta`
**and** paste the device grant into your own `devcontainer.json`:

```jsonc
"runArgs": ["--device=/dev/net/tun"]
```

Both — the option and the device. The option alone fails every `docker run` loudly
(`Failed to open() /dev/net/tun`) rather than silently falling back to `host`.

Both backend packages are always installed regardless of which is your base image's default,
so setting `rootlessNetworkCmd` explicitly works either way.

## Mutual exclusion with docker-in-docker / docker-outside-of-docker

All three Features provide `/usr/bin/docker`, and whichever installs last wins silently.
**Do not combine them.** The build is refused if a non-podman `/usr/bin/docker` already
exists, naming the conflict rather than letting one Feature silently shadow another.

## Troubleshooting

**`newuidmap: write to uid_map failed: Operation not permitted`** — two distinct causes
print the identical string:

1. `capAdd: ["SYS_ADMIN"]` is missing or was stripped (some CI runners and older Docker
   versions ignore Feature-declared `capAdd`). Confirm with
   `capsh --decode=$(cat /proc/self/status | grep CapBnd | cut -f2)` and look for
   `cap_sys_admin`.
2. `/etc/subuid`/`/etc/subgid` has no range for the remote user. A range is added at build
   time, but a base image that renumbers the remote user's UID _after_ the image builds (the
   devcontainer CLI's UID-remap step) can orphan it. Check
   `grep "^$(id -un):" /etc/subuid /etc/subgid`.

**`Failed to open() /dev/net/tun: No such file or directory`** — `rootlessNetworkCmd` is set
to `slirp4netns`/`pasta` without the matching `--device=/dev/net/tun` in your own `runArgs`.
See [Networking](#networking).

**`mount ...: permission denied`** during Podman's own storage setup — the `docker-default`
AppArmor profile is enforced and `apparmor=unconfined` did not reach the running container.
This shows up if something strips or overrides Feature-declared `securityOpt`. Confirm with
`cat /proc/self/attr/current`; `docker-default (enforce)` means the flag did not take.

**`crun: create keyring '...': Operation not permitted`** — the `docker-default` seccomp
profile is enforced and `seccomp=unconfined` did not reach the container. Same diagnosis;
confirm with `grep Seccomp: /proc/self/status` — `1` or `2` means a filter is active and the
flag did not take (`0` is what you want).

**Every `docker run` fails with `exec container process: Invalid argument`** —
`storageDriver` is forced to `overlay` (or was auto-chosen before a volume existed) while
the graphroot sits on an overlay-on-overlay backing. Mount a real volume there (the default,
unless you overrode `mounts` yourself), or set `storageDriver: vfs`.

**`.../podman-as-docker/service.log: Permission denied`**, and the API socket never appears
— `/run/devc-features/podman-as-docker` is owned by a UID that no longer matches the remote
user. The devcontainer CLI's UID-remap step renumbers the remote user _after_ the image
builds and repairs only `$HOME`, orphaning this directory. The start-time step repairs it on
every start, so this should self-heal — if it doesn't, `sudo` may be missing or may require
a password (the repair is `sudo -n`, so it skips rather than hangs). Check with
`stat -c '%U' /run/devc-features/podman-as-docker`.

## What this deliberately does not solve

- **It costs `CAP_SYS_ADMIN`, `systempaths=unconfined`, `apparmor=unconfined` and
  `seccomp=unconfined`.** See the top of this file.
- **Not a Docker daemon.** Anything talking to `dockerd` internals rather than the REST API
  may not work; Buildx is the usual casualty.
- **Not host Docker.** Containers here are invisible to the host's `docker ps` and vice
  versa. That is the security property, not a bug.
- **`vfs` is slow** and copies every layer — the fallback whenever the graphroot is not on a
  real filesystem, which the Feature's own volume makes the uncommon case.
- **Networking defaults to `host`, not real isolation** — see [Networking](#networking).
- **SELinux is untested.** Some upstream "podman in a devcontainer" examples also carry
  `--security-opt label=disable`. That is SELinux-specific and irrelevant on Docker Desktop
  or plain Ubuntu, but would matter on a Fedora/RHEL/CentOS host running SELinux in
  enforcing mode. If you hit an `avc: denied` in `dmesg`/`audit.log` on such a host, that
  flag is the starting point; nobody has confirmed whether it is actually needed.

Tested against podman 4.9.3 (Ubuntu 24.04) and 5.7.0 (Ubuntu 26.04), on Docker Desktop and
on a native Linux Docker Engine host.

## Related, but not this

- **`DOCKER_HOST`.** This Feature sets a unix socket. A dind-sidecar setup uses
  `tcp://dind:2375` instead — two strategies for one variable, and they cannot both be in
  effect.
- **`devc-bridge`.** Reaching the _host's_ Docker through the bridge is a different,
  unrelated answer. This Feature is entirely container-local.
- **"rootless"** here means rootless _inside the container_, as the remote user. It does not
  mean rootless Docker on the host, and — given `capAdd` — it does not mean the devcontainer
  itself is unprivileged.
- **`/etc/containers/nodocker`** is `podman-docker`'s own convention, not a `devc-features`
  invention.
