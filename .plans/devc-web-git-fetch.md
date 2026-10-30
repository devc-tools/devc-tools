# devc web: Fetch

Decided with the user on 2026-10-28. Second of six plans (see "Git and the trusted host area" in
`PLAN.md`). After `devc-web-git-changes`.

## Checklist

- [x] `git_status.ts`: a bundle of a folder's upstream ref from its mirror.
- [x] `git_fetch.ts`: fetch one repo (mirror fetch, bundle, `git fetch` in the environment).
- [x] Protocol: `fetch_repo` in, `fetch_result` out.
- [x] Page: **Fetch** on the repo card's right-click, and a click on its `↓n` mark.
- [x] Tests, README.
- [ ] Manual (the user, on the Mac): Fetch on a container project and a host project; the repo's
      `origin/<branch>` moves and Fetch (menu item and `↓n` click) goes away. `↓n` itself does not
      change: it already counts the mirror's commits, and only a pull lowers it.
      (2026-10-29: Fetch runs and shows its spinner on the Mac. Clicking it left `↓n` as it was,
      which is why Fetch is now offered only while the mirror has upstream commits the repo's
      remote-tracking ref lacks: `GitStatus.unfetched > 0`, from `devc-web-git-pull`, which
      replaced the first `toFetch` boolean.)

**2026-10-29:** implemented; everything but the manual check is done. The page was checked headless
against a fake socket (the ↓ click sends `fetch_repo`, the spinner shows, a problem toasts, the
menu leads with **Fetch**). Left: the manual check above, which needs `devc web` restarted from
this checkout. Choices beyond the contracts:

- `upstreamBundle` can also answer `{ upToDate: true, remote, branch }`: it reads the folder first,
  and when the repo's own remote-tracking ref already contains the mirror's commit there is
  nothing to bundle (an empty bundle is refused), and a forced fetch would move the ref back. The
  bundle leaves out what that ref has (`^<prefix>/tracking`), so it holds only the new commits.
- `fetchUpstreamProblem` (beside `fetchUpstream`, which now wraps it) says why the mirror fetch
  failed, for the toast.
- `fetchRepo` takes an optional `MirrorOpts` (tests); the script takes the bundle's ref as `$3`
  and prints the ref before and after, which is how `updated` is known.
- It runs through `Environment.run(x, bundle)`, not `runLimited`: only `run` pipes stdin, and it is
  already bounded (15 s, killed). The output is two hashes, so no cap is needed.
- Only `gitWatch` is refreshed after a fetch that moved the ref: a fetch changes no working tree,
  so the changes watch has nothing new to read.

## Goal

The user can fetch a repo from devc web, and its own `origin/<branch>` ref moves. Fetching
publishes nothing, so the page may start it. The **host still never runs git in the repo**.

## How

1. `fetchUpstream(folder)` (exists): the host fetches the remote into its bare mirror, with the
   host's own credentials.
2. The host writes a bundle of just the upstream branch from the mirror:
   `git --git-dir=<mirror> bundle create - <prefix>/upstream` to memory, capped (see below).
3. The repo's own git, **in its environment**, fetches from that bundle:
   `env.run({ cmd: ['sh', '-c', SCRIPT, 'fetch', remote, branch], cwd: <repo path> }, bundleBytes)`,
   where `SCRIPT` writes stdin to a `mktemp` file, runs
   `git fetch --no-write-fetch-head "$tmp" "+<mirror ref>:refs/remotes/$1/$2"`, and removes
   the file. A container runs its own config in its own repo; a host project already has a host
   shell.

Nothing is mounted or written into the repo by the host.

## Contracts

`git_status.ts`:

```ts
/** A git bundle (bytes) holding `folder`'s upstream branch as fetched into its mirror. */
export function upstreamBundle(
  folder: string,
  opts?: MirrorOpts,
  maxBytes?: number,
): Promise<
  | { bundle: Uint8Array; ref: string; remote: string; branch: string }
  | GitProblem
>;
```

`ref` is the bundle's ref name (`<prefix>/upstream`). `remote` and `branch` come from
`readUpstream` (data). Default `maxBytes`: 256 MiB; over it gives
`{ problem: 'fetch too large for devc web: run git fetch in the project' }`.

`devc/web/git_fetch.ts`:

```ts
export type FetchOutcome =
  | { ok: true; updated: boolean } // updated: the remote-tracking ref moved
  | { ok: false; problem: string };

export function fetchRepo(
  env: Environment,
  folder: string,
  path: string,
): Promise<FetchOutcome>;
```

- `remote` and `branch` are validated before they go into argv: `remote` matches
  `^[A-Za-z0-9._-]+$`, and `branch` passes `git check-ref-format --branch`, run on the host with
  no repo (it reads no config).
- One fetch per folder at a time. A second request while one runs gets the first's outcome.
- Afterwards, call `gitWatch.refresh()` so ahead/behind updates.

Protocol (`protocol.ts`):

```ts
// client
| { type: 'fetch_repo'; id: string; localFolder: string; folder: string }
// server, to the requester
| { type: 'fetch_result'; id: string; folder: string; ok: boolean; updated?: boolean; problem?: string }
```

`folder` must be one of the project's repo folders as the `projects` message lists them
(`projects_view.ts`'s repo-folder check, as `list_dir` uses). The project's environment must be
running: otherwise `problem: 'not running'`. Allowed under `--live`: it publishes nothing and runs
nothing on the host but git in a mirror. Rate limit: 1 per folder per 10 s.

Page: **Fetch** in the repo card's menu. A click on the `↓n` mark fetches too. While it runs the
mark shows a spinner. A problem shows as the existing toast.

## Concept boundaries

- `fetchUpstream` (remote → mirror, periodic) vs `fetchRepo` (mirror → repo, on request). The
  periodic one stays as it is.
- This is not `git pull`: no merge or rebase, no working-tree change.

## Validation

- Check and tests pass, with `web/git_fetch.ts` in `check`'s list.
- Unit, with a temp "remote" repo, a clone, and `MirrorOpts.fetchable` widened to local paths:
  commit to the remote; `fetchUpstream` + `upstreamBundle` + running `SCRIPT` with `sh` in the
  clone moves `refs/remotes/origin/<branch>`; the clone's `.git/hooks` and `core.fsmonitor` set to
  a marker-writing script are never run by the host (the marker is absent after the host steps).
- Unit: the remote/branch validation refuses `-x`, `a b`, `..`.
- Unit: `readGitStatus`'s `unfetched` is above 0 after `fetchUpstream` brings a remote commit, and
  0 once the repo's own ref has it.
- Manual: Fetch on a container project and a host project; the repo's `origin/<branch>` moves and
  Fetch is no longer offered.

## Relevant files

`devc/web/git_status.ts`, `devc/web/git_repo.ts` (`readUpstream`), `devc/web/environment.ts`,
`devc/web/server.ts`, `devc/web/protocol.ts`, `devc/web/projects_view.ts`,
`devc/web/static/sidebar.js`, `devc/README.md`.
