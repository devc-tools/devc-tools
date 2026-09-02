# @devc-tools/core

`devc`'s dev container lifecycle logic — start/rebuild/stop/down, status,
mounts, exec, the `devc.json` overlay, and the config wizard's pure helpers —
as a runtime-neutral library. It is written against `node:` builtins only, so
the exact same source runs unchanged on both Deno (`devc`'s own `deno compile`
binary consumes it from source) and Node (this package, published to npm).

This is **not** a new tool. It is the library
[`devc`](../devc/README.md) has always had, split out so a programmatic
consumer — a coding-agent extension, a script — can call `startContainer` and
get a `ContainerInfo` back as a value, without a `devcontainer`/`devc` binary
on disk or stdout to parse. `devc`'s own CLI, install, and behavior are
unchanged; see [`.plans/archived/devc-core-npm-library.md`](../.plans/archived/devc-core-npm-library.md)
for the full design, and
[`.plans/archived/devc-core-consumer-prep.md`](../.plans/archived/devc-core-consumer-prep.md)
for the logger seam, the runner factory and the content-addressed cache below.

## Install

```sh
npm install @devc-tools/core
```

Requires Node 20+. `docker` is the only external prerequisite at runtime — the
`devcontainer` CLI is an ordinary `dependencies` entry
(`@devcontainers/cli`), resolved and spawned for you.

## Usage

```ts
import {
  downContainer,
  execInContainer,
  startContainer,
} from '@devc-tools/core';

const info = await startContainer('/path/to/project');
console.log(info.containerId, info.remoteWorkspaceFolder);

const { code, stdout } = await execInContainer('/path/to/project', {
  cmd: ['npm', 'test'],
  stdio: 'piped', // capture output instead of inheriting the parent's stdio
});

await downContainer('/path/to/project');
```

Everything importable is re-exported from the package root (`mod.ts` /
`dist/mod.js`) — see that file for the full surface, grouped by module:
`container.ts` (lifecycle), `overlay.ts` (`devc.json`), `merge.ts` +
`merged_config.ts` (the layer merge and the effective config it produces),
`config.ts` (global user config), `mount_paths.ts` (host ↔ container path
translation over a container's mount table), `worktree.ts` + `mounts.ts` +
`wizard_apply.ts` (the config wizard's pure helpers), `init.ts` (scaffold the
bundled default `.devcontainer/`), `default_config.ts` (the bundled default and
`devcontainer.json` variable substitution), and `jsonc_edit.ts` / `posix.ts` /
`paths.ts` (small primitives the rest is built on).

`mount_paths.ts` works **host-side only**. It reads the table `getContainerMounts`
returns from `docker inspect`, where a bind mount's `source` is the real host
path; inside a container the same mount reports a source like
`/run/host_mark/Users`, so a container cannot derive host paths at all. Reach for
this rather than `/proc/mounts` — and only from the host.

"Real host path" takes one step of work that `docker inspect` does not do for
you. Docker Desktop runs the daemon in a Linux VM and reports bind sources as
paths in _that_ VM, grafted under `/host_mnt` — and it does so inconsistently:
on macOS, `devcontainer.json` `mounts` entries come back as
`/host_mnt/Users/me/...` while the workspace folder mount comes back host-real
as `/Users/me/...`, both in the same table. `parseMounts` strips the prefix
(`hostSourceFromMount`), so `ContainerMount.source` is always a path the host
would recognize and a caller may safely `stat` it or compare a host path against
it. Anything reading `.Mounts` without going through core has to do this itself,
and the failure is silent: a `/host_mnt/...` source simply matches nothing and
does not exist.

### The devcontainer CLI seam

`startContainer`/`rebuildContainer`/`execInContainer` accept an optional
`devcontainer: DevcontainerRunner` in their options, defaulting to
`nodeDevcontainerRunner` — a plain `process.execPath` + the resolved
`devcontainer.js` from `node_modules`. A consumer embedding its own copy of
the devcontainer CLI, or needing a different one, can supply its own
`DevcontainerRunner`:

```ts
export interface DevcontainerRunner {
  run(args: string[]): Promise<{ code: number; stdout: string }>;
}
```

(`devc`'s own CLI binds a different one — a hidden self-exec subcommand, since
a `deno compile` binary has no `node_modules` a separate process could open.
See `devc/devcontainer_selfexec.ts`.)

For the common case — the Node runner, but with the devcontainer CLI's stderr
as data rather than on the terminal — there is a factory rather than a
hand-rolled runner:

```ts
import { createNodeDevcontainerRunner, startContainer } from '@devc-tools/core';

const info = await startContainer('/path/to/project', false, {
  devcontainer: createNodeDevcontainerRunner({
    onStderr: (chunk) => myTui.appendBuildLog(chunk),
  }),
});
```

With `onStderr` the CLI's stderr is piped and forwarded chunk by chunk; with no
options it is inherited, exactly as `nodeDevcontainerRunner` (which _is_ the
no-options instance) has always done. On a cold build that stream is minutes of
the only progress there is, so a consumer that hides it usually wants it
somewhere. `devcontainerJsPath()` is exported alongside, for a consumer building
a runner of its own — it is the path this package resolves out of its own
`node_modules`, and re-deriving it from outside would mean depending on where
core's bundle happens to sit on disk.

### Where core's output goes

A handful of sites in core have something to say to a human: an ignored template
file, a bridge mount that could not be injected, the build output of a failed
`devcontainer up`. By default they go where they always went — `notice` to
stdout, `warning` to stderr — which is what keeps `devc`'s own output
byte-identical.

That is the wrong destination for a consumer holding the terminal (a TUI): the
text lands in _its_ stdout and stderr and corrupts the display. One call at load
redirects all of it:

```ts
import { setLogger } from '@devc-tools/core';

setLogger((level, message) => myTui.log(level, message)); // 'notice' | 'warning'
setLogger(null); // back to the console default
```

It is process-global and deliberately so — the call sites sit at varying depths
across three modules, several inside otherwise-pure helpers that no options
object reaches. There is one core instance per process and one consumer driving
it.

### Two caches under `~/.cache/devc/`

**`projects/<key>/devcontainer.json`** is the _effective_ config for one project
— the base config with devc's own layer and both `devc.json` overlays merged in
(`ensureMergedConfig`). It is what `devcontainer up` is actually given, and it is
written on every start, atomically, at `0600`. Its path is keyed on the project
and never on content, deliberately: the devcontainer CLI keys a container on
`devcontainer.local_folder` + `devcontainer.config_file` and will not reuse one
whose `config_file` differs — without removing it, even under
`--remove-existing-container` — so a path that moved would strand a container per
move.

Nothing is written into the project. A generated config inside a git worktree is
also a file inside a Docker build context, it shows up in `git status` for a repo
that need not know devc exists, and it would carry the user-level overlay's
contents into a committable location.

**`default-<key>/`** is the bundled default, materialized for the zero-config
path (`ensureDefaultConfig`). The key is a 12-hex-char `sha256` over the bundled
`default/` tree and the user's `~/.config/devc/templates` overlay, so:

- identical inputs reuse the directory and **write nothing** — a second start is
  a hash and a `stat`;
- different inputs (a different `devc` version, an edited template) get a
  _different_ directory, so two copies of core on one machine never rewrite each
  other's config and never cause a rebuild from nothing the user did;
- a miss stages into a sibling `.tmp-…/` and `rename`s it into place, so a
  concurrent read never sees a half-written tree.

`materializeDefaultConfig` — which writes unconditionally to the directory it is
handed — is the layer underneath `ensureDefaultConfig`, kept separate because it
is what the tests drive; calling it from production code reintroduces the
shared-mutable-path bug the cache exists to fix.

## What's deliberately not here

Attaching an interactive shell (`devc attach` / `devc claude`) — tmux window
titles, OSC terminal-tint escapes, raw-mode TTY handling — stays in `devc`'s
own `attach.ts`. None of it means anything to a library consumer that isn't
holding a terminal.

Also not here: the `devc` CLI itself, and any change to how humans install it.
`devc` still ships as a single `deno compile` binary via `install.sh`; this
package is an additional distribution channel for the logic underneath it,
not a replacement for the CLI.

## Development

```sh
deno task check   # type-check under Deno — the primary suite, since both hosts
deno task test    # read the exact same source (`devc`'s own `deno task test`,
                   # run from ../devc, covers the CLI half: attach, args, help)

npm run build              # esbuild → dist/mod.js, tsc → dist/*.d.ts, default/ copied in
npm run check               # tsc --noEmit, the npm-facing type check
npm run portability-check   # fails if a `Deno.` or `jsr:` reference sneaks back in
```

The portability check exists because the failure it catches is otherwise
silent: a stray `Deno.` in a module here keeps every `deno test` green and only
breaks the npm build. CI runs both `deno task test` here and a real
`npm pack` + scratch-project `node` smoke run (`smoke.mjs`) against the built
tarball, with no Deno, no `devcontainer`, and no `devc` on PATH.

`default/` is the bundled zero-config `devcontainer.json` + `Dockerfile` +
lifecycle scripts, shared by `devc`'s zero-config path and `devc init`. It
ships inside the npm tarball (`npm run build` copies it beside `dist/mod.js`)
and inside the compiled `devc` binary (`deno compile --include ../devc-core/default`,
from `devc/deno.json`) — same files, two delivery mechanisms.
