# devc web: fast-forward Pull, and a faded mark for commits not yet fetched

Decided with the user on 2026-10-29. Follows `devc-web-git-fetch`.

## Starting point

`devc-web-git-fetch` built **Fetch**. `↓n` already counts commits the host's mirror fetched from the
remote (every 5 min), so a Fetch never changed it, and nothing showed that the Fetch worked. In
the working tree (uncommitted when this plan was written), `GitStatus` gained `toFetch: boolean`.
The page offers Fetch only while it is true, and the server refreshes `gitWatch` after every
successful fetch. This plan replaces `toFetch` with a count, and adds Pull.

## Checklist

- [ ] `git_status.ts`: replace `GitStatus.toFetch: boolean` with `unfetched: number` (below).
- [ ] `git_fetch.ts`: `pullRepo` (Fetch, then `git merge --ff-only` in the environment).
- [ ] Protocol: `pull_repo` in, `pull_result` out; parsed in `protocol.ts`.
- [ ] Server: `pull_repo` handler with the checks below; refresh both watches after a pull.
- [ ] Page: split `↓` into a normal (pull) mark and a faded (fetch) mark; Pull in the repo card's
      menu and on a click of the normal `↓`; tooltips as below; collapsed rollup unchanged.
- [ ] Tests (unit, sidebar, protocol), README.
- [ ] Manual (the user): the states and clicks under Validation, on a container project and a
      host project.

## Contracts

### `GitStatus` (`devc/web/git_status.ts`)

```ts
export interface GitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  /** Commits to pull: on the newer upstream copy (repo's or mirror's), not in the branch. Unchanged. */
  behind: number;
  gone: boolean;
  /** Of `behind`, those the repo's own remote-tracking ref lacks: a Fetch brings them in. */
  unfetched: number;
}
```

Computed in `readGitState` from the refs it already has (`local`, `fetched`, `tracked`, `against`):

- `0` when there is no upstream, `gone`, `upstream.trackingRef === null` (it tracks a URL), or
  `against` is `tracked` (the repo's own ref is the newer copy, or the same one).
- Otherwise (`against` is `fetched`):
  `git --git-dir=<mirror> rev-list --count <fetched> ^<prefix>/local [^<tracked>]`. Leave out
  `^<tracked>` when the repo has no remote-tracking ref.

So `behind - unfetched` is what is in the repo now, ready to pull. The `toFetch` boolean is removed
everywhere: the server, the page, and the tests.

### `pullRepo` (`devc/web/git_fetch.ts`)

```ts
export type PullOutcome =
  | { ok: true; updated: boolean } // updated: HEAD moved
  | { ok: false; problem: string };

export function pullRepo(
  env: Pick<Environment, 'run' | 'runLimited'>,
  folder: string,
  path: string,
  opts?: MirrorOpts,
): Promise<PullOutcome>;
```

1. `await fetchRepo(env, folder, path, opts)`. On `ok: false`, return its problem unchanged.
   `updated: false` is fine: the repo may already have the commits.
2. Read the local branch (`readBranch`) and the upstream (`readUpstream`) as data, as
   `git_status.ts`'s `locate` does. Detached HEAD → `{ problem: 'detached HEAD' }`. No upstream, or
   `trackingRef === null` → the same problem strings `upstreamBundle` uses. Validate the remote
   with `validRemote`, and both branch names with `validBranch`, using the same problem strings as
   `fetchOnce`.
3. Run `PULL_SCRIPT` in the repo: `env.runLimited({ cmd: pullArgv(remote, upstreamBranch,
   localBranch), cwd: path, env: { GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' } },
   { timeoutMs: 120_000, maxOutput: 4096 })`. Use `runLimited`, not `run`: a checkout of many
   files can pass `run`'s 15 s, and no stdin is needed.

```sh
# sh -c PULL_SCRIPT pull <remote> <upstream branch> <local branch>
set -e
[ "$(git symbolic-ref -q HEAD || true)" = "refs/heads/$3" ] || exit 3
old=$(git rev-parse HEAD)
git merge --ff-only --quiet "refs/remotes/$1/$2"
new=$(git rev-parse HEAD)
printf '%s %s\n' "$old" "$new"
```

Exported as `PULL_SCRIPT` and `pullArgv`, as `FETCH_SCRIPT` and `fetchArgv` are.

Outcomes:

| Result      | Outcome                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| exit 0      | `{ ok: true, updated: old !== new }`                                                                         |
| exit 3      | `{ ok: false, problem: 'the branch changed: try again' }`                                                    |
| other exit  | `{ ok: false, problem: 'git merge: <first non-empty stderr line>' }`, or `'git merge failed'` with no stderr |
| `timeout`   | `{ ok: false, problem: 'git merge: timed out' }`                                                             |
| `too_large` | `{ ok: false, problem: 'git merge: unexpected output' }`                                                     |
| thrown      | `{ ok: false, problem: 'pull: <message>' }` (never throws)                                                   |

One pull per folder at a time, as for fetches: a second call while one runs gets the first's
outcome (a `Map<string, Promise<PullOutcome>>` like `running`). A pull's own fetch shares a fetch
that is already running.

Uncommitted changes are allowed. git refuses a fast-forward that would overwrite a modified file
(`error: Your local changes to the following files would be overwritten by merge:`), and that
comes back as the problem. No `--autostash`, no rebase, no merge commit. Submodules are not
updated.

### Protocol (`devc/web/protocol.ts`)

```ts
// client
| { type: 'pull_repo'; id: string; localFolder: string; folder: string }
// server, to the requester only
| { type: 'pull_result'; id: string; folder: string; ok: boolean; updated?: boolean; problem?: string }
```

Parsed exactly like `fetch_repo` (`id` required, both folders absolute), and `bad_request`
otherwise.

### Server (`devc/web/server.ts`)

`pull_repo` runs these checks in order. The first one that fails is answered as
`pull_result { ok: false, problem }`:

1. `isProjectRepo(...)`, else `'unknown repo'`.
2. A running session for `localFolder`, else `'not running'`.
3. `hostToContainerPath`, else `` `the repo is not ${placeOf(session)}` ``, as for Fetch.
4. **No agent busy:** no pane in that session's snapshot (`snapshotPanes(session.snapshot)`) has
   `agent_status` `'working'` or `'blocked'`, else `'an agent is working in this project: pull
   when it is idle'`. This is checked on the server, not just in the page: under `--live` the
   page's code comes from a checkout an agent can edit.
5. **Fast-forward only:** `gitWatch.statuses.get(folder)` is a `GitStatus` with `ahead === 0`,
   else `'diverged: merge or rebase in the project'`. A `GitProblem` or a missing status →
   `'git status unknown: try again soon'`. `behind === 0` → `'nothing to pull'`. git's
   `--ff-only` still guards a stale status.
6. **Rate limit:** one pull start per folder per `FETCH_INTERVAL_MS` (10 s), in a map separate
   from fetch's. Skip it while a pull of that folder runs; the request shares that pull's outcome.
   Otherwise answer `'pulled moments ago: try again soon'`.

Then `pullRepo(session.env, msg.folder, path)`, and answer. After any `ok: true`, call
`gitWatch.refresh()` and `changesWatch.refreshEnvironment(session.record.id)`. A pull changes the
working tree, so the changes count is re-read too.

Allowed under `--live`. It publishes nothing. It can only fast-forward a listed repo to its own
configured upstream. A page that types into every Herdr pane can already run `git merge` there.
It is allowed wherever `fetch_repo` is, through the same gate.

### Page

`gitSync` / `pushPull` (`devc/web/static/lib/sidebar.js`) build the marks from `ahead`,
`behind` and `unfetched`. `ready = behind - unfetched`:

| State                        | Marks (in order, after `● n` and `↑n`)                               | `pushPull` title                                                                                             |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ready > 0`, `unfetched = 0` | `{dir:'behind', text:'↓<ready>'}`                                    | `<ready> behind <upstream>: pull to fast-forward`                                                            |
| `ready = 0`, `unfetched > 0` | `{dir:'unfetched', text:'↓<unfetched>'}`                             | `<unfetched> new on <upstream>: fetch to bring them in`                                                      |
| both `> 0`                   | `↓<ready>` (`behind`), then `{dir:'unfetched', text:'+<unfetched>'}` | `<ready> behind <upstream>; <unfetched> more on <upstream> to fetch`                                         |
| `ahead > 0` and `behind > 0` | as above, `diverged: true`                                           | the push count, then the line above with `pull to fast-forward` replaced by `merge or rebase in the project` |

Each title still ends with `(as of the last fetch)`, and still starts with
`<branch> → <upstream>:` as it does now, with a push count first when `ahead > 0`
(`<n> to push, …`). `↓` is gone from the title text for the `ready` part: "behind" replaces
"to pull".

Styling (`style.css`): `.git-sync [data-dir='unfetched']` uses the muted text color
(`--text-muted` or the token the sidebar already uses for quiet text), with no other change.
The `behind` color is unchanged.

Clicks (`gitMark` in `cards.js`, repo cards only, as now):

- A `unfetched` mark: Fetch (`fetchRepo`). Its own title: `Fetch: bring <n> new commits into
  <upstream>`.
- A `behind` mark, when `ahead === 0`: Pull. Its own title: `Pull: fast-forward to <upstream>`.
  When `ahead > 0` it is not clickable.
- One spinner per repo: the `fetchingRepos` map holds both fetches and pulls (rename it to fit).
  A click while either runs does nothing.

Repo card menu, top group, in this order, each only when it applies:

- **Pull** (`LABELS.pull = 'Pull'`): `ahead === 0 && behind > 0`, or a pull of it running.
- **Fetch**: `unfetched > 0`, or a fetch of it running.

A failed pull toasts `Pull failed: <problem>`. Success shows nothing: the marks change. Handle
`pull_result` wherever `fetch_result` is handled now (`containers.js`, `onFetchDone`).

`gitRollup` (collapsed containers) adds `behind` and `unfetched` marks into one plain `↓<sum>`,
with the same look as today. `sum` parses the digits of `+<n>` too.

## Concept boundaries

- **Fetch** moves only `refs/remotes/<remote>/<branch>`. **Pull** is Fetch, then a fast-forward
  of the checked-out branch and working tree to that ref. Never a merge commit, rebase, stash or
  force.
- Neither runs git on the host in the repo. The host runs git only in its mirror. The merge runs
  in the project's environment (`docker exec`, or directly for a project on this machine).

## Validation

- [ ] `deno task check` and `deno task test` pass in `devc/`. `deno fmt --check` is clean on the
      touched files.
- [ ] Unit (`tests/web_git_status_test.ts`): with a remote, a clone `work` and a second clone
      `other`, after `other` pushes 2 commits and `fetchUpstream(work)`: `behind 2, unfetched 2`.
      After `git fetch` in `work`: `behind 2, unfetched 0`. After `other` pushes 1 more and
      `fetchUpstream`: `behind 3, unfetched 1`. A branch with no upstream, and a gone upstream:
      `unfetched 0`.
- [ ] Unit (`tests/web_git_fetch_test.ts`, `hereEnv` as the Fetch tests use): `pullRepo` after a
      remote commit moves `work`'s HEAD and working tree (`{ ok: true, updated: true }`). A second
      call gives `updated: false`. A local commit in `work` plus a remote commit →
      `ok: false`, `problem` starting `git merge:`, and HEAD unchanged. A modified tracked file
      the incoming commit also changes → `ok: false`, `problem` starting `git merge:`, and the
      file's content unchanged. `PULL_SCRIPT` run with a local-branch argument other than the
      checked-out one → `'the branch changed: try again'`. The clone's hooks and `core.fsmonitor`
      set to a marker-writing script do not fire during the host steps (the marker is absent
      after `fetchUpstream`, the same check the Fetch test makes).
- [ ] Unit (`tests/web_sidebar_test.ts`): `gitSync` gives the marks and titles in the Page
      table for each of the four states. `gitRollup` of one repo with `↓2` + `+1` and one with
      `↓1` gives a single `↓4`.
- [ ] Unit (`tests/web_server_test.ts`): `pull_repo` parses like `fetch_repo`, and rejects the
      same bad shapes with `bad_request`.
- [ ] Manual, on a container project and a host project, with a second clone pushing to the same
      branch:
  - [ ] Push 2 from the other clone. Within 5 min (or after a `devc web` restart), the card shows
        a faded `↓2` and the menu offers Fetch, not Pull. Click the faded `↓2`: it turns into a
        normal `↓2`, and the menu now offers Pull, not Fetch.
  - [ ] Click `↓2`: the mark goes to `✓`. `git log -1` in the repo shows the pushed commit, and
        the files changed on disk.
  - [ ] With an agent mid-turn in the project, Pull toasts `Pull failed: an agent is working in
        this project: pull when it is idle`.
  - [ ] With a local commit (`↑1 ↓1`), the `↓1` is not clickable and the menu has no Pull.
  - [ ] Under `--live`, Pull works the same.

## Relevant files

- `devc/web/git_status.ts`: `unfetched` replaces `toFetch`
- `devc/web/git_fetch.ts`: `pullRepo`, `PULL_SCRIPT`, `pullArgv`
- `devc/web/git_repo.ts`: `readBranch`, `readUpstream` (read only, unchanged)
- `devc/web/environment.ts`: `runLimited` (read only, unchanged)
- `devc/web/protocol.ts`: `pull_repo`, `pull_result`
- `devc/web/server.ts`: the `pull_repo` handler, and the `toFetch` comment on the fetch handler
- `devc/web/static/lib/sidebar.js`: `pushPull`, `gitSync`, `gitRollup`
- `devc/web/static/cards.js`: `gitMark`, the repo card menu, `canFetch`, `fetchRepo` /
  `onFetchDone` plus their pull counterparts
- `devc/web/static/containers.js`: `pull_result` handling
- `devc/web/static/ui.js`: `LABELS.pull`, the `unfetched` / pull titles
- `devc/web/static/style.css`: the `unfetched` mark
- `devc/tests/web_git_status_test.ts`, `devc/tests/web_git_fetch_test.ts`,
  `devc/tests/web_sidebar_test.ts`, `devc/tests/web_server_test.ts`,
  `devc/tests/web_projects_test.ts` (its `GitStatus` literal)
- `devc/README.md`: the repo card paragraph (↓ / faded ↓ / Pull)
- `.plans/devc-web-git-fetch.md`: note that its `toFetch` was replaced here
