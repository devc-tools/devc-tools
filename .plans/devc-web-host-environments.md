# devc web: environments — devcontainers and this machine

Decided with the user on 2026-10-23. This doc is the spec.

## Goal

devc web serves people who use no containers. What it does today for a devcontainer (Herdr
terminals, agent status, files, agent sessions, task queues, repo cards, git status, PR review)
it also does for a project
folder **on this machine**, with no Docker anywhere. Both kinds live in one server at once, chosen
per project.

The way there is an **environment** seam: everything that today runs `docker …` goes through an
`Environment` (one project's place to run commands) and an `EnvironmentSource` (finds environments
and starts and stops them). The devcontainer code becomes the first implementation and the host
becomes the second. SSH is **not** built, but the interface must take it without a reshape (see
D9).

## Out of scope

- An SSH (or any remote) environment.
- The agent-side PR loop (`devc-bridge gh-pr-*` run by an agent inside a container, the
  `github-pr-reviewing` skill) is unchanged. Host projects get the **page's** PR review (D10). An
  agent on the host can run `gh` itself.
- Removing a host project's Herdr session (no **Remove** for host projects).
- Renaming `container` / `containers` / `localFolder` on the wire or in page code.
- Packaging devc web apart from the `devc` binary.

## Decisions

### D1 — An environment is one project folder

- Every environment has exactly one `localFolder`, as a devcontainer does today. A host project
  folder's environment is its own Herdr **session**, so the `containers` message, repo cards
  (`repoCardKey(localFolder, …)`), task routes and `sessions` (the server's map) keep their
  one-environment-per-folder shape.
- **Environment id** (the wire's `container` field): a devcontainer's is its full Docker id, as
  today. A host one's is `host-` plus the first 16 hex chars of SHA-256(UTF-8 `localFolder`),
  lowercase, so it is stable across restarts. The page treats both as opaque strings.
- **Host Herdr session name:** `` `${opts.session}-${slug}-${hex8}` ``, where `opts.session` is
  `--session` (default `devc`), `hex8` is the first 8 chars of that same hash, and `slug` is
  `basename(localFolder)` lowercased, with every run of `[^a-z0-9]` turned into `-`, leading and
  trailing `-` trimmed, and cut to 24 chars (trailing `-` trimmed again). An empty slug drops its
  segment: `` `${opts.session}-${hex8}` ``. Example: `/home/me/src/My App!` →
  `devc-my-app-<hex8>`.

### D2 — The interface

Method and type names are at the implementer's discretion. The split and the behavior are not:

```ts
type EnvironmentKind = 'container' | 'host';

interface EnvExec {
  cmd: string[];                 // argv, exec'd directly (no shell)
  cwd?: string;                  // default: container → remoteWorkspaceFolder, host → localFolder
  env?: Record<string, string>;  // on top of the environment's own
  interactive?: boolean;         // stdin piped (Herdr's JSON lines)
}

interface Environment {
  readonly id: string;
  readonly kind: EnvironmentKind;
  readonly localFolder: string;
  readonly herdrSession: string;  // container: opts.session; host: D1's name
  /** Resolves how to reach it (container: connectionFor; host: D3's login-shell probe). Again on Retry/start. */
  prepare(): Promise<void>;
  spawn(x: EnvExec): LineProc;                                   // long-lived (bridge, controller)
  run(x: EnvExec, input?: Uint8Array): Promise<ExecOutput>;      // one-shot, bytes out
  runDetached(x: EnvExec): Promise<ExecOutput>;                  // `herdr server`
  loginShell(script: string, ...args: string[]): string[];       // argv running `script` in a login shell
  herdrPath(): Promise<string>;                                  // absolute, or '' when none
  home(): Promise<string | null>;
  /** The path map. Container: its mount table. Host: [{type:'bind', source:'/', destination:'/'}]. */
  mounts(): Promise<ContainerMount[]>;
  /** Host folders `mountedRepos` looks for repos in, besides localFolder. */
  repoSources(): Promise<string[]>;
  files: EnvFiles;   // list / read / readBytes / create / rename / delete / write / writeText, today's FilesError codes
  /** Live Claude processes: which session id runs in which Herdr pane (D8). */
  runningAgents(): Promise<RunningSession[]>;
  /** The page's PR review for this environment's repos (D10). */
  pr: PrBackend;
  caps: { stop: boolean; down: boolean; containerPaths: boolean };
}

interface PrBackend {
  /** The repo at host folder `root` as a pinned line (`target`, `grants`), or why there is none. */
  pin(root: string): Promise<{ target: string; grants: BridgeCapability[] } | { problem: string }>;
  /** `<command> --repo <target> …args`, the built-in recipe, under today's `runBridge` limits. */
  run(command: string, target: string, args: string[], limits: RunLimits): Promise<BridgeRun>;
}

interface EnvironmentSource {
  readonly kind: EnvironmentKind;
  start(hooks: DiscoveryHooks): void;  // onAdd(env) / onRemove(id) / onStoppedChange / onLaunch(id) / onError
  stop(): void;
  refresh(): Promise<void>;
  stopped(): ReadonlyMap<string, { id: string; localFolder: string }>;
  startProject(localFolder: string, onLine: (line: string) => void): Promise<void>;
  stopProject(localFolder: string): Promise<boolean>;
  downProject?(localFolder: string): Promise<boolean>;
}
```

- `HerdrTarget` becomes `{ env, herdrPath, session }`. `herdrArgv` and every `spawnLines('docker',
  …)` / `runText('docker', …)` / `runDocker` / `runDockerInput` / `runBridge` call site in
  `herdr_bridge.ts`, `controllers.ts`, `container_files.ts`, `sessions.ts`, `pr_review.ts` and
  `server.ts` goes through the target's `env`. Afterwards no module but the container
  implementation names `docker` or `dockerExecArgv` (validated by grep).
- `ContainerSession` keeps its states and lifecycle unchanged. It calls `env.prepare()` and
  `env.herdrPath()` where it calls `resolveConnection` and `resolveHerdrPath` today.
- Test seams: the existing `run = runDocker` style parameters become a fake `Environment`, and
  current tests keep their assertions on the docker argv by going through the container
  implementation.

### D3 — The host environment

- **Exec.** `Deno.Command` / `node:child_process` `spawn` of `cmd` directly, in `cwd` (default
  `localFolder`), with env = devc web's own environment, then `PATH` replaced by the probed one
  (below), then `x.env`. There is no user switching. `spawn` goes through `proc.ts`'s
  `spawnLines` (tracked for shutdown, its own process group). `runDetached` spawns with
  `detached: true`, stdio ignored, `unref()`, and resolves `{ code: 0 }` once the spawn succeeded
  (a spawn error gives code 127 with the error as stderr). A Herdr server started this way
  outlives devc web, as a container's does.
- **Login-shell probe** (`prepare`, cached until the next `prepare`): pick `shell = $SHELL` when
  its basename is one of `sh bash zsh dash ksh`, else `/bin/sh`. Run
  `[shell, '-lc', 'printf "%s\\n" "$PATH"; command -v herdr || true']`. Line 1 is the PATH used
  for every later exec. The last line is `herdrPath` when it starts with `/`, else `''`.
  **Gotcha:** fish (and other non-POSIX shells) print `"$PATH"` space-joined and reject the
  syntax, so they are deliberately not used. On macOS, devc-desktop launched from Finder has a
  bare environment, so this probe is the only way to get the user's PATH. `loginShell(script,
  …args)` gives `[shell, '-lc', script, ...args]`.
- **Paths.** `mounts()` gives the one identity bind `/ → /`. The existing
  `containerToHostPath` / `hostToContainerPath` / `findMountForContainerPath` then return paths
  unchanged (checked: `containerToHostPath('/home/x/a b', m)` → `/home/x/a b`, `'/'` → `/`).
  Nothing in `server.ts` branches on kind for paths.
- **Repos.** `repoSources()` gives the linked worktrees of `localFolder` from
  `git -C <localFolder> worktree list --porcelain`: every `worktree <path>` line after the first
  (the main one), keeping only paths that are existing directories. Not a repo, or git missing:
  `[]`.
- **Files.** Deno FS APIs, not shell argv: `find -printf` and `mv -T` are GNU-only, so today's argv
  fails on macOS. They keep the same contract and `FilesError` codes as the container ones:
  - list: `Deno.readDir` plus `Deno.lstat` per entry (a symlink's `to` from `Deno.stat`, absent
    when broken), sorted and capped as today.
  - read: `stat`, then `not_found` / `not_file` / `forbidden` before opening (never open a FIFO).
    Read up to `max + 1` bytes.
  - create: a file with `Deno.open(path, { createNew: true, write: true })`, a folder with
    `Deno.mkdir` (not recursive).
  - rename: `exists` when `Deno.lstat(to)` succeeds, else `Deno.rename`.
  - delete: `Deno.remove(path, { recursive: true })`, never following a link.
  - write: `mkdir -p` then write. writeText keeps today's hash check, then writes in place
    (truncate, same inode and mode).
  - Error map: `NotFound` → `not_found`, `PermissionDenied` → `forbidden`, `AlreadyExists` →
    `exists`, `NotADirectory` on create → `not_found`.
- **home()** is `Deno.env.get('HOME')` when absolute, else `null`.
- **caps:** `{ stop: true, down: false, containerPaths: false }`.

### D4 — The host source

- **Candidates:** the projects whose effective environment (D5) is `host`.
- **Liveness:** one `herdr session list --json` (in the host's probed environment) gives
  `{"sessions":[{"name","running","session_dir",…}]}`. A candidate whose session is `running` is
  an environment (`onAdd`). One listed but not running is **stopped**, and the project row shows
  `container: 'stopped'`. One not listed is `missing`. Parse with a type guard: a malformed
  answer, or no `herdr`, counts as nothing running (plus one `onError` line when the command
  failed for a reason other than herdr missing).
- **When:** at start, every 5 000 ms (`HOST_POLL_MS`), right after a host `startProject` /
  `stopProject`, and whenever the projects list or an entry's environment changes. A session that
  turns running while its environment exists calls `onLaunch(id)` (what `docker events`
  `exec_start` drives today), so a `no-session` card reconnects when the user runs
  `herdr --session <name>` in a terminal.
- **startProject:** `prepare()`. If `herdrPath` is `''`, throw `herdr is not installed on this
  machine (not on your login shell's PATH)`. Then `runDetached([herdr, '--session', name,
  'server'])` with `cwd = localFolder`, then poll the listing until the session runs, with
  today's `START_SESSION_TRIES × START_SESSION_WAIT_MS` bound. On timeout, throw with the last 10
  lines of `<session_dir>/herdr-server.log`. Take the directory from the listing; never hard-code
  `~/.config/herdr`, which differs on macOS. Output lines go to `onLine` as a container start's do.
- **stopProject:** `herdr session stop <name>`, then `refresh()`. Returns `false` when it was not
  running.
- The host source is **not created** when `projectStarts` is false (`devc web --live`: a page
  agents can write must never get a host shell). It is created under `--live-yolo` and the plain
  server.

### D5 — Which environment a project uses

- `ProjectEntry` gains optional `environment: 'host' | 'container'`. `loadProjects` keeps it (it
  rebuilds entries field by field today, so the field must be added there and to `isEntry`), and
  every list function preserves it. The JSON key is `"environment"`. Absent means unset.
- **Effective environment**, as one pure function in `projects_view.ts`:
  1. a devcontainer (running or stopped) carries the folder → `container`;
  2. else the entry's `environment`, when that kind is available;
  3. else `container` when Docker is available, otherwise `host`.
- **Docker optional.** `requireDocker` no longer fails startup when the host source exists.
  `docker` missing prints `devc web: docker not found on PATH; devcontainers are off` once to
  stderr, and no container source is made. With neither source (`--live` and no docker), it fails
  as today with `docker not found on PATH`.
- A host session left running for a folder that now has a container is not shown (rule 1 wins).
  This is documented in the README, not handled.

### D6 — Protocol

- `containers` entries gain `kind: 'container' | 'host'`. `projects` entries gain
  `environment: 'container' | 'host'` (the effective one). The `projects` message gains top-level
  `environments: EnvironmentKind[]`, the kinds this server can run, in the order
  `['container', 'host']`, each only when present.
- New client message `{ type: 'set_project_environment', id, localFolder, environment }`, where
  `environment` is `'host'` or `'container'`. It writes the entry's `environment` (adding the
  entry unpinned when the folder is unknown to the list) and replies `{ ok: true, result: {} }`.
  Errors: `not_allowed` under `projectStarts === false` (via `projectRefusal`); `has_container`
  (message `<folder> has a container; remove it first`) when rule 1 applies; `bad_request` for an
  unlisted folder or a kind not in `environments`.
- `add_project` takes optional `environment`, with the same validation, stored with the entry.
- `start_project` / `stop_project` / `down_project` go to the source of the project's effective
  environment. `down_project` on a host project → `bad_request` `host projects have no container
  to remove`.
- PR messages are unchanged on the wire. `PrReview` takes its context from the project's
  environment's `pr` backend (D10) instead of a container session plus `readPolicy`.

### D7 — Page

- Project row, container card and menus for a host project:
  - **Start container** reads **Start session**.
  - **Stop container…** reads **Stop session…**, with confirm body `Stops the Herdr session for
    <name>: every terminal in it closes.` and OK label `Stop session`.
  - There is no **Remove container…** button or item.
- A host environment's card header shows muted `this machine` after its name (`span.env-kind`).
- No **Copy container path** on host items (`caps.containerPaths` false: the path is the host
  path).
- The PR toggle shows on a host project's repo cards while its environment runs, as on a
  container's. A host project's not-running message reads `Start the session to see its pull
  request`.
- `no-herdr` on a host card reads `herdr is not installed on this machine`.
- A project's right-click menu offers **Run on this machine** or **Run in a container** (whichever
  is not current) when `environments` has both kinds and rule 1 does not apply. It sends
  `set_project_environment`.

### D8 — Agent status, sessions and running sessions on every platform

**Agent status needs no work.** The working / blocked / done / idle badges, `agent_status`
messages and the task queue's end-of-run detection all come from Herdr
(`pane.agent_status_changed` and the snapshot's `agents`). They work wherever Herdr runs, macOS
included, through the bridge connection D2 already moves onto `Environment`.

**Past sessions** (`SESSIONS_SCRIPT`) uses `stat -c '%Y %n'`, which is GNU-only. Pick the flavor
once at the top of the script: `if stat -c %Y / >/dev/null 2>&1; then mt() { stat -c '%Y %n'
"$@"; }; else mt() { stat -f '%m %N' "$@"; }; fi`, and use `mt` everywhere. **Gotcha:** do not
chain `stat -c … || stat -f …`. GNU `stat` exits non-zero when any one glob match is missing, and
GNU `stat -f` means *filesystem* status, which would print junk lines.

**Running sessions** (`runningAgents()`): which past Claude session is open in which pane, for
Past sessions' running mark and for resume focusing that pane instead of starting a second
`claude --resume`. Today's `RUNNING_SCRIPT` reads `/proc`, which exists only on Linux, so it moves
behind `Environment.runningAgents()`, with the same `R <session id> <HERDR_SESSION>
<HERDR_PANE_ID>` lines and parser:
- **Container, and a Linux host:** today's `RUNNING_SCRIPT`, unchanged.
- **macOS host:** the same loop over `$CLAUDE_CONFIG_DIR/sessions/*.json` (default
  `~/.claude/sessions`).
  - The record's `pid` must be alive (`kill -0`).
  - It must be the same process, not a reused pid: the record's `procStart` must match that pid's
    start time in the format Claude Code writes on macOS. Step 0b measures that format.
  - The pane comes from `ps -E -ww -o command= -p <pid>` (the process's environment, appended to
    its command line), taking the `HERDR_PANE_ID=` and `HERDR_SESSION=` tokens.
  - Pick the flavor with `uname -s` (`Darwin` → this script, else `RUNNING_SCRIPT`).
- A record that fails any check is skipped, as today. Failing closed costs only the running mark.
  Resume then opens a new pane, which is today's behavior for a session nothing runs.

### D9 — Not blocking SSH (design check only)

An SSH environment later would be a third implementation:
- `spawn` / `run` wrap argv as `ssh <dest> -- <quoted argv>`.
- `mounts()` gives `[]`, so every host-path feature already falls back to its `not_mounted` /
  `null` path.
- `files` reuses the current exec-backed (GNU argv) implementation. Keep that implementation
  written against `Environment.run`, not against Docker.
- The source polls `herdr session list --json` over ssh, exactly as D4.
- `runningAgents()` runs the Linux `RUNNING_SCRIPT` over ssh.
- `pr` is the host backend, with `pin` reading `HEAD` and `origin` through `env.run`
  (`git -C <target> …`) instead of `resolvePin`'s host file reads.

What it would still need is git status and `mountedRepos` (both read the host FS) going through
`env.run`. Leave a one-line comment at `loadRepos` and `GitStatusWatch` saying so. Nothing else.

### D10 — The page's PR review on every environment

Everything the page does with a PR today works on host projects too: the file tree, diffs,
Viewed marks, changes since viewed, threads, replies, resolving and pending reviews. The seam is
D2's `PrBackend`. `PrReview` keeps its parsing, caps, listings, viewed history and messages, and
loses only its two container assumptions: `#run` (a `docker exec`) and the grant lookup
(`readPolicy`).

- **Container `PrBackend`:** today's behavior, moved.
  - `pin` is today's `readPolicy(projectKey(localFolder))` line lookup, with `noGrantMessage` as
    its problem.
  - `run` is `docker exec … devc-bridge <command> --repo <target> …`.
- **Host `PrBackend`:** the same built-in recipes, run directly on the host.
  - The recipes are `devc-bridge/builtin/gh-pr-*`, the scripts the host bridge already runs on
    macOS and Linux. Reusing them keeps one copy of the GraphQL.
  - `pin(root)`: `resolvePin(root)` from `@devc-tools/core/bridge.ts` gives `remote` and
    `branch`. Its `reason` (detached HEAD, not a repo, worktreeConfig) is the problem, and so is
    `isGitHubRemote(remote)` failing (`<remote> is not a GitHub remote`). Otherwise the line is
    `{ repo: root, remote, branch, target: root, grants: HOST_PR_GRANTS }`.
  - `HOST_PR_GRANTS` is `['gh-pr-read', 'gh-pr-reply', 'gh-pr-pending-review', 'gh-pr-viewed',
    'gh-pr-resolve', 'gh-pr-request-review']`, in canonical order. `grantsProblem` must return
    `null` for it; a test holds that. No `gh-push`, and no `gh-pr-resolve-copilot`
    (`gh-pr-resolve` is the wider one).
  - **Why all grants:** grants exist to limit what an agent inside a container can make the host
    do. A host project's page already has a host shell with the user's own `gh`, so the grants
    limit nothing there.
  - `run`: before every run, write `serializePolicy({ repos: [line] })` to
    `~/.cache/devc/web-pr-policy/<key>.conf` (dir `0700`, file `0600`, temp file + rename), where
    `key` is `web-` + the first 16 hex chars of SHA-256(`root`). Writing it every time is
    deliberate: the branch can change between runs.
  - Then spawn `<builtins>/<command> --repo <root> …args` with `cwd: '/'` and env = the host's
    probed environment (D3) plus `DEVC_BRIDGE_KEY=<key>` and
    `DEVC_BRIDGE_POLICY_DIR=~/.cache/devc/web-pr-policy`, under the same timeout and output cap
    as `runBridge`.
- **Where the host recipes come from.**
  - From a checkout (`deno task run`): `new URL('../../devc-bridge/builtin/', import.meta.url)`.
  - In the compiled binary: `devc/deno.json`'s `build` and `build:release` add
    `--include ../devc-bridge/builtin`, and the first host PR call materializes the `gh-pr-*`
    files to `~/.cache/devc/web-builtin/` (`0755`). Write a temp dir, then rename it over the old
    one, as `devc-bridge/host/config.ts`'s `materializeBuiltins` does, so a concurrent reader
    never sees half a set.
  - **Gotcha:** `deno compile` serves included files only through `import.meta.url`-relative
    `URL`s. The scripts must be copied out to run, since `bash` cannot exec an embedded file.
- **Needs on the host:** `bash` and an authenticated `gh` (`gh auth login`). A missing `gh`, or
  an unauthenticated one, reaches the page as the recipe's own exit-4 message through today's
  `bridgeMessage`.
- Output is parsed exactly as defensively as today. The recipes print what GitHub sent, which is
  still untrusted text.
- **Dependency:** `devc-web-pr-review-depth` is changing `pr_review.ts` (and adding
  `gh-pr-file-at` and `gh-pr-pending-review`) in this checkout now. Implement D10 after it lands,
  and carry every recipe it adds into the host set.

## Checklist

- [ ] Step 0: in this devcontainer (herdr 0.9.5, no docker), confirm `herdr --session
      devc-my-app-1a2b3c4d server` starts a session that `herdr session list --json` lists
      `running`, and that `herdr session stop devc-my-app-1a2b3c4d` stops it. If the name is
      refused, change D1's slug rule here first.
- [ ] Step 0b, on a Mac (ask the user to run it): with a `claude` running in a host `herdr`
      pane, show `~/.claude/sessions/<pid>.json`'s `procStart`, and compare it with
      `ps -o lstart= -p <pid>` and `ps -o etime= -p <pid>`. Pin down the exact format and
      conversion. Also confirm `ps -E -ww -o command= -p <pid>` shows `HERDR_PANE_ID=`. Write the
      findings into D8 before building the macOS probe.
- [ ] `environment.ts`: `EnvironmentKind`, `EnvExec`, `Environment`, `EnvFiles`,
      `EnvironmentSource`, `DiscoveryHooks` (D2), plus the id and session-name derivation (D1).
- [ ] Container implementation: `containers.ts`'s `Discovery`, `resolveConnection`,
      `resolveHerdrPath`, `inspectMounts` and `project_control.ts` behind `EnvironmentSource` /
      `Environment`. `container_files.ts`'s argv functions become the exec-backed `EnvFiles`,
      taking an `Environment`.
- [ ] `herdr_bridge.ts`, `controllers.ts`, `sessions.ts`, `pr_review.ts` run through
      `HerdrTarget.env` / `Environment`. No `docker` outside the container implementation.
- [ ] `server.ts`: `sessions` holds environments from every source. `loadRepos` uses
      `env.mounts()` + `env.repoSources()`. Project messages route by effective environment.
      Docker is optional (D5).
- [ ] `env_host.ts`: the host environment (D3) and host source (D4).
- [ ] `projects.ts`: optional `environment` kept through load, list functions and write (D5).
- [ ] `projects_view.ts`: effective-environment function. `environment` on projects and
      `environments` on the message (D6).
- [ ] `protocol.ts`: `set_project_environment`, `add_project.environment`, `kind` (D6).
- [ ] `sessions.ts`: portable `mt`. `runningAgents()` on each environment, with the macOS probe
      (D8).
- [ ] `pr_review.ts`: `PrReview` over `PrBackend`. The container backend is today's code; the host
      backend is `pr_host.ts` (D10). The host builtins are embedded (`deno.json` build tasks) and
      materialized.
- [ ] Page (D7): labels, no Remove, `this machine` marker, no Copy container path, the host
      not-running PR message, the Run on / Run in menu item.
- [ ] D9's comments at `loadRepos` and `GitStatusWatch`.
- [ ] Tests (see Validation).
- [ ] `devc/README.md`: the `devc web` usage line says `…for the Herdr sessions in every running
      devcontainer and on this machine`. A "Projects on this machine" subsection under `devc web`
      covers D1's session name, D3's login-shell PATH, D4's polling, D5's rules including the
      rule-1 caveat, D7, and D10's needs (`bash`, authenticated `gh`). The PR review section says
      host projects use the host's `gh` with every PR capability, and why.

## Validation

- [ ] `cd devc && deno task check` passes, with `web/environment.ts`, `web/env_host.ts` and
      `web/pr_host.ts` added to the `check` task's file list.
- [ ] `cd devc && deno task build` succeeds, and the binary's first host PR call creates
      `~/.cache/devc/web-builtin/gh-pr-files` (executable).
- [ ] `cd devc && deno task test` passes, including the new tests below.
- [ ] `cd devc && deno lint && deno fmt --check` pass.
- [ ] `grep -nE "'docker'|dockerExecArgv" devc/web/*.ts` matches only the container
      implementation's files.
- [ ] Unit tests:
  - id and session name for `/home/me/src/My App!` (prefix `devc-my-app-`, 8 hex), for `/` (empty
    slug → `devc-<hex8>`) and for a 40-char basename (slug ≤ 24 chars, no trailing `-`); ids
    stable across calls and distinct per folder.
  - `herdr session list --json` parsing: running, stopped, missing, malformed JSON → nothing
    running.
  - host `EnvFiles` against a temp dir: list (file, dir, symlink to dir, broken link), read
    `not_found` / `not_file` / `forbidden` (chmod 000; skipped as root), create `exists`, rename
    onto an existing name → `exists`, delete a folder, writeText `conflict` and in-place inode
    kept.
  - effective-environment function: all three rules, including entry `host` plus a stopped
    container → `container`.
  - `projects.ts` round-trips `environment`, and `recordUse` / `setPinned` keep it (`projects_test.ts`).
  - `parseClientMessage`: `set_project_environment` valid, bad `environment`, missing
    `localFolder`.
  - `SESSIONS_SCRIPT` runs under `sh` on this Linux host against a fake `$HOME` with one Claude
    `.jsonl`, and lists it.
  - `grantsProblem(HOST_PR_GRANTS) === null`.
  - host `PrBackend` against a temp repo whose `origin` is `https://github.com/o/r.git` on branch
    `feat`:
    - `pin` gives target = root;
    - a detached HEAD gives the problem;
    - a non-GitHub remote gives the problem;
    - `run` with a stub recipe dir (a `gh-pr-files` that prints its env and args) sees
      `DEVC_BRIDGE_KEY`, `DEVC_BRIDGE_POLICY_DIR`, `--repo <root>`, and a `0600` policy file that
      `parsePolicy` reads back as the one line.
  - the real `gh-pr-files` recipe against that temp policy, with a stub `gh` first on `PATH` that
    answers the GraphQL with a fixture, yields a listing `parsePrFiles` accepts. This proves the
    synthesized policy is one the recipes take.
  - macOS running-probe parsing on fixture `ps -E` output (extracting the `HERDR_*` tokens). It
    runs everywhere; only the probe's flavor choice is per-OS.
  - existing `web_container_files_test.ts`, `web_sessions_test.ts`, `web_pr_review_test.ts`, `web_bridge_test.ts`
    and `web_agents_test.ts` still assert the same docker argv through the container implementation.
- [ ] Manual, in this devcontainer (no docker): `cd devc && deno task run web --port 7681
      --no-open` starts and prints the docker-off line. Then on the page:
  - add `/workspaces/tools/devc-tools` (`environment: host`, since there's no Docker);
  - **Start session**, and the card shows `this machine`;
  - open a terminal and run `pwd` → the folder;
  - browse the Files row, open, edit and save a file in the repo;
  - Past sessions lists Claude sessions, and one running in a pane is marked running (Linux
    probe);
  - agent status badges change as a `claude` in a host pane works and finishes;
  - with `gh auth status` good on this machine, a repo card's PR toggle lists the PR of a pushed
    branch with an open PR: diffs show, a file can be marked Viewed and unmarked, and a reply
    posts;
  - **Stop session…** brings the row back to stopped;
  - running `herdr --session <name>` in a shell makes the card come back within 5 s.
- [ ] Manual, on a Mac (ask the user): a host project shows agent status, Past sessions with the
      running mark, and the PR tree with Viewed marks.
- [ ] Manual, on a host with Docker: an existing devcontainer project behaves exactly as before
      (terminals, files, PR toggle, Remove), and **Run on this machine** appears only on a project
      with no container.

## Relevant Files

- `devc/web/environment.ts` (new)
- `devc/web/env_host.ts` (new)
- `devc/web/pr_host.ts` (new)
- `devc/web/containers.ts`
- `devc/web/container_files.ts`
- `devc/web/herdr_bridge.ts`
- `devc/web/controllers.ts`
- `devc/web/sessions.ts`
- `devc/web/pr_review.ts`
- `devc/web/project_control.ts`
- `devc/web/projects_view.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/git_status.ts` (D9 comment only)
- `devc/projects.ts`
- `devc/web/static/sidebar.js`
- `devc/web/static/menus.js`
- `devc/web/static/lib/sidebar.js`
- `devc/deno.json` (`check` task list; `build` / `build:release` `--include ../devc-bridge/builtin`)
- `devc/README.md`
- `devc/tests/web_host_env_test.ts` (new)
- `devc/tests/web_pr_host_test.ts` (new)
- `devc/tests/web_container_files_test.ts`
- `devc/tests/web_sessions_test.ts`
- `devc/tests/web_pr_review_test.ts`
- `devc/tests/web_projects_test.ts`
- `devc/tests/web_containers_test.ts`
- `devc/tests/web_server_test.ts`
- `devc/tests/web_bridge_test.ts`
- `devc/tests/web_agents_test.ts`
- `devc/tests/projects_test.ts`
