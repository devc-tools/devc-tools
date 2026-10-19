# devc-web-worktree-git-marks

Worktree rows under **Repos › some-repo** in `devc web`'s sidebar show no push/pull mark (`↑n`,
`↓n`, `✓`, `•`). They should show one, as their repo's row does. And when a status can't be
read, the row should say so instead of showing nothing.

## Why the marks are missing

Measured in this devcontainer against the user's own repos (`/workspaces/*.worktrees/*`), with
`readGitStatus` and the same `git fetch` it runs:

- `readGitStatus` fetches the folder's branch **from the folder** into a host-owned bare mirror,
  one per remote URL (`web/git_status.ts`), through `git()`, whose timeout is **10 s**.
- Into a cold (empty) mirror, that fetch copies the branch's whole history. For
  `web-client-ui.worktrees/pr-review` it took **12.3 s**; for an `iris` worktree, over 120 s.
  The 10 s timeout kills it, and git throws away the partial pack, so the next pass (15 s later)
  starts from nothing again. The fetch never gets through and the status is `null` for good.
  Once the mirror has the objects, the same kind of fetch takes 0.8 s.
- Worktrees with **no upstream** skip the fetch and do get `•`. Those with an upstream get
  `null`. That is what the measurements show.
- `fetchAll` (the remote fetch, 60 s) can't save it: it reads the folder status first, and for a
  big repo a cold remote fetch also misses 60 s.
- What the page shows: during the first pass (one 10 s timeout per folder, twice when the
  remote-tracking fetch falls back), `git` is absent, so the row has no mark. The watch only
  calls `onChange` at the end of a pass. Once the pass is done, `git: null`, and `repoRows`
  hides every row after the first whose `git` is `null`. Neither state says what went wrong.

One possible cause can't be checked from a container: a host git older than 2.48 refuses every
repo that has `extensions.relativeworktrees` (all of the user's repos with worktrees have it,
set by `worktree.useRelativePaths`), and that would fail the fetch from the folder for the repo
and its worktrees alike. This plan doesn't work around it. It makes that failure **visible**:
the row's tooltip gets git's own error line (see "A status that can't be read").

## Checklist

- [x] `git_status.ts`: the two fetches **from the folder** use a 10-minute timeout; every other git call keeps 10 s
- [x] `git_status.ts`: a status that can't be read carries a reason (`gitProblem`): `detached HEAD`, `git fetch: timed out`, or `git <subcommand>: <git's first stderr line>`
- [x] `GitStatusWatch`: `onChange` after each folder whose status (or reason) changed, not once per pass
- [x] `projects_view.ts`: `RepoView.gitProblem?: string`, set from the watch
- [x] `sidebar.js`: `gitSync(git, problem)` gives a muted `?` mark (`dir: 'unknown'`) with the reason as its tooltip; `gitRollup` counts `unknown` as quiet
- [x] `app.js`: repo rows hidden only when `git === null` with no `gitProblem`; every `gitSync` call passes `r.gitProblem`
- [x] `style.css`: `[data-dir='unknown']` muted, like `synced` / `local`
- [x] Tests in `web_git_status_test.ts`, `web_sidebar_test.ts`, `web_projects_test.ts`
- [x] `.plans/devc-web.md`: the `projects` row of the protocol table documents `gitProblem`
- [ ] Verify (below) and ask the user to check it in their open tab

## Design

### Fetching from the folder

In `readGitStatus`, the two `inMirror(...FETCH_FLAGS, folder, …)` calls (branch plus
remote-tracking ref, and the branch-only fallback) run with
`LOCAL_FETCH_TIMEOUT_MS = 10 * 60_000`. The timeout only guards against a hang. A local fetch has
no network or prompt to wait on, and a fetch that gets killed makes no progress, so a short limit
just fails forever. `for-each-ref`, `merge-base`, `rev-list`, `update-ref` and `init` keep the
10 s default. `fetchUpstream` keeps `FETCH_TIMEOUT_MS` (60 s).

`MirrorOpts` gains `localFetchTimeoutMs?: number` (default `LOCAL_FETCH_TIMEOUT_MS`) so a test
can force a timeout.

Worktrees of one repo share its object store and its mirror (same remote URL). After the first
of them (usually the primary, which comes first) seeds the mirror, the rest are incremental. A
cold seed now holds up the pass that runs it, up to 10 minutes. That's acceptable because it
happens once per mirror, and the per-folder `onChange` below means already-read repos show their
marks while it runs.

### A status that can't be read

`RepoView` (`projects_view.ts`) gains `gitProblem?: string`. It is present only when `git` is
`null` and the folder **is** a repo (`resolveRepo` succeeded). A folder that is no repo stays
`git: null` with no `gitProblem`. The exact strings:

| Case                                                                                                                                                                                                        | `gitProblem`                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HEAD is detached (`readBranch` → `null`)                                                                                                                                                                    | `detached HEAD`                                                                                                      |
| A git call was killed by its timeout (`AbortSignal.timeout` fired: `signal.aborted` after `Deno.Command.output()`, which **resolves** with a failed status when the signal kills git, rather than throwing) | `git <subcommand>: timed out`, e.g. `git fetch: timed out`                                                           |
| A git call exited non-zero                                                                                                                                                                                  | `git <subcommand>: <first non-empty line of its stderr, trimmed>`, or `git <subcommand> failed` when stderr is empty |
| The mirror couldn't be created (`mirrorFor` → `null`)                                                                                                                                                       | `could not create the git mirror`                                                                                    |
| `rev-list` printed something that isn't two integers                                                                                                                                                        | `git rev-list: unexpected output`                                                                                    |

`<subcommand>` is the first argument after any `--git-dir=…`: `fetch`, `rev-list`, and so on.
Read git's stderr instead of discarding it: `stderr: 'piped'` in `git()`, and keep the
first line. For a fetch where the remote-tracking ref falls back to branch-only, only a failure
of the **fallback** is a problem. The first fetch failing is the normal "no remote-tracking ref"
path. If the first one timed out, though, skip the fallback and report the timeout: a repo that
timed out once will time out again, and retrying doubles the wait.

How the watch holds the reason is up to the implementer (for example, `readGitStatus` returning
`GitStatus | {problem: string} | null`, with `statuses` keeping `{git, problem}`). Some things
are fixed:

- `GitStatusWatch`'s `read` option (tests inject it) can return a problem.
- A change in the problem alone counts as a change.
- `buildProjects` sets `gitProblem` on exactly the repos that have one.

`server.ts` passes the watch's map to `buildProjects` as today, with whatever type that map now
has.

### Broadcasting while a pass runs

In `GitStatusWatch.#pass`, call `onChange` right after each folder whose stored value changed,
and once after dropping folders no longer listed (if any were dropped). A pass where nothing
changed still calls it zero times. `refresh`'s coalescing (`#again`) stays as it is.

### Page

- `gitSync(git, problem)` (`static/lib/sidebar.js`): when `git` is `null`/`undefined` and
  `problem` is a non-empty string, return
  `{marks: [{dir: 'unknown', text: '?'}], diverged: false, title: \`git status unavailable: ${problem}\`}`.
  Otherwise, behave exactly as today (`problem`ignored when`git` is set). Update its doc
  comment.
- `QUIET_DIRS` becomes `['synced', 'local', 'unknown']`. In `gitRollup`'s all-quiet branch, the
  single mark is `✓` (`synced`) if any repo is synced, else `•` (`local`) if any is local, else
  `?` (`unknown`). The title is still one `name: title` line per repo. `gitRollup` passes each
  repo's `r.gitProblem` to `gitSync`.
- `app.js` `repoRows`: the filter becomes `i === 0 || r.git !== null || !!r.gitProblem`. A
  worktree that can't be read keeps its row and shows `?`. The repo row's mark is
  `gitMark(gitSync(r.git, r.gitProblem))`. Update the function's doc comment. Leave the task
  dialog's repo filter (`projectRepos(localFolder).filter(...)` near the tasks code) unchanged.
- `style.css`: add `.git-sync [data-dir='unknown']` to the muted `synced` / `local` rule, and
  mention `?` in that rule's comment.

## Validation

- [x] `cd devc && deno task check && deno task test` passes
- [x] `cd /workspaces/tools/devc-tools && deno fmt --check` passes
- [x] `web_git_status_test.ts`: with `localFetchTimeoutMs: 1`, `readGitStatus` on a repo whose branch tracks an upstream returns the problem `git fetch: timed out`. With the default it returns a status. A detached-HEAD repo gives `detached HEAD`. A folder that is no repo gives `null` with no problem
- [x] `web_git_status_test.ts`: a fetch from a folder that fails (for example, a repo whose `refs/heads/<branch>` was deleted after HEAD was set) gives a problem starting `git fetch:` followed by git's stderr line
- [x] `web_git_status_test.ts`: `GitStatusWatch` with two changed folders calls `onChange` twice in one `refresh()`. A pass with no change calls it zero times. A change in the problem alone counts. Update the existing "reports only changes" test's expected counts to match
- [x] `web_sidebar_test.ts`: `gitSync(null, 'detached HEAD')` → `{marks: [{dir: 'unknown', text: '?'}], diverged: false, title: 'git status unavailable: detached HEAD'}`. `gitSync(null)` and `gitSync(undefined, '')` → `null`. `gitRollup` of an unknown repo and a local one → `•`. Of only unknown repos → `?`. Of an unknown repo and one with `↑2` → `↑2`
- [x] `web_projects_test.ts`: `buildProjects` sets `gitProblem` on the repo with one and leaves it off the others
- [x] In this container, with a fresh mirror dir: `readGitStatus('/workspaces/web-client-ui.worktrees/pr-review', {root: <empty scratch dir>})` returns a `GitStatus` (it returned `null` before this change). Done: 15.2 s cold, then `web-client-ui` 23.0 s and a second worktree 0.2 s, all with a status. The problem tests call `readGitState`; `readGitStatus` keeps returning `GitStatus | null`
- [ ] Ask the user to check in their open tab (needs `--live-yolo` or an updated `devc`):
  1. Stop `devc web`, move `~/.cache/devc/web/git` aside, and start it again. Within a few minutes, every worktree row under **Repos › <repo>** shows `✓`, `•` or arrows, and repos that are already read show marks before the slow ones finish.
  2. A worktree that still can't be read shows a muted `?`. Its tooltip names the reason, for example `git status unavailable: git fetch: fatal: unknown repository extension found: relativeworktrees` (meaning the host git is older than 2.48).
  3. A detached worktree keeps its row, with `?` and `detached HEAD`.

## Relevant Files

- `devc/web/git_status.ts` — local-fetch timeout, problems, per-folder `onChange`
- `devc/web/projects_view.ts` — `RepoView.gitProblem`, `buildProjects` input type
- `devc/web/server.ts` — the `gitWatch.statuses` argument to `buildProjects`, if its type changes
- `devc/web/static/lib/sidebar.js` — `gitSync(git, problem)`, `QUIET_DIRS`, `gitRollup`
- `devc/web/static/app.js` — `repoRows` filter and mark
- `devc/web/static/style.css` — `unknown` mark
- `devc/tests/web_git_status_test.ts`
- `devc/tests/web_sidebar_test.ts`
- `devc/tests/web_projects_test.ts`
- `.plans/devc-web.md` — `projects` row of the protocol table: `repos: [{folder, name, worktreeOf, git?, gitProblem?}]`, with `gitProblem` described as "why `git` is `null` for a folder that is a repo (`detached HEAD`, a timed-out or failed git call)"
- `.plans/PLAN.md`
