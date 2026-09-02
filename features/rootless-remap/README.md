# rootless-remap (devcontainer Feature)

Makes a devcontainer's workspace writable on a **rootless Linux Docker** host, without
changing anything in your `devcontainer.json`. On every other host it does nothing.

```jsonc
"features": {
  "ghcr.io/devc-tools/features/rootless-remap:0": {}
}
```

No options, no `runArgs`, no mount. Keep `remoteUser` as it is (`vscode`, say).

> The tag tracks **this Feature's own** version line, not the devc-tools release. It is
> `:0` while this Feature is pre-1.0.

## The problem it solves

Under rootless Docker, `dockerd` runs inside a user namespace: container uid **0** is *your*
uid on the host, and container uids 1 and up map to your `/etc/subuid` range (host uid
100000+). Your project's bind mount is therefore owned by container **root** inside, and the
conventional `vscode` user (container uid 1000, a host uid you do not own) cannot write a
single project file. There is no other container identity that owns the mount, so the remote
user has to *be* uid 0 there — and making it plain `root` changes `$HOME`, breaks every
Feature that assumes `/home/vscode`, and puts `root` in a config you also use on your Mac.

## What it does

**At build time**, `install.sh` reads `/proc/self/uid_map`, which is visible during
`docker build` and tells the two cases apart reliably:

- **Identity map** (`0 0 4294967295`): a rootful daemon — Docker Desktop, native Linux Docker,
  a GitHub runner. It logs that and exits. Nothing else happens.
- **Anything else**: a rootless daemon. It rewrites the remote user's `/etc/passwd` entry to
  uid 0 and gid 0, keeping the name, home and shell, and moves it to the top of the file so
  `getpwuid(0)` answers with that name. `id` then prints `uid=0(vscode) gid=0(root)`,
  `$HOME` is still `/home/vscode`, `sudo` works, and files you create land on the host owned
  by you. It `chown`s the home directory to `0:0` so anything earlier Features left there is
  still yours.

It also adds a **placeholder user** (`devc-uid-hold`) holding your host uid. That is what
lets you leave `updateRemoteUserUID` at its default: the devcontainer CLI's uid-update step
would otherwise renumber the remote user back to your host uid after the build, silently
undoing the remap and leaving a user whose new files are owned by an unmapped subuid. When
some user already holds the target uid, that step logs `User with UID exists` and skips.
Measured: the update layer is built, and the remap survives.

Finally it writes `/etc/subuid` and `/etc/subgid` ranges (`10000:50001`) for the remote user
and for the placeholder, inside the ids the outer namespace actually owns. Nested rootless
podman needs them — see [podman-as-docker](../podman-as-docker/README.md).

**At create time**, a guard asserts that a remapped user really is uid 0. If it is not,
something renumbered the user after the build, and the guard **fails the create** — the one
step in this collection that deliberately does — naming the `"updateRemoteUserUID": false`
fallback. A create that succeeds in that state produces files you cannot edit or delete on
the host.

## What you will notice

| | rootful host (Mac, native Docker) | rootless Linux |
| --- | --- | --- |
| `id` | `uid=1000(vscode)` | `uid=0(vscode) gid=0(root)` |
| `$HOME` | `/home/vscode` | `/home/vscode` |
| `sudo` | asks nothing, as before | a no-op |
| files you create, on the host | owned by you | owned by you |

Inside a rootless devcontainer you are effectively root: tools that refuse to run as root
will complain, and `sudo` no longer stands between a misbehaving script and the container's
system files. None of that reaches the host — container root *is* your unprivileged host
account there, which is the whole point of rootless Docker.

## Security

This Feature grants no capability and declares no `securityOpt`. It changes which uid the
remote user is inside a namespace whose uid 0 is already you.

## Limitations

- **A rootful daemon configured with `userns-remap`** also has a non-identity map and will
  be treated as rootless. Not measured; probably harmless, since the same reasoning applies.
- **Two uid-0 entries in `/etc/passwd`** (`vscode` first, `root` second). `getpwuid(0)`
  answers `vscode`; anything keying off the name `root` still finds it by name.
- **Build-time only.** A container created from an image built on a rootful daemon and then
  run against a rootless one (an unusual move) is not remapped.

## Related

- [podman-as-docker](../podman-as-docker/README.md) — nested podman with no added capability;
  on a rootless host it relies on this Feature's remap and runs podman one user namespace
  down for the uid-0 remote user.
- devc-dev `docs/rootless-linux-findings.md` — the measurements (M-1 to M-7 and
  § Keeping `remoteUser: vscode`) behind every claim above.
