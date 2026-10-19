# devc-container-connection

**Repo:** `devc-tools`
**Run on:** any checkout for Steps 1–5 and the offline tests; a **host** with Docker for Step 0
and the Validation.

Every `docker exec` devc makes into a devcontainer, whether from the CLI (`attach`, `exec`,
`claude`, `herdr`, the Herdr watcher) or from `devc web`, must reach the container **the same
way**: the same `remoteUser`, the same re-derived `remoteEnv`, the same working directory and
the same login shell. Today there are three paths, and they disagree. This plan puts one
connection resolver and one argv builder in devc-core and makes every exec site use them.

## Checklist

- [x] Step 0: `read-configuration` settled from the CLI 0.88.0 source plus a stub-docker run; host measurement folded into Validation (§ Step 0 results)
- [x] Step 1: `connectionFor`, and `startContainer` sharing its `remoteEnv` derivation (§ Step 1)
- [x] Step 2: `dockerExecArgv` and `loginShellArgv`; `buildExecArgs` removed (§ Step 2)
- [x] Step 3: CLI exec sites use them: `execInContainer`, `attach`, the Herdr watcher (§ Step 3)
- [x] Step 4: `devc web` resolves a `ContainerInfo` per container and every exec uses it (§ Step 4)
- [x] Step 5: the single-path test, README, doc comments (§ Step 5)
- [x] Tests (§ Tests): the `connectionFor` test runs the real CLI against a stub `docker` (`devc-core/tests/connection_for_test.ts`)
- [ ] Validation on a host (§ Validation), including Step 0's cases (a)–(d) against real containers

### Implementation notes (2026-10-18)

- **`attachExecArgs` was kept, not removed**, as attach's own pure argv function over
  `dockerExecArgv` (`(info, options, hostEnv) => string[]`). It owns attach's env layering and
  login-shell choice, which are now tested directly, `remoteEnv` beating host `TERM` included.
- **The single-path test's pattern** is `/(^\s*|\[\s*)['"]exec['"]\s*,/` (an array element at
  the start of a line or right after `[`), not the own-line-only pattern in § Step 5. It also
  catches a one-line `['exec', …]`, and it skips `f('exec', …)` (`main.ts`) and
  `action: 'exec',`. Checked against the pre-plan code: it flags all seven hand-built sites.
- **Retry is `ContainerSession.retry()`**, which clears `target` and runs again. `run()` alone
  resolves only when there is no target, so the post-start reconnect in `#awaitServer` doesn't
  pay for a second `read-configuration`.
- **`resolveConnection`** (`web/containers.ts`) runs `connectionFor` through `streamingRunner`, so
  the CLI's log lines stay out of `devc web`'s terminal, and a failure's message carries the last
  five lines.
- `devc-core/tests/git_dirs_test.ts` "cliWorktreeMounts matches what the pinned devcontainer CLI
  computes" fails in a container without Docker, both before and after this change: the real
  `read-configuration` exits 1 when it can't run `docker`.

## What was observed (2026-10-18)

The host has `$TZ` set. Containers attached with `devc attach` / `devc herdr` get it. A Herdr
session started from the `devc web` page did not: in the container, the
`herdr --session devc server` process's `/proc/<pid>/environ` held `SHELL=/bin/bash` and none
of `TZ`, `LANG` or `PROJECT_PATH`, and every pane inherits that environment.

**Why:** the bundled default config sets those as `remoteEnv`
(`devc-core/default/devcontainer.json`, `"TZ": "${localEnv:TZ:America/New_York}"`).
`remoteEnv` is not stored on the container: each client applies it per connection, so a bare
`docker exec` never sees it. The CLI rebuilds it after `devcontainer up` (`startContainer` in
`devc-core/container.ts`, via `resolveRemoteEnv` + `inspectContainerEnv`) and passes `-e K=V`.
`devc web` never calls `startContainer` for a running container. It finds containers through
`docker ps`/`docker events` and built its own connection details: `remoteUser` from the
`devcontainer.metadata` label (`resolveRemoteUser` in `devc/web/containers.ts`; its plan says
"Nothing in devc reads this label today … so this parser is new") and **no `remoteEnv` at all**.

**Root cause:** devc-core only offers "start, then exec". Every connection detail
(`ContainerInfo`) comes out of `devcontainer up`, which an observer like `devc web` must not run
(it takes seconds, renames the container and refreshes the bridge policy, and web "never
starts the container"). So nothing tells you how to reach a container that is already running,
and each new consumer has built its own answer.

## Current exec sites

Every site that runs `docker exec`, and how it differs from `execInContainer`:

| Site                                                                                                        | `-u`        | `remoteEnv`                                                            | `-w`                            | Shell                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `execInContainer` (`devc-core/container.ts`, via `buildExecArgs`)                                           | `up` result | yes                                                                    | `remoteWorkspaceFolder` / `cwd` | none (argv)                                                           |
| `attachToContainer` (`devc/attach.ts`, via `attachExecArgs`)                                                | `up` result | yes, plus TERM identity below it and TMUX/`DEVC_ATTACH`/watch id above | `remoteWorkspaceFolder` / `cwd` | `/bin/bash -l` or `/bin/bash -lc`                                     |
| Herdr watcher (`herdrWatcherArgs`, `devc/herdr.ts`)                                                         | `up` result | **no**                                                                 | **no**                          | `sh -c`                                                               |
| `herdrArgv` (`devc/web/herdr_bridge.ts`): bridge, `--check`, `terminal session control` in `controllers.ts` | label parse | **no**                                                                 | **no**                          | none                                                                  |
| `startSession` (`herdr_bridge.ts`)                                                                          | label parse | **no**                                                                 | **no**                          | `SERVER_SHELL`: `/bin/bash -lc 'export SHELL; exec "$0" "$@"'`        |
| `serverLogTail` (`herdr_bridge.ts`)                                                                         | label parse | **no**                                                                 | **no**                          | `sh -c`                                                               |
| `commandInstalled` (`herdr_bridge.ts`)                                                                      | label parse | **no**                                                                 | **no**                          | `bash -lc`                                                            |
| `resolveHerdrPath` (`devc/web/containers.ts`)                                                               | label parse | **no**                                                                 | **no**                          | `sh -lc`. **Not** the `bash -l` PATH that panes and `devc claude` get |

Out of scope: `docker` calls that don't exec into a container (`docker ps`, `docker events`,
`docker inspect`). Duplicated inspect helpers such as `inspectMounts` in web vs
`getContainerMounts` in core are a separate cleanup.

## The rule this plan establishes

1. A container's connection is a `ContainerInfo` (`containerId`, `remoteUser`,
   `remoteWorkspaceFolder`, `remoteEnv`). There are exactly two ways to get one:
   `startContainer` (runs `up`) and `connectionFor` (no `up`). Both derive `remoteEnv` with
   the same function.
2. Every `docker exec` argv is built by `dockerExecArgv(info, spec)`. Every exec carries `-u`,
   the full `remoteEnv` and `-w`, with no exceptions. That includes Herdr client processes
   (bridge, `terminal session control`), for which the env is harmless.
3. Every login shell is `loginShellArgv(…)`, which is `/bin/bash -l`. A plain `sh -c` stays
   allowed for scripts that need no profile (the watcher, `serverLogTail`).

## Step 0: measure `read-configuration`

`connectionFor` needs `remoteUser` and `remoteWorkspaceFolder` without `up`. Today both come
only from `up`'s outcome JSON. Deriving `remoteWorkspaceFolder` on the host is not simple: the
CLI targets the **git root** (`--mount-git-worktree-common-dir`, worktree targets,
`workspaceFolder` sub-paths; see `workspaceMountRow` in `devc-core/overlay.ts` and
`findRepoRoot` in `devc-core/repo.ts`). Re-implementing that would create a fourth copy of the
same logic, so the preferred source is the devcontainer CLI itself:

```
devcontainer read-configuration --workspace-folder <localFolder> [--no-lockfile]
  (--config | --override-config) <merged.path>
  [--mount-git-worktree-common-dir]
  --include-merged-configuration
```

That's the same flag selection as `buildUpArgs`, minus `up`'s own flags. On a host, for
**(a)** a zero-config project, **(b)** a project with its own `.devcontainer/` and a
`workspaceFolder` sub-path, **(c)** a linked worktree, and **(d)** a container started by VS
Code, not devc, record:

- whether the output has `workspace.workspaceFolder` equal to `up`'s `remoteWorkspaceFolder`;
- whether `mergedConfiguration.remoteUser` equals `up`'s `remoteUser` (it reads the running
  container's metadata, so this only holds if the CLI finds the container from these flags);
- wall time per call, from the self-exec runner (`selfExecDevcontainerRunner`);
- which flags `read-configuration` rejects (for example `--no-lockfile`).

Write the results into this section. **If (a)–(c) match**, Step 1 uses `read-configuration`.
**If they don't**, fall back to this: `startContainer` writes `{containerId, remoteUser,
remoteWorkspaceFolder}` to `~/.cache/devc/projects/<key>/connection.json` after every
successful `up`. `connectionFor` reads it, and it must match `containerId`, or it fails with
"start it with devc once". Case (d) then has no file, so record what web should do for it here
before Step 4.

### Step 0 results (2026-10-18, from source; no Docker in the implementing container)

Read from `@devcontainers/cli` 0.88.0's bundle (`dist/spec-node/devContainersSpecCLI.js`):

- `read-configuration` gets `workspace` from the same `vi(cliHost, workspace, configFile,
  mountWorkspaceGitRoot, mountGitWorktreeCommonDir, …)` whose `workspaceConfig.workspaceFolder`
  `up` (and `exec`) report as `remoteWorkspaceFolder`. Given the same `--workspace-folder`,
  `--mount-git-worktree-common-dir` and config flag, the two match by construction, for
  (a)–(c) alike.
- With `--container-id`, the container is found by id with no label lookup, and
  `--include-merged-configuration` merges **that container's** metadata (`Or(container, …)`),
  which is the same merge `up` uses. `up`'s user is then `mergedConfig.remoteUser ||
  Config.User || "root"`, user part only (`resolveRemoteUserName`). By id also covers (d), a
  VS Code-started container, so no fallback and no label parser is needed.
- `--no-lockfile` is rejected ("Unknown arguments"), and `read-configuration` writes no lockfile
  anyway.
- Smoke run (real CLI, real `ensureMergedConfig`, stub `docker` answering `inspect`): a project
  with `workspaceFolder: /workspaces/proj/sub` resolved `remoteWorkspaceFolder`
  `/workspaces/proj/sub`, `remoteUser` `vscode` from metadata over `Config.User` `root`, and
  `remoteEnv` with `${localEnv:…:default}`, `${containerWorkspaceFolder}` and
  `${containerEnv:FOO}` all resolved.
- Not measured: wall time per call on a host. It is one Node process plus one `docker inspect`,
  paid once per container at discovery, on Retry, and before Start session.

## Step 1: `connectionFor` (devc-core/container.ts)

```ts
/**
 * How to reach a container that is already running, without `devcontainer up`: the same
 * ContainerInfo startContainer returns. Recomputes the merged config (ensureMergedConfig), so a
 * config edit since the start is reflected, exactly as the next `devc attach` would see it.
 */
export async function connectionFor(
  localFolder: string,
  containerId: string,
  opts?: { devcontainer?: DevcontainerRunner },
): Promise<ContainerInfo>;
```

- It throws on the same failures `startContainer` would surface before `up`
  (`ensureMergedConfig` errors such as a strict-load failure or compose + git protection), plus
  a failed `read-configuration`. The message is the underlying one.
- `remoteEnv` comes from **one** function used by both `startContainer` and `connectionFor`
  (internal, not exported):
  `deriveRemoteEnv(merged: MergedConfig, containerId: string, remoteWorkspaceFolder: string, localFolder: string): Promise<Record<string, string>>`,
  i.e. today's `resolveRemoteEnv(merged.config, …, await inspectContainerEnv(containerId))`
  call moved out of `startContainer`.
- `devc/container.ts` gets a pre-bound `connectionFor` (the self-exec `DevcontainerRunner`),
  as it does for `startContainer`. It does **not** record the project or refresh the bridge
  policy. Those are start effects.

## Step 2: `dockerExecArgv` and `loginShellArgv` (devc-core/container.ts)

```ts
export interface DockerExecSpec {
  /** `-i`. */
  interactive?: boolean;
  /** `-t`. Never together with a JSON-over-stdio consumer. */
  tty?: boolean;
  /** `-d`. */
  detach?: boolean;
  /** `-w`. Defaults to info.remoteWorkspaceFolder. */
  cwd?: string;
  /** Applied *below* remoteEnv: remoteEnv wins on collision (attach's TERM identity). */
  envDefaults?: Record<string, string>;
  /** Applied *above* remoteEnv: wins on collision (ExecOptions.env, TMUX, DEVC_ATTACH…). */
  env?: Record<string, string>;
  /** Exec'd as given, after the container id. */
  cmd: string[];
}

/**
 * `['exec', <-i/-t/-d>, ...('-e', 'K=V') one per merged key (envDefaults < remoteEnv < env),
 *   '-u', remoteUser, '-w', cwd, containerId, ...cmd]`.
 */
export function dockerExecArgv(
  info: ContainerInfo,
  spec: DockerExecSpec,
): string[];

/**
 * A login shell. With no script: `['/bin/bash', '-l']` (interactive attach). With one:
 * `['/bin/bash', '-lc', script, ...args]`, args riding as $0/$@.
 */
export function loginShellArgv(script?: string, ...args: string[]): string[];
```

- `buildExecArgs` is removed and its tests (`devc-core/tests/exec_args_test.ts`) move to
  `dockerExecArgv`. `attachExecArgs` is removed too, but its test file
  `devc/tests/attach_cwd_test.ts` keeps testing the `-w` decision, through `dockerExecArgv`.
- One `-e` per key. Collisions resolve as the doc comment says, with no duplicate `-e` flags.

## Step 3: CLI exec sites

- `execInContainer`: `dockerExecArgv(info, {interactive: true, cwd: opts.cwd, env: opts.env, cmd: opts.cmd})`.
- `attachToContainer`: `dockerExecArgv(info, {interactive: true, tty: true, cwd, envDefaults: <TERM, TERM_PROGRAM, TERM_PROGRAM_VERSION when set>, env: <TMUX, DEVC_ATTACH, DEVC_HERDR_WATCH_ENV as today>, cmd: loginShellArgv(…)})`.
  The `clear; printf …; exec "$0" "$@"` script is unchanged.
- Herdr watcher: `dockerExecArgv(info, {cmd: ['sh', '-c', herdrWatcherScript(id)]})`, still
  with no `-i` and no `-t`. `herdrWatcherArgs` then takes `info` and drops its own argv.

## Step 4: `devc web`

- **`HerdrTarget`** (`devc/web/herdr_bridge.ts`) becomes
  `{ info: ContainerInfo; herdrPath: string; session: string }`. `containerId` and `user` are
  replaced by `info.containerId` / `info.remoteUser` at every use (`controllers.ts` keys,
  `server.ts`, tests).
- **Resolution** (`ContainerSession.run`, today `inspectRemoteUser` + `resolveHerdrPath`):
  `connectionFor(record.localFolder, record.id)`, then `resolveHerdrPath(info)`. A thrown
  `connectionFor` puts the container in `error` with its message, which matches what
  `devc attach` would fail with. Re-resolve on Retry and before Start session, not only when
  `target` is null, so a config edit is picked up without restarting `devc web`. Resolution
  goes through `this.#deps` so tests can stub it.
- **Every exec** goes through `dockerExecArgv(t.info, …)`:
  - `herdrArgv(t, rest)` → `{interactive: true, cmd: [t.herdrPath, '--session', t.session, ...rest]}`
  - `startSession` → `{detach: true, cmd: loginShellArgv('export SHELL; exec "$0" "$@"', t.herdrPath, '--session', t.session, 'server')}`.
    `SERVER_SHELL` becomes that script constant. `export SHELL` stays, because a project
    config need not set `SHELL` in `remoteEnv`.
  - `serverLogTail` → `{cmd: ['sh', '-c', <same script>, '_', t.session]}`
  - `commandInstalled` → `{cmd: loginShellArgv('command -v "$1" >/dev/null', command)}`
  - `resolveHerdrPath(info)` → `{cmd: loginShellArgv('command -v herdr')}`. That moves from
    `sh -l` to `bash -l`, so the herdr found is the one on the panes' PATH.
- **Remove** `resolveRemoteUser` and `inspectRemoteUser` (`devc/web/containers.ts`) and their
  tests, unless Step 0 recorded a case (d) fallback that still needs the label parser. Then
  keep it in devc-core next to `connectionFor`, not in web.
- `web/proc.ts` stays web's own: process groups, cleanup and the `spawnLines`/`runText`
  wrappers. Only the argv is shared.

## Step 5: enforce and document

- **Single-path test**, `devc/tests/docker_exec_single_path_test.ts`: it walks every non-test
  `.ts` file under `devc/` and `devc-core/` and fails if any file other than
  `devc-core/container.ts` contains an array element that is exactly the literal `'exec'` on a
  line of its own (`/^\s*'exec',?\s*$/m`). The test names the file. The `action: 'exec'` event
  parsing in `web/containers.ts` doesn't match, because it isn't on a line of its own.
- **`devc/README.md`**, the "exec / attach" bullet under how devc works: say that `devc web`
  reaches running containers with the same resolution (`connectionFor`), and that every exec
  carries `remoteEnv`.
- Doc comments: `HerdrTarget`, `SERVER_SHELL`, `resolveHerdrPath` (it no longer says `sh -l`)
  and `ContainerInfo` (name both producers).
- `.claude/skills/` is read-only. Don't edit the `devc-web` skill even if it mentions
  `inspectRemoteUser`. Report any such mention instead.

## Concept boundaries

- **`ContainerInfo` vs `HerdrTarget`.** A `ContainerInfo` says how to reach a container. A
  `HerdrTarget` adds which `herdr` binary and session to use. Don't add Herdr fields to
  `ContainerInfo`.
- **`connectionFor` vs `startContainer`.** Both return a `ContainerInfo`. Only
  `startContainer` has start effects (`up`, rename, image tag, bridge policy, project
  recording). `connectionFor` must not acquire any of them. `ensureMergedConfig` rewriting the
  cache file is not a start effect: it already writes on every call.
- **`remoteEnv` vs `containerEnv`.** `containerEnv` is baked into the container at create time
  and every `docker exec` already has it. `remoteEnv` is what this plan makes universal. Don't
  "fix" this by moving `remoteEnv` entries into `containerEnv`: that only takes effect on
  rebuild and changes the config's meaning.
- **`envDefaults` vs `env`.** Below vs above `remoteEnv`. Attach's TERM identity is the only
  current `envDefaults` user.
- **`loginShellArgv` vs `SERVER_SHELL`'s script.** The helper owns `/bin/bash -l[c]`. The
  `export SHELL; exec "$0" "$@"` script is the server's own and stays in `herdr_bridge.ts`.
- **Discovery's `record.localFolder`** comes from the `devcontainer.local_folder` label. It is
  the `localFolder` to pass to `connectionFor`, with no path translation.

## Tests

- `dockerExecArgv`: flag order; `-w` default vs `cwd`; env precedence
  (`envDefaults` < `remoteEnv` < `env`) with one `-e` per key; `-i`/`-t`/`-d` combinations.
- `loginShellArgv`: no script, and script + args.
- `connectionFor` with a stub `DevcontainerRunner` and a temp `cacheRoot`/`configDir`
  (the `ensureMergedConfig` options): `remoteEnv` resolves `${localEnv:VAR:default}` and
  `${containerWorkspaceFolder}` from the workspace folder `read-configuration` reported;
  `startContainer` and `connectionFor` produce the same `remoteEnv` for the same inputs (this
  is the drift guard); a failing `read-configuration` throws.
- Web (`devc/tests/web_bridge_test.ts`): `startSession` argv has `-d`, `-u`, `-w`, an `-e`
  for every `remoteEnv` key and `/bin/bash -lc`; `herdrArgv` carries `remoteEnv`; Retry
  re-resolves the connection; a throwing resolver yields state `error` with the message.
- The single-path test (§ Step 5).
- `deno task test` (or the repo's usual test command) passes for `devc/` and `devc-core/`.

## Validation (on a host)

1. With `TZ` set on the host, kill the container's Herdr server (`herdr --session devc server`),
   then start it from the `devc web` page. In a new pane, `echo $TZ $LANG $PROJECT_PATH` prints
   the host's TZ, `en_US.utf8` and the workspace folder. The server process's
   `/proc/<pid>/environ` has them too.
2. `devc attach` and `devc exec <project> env` print the same three values as step 1.
3. Edit the project's `remoteEnv` (devc.json overlay), press Retry/Start on the page, and the
   new value reaches a newly started server without restarting `devc web`.
4. A worktree project and a project with a `workspaceFolder` sub-path both open panes in the
   right directory from the page.
5. If you run `devc web --live-yolo` from this checkout, the server restarts on save. An
   already-running Herdr server keeps its old environment until it is restarted (step 1).
