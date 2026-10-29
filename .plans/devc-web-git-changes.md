# devc web: changes to commit

Decided with the user on 2026-10-28. First of six plans (see "Git and the trusted host area" in
`PLAN.md`).

## Checklist

- [x] Prerequisite: the user has run `devc-web-host-environments`' manual validation on the Mac
      (done 2026-10-28; only Docker quit and Remove container are left, and neither blocks this).
- [ ] `git_changes.ts`: the reading, its parser and a watch (contracts below).
- [ ] `server.ts`: run the watch over running environments, and put its readings in the
      `projects` message.
- [ ] `projects_view.ts`: `changes` / `changesProblem` on `RepoView`.
- [ ] Page: the repo card's git mark shows the count.
- [ ] Tests, README.

Decided 2026-10-29: untracked files count toward the mark (they are changes to commit, and
`.gitignore` already hides the ones that aren't).

## Goal

A repo card says when its working tree has changes to commit, beside the ahead/behind counts that
`GitStatusWatch` already shows.

## Why not on the host

`git status` runs the repo's own config: `core.fsmonitor`, and `filter.<x>.clean` drivers for
files whose stat changed. No flag turns off every config-named command, so the host must never
run it in a container's repo (`git_status.ts`'s header explains the same rule for ahead/behind).
It runs **in the environment** instead, through `Environment.run`:

- **Container:** a `docker exec` with the container's git. It runs the container's config inside
  the container, which crosses no boundary. The output is display data only.
- **Host project:** a direct run. `env_host.ts` already runs `git -C` in host projects, whose
  pages already have a host shell.

## Contracts

`devc/web/git_changes.ts`:

```ts
/** A repo's working tree against its index and HEAD. */
export interface GitChanges {
  /** Entries with a staged change (porcelain v2 `1`/`2` lines whose X is not `.`). */
  staged: number;
  /** Entries with an unstaged change (Y not `.`). */
  unstaged: number;
  /** `?` lines. */
  untracked: number;
  /** `u` lines. */
  conflicted: number;
}

/** Parses `git status --porcelain=v2 -z --untracked-files=normal` output. Ignores `#` headers. */
export function parseChanges(stdout: Uint8Array): GitChanges;

/** Runs it in `env` at `path` (the repo's path in the environment). Never throws. */
export function readChanges(
  env: Environment,
  path: string,
): Promise<GitChanges | { problem: string }>;
```

- argv: `['git', '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=normal']`,
  `cwd` = the repo's path in the environment (`hostToContainerPath(folder, await env.mounts())`;
  for a host project that is the identity).
- Output cap of 1 MiB and a 10 s timeout. Over the cap, give `{ problem: 'too many changes to count' }`.
  A non-zero exit gives `git status: <first stderr line>`.
- **Only running environments.** A stopped container or host session gives no reading, and the
  field is absent.

A watch beside `GitStatusWatch` (not inside it: that class reads host data for every folder;
this one execs per environment). Its name is the implementer's. It polls every `GIT_POLL_MS`, and
refreshes one environment's repos when one of its agents turns `idle` or `done` (the server
already sees those transitions for activity recording). It runs at most one exec per environment
at a time.

Wire, on `RepoView` (`projects_view.ts`):

```ts
/** Its working tree's changes; absent until read, or while its environment isn't running. */
changes?: GitChanges;
/** Why there is no `changes` for a repo that should have one. */
changesProblem?: string;
```

Page (`static/sidebar.js`'s `gitMark` / `gitSync`): when `staged + unstaged + untracked + conflicted > 0`,
the mark shows `● <n>` (`--blocked` color) before `↑a ↓b`. The tooltip lists the four counts.
`changesProblem` goes in the tooltip. Conflicts take `--danger`.

## Concept boundaries

- `GitStatus` / `GitReading` / `GitStatusWatch` (`git_status.ts`) stay ahead/behind only, read
  on the host from data. Don't add the count there: it's a different data source with a
  different trust rule.
- `RepoView.git` stays as is. `changes` is a sibling field, not nested in `git`.

## Validation

- `cd devc && deno task check && deno task test` pass, with `web/git_changes.ts` in `check`'s list.
- Unit: `parseChanges` on fixture output with each line kind (`1`, `2` rename, `u`, `?`, `!`
  ignored, a path containing a newline, which `-z` makes safe), and on empty output.
- Unit: `readChanges` against a fake `Environment` whose `run` returns fixture bytes, exit 128,
  and output over the cap.
- Manual: a host project and a container project each show `● n` after an edit, and it clears
  after a commit, within one poll or immediately after an agent goes idle.

## Relevant files

`devc/web/git_status.ts` (the rule and the neighbour), `devc/web/environment.ts` (`run`),
`devc/web/server.ts` (the `gitWatch` wiring, around line 817), `devc/web/projects_view.ts`,
`devc/web/static/sidebar.js` (`gitMark`), `devc/README.md` (git status paragraph).
