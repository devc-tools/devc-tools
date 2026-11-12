# devc web: cheaper changes-to-commit reads

Decided with the user on 2026-11-12. Follows `devc-web-git-changes` (the `● n` mark), which this
changes only in cost, not in what the page shows.

## Problem (measured 2026-11-12, Docker Desktop on the Mac, gRPC FUSE file sharing)

`GitChangesWatch` reads every running environment's repos every `GIT_POLL_MS` (15 s). In the
deephaven workspace that is ~69 repos and worktrees, read one after another.

- **Each read is slow for no reason.** In `deephaven-core.worktrees/feature2` (16 556 tracked files,
  2 reported changes), `git --no-optional-locks status --porcelain=v2 -z --untracked-files=normal`
  took **76 s**; with `-c core.checkStat=minimal` it took **2 s**. The index was written where the
  container sees different `ino`/`dev`/`ctime` through the file share, so every entry looks
  stat-dirty. Git re-hashes each one, many through `git-lfs filter-process`. `--no-optional-locks`
  stops it from writing the refreshed stat data, so every read pays the full cost again. Both
  entries the slow read reported were false positives: LFS images whose index and worktree hashes
  are identical.
- **Timeouts don't stop git.** `runLimited` kills the host's `docker exec` client at 10 s. The
  `git` it started keeps running in the container (no TTY, so no SIGHUP). Each poll starts more,
  and 7 were seen at once, keeping the container at ~100% CPU and the Docker VM at 3+ cores.
- **Most reads are wasted.** Nearly all repos are unchanged between polls.

The user won't switch Docker Desktop's file sharing implementation. Fix it in devc.

## Checklist

- [ ] `git_changes.ts`: `-c core.checkStat=minimal` in `CHANGES_ARGV` (Contract 1).
- [ ] `git_uncommitted.ts`: the same flag in `GIT`, the read-only prefix (Contract 1).
- [ ] `git_changes.ts`: in-container `timeout` wrapper for container environments, and timeout
      exit codes mapped to the existing problem (Contract 2).
- [ ] `git_changes.ts`: dirty-tracking scheduler replacing the fixed poll (Contract 3).
- [ ] `git_changes.ts`: host-side file watching that marks repos dirty (Contract 4).
- [ ] `server.ts`: pass whether any client is connected. Stage/commit/pull refresh the one repo
      they touched, and agent idle/done marks its environment dirty (Contract 5).
- [ ] Tests in `devc/tests/web_git_changes_test.ts` (see Validation).
- [ ] `devc/README.md`: update the changes-to-commit paragraph (when reads happen: on file
      changes, agent idle/done, devc's own git actions, a 5-minute sweep, and only while a page
      is open).

## Contracts

### 1. Stat checking

`CHANGES_ARGV` becomes:

```ts
['git', '-c', 'core.checkStat=minimal', '--no-optional-locks', 'status', '--porcelain=v2', '-z',
 '--untracked-files=normal']
```

`git_uncommitted.ts`'s `GIT` becomes
`['git', '--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.checkStat=minimal']`.
Leave `GIT_WRITE` unchanged: commands that write the index refresh the stat data themselves.

`core.checkStat=minimal` compares only whole-second mtime, size and file mode. It applies to host
projects too: there it only loses `ctime`/`ino` precision, which a change count doesn't need.

### 2. Timeouts that stop git

- **Container** (`env.kind === 'container'`): run
  `['timeout', '-k', '2', '10', ...CHANGES_ARGV]` and pass `runLimited` `timeoutMs: 13_000`.
  The in-container timeout fires first (SIGTERM at 10 s, SIGKILL 2 s later), so git is gone even
  when devc web exits or the host gives up. The host's 13 s stays as a backstop.
- **Host project** (`env.kind === 'host'`): unchanged. `CHANGES_ARGV` with `timeoutMs: 10_000`.
  `runLimited` kills the process directly.
- Exit **124** (TERM) or **137** (KILL) from the wrapped command, or `r.kind === 'timeout'`, gives
  `{ problem: 'git status: timed out' }`.
- Exit **127** with stderr containing `timeout` gives
  `{ problem: 'git status: no timeout command in the environment' }`. Don't fall back to an
  unwrapped run: it would bring the orphans back.
- Gotcha: `timeout` is coreutils (`/usr/bin/timeout`), checked present in both current
  containers. It is a separate binary, not a shell builtin, so it needs no `sh -c`.
- Gotcha: killing git with SIGKILL is safe here. With `--no-optional-locks` it writes no index
  and creates no `index.lock`. `git-lfs filter-process` exits on its own when its stdin (git)
  closes.

### 3. Scheduling (`GitChangesWatch`)

Repos are tracked one by one (environment id + host folder), not as a whole environment. Each
repo has `dirty`, `lastReadAt`, `lastDurationMs`.

| Constant | Value | Meaning |
|---|---|---|
| `CHANGES_DEBOUNCE_MS` | `2_000` | A dirty repo is read this long after its **last** mark, so bursts of edits coalesce |
| `CHANGES_MIN_INTERVAL_MS` | `15_000` | Floor on the gap between two reads of one repo |
| `CHANGES_SLOW_FACTOR` | `5` | A repo's gap is at least `5 × lastDurationMs` (a timed-out read counts as 13 000 ms, so 65 s) |
| `CHANGES_SWEEP_MS` | `300_000` | Every repo is marked dirty this often, for missed file events |

Rules:

- A repo becomes **dirty** when: it is first listed (environment start, `loadRepos`); a file event
  maps to it (Contract 4); its environment's agent turns `idle`/`done`; or the sweep fires.
- A dirty repo is **due** when `now ≥ lastMark + CHANGES_DEBOUNCE_MS` and
  `now ≥ lastReadAt + max(CHANGES_MIN_INTERVAL_MS, CHANGES_SLOW_FACTOR × lastDurationMs)`.
  A never-read repo has no `lastReadAt` and is due after the debounce alone.
- `refreshFolder(envId, folder)` reads that repo **now**, skipping debounce and gaps. It is only
  for devc's own git actions (Contract 5). If a read of that environment is in progress, it runs
  right after it.
- **At most one exec per environment at a time**, as now. Due repos in one environment are read
  one after another. Environments run side by side.
- Reading clears `dirty`, unless a mark arrives during the read. In that case the repo stays
  dirty with that mark's time.
- **No clients connected:** nothing is read. Marks still accumulate. When the client count goes
  from 0 to ≥1, every dirty repo is due right away, with debounce and gaps skipped once.
- Readings, `onChange` and dropping stopped environments behave as today.
- Drive it with one `setTimeout` per watch, armed for the earliest due time and re-armed after
  every mark, read and client change. No fixed-interval poll. When nothing is dirty, no timer is
  armed except the sweep's.
- `refreshEnvironment(id)` stays public with new meaning: mark every repo of `id` dirty and
  return a promise that resolves once those reads finish. If no client is connected, it
  resolves without reading. `refresh()` does the same for every environment. Existing tests
  calling them keep compiling. Update their timing expectations to the new rules.
- Inject the clock, the watcher factory and the clients-connected check through the constructor
  options, so tests run without real time or a real FS.

### 4. File watching

- One `Deno.watchFs(folders, { recursive: true })` per environment, over its repos' **host**
  folders (`ChangesTarget.folders`). It's rebuilt when the folder set changes and closed when the
  environment goes. These are the host side of the bind mounts, so this sees edits made inside
  the container. Watching runs no git and no repo config, so the "never run the repo's git on the
  host" rule holds.
- An event path maps to the repo whose folder is its **longest** prefix (nested repos/worktrees).
- Paths inside `<folder>/.git/` are ignored except these, which mark that repo dirty:
  - `.git/index`, `.git/HEAD`, `.git/MERGE_HEAD`
  - anything under `.git/refs/`
- An event under `<folder>/.git/worktrees/<name>/` (`index` or `HEAD`) marks dirty every watched
  folder in that environment whose `.git` is a **file** (a linked worktree). Check that once per
  folder with `Deno.lstat` when the watcher is built. This makes a commit inside a worktree show
  up without mapping gitdir paths.
- Gitignored paths (build output, `node_modules`) are **not** filtered. They make a repo dirty,
  and the debounce and gaps limit the cost to one cheap read.
- If `Deno.watchFs` throws, or the watcher's iterator errors, that environment falls back to
  marking all its repos dirty every `GIT_POLL_MS` (15 s), gaps still applying. Log it once.
- Gotcha: on macOS `Deno.watchFs` is FSEvents. Events can come batched and late (up to ~1 s), and
  paths are real paths. Resolve each folder with `Deno.realPath` before prefix matching, since
  `/Users/...` vs `/private/...` symlinks can differ.

### 5. Server wiring (`server.ts`)

- `changesWatch` gets a clients-connected check reading `clients.size > 0`, counting **both**
  `WsRole`s (`page` and `desktop`). It is told when a client is added to `clients` in
  `socket.onopen`, so a 0→1 change triggers the catch-up read. Removal needs no call, since the
  check is read when a repo comes due.
- Known consequence: devc-desktop's Containers pane holds a `desktop` socket whenever the app is
  running, so reads pause only when the app is quit and no browser page is open. That's
  accepted. Dirty-only reads (Contract 3) are the main saving, and the pause is secondary. Don't
  add a visibility protocol in this plan.
- Agent `idle`/`done` (currently `refreshEnvironment(id)`): marks every repo of that environment
  dirty. Debounce and gaps apply.
- `stage_files`/`unstage_files`/`commit_staged` and a successful pull: `refreshFolder(id, folder)`
  for the repo acted on, not `refreshEnvironment`.
- Environment start and `loadRepos`: new repos become dirty (rule in 3). No separate call needed
  beyond what the watch learns from `targets()`.

## Concept boundaries

- `GitStatusWatch` (`git_status.ts`, ahead/behind from host data) is untouched. Its 15 s poll reads
  host files and is cheap.
- The wire (`RepoView.changes`/`changesProblem`) and the page don't change.

## Validation

- [ ] `cd devc && deno task check && deno task test` pass. The known `docker_exec_single_path`
      failure is the only accepted one.
- [ ] Unit: `readChanges` on a container env sends argv starting
      `['timeout', '-k', '2', '10', 'git', '-c', 'core.checkStat=minimal', '--no-optional-locks', 'status', ...]`
      with `timeoutMs: 13000`. On a host env it sends `CHANGES_ARGV` with `timeoutMs: 10000`.
- [ ] Unit: exit 124, exit 137 and `kind: 'timeout'` each give `git status: timed out`. Exit 127
      with stderr `timeout: not found` gives `git status: no timeout command in the environment`.
- [ ] Unit (fake clock, fake watcher): with no marks, advancing 10 minutes reads each repo only
      at the initial read and the two sweeps, never every 15 s.
- [ ] Unit: two marks 1 s apart on one repo cause one read, 2 s after the second.
- [ ] Unit: a repo whose last read took 10 s is not read again within 50 s, even if marked dirty.
- [ ] Unit: a timed-out repo is not read again within 65 s.
- [ ] Unit: `refreshFolder` reads at once, ignoring debounce and gaps, and reads only that repo.
- [ ] Unit: with clients-connected false, marks cause no reads. Flipping to true reads every dirty
      repo once, right away.
- [ ] Unit: never more than one read in flight per environment, while two environments' reads
      overlap.
- [ ] Unit: event-path mapping covers a working-tree file → its repo, longest prefix for nested
      repos, `.git/objects/...` ignored, `.git/index` and `.git/refs/heads/x` → that repo, and
      `.git/worktrees/w/index` → the linked worktrees.
- [ ] Unit: a watcher that throws on start falls back to the 15 s marking.
- [ ] Manual, on the Mac with the deephaven workspace running and devc web open:
      `docker exec devc-deephaven-wksp-<id> pgrep -fc 'git --no-optional-locks status'` prints
      `0` or `1` every time over two minutes, and never more than `1`.
- [ ] Manual: with no edits, `docker stats --no-stream` for the deephaven container shows under
      5% CPU after two quiet minutes. It showed 96% before this change.
- [ ] Manual: an edit in a container repo shows `● n` on its card within ~20 s, and a commit
      through devc clears it at once.
- [ ] Manual: with devc-desktop quit (it hosts the server and its Containers pane holds a socket),
      start the server alone with `devc web --no-open`, open one browser page, then close it.
      Edit a file in a container repo. `pgrep` as above over two minutes shows no `git status`
      runs. Reopening the page shows the updated `● n` within a few seconds.

## Relevant files

- `devc/web/git_changes.ts` — argv, timeout wrapper, scheduler, file watching
- `devc/web/git_uncommitted.ts` — `GIT` prefix
- `devc/web/server.ts` — `changesWatch` construction (~line 1086), agent idle/done (~1278), stage/
  commit (~1739), pull (~1852), `clients` (~782, ~4263/4316)
- `devc/tests/web_git_changes_test.ts` — new and updated tests
- `devc/tests/web_git_uncommitted_test.ts`, `devc/tests/web_git_stage_test.ts` — update any
  asserted read argv for the new `GIT` prefix
- `devc/README.md` — changes-to-commit paragraph
- `.plans/PLAN.md` — status
