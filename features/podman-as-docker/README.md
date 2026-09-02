# podman-as-docker (devcontainer Feature)

Makes `docker` commands work inside a devcontainer by installing **Podman** and the
`podman-docker` shim — no Docker daemon, no `/var/run/docker.sock` bind mount, no privileged
sibling container.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/podman-as-docker:0": {}
}
```

Plus **one file and one line**: copy this Feature's
[`seccomp-podman.json`](seccomp-podman.json) into your repo's `.devcontainer/` and reference it
from `runArgs`:

```jsonc
"runArgs": ["--security-opt", "seccomp=${localWorkspaceFolder}/.devcontainer/seccomp-podman.json"]
```

That is the whole cost. Since 0.2.0 this Feature grants the devcontainer **no capability** —
`capAdd` is empty — and a bare `{}` plus that line gets a working `docker run`, with storage
on a per-devcontainer volume the Feature declares itself. The only other thing you might add
is a device grant, and only if you want real network isolation for nested containers — see
[Networking](#networking).

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## Read this before enabling it: the privilege cost

**This grants no capability.** Rootless Podman runs on any Linux desktop with an empty
capability set: it creates its own user namespace and is privileged only inside it. Inside a
Docker container it used to need `CAP_SYS_ADMIN` for two reasons that were Docker's defaults,
not Podman's requirements, and 0.2.0 removes both:

- **Docker's default seccomp profile** refuses the namespace and mount syscalls
  (`unshare`, `mount`, `pivot_root`, `setns`, `sethostname`, the new mount API) by name unless
  the container already holds `CAP_SYS_ADMIN` — before the kernel gets to check that a
  process inside its own user namespace is allowed to use them. **The profile you commit** is
  Docker's own default with one rule prepended that allows exactly those syscalls. Every
  other rule stays. A Feature cannot apply it for you: the Docker CLI reads the file on the
  host, which is why it lives in your repo and in your `runArgs`.
- **Ubuntu's `newuidmap` is setuid root.** Writing a namespace's uid map needs
  `CAP_SYS_ADMIN` *over that namespace*; its creator has that as the owner, but a setuid-root
  helper runs as root, and container root only has it if the container was granted
  `SYS_ADMIN`. `install.sh` gives `newuidmap`/`newgidmap` file capabilities
  (`cap_setuid`/`cap_setgid`) and removes the setuid bit, so they keep the caller's uid and
  the same check passes with no capability anywhere.

What the Feature still declares, and what each costs:

| Declared | Needed on | What it opens |
| --- | --- | --- |
| `securityOpt: systempaths=unconfined` | every host | Removes Docker's read-only masking of `/proc/sys` and neighbours. Required: without it the nested runtime cannot mount a fresh `proc` (the kernel only allows an unprivileged `proc` mount when an existing one is fully visible). With no capability in the container this is mostly information exposure — the kernel's own permission checks on `/proc/sys` remain, and nothing here can pass them. |
| `securityOpt: apparmor=unconfined` | rootful native Linux only | Removes the `docker-default` AppArmor profile, whose blanket `deny mount` blocks Podman's storage setup there. A no-op on Docker Desktop (no AppArmor) and on rootless daemons. |
| your `runArgs`: the seccomp profile | every host | Allows user-namespace creation and the mount syscalls **inside** namespaces the container owns — what any unprivileged user on a stock Linux desktop can do. It is a larger kernel attack surface than a default devcontainer (unprivileged user namespaces have been the entry point for several past kernel privilege-escalation bugs, which is why some distributions restrict them), but an escape once again needs a kernel bug rather than a known technique. |
| your `runArgs`: `--device=/dev/net/tun` | only with private nested networking | A tun device. Low risk. |

The honest comparison, then:

| Approach | What it grants | Cost of abuse |
| --- | --- | --- |
| `docker-outside-of-docker` | the host Docker API | **Immediate, trivial, total.** `docker run -v /:/host alpine chroot /host sh`. No exploit required. |
| `docker-in-docker` | `--privileged` — all caps, all devices, no seccomp, no AppArmor | Immediate and total, by a slightly longer road. |
| `podman-as-docker` ≤ 0.1.x | `CAP_SYS_ADMIN` + `seccomp=unconfined` + the two above | Escape by known technique; the devcontainer should be treated as running as you on the machine. |
| **`podman-as-docker` 0.2.0** | **no capability**; the seccomp allowance and `systempaths` above | Escape needs a kernel bug. Roughly a plain devcontainer's boundary, with unprivileged user namespaces enabled inside it. |

`seccomp=unconfined` is gone: the profile keeps Docker's filter for everything Podman does
not need. **`privileged` is never declared.** That is the line this Feature exists not to
cross.

### Compose-file consumers get neither the securityOpt nor the runArgs

A `dockerComposeFile`-based devcontainer gets **neither** this Feature's `securityOpt` **nor**
any `runArgs` you paste — both are `docker run` flags with nowhere to go under Compose. Set
the equivalents on the service in your own compose file instead:

```yaml
services:
  app:
    security_opt:
      - 'systempaths=unconfined'
      - 'apparmor=unconfined'
      - 'seccomp=./.devcontainer/seccomp-podman.json'
    # Only if you also want real network isolation (see Networking below):
    devices: ['/dev/net/tun']
```

Without this, the failure mode is `cannot clone: Operation not permitted` / `cannot re-exec
process` on every `docker run` — the start-time step recognises that string and prints the
fix.

## What it does

**At build time:** installs `podman`, `uidmap`, `slirp4netns`, `fuse-overlayfs`, `runc`, the
netavark stack (`netavark`, `aardvark-dns`, `iptables` — name resolution between containers on
a created network needs all three, and `--no-install-recommends` would otherwise drop them),
and `podman-docker` (unless `dockerShim: false`); gives `newuidmap`/`newgidmap` file
capabilities in place of setuid; ensures `/etc/subuid`/`/etc/subgid` carry a range for the
remote user; creates `/var/lib/cni` (rootless podman's network setup otherwise bind-mounts
over `/var/lib` and hides this Feature's own graphroot); installs thin `podman` and `docker`
shims in `/usr/local/bin` (see [Rootless Linux hosts](#rootless-linux-hosts)); writes the
registry search path and network-backend defaults under `/etc/containers/`; refuses the build
if a non-podman `/usr/bin/docker` already exists (see
[Mutual exclusion](#mutual-exclusion-with-docker-in-docker--docker-outside-of-docker)). When
the image is being built on a **rootless** Docker daemon it also writes the nested-podman
configuration described below.

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

## Rootless Linux hosts

On a host running **rootless Docker**, this Feature detects at build time (from
`/proc/self/uid_map`, which a rootless daemon shows as `0 1000 1 / 1 100000 65536` rather than
the identity map) that it is nested inside a user namespace, and configures itself for it:

- `runc` with `no_pivot_root` and `keyring = false` in a `containers.conf` drop-in — crun
  cannot create its keyring there and `pivot_root` is refused;
- subordinate ranges of `10000:50001` instead of `100000:65536`, because the outer namespace
  only owns ids 0–65536.

Pair it with [rootless-remap](../rootless-remap/README.md), which makes the remote user uid 0
(keeping its name and home) so the bind-mounted workspace is writable there at all. With a
uid-0 remote user, podman run directly would re-exec into a `0→0` namespace and take its
rootful path, which needs cgroups a devcontainer cannot provide — so the `podman` and `docker`
shims run it **one user namespace down**, as uid 1000, where it is an ordinary rootless podman
again. That namespace is created once per container (a `sleep infinity` holder, its pid kept
next to the API socket) and re-entered on every call, so every shell, the API service and
every `docker` invocation share one podman state. The nested container's root then maps
`0 → 1000 → outer 0 → you` on the host, which is why files a nested container writes into the
workspace come back owned by you.

All of this is decided from in-container facts. On Docker Desktop and on native rootful Linux
the shims are a plain `exec` and none of the above is written. Nothing in your
`devcontainer.json` changes between the hosts.

## Mutual exclusion with docker-in-docker / docker-outside-of-docker

All three Features provide `/usr/bin/docker`, and whichever installs last wins silently.
**Do not combine them.** The build is refused if a non-podman `/usr/bin/docker` already
exists, naming the conflict rather than letting one Feature silently shadow another.

## Troubleshooting

**`cannot clone: Operation not permitted` / `Error: cannot re-exec process`** on every
`podman` command — the seccomp profile did not reach the container, so Docker's default filter
still blocks `clone(CLONE_NEWUSER)` and podman cannot create its user namespace. The
`runArgs` line is missing, points at a path that does not exist on the host, or was dropped
(Compose-file consumers, some CI runners). The start-time step probes for this and prints the
fix in the create log. Measured: this is the exact failure with the line removed.

**`newuidmap: write to uid_map failed: Operation not permitted`** — the namespace was created
but its map could not be written. Two causes:

1. `newuidmap` lost its file capabilities — `getcap /usr/bin/newuidmap` should print
   `cap_setuid=ep`. A later Feature or a `RUN` step that reinstalled `uidmap` puts the setuid
   bit back; rebuild with this Feature ordered after it, or run
   `setcap cap_setuid+ep /usr/bin/newuidmap; setcap cap_setgid+ep /usr/bin/newgidmap`.
2. `/etc/subuid`/`/etc/subgid` has no range for the remote user. A range is added at build
   time, but a base image that renumbers the remote user's UID _after_ the image builds (the
   devcontainer CLI's UID-remap step) can orphan it. Check
   `grep "^$(id -un):" /etc/subuid /etc/subgid`.

**`Failed to open() /dev/net/tun: No such file or directory`** — `rootlessNetworkCmd` is set
to `slirp4netns`/`pasta` without the matching `--device=/dev/net/tun` in your own `runArgs`.
See [Networking](#networking).

**`mount ...: permission denied`** during Podman's own storage setup, on a native Linux Docker
host — the `docker-default` AppArmor profile is enforced and `apparmor=unconfined` did not
reach the running container. This shows up if something strips or overrides Feature-declared
`securityOpt`. Confirm with `cat /proc/self/attr/current`; `docker-default (enforce)` means the
flag did not take.

**`crun: mount `proc` to `proc`: Operation not permitted`** (or runc's `error mounting "proc"`)
— `systempaths=unconfined` did not reach the container. Same diagnosis: something stripped the
Feature's `securityOpt`.

**`network not found` for a network `podman network ls` lists** — `/var/lib/cni` is missing
(a `RUN` step removed it?). Rootless podman bind-mounts over `/var/lib` during network setup
when that directory is absent, hiding the graphroot's `networks/`. `mkdir -p /var/lib/cni`.

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

- **It costs `systempaths=unconfined`, a seccomp allowance for the namespace and mount
  syscalls, and (on rootful native Linux) `apparmor=unconfined`.** No capability, but not
  nothing — see the top of this file.
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
on a native Linux Docker Engine host; the no-capability configuration (0.2.0) was measured on
Docker Desktop and on a rootless Docker 29 host — `docs/manual-verification.md` § 13.9.

## The seccomp profile

[`seccomp-podman.json`](seccomp-podman.json) is Docker's default profile
(`github.com/moby/profiles`, `seccomp/default.json`, Apache-2.0) with one rule prepended:
`SCMP_ACT_ALLOW` for `unshare mount umount2 pivot_root setns clone clone3 keyctl sethostname
setdomainname mount_setattr open_tree move_mount fsopen fsconfig fsmount fspick
open_tree_attr`. Nothing else is changed. Diff it against upstream whenever Docker updates its
default; the Feature's scenario tests run against this exact file.

## Related, but not this

- **`DOCKER_HOST`.** This Feature sets a unix socket. A dind-sidecar setup uses
  `tcp://dind:2375` instead — two strategies for one variable, and they cannot both be in
  effect.
- **`devc-bridge`.** Reaching the _host's_ Docker through the bridge is a different,
  unrelated answer. This Feature is entirely container-local.
- **"rootless"** here means rootless _inside the container_, as the remote user. It does not
  by itself mean rootless Docker on the host — though since 0.2.0 that host is supported too
  (see [Rootless Linux hosts](#rootless-linux-hosts)), and the devcontainer itself holds no
  capability on any host.
- **`/etc/containers/nodocker`** is `podman-docker`'s own convention, not a `devc-features`
  invention.
