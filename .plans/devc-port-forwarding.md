# devc-port-forwarding

**Repo:** `devc-tools`
**Run on:** any checkout for the code and offline tests; a host with Docker for the last
Validation items.

Let `devc up --port 3000` make a container port reachable on the host **without recreating the
container**, and make the merged config's `forwardPorts` work outside VS Code.

## Findings (what the investigation settled)

- Docker port publishing (`-p`, `appPort`, `runArgs: ["-p", …]`) is a create-time
  `HostConfig.PortBindings`. There is no `docker update` for it, so adding a published port means
  recreating the container (`devc build`). That route stays as it is and is **not** this plan.
- `forwardPorts` is in the overlay's `KNOWN_CONFIG_KEYS` (`devc-core/overlay.ts`), but the
  embedded devcontainer CLI does nothing with it: VS Code implements it client-side. Today a devc
  user who writes `forwardPorts` gets nothing unless VS Code is attached.
- The forwarding mechanism is VS Code's: the host listens, and each accepted connection is piped
  through its own `docker exec -i <id> <connector>` whose stdio is a TCP connection to the port
  *inside* the container. This works on Docker Desktop (no route to container IPs needed) and
  reaches servers bound only to loopback in the container, which most dev servers are.
  Rejected alternatives: a socat sidecar on the container's network (cannot reach in-container
  loopback; `--network container:<id>` rejects `-p`), and dialing the container IP (Linux only).
- `devc up` exits as soon as the container is up, so the listeners need a process that outlives
  it. This plan adds one: a **forwarder**, a detached devc process per container (the same
  self-exec-as-a-detached-child pattern `devc-bridge start` uses in `devc-bridge/host/main.ts`).
  Not the devc-bridge daemon (a separate binary with a token-authorized, container→host trust
  boundary that should not grow a host→container one) and not `devc web` (optional; not running
  for a CLI-only user).

## Checklist

- [ ] Step 1: core module — port specs, `forwardPorts` extraction, connector argv, state file (§ Step 1)
- [ ] Step 2: the forwarder process (§ Step 2)
- [ ] Step 3: `devc up --port` / `devc build --port`, and `forwardPorts` on every start (§ Step 3)
- [ ] Step 4: `devc ports` (list / stop), and `stop`/`down` tear-down (§ Step 4)
- [ ] Step 5: docs and help (§ Step 5)
- [ ] Tests (§ Tests)
- [ ] Validation (§ Validation)

## Existing touchpoints

| File                                       | Role in this plan                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `devc-core/container.ts`                   | `dockerExecArgv` — the **only** place a `docker exec` argv may be built (enforced by `devc/tests/docker_exec_single_path_test.ts`). The connector exec goes through it. `ContainerInfo`, `findContainer`, `getContainerStatus`. |
| `devc-core/mod.ts`                         | Export the new core module's public API.                                                                                       |
| `devc-core/merged_config.ts`               | `ensureMergedConfig` (source of `forwardPorts`), `projectKey`.                                                                 |
| `devc/args.ts`                             | `parseUpArgs` / `parseBuildArgs` gain `ports`; new `parsePortsArgs`.                                                           |
| `devc/main.ts`                             | `up`, `build`, `stop`, `down` subcommands; new `ports` and hidden `__ports-serve` subcommands.                                 |
| `devc/container.ts`                        | `startContainer` / `connectionFor` (CLI-bound wrappers the forwarder uses to get a `ContainerInfo`).                           |
| `devc/help.ts`                             | Help text for the new flag and subcommand.                                                                                     |
| `devc/README.md`                           | Docs (§ Step 5).                                                                                                               |
| `devc-bridge/host/main.ts`                 | Reference only: the detached self-exec, pid-file, stop/status pattern to copy.                                                 |

New files: `devc-core/ports.ts` (pure, no Deno-only APIs beyond what the rest of devc-core uses —
devc-core is also an npm package), `devc/ports.ts` (forwarder process + CLI glue), tests below.

## Contracts

### Port spec (CLI)

`--port SPEC`, repeatable, on `devc up` and `devc build`. `SPEC` is:

- `N` — host port `N` → container port `N`
- `H:C` — host port `H` → container port `C`

Ports are integers 1–65535. Anything else throws `invalid --port '<SPEC>': expected PORT or
HOST_PORT:CONTAINER_PORT` (exit 2 via `parseOrExit2`, as other arg errors). Two specs with the
same host port in one invocation throw `--port: host port H given twice`.

The host listener **always** binds `127.0.0.1`. No flag binds another address in this plan
(exposing a dev server to the LAN is a deliberate act; `appPort` already does it).

### `devc-core/ports.ts`

```ts
export interface PortForward {
  hostPort: number;
  containerPort: number;
  /** Where it came from: a `--port` flag, or the merged config's `forwardPorts`. */
  source: 'cli' | 'config';
}

/** Parse one CLI spec. Throws with the message above. */
export function parsePortSpec(spec: string): Omit<PortForward, 'source'>;

/**
 * The merged config's `forwardPorts`, as forwards (hostPort === containerPort).
 * Per the spec, entries are numbers or `"host:port"` strings. Numbers, and strings whose host is
 * `localhost` or `127.0.0.1`, are kept; any other `"host:port"` (a compose service name) is
 * returned in `skipped` with its original value, for the caller to warn about.
 */
export function forwardPortsFromConfig(config: Record<string, unknown>): {
  forwards: PortForward[];
  skipped: unknown[];
};

/** Which connector the container has, probed once per forwarder start. */
export type Connector = 'socat' | 'nc' | 'bash';

/** The `cmd` (for `DockerExecSpec.cmd`) of the probe: prints the first of socat, nc, bash found. */
export function connectorProbeCmd(): string[];

/** The `cmd` that turns the exec's stdio into a TCP connection to `containerPort` in the container. */
export function connectorCmd(connector: Connector, containerPort: number): string[];

/** `~/.cache/devc/ports/<containerId>.json`. */
export function portsStatePath(containerId: string, cacheRoot?: string): string;
```

Connector requirements (the implementer picks the exact commands):

- Reach a server bound to `127.0.0.1`, `::1` or `0.0.0.0` in the container. `localhost` resolving
  to `::1` first is common (Node ≥ 17, Vite), so an IPv4-only `127.0.0.1` dial is not enough on its
  own: fall back to `::1` on refusal, or dial `localhost` in a way that tries both.
- `nc` variants differ on EOF handling (OpenBSD, BSD, busybox, ncat); the chosen invocation must
  close the connection when either side closes, on whichever `nc` is found — or the probe must
  only report `nc` for variants it handles.
- `bash` means the `/dev/tcp` fallback.
- None found: the forwarder refuses that container with
  `no connector in container: install socat or nc` and exits non-zero; `devc up` prints it as a
  warning (the container is still up — see Step 3).

### State file — `~/.cache/devc/ports/<containerId>.json`

Written by the devc CLI (desired state) and read/watched by the forwarder. One file per
container. Keyed by container id, not project key, because forwards belong to one container's
lifetime: a recreate gets a new id and therefore a clean slate.

```jsonc
{
  "version": 1,
  "containerId": "<full id>",
  "localFolder": "/abs/project/path",
  "pid": 12345,              // the forwarder's pid; written by the forwarder, null before it starts
  "forwards": [
    { "hostPort": 3000, "containerPort": 3000, "source": "cli" }
  ],
  // written by the forwarder, one entry per forward it tried; read by `devc ports`
  "listening": [
    { "hostPort": 3000, "ok": true },
    { "hostPort": 5173, "ok": false, "error": "address in use" }
  ]
}
```

Writers replace the file atomically (write a temp file in the same directory, then rename). The CLI
owns `forwards`; the forwarder owns `pid` and `listening`. Each side re-reads before writing and
keeps the other side's fields.

### Forwarder process — hidden subcommand

`devc __ports-serve <containerId>` — not in help. Spawned detached (stdio null, own process group)
by the CLI; logs to `~/.cache/devc/ports/<containerId>.log`.

Behaviour:

1. Write its `pid` into the state file. If the file already names a live pid that is not itself,
   exit 0 (another forwarder owns it).
2. Get a `ContainerInfo` via `connectionFor(localFolder, containerId)` and probe the connector
   once.
3. Reconcile listeners against `forwards`: open the missing ones on `127.0.0.1:<hostPort>`, close
   the removed ones (close their live connections too). Record each result in `listening`. A bind
   failure (port in use — VS Code forwarding the same port is the expected case) is recorded and
   skipped, never fatal.
4. Per accepted connection: spawn the connector through `dockerExecArgv(info, { interactive: true,
   cmd: connectorCmd(...) })` and pipe both directions; close both ends when either finishes.
5. Re-reconcile whenever the state file changes (watch it).
6. Exit, removing the state file, when the container is no longer running (poll
   `docker inspect` state every few seconds, or `docker events` filtered to the container) or when
   `forwards` becomes empty.

### CLI surface

```
devc up    [PATH] [--port SPEC]... [existing flags]
devc build [PATH] [--port SPEC]... [existing flags]
devc ports [PATH] [--json]
devc ports stop [PATH] [HOST_PORT]...
```

`UpArgs` and `BuildArgs` (`devc/args.ts`) gain `ports: Array<{ hostPort: number; containerPort: number }>`.

`devc ports` output, one row per forward: `127.0.0.1:3000 → 3000  cli  listening` (or the
recorded error). `--json` prints the state file's `forwards` merged with `listening` as an array
of `{ hostPort, containerPort, source, ok, error? }`. No container running: `No running container
for <PATH>`, exit 0. Running but no forwards: `No ports forwarded for <PATH>`.

`devc ports stop` with no ports removes every forward (the forwarder exits); with ports, removes
those host ports. Unknown host port: `not forwarded: H`, exit 1.

## Step 1: core module

`devc-core/ports.ts` per the contract; export from `devc-core/mod.ts`. Pure functions only, apart
from `portsStatePath`'s use of the home dir (copy how `merged_config.ts` defaults `cacheRoot`).

## Step 2: forwarder

`devc/ports.ts`: the `__ports-serve` loop, plus the helpers the CLI uses:

```ts
/** Merge `forwards` into the container's state file (by hostPort; a later source wins) and make sure a forwarder is running. */
export async function ensureForwards(localFolder: string, containerId: string, forwards: PortForward[]): Promise<void>;

/** Remove forwards (all when `hostPorts` is omitted). Returns the host ports that were not forwarded. */
export async function removeForwards(containerId: string, hostPorts?: number[]): Promise<number[]>;

/** The state file joined with listening status, or null when there is none. */
export async function readForwards(containerId: string): Promise<ForwardStatus[] | null>;
```

`ensureForwards` spawns the forwarder only when the state file's `pid` is absent or dead, then
waits briefly (bounded, ~2 s) for `listening` to cover the new forwards so `devc up` can report
bind failures. The spawn runs this same program (`Deno.execPath()` plus the args a compiled vs.
`deno run` devc needs — copy `devc-bridge`'s `start`).

## Step 3: `up` / `build` / `forwardPorts`

After `startContainer` / `rebuildContainer` returns, `devc up` and `devc build`:

1. Take `forwardPortsFromConfig(merged.config)` (`source: 'config'`) plus the `--port` forwards
   (`source: 'cli'`; a CLI forward replaces a config one with the same host port).
2. If there are any, `ensureForwards(...)`. Print each skipped `forwardPorts` entry as
   `forwardPorts: skipping '<value>' (only local ports are forwarded)` on stderr.
3. Report: one line per forward, `forwarding 127.0.0.1:H → C`, or
   `port H not forwarded: <error>` on stderr. A forwarding failure (including no connector) is a
   **warning**: the container is up, and the exit code stays 0. With `--json`, add
   `"ports": ForwardStatus[]` to the printed object instead of the lines.

`--port` forwards last for the container's lifetime: a later `devc up` without `--port` keeps
them (the merge only adds). `devc build` gets a new container id, so only the forwards given to
that `build` (plus `forwardPorts`) apply — previous `--port`s do not carry over. Say so in the
docs.

Other start paths (`devc attach`, `devc claude`, `devc web`'s starts, …) also apply
`forwardPorts`, but take no `--port`. Put the config half in one helper the start paths share
rather than in `main.ts`'s `up` branch only; `devc web` starts must reach it through the same
helper (single-path rule, as for exec).

## Step 4: `devc ports`, `stop`, `down`

`ports` subcommand per the contract, parsed by a new strict `parsePortsArgs` in `devc/args.ts`
(unknown flag throws, like `parseConfigArgs`). `devc stop` and `devc down` call
`removeForwards(containerId)` before stopping/removing, so listeners go away immediately rather
than at the forwarder's next poll.

## Step 5: docs and help

- `devc/help.ts`: `--port` on `up`/`build`; `ports` and `ports stop`.
- `devc/README.md`, a new section after `## Optional overlay: devc.json`'s siblings (implementer's
  choice of spot), covering: the two routes (forward — no recreate, loopback only, needs
  socat/nc/bash in the container; `appPort` — published by Docker, needs `devc build`);
  `forwardPorts` now works without VS Code; VS Code attached at the same time will hold the same
  host port and one of the two will report it in use; lifetime rules from Step 3.
- `devc/README.md` § Commands table: `ports`.

## Concept boundaries

- **devc-bridge** (`devc-bridge/`, TCP `127.0.0.1:48227`) carries container → host *commands*.
  This plan is host → container *TCP*. They share nothing; do not route forwards through the
  bridge, and do not reuse its config dir (`~/.config/devc-bridge/`).
- **`appPort`** and `runArgs -p` are Docker publishes. This plan neither reads nor writes them;
  the docs point at them as the permanent route.
- **`portsAttributes` / `otherPortsAttributes`** (also in `KNOWN_CONFIG_KEYS`) are VS Code UI
  hints (labels, auto-open). Ignored here.
- **`devPort`** in `KNOWN_CONFIG_KEYS` is a legacy VS Code key the CLI migrates; unrelated.
- **`devc web`'s own listen port** is the web server's, not a forward. Do not list it in
  `devc ports`.
- **`devc web --port`** already exists (`devc/args.ts`, the web server's listen port). It is a
  different flag on a different subcommand; this plan's `--port` exists only on `up` and `build`,
  and the two parsers stay separate.

## .gitignore

Nothing: all state is under `~/.cache/devc/ports/`.

## Tests

- `devc-core/tests/ports_test.ts`: `parsePortSpec` (valid forms, 0, 65536, `a:b`, `1:2:3`);
  `forwardPortsFromConfig` (numbers, `"localhost:3000"`, `"db:5432"` skipped, absent key, wrong
  types ignored); `connectorCmd` shapes per connector.
- `devc/tests/args_test.ts`: `--port` on up/build (repeat, duplicate host port, invalid);
  `parsePortsArgs`.
- `devc/tests/ports_test.ts`: the state-file merge (CLI wins over config on host port; the other
  side's fields preserved; atomic replace) with a temp `cacheRoot`; forwarder reconcile against a
  fake connector (inject the spawn so a test can stand in `cat`-style echo for `docker exec`):
  open, close, bind-in-use recorded and not fatal, exit on empty `forwards`.
- `devc/tests/docker_exec_single_path_test.ts` must still pass unchanged (the connector goes
  through `dockerExecArgv`).
- `deno task test` (or the repo's documented test command) green; `deno check` clean.

## Validation

On a host with Docker:

- [ ] In a running container: start a server bound to `127.0.0.1:8000`; `devc up --port 8000`
      (no recreate — the container id is unchanged); `curl 127.0.0.1:8000` on the host reaches
      it.
- [ ] Same with a server bound to `::1` only.
- [ ] `devc up --port 9000:8000` forwards host 9000; `devc ports` lists both; `devc ports stop .
      9000` removes one; `devc ports stop` removes the rest and the forwarder process is gone.
- [ ] `forwardPorts: [8000]` in a `devc.json` overlay: a plain `devc up` forwards it.
- [ ] Host port already taken: `devc up --port` prints the warning, exits 0, container up.
- [ ] `devc stop`: the host port is free immediately after.
- [ ] A container with none of socat/nc/bash (e.g. a distroless-ish image): the warning names the
      missing connector.
