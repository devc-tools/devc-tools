# Hardening a devcontainer used as an agent sandbox

Removing the three mounts that undo container isolation — the Docker socket,
`~/.ssh`, and cloud credential files — and replacing each with a brokered
capability.

**Governing principle:** the container should be able to _cause_ a privileged
action, never to _hold_ the credential. The host keeps the secret; the container
gets a narrow, logged RPC.

---

## Context: why this matters more than the isolation boundary

Comparison of a devcontainer-based agent sandbox against a microVM sandbox (e.g.
[gondolin](https://github.com/earendil-works/gondolin), used by
[pi-gondolin](https://github.com/pasky/pi-gondolin)):

| Axis               | Devcontainer                                                  | Gondolin microVM                                  |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| Isolation boundary | namespaces/cgroups/seccomp — shared kernel                    | own guest kernel behind hypervisor                |
| Egress control     | all-or-nothing by default; you build the proxy                | programmable allowlist + request/response hooks   |
| Secret handling    | mounted creds are visible to the agent                        | placeholder injection, guest never sees the value |
| Env fidelity       | the real spec: features, compose, VS Code attach, team-shared | bespoke rootfs you reconstruct                    |
| FS performance     | native bind on Linux; volume escape hatch on Docker Desktop   | FUSE for everything, no escape hatch              |
| State              | long-lived, warm caches, background services                  | disposable per session + snapshots                |
| Maturity           | stable spec, MS-backed                                        | explicitly experimental                           |

Two observations drive the conclusion below:

1. **The realistic threat is exfiltration, not kernel escape.** Prompt injection
   from a README, a dependency, or a fetched page causing the agent to POST your
   tokens somewhere. A microVM does nothing for that. Egress allowlisting and
   secret brokering do, and both are available to a container.
2. **On Docker Desktop you already have a hypervisor boundary.** A container
   escape lands the attacker in the Docker Desktop Linux VM, not on macOS. The
   microVM's headline advantage mostly applies only on native Linux hosts.

So: keep the devcontainer, and close the credential gaps — which is the rest of
this doc.

---

## Why these three mounts are categorically different

### `/var/run/docker.sock`

Not a partial escape — a documented API for one. No CVE required:

```bash
docker run -v /:/host alpine chroot /host sh   # game over
```

On Docker Desktop this yields root in the Linux VM _plus_ whatever host paths
Docker Desktop shares (usually all of `/Users`), so it still reaches back into
your home directory. Any other hardening of the agent container is irrelevant
while this socket is present.

### `~/.ssh`

Durable, broadly scoped, and trivially copyable. Private key + `known_hosts` +
an `ssh_config` that may contain `ProxyJump` routes into staging or prod. That
is push access to every repo you have, plus a map for lateral movement.

### Cloud credential files

Worse than they look, because the file usually holds a **refresh** token rather
than an access token. `~/.config/gcloud/application_default_credentials.json`
and `~/.aws/credentials` are effectively permanent.

> Exfiltrating a 1-hour access token is an incident. Exfiltrating a refresh
> token is a breach.

---

## Step 1 — Audit: find every path in

Check the running container:

```bash
docker inspect <ctr> --format '{{json .HostConfig.Binds}}' | jq
docker inspect <ctr> --format '{{.HostConfig.Privileged}}'
docker exec <ctr> ls -la /var/run/docker.sock ~/.ssh ~/.aws ~/.config/gcloud ~/.kube
docker exec <ctr> env | grep -Ei 'token|secret|key|password'
```

Then check **all five** of these config locations, not just `mounts`:

```jsonc
{
  "mounts": ["source=${localEnv:HOME}/.ssh,target=/home/vscode/.ssh,type=bind"], // ← obvious
  "runArgs": ["-v", "/var/run/docker.sock:/var/run/docker.sock"], // ← easy to miss
  "remoteEnv": { "AWS_SECRET_ACCESS_KEY": "${localEnv:AWS_SECRET_ACCESS_KEY}" }, // ← a mount by another name
  "containerEnv": { "GH_TOKEN": "${localEnv:GH_TOKEN}" }, // ← same
  "features": {
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {} // ← this IS the socket
  }
}
```

Plus `volumes:` in any `docker-compose.yml` the devcontainer references.

`${localEnv:...}` is the one that survives cleanups, because it does not look
like a mount.

---

## Step 2 — Replace the Docker socket

Ask what it was for, because the answers diverge.

### Testcontainers / integration tests → dind **sidecar**

Do **not** simply swap in the `docker-in-docker` feature on the agent container:
it requires `--privileged`, which is its own host-escape path. Keep the agent
container unprivileged and confine the privileged blast radius to a separate
service:

```yaml
services:
  dev:
    environment: ['DOCKER_HOST=tcp://dind:2375']
  dind:
    image: docker:dind-rootless # rootless: no --privileged needed
    environment: ['DOCKER_TLS_CERTDIR=']
```

The agent can now create containers, but inside a daemon whose storage and
network are separate from the host's — it cannot see or exec into your other
containers.

### Read-only introspection (`docker ps`, log tailing) → socket proxy

Use `tecnativa/docker-socket-proxy` with only `CONTAINERS=1` and everything else
off.

⚠️ Honest limit: a socket proxy that permits `POST /containers/create` is
**still a full escape**. This is only safe as a strictly read-only allowlist.

### Convenience → drop it

Run docker commands on the host.

### A fourth option: no daemon at all → `podman-as-docker` Feature

[`features/podman-as-docker`](../../features/podman-as-docker/README.md) is not a
replacement for the dind sidecar above — it is a fourth option with a different
shape of cost, worth naming here because it is easy to mistake for "the secure one"
if you only skim its pitch. It installs Podman in the agent container itself (no
daemon, no `docker.sock`), which sounds like it sidesteps this whole section. It
does not: it costs `CAP_SYS_ADMIN` plus three Docker/runc flags
(`systempaths=unconfined`, `apparmor=unconfined`, `seccomp=unconfined`) on the agent
container — measured required, not optional — so the agent container itself is no
longer unprivileged. Compare honestly:

| Approach                      | Where the privilege lives      | Cost of abuse                                                                                                                                                                       |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dind-rootless sidecar (above) | a separate `dind` service      | Confined to that service's own daemon; the agent container stays unprivileged                                                                                                       |
| `podman-as-docker`            | **the agent container itself** | `CAP_SYS_ADMIN` + `systempaths=unconfined` + `apparmor=unconfined` + `seccomp=unconfined` there — a real kernel/mount exploit surface, but no host Docker API and no `--privileged` |

Prefer the dind-rootless sidecar when the agent container being unprivileged is
itself the property you want (this doc's whole thesis). Prefer `podman-as-docker`
when a second service is the wrong shape for the workflow — a single-container
devcontainer with no compose file to add a sidecar to — and the narrower, measured
`SYS_ADMIN`+`systempaths=unconfined`+`apparmor=unconfined`+`seccomp=unconfined` cost
is an acceptable trade there. Never reach for it as "the secure Docker option"; it
is the _less bad_ option when a sidecar is not available, not a way to avoid this
section's trade-off entirely.

---

## Step 3 — Replace `~/.ssh`

Escalating strength; pick the strongest you can tolerate.

### 3a. Nothing (start here)

VS Code Dev Containers **already** forwards your host `ssh-agent` socket, and
proxies HTTPS git credentials over a forwarded port, when you have keys loaded.
No mount needed; keys never enter the container.

This is the credential-broker pattern already shipped in the tooling. Most
people mount `~/.ssh` purely because they did not know this existed.

_Caveat:_ while connected, the agent can sign **anything** with that key.

### 3b. A dedicated agent identity

A fine-grained GitHub PAT or deploy key scoped to the single repo, held only by
the broker. Compromise costs one repo, not the whole account.

### 3c. No push at all

The agent commits locally. A host-side broker performs the push after validating
the remote and refusing `--force`, non-fast-forward, and pushes to protected
branches.

Transport for this is the loopback TCP + `host.docker.internal` + token bridge.

### In all cases

Strip `~/.ssh/config` from any copy you do provide. **The key is the credential;
the config is the target list.**

---

## Step 4 — Replace cloud credentials

Always the same move: exchange the long-lived artifact on the host, inject only
the short-lived result.

```bash
# AWS — narrow role, 1h creds, injected as env at container start
aws sts assume-role --role-arn arn:aws:iam::…:role/dev-readonly \
  --role-session-name agent --duration-seconds 3600

# GCP — access token, not the refresh-token file
gcloud auth application-default print-access-token
```

For AWS specifically, the cleaner long-term shape is `credential_process` in the
container's `~/.aws/config` pointing at a stub that calls the host broker. The
container re-fetches on expiry without ever holding a key:

```ini
[profile dev]
credential_process = /usr/local/bin/creds-from-broker aws dev
```

### What not to mount, and what to use instead

| Mount                   | Why it's dangerous                       | Replace with                                            |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `~/.aws`                | long-lived access keys                   | STS creds via `credential_process`                      |
| `~/.config/gcloud`      | refresh token = permanent                | printed access token, injected                          |
| `~/.kube/config`        | often cluster-admin, plus `exec` plugins | namespace-scoped ServiceAccount token                   |
| `~/.docker/config.json` | registry creds + host cred-helper paths  | scoped robot account, or nothing                        |
| `~/.npmrc`, `~/.pypirc` | **publish** tokens                       | never in the container — publishing is a host/CI action |

---

## The property you gain

Every brokered action is a chokepoint you can log, rate-limit, and refuse. A
mounted key gives you none of that — you find out what happened by reading
someone else's audit log.

That is the real argument for this over the microVM boundary: it converts

> "the agent had my credentials"

into

> "the agent asked for three pushes, and I have all three requests."

---

## Related hardening (the other three items)

This doc covers item 3 of a four-part recommendation:

1. **Egress allowlist proxy** — container has no default route; `HTTP(S)_PROXY`
   plus an injected CA, with per-request logging.
2. **No credentials in the container** — broker them on the host over the
   existing loopback-TCP + `host.docker.internal` + token bridge.
3. **Drop the docker socket and `~/.ssh`/cloud-cred mounts** — this document.
4. **Read-only source + overlay or worktree copy** — so a runaway agent cannot
   rewrite history.

A natural follow-on: encode this as a `hardened` profile in the devc-tools
config wizard — one flag that emits the no-socket, no-cred-mount,
proxy-plus-broker layout, so the safe shape is the default rather than something
each project re-derives.

---

## Sources

- [pasky/pi-gondolin](https://github.com/pasky/pi-gondolin)
- [earendil-works/gondolin](https://github.com/earendil-works/gondolin)
- [pi containerization docs](https://pi.dev/docs/latest/containerization)
