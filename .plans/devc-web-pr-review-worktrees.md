# devc web: review worktrees for PRs on another remote, with Pull and Reset to PR

Decided with the user on 2026-11-24. Follows `devc-web-worktrees` (archived), `devc-web-git-fetch`
and `devc-web-git-pull`.

## Starting point

The user reviews other developers' PRs in repos where `origin` is the user's fork and `upstream`
is the real repo. The New worktree dialog only knows `origin`: its PR tab runs
`gh pr list --repo <origin's repo>`, which is empty for a fork, and a fork PR's worktree gets
**no upstream**, so its card never offers Fetch or Pull. Once the PR author pushes or rebases, the
only way to see the new commits is to delete the worktree and create it again.

This plan:

1. Lists PRs from the repo they are opened against (the **PR remote**, below).
2. Gives every PR worktree a tracking config that names the PR's head branch, the way
   `gh pr checkout` does. Fetch and Pull then work, and the card finds its PR, because
   `parsePrHead` (`devc-core/bridge.ts`) already reads that config.
3. Adds **Reset to PR**, for when the author rebased and Pull's fast-forward is refused.

Out of scope: listing other remotes' branches in the Branch tab; anything about Push (it stays as
it is, and devc's own push already refuses a branch that tracks another name); GitHub Enterprise
hosts (only what `gitHubRepoOf` accepts today).

## Decisions

### The PR remote

The remote whose GitHub repo the PR tab lists and fetches from, picked from the primary repo's
config (read as a file, as `readRemoteUrl` does), in this order (the same order `gh` itself uses):

1. The remote with `remote.<name>.gh-resolved` = `base` (what `gh repo set-default` writes). When
   several remotes have it, the first one in config order wins.
2. `upstream`, when it has a `url`.
3. `origin`.

There is no fallback past the picked remote. If it is not fetchable (`isFetchableRemote`), the PR
tab shows `<name> is not an https or ssh remote`. If it is not GitHub, it shows
`<name> is not a GitHub repo`. These replace today's `origin …` texts for the PR tab. The Branch
tab keeps using `origin` and keeps its own texts.

### Tracking config written for a PR worktree

The host writes the keys it already writes today (`branch.<b>.remote` and `branch.<b>.merge`), in
place, through `writeConfigInPlace`. As today, it writes them only when `branch.<b>.merge` is not
already set (`hasMerge`). Which values it writes depends on the PR (`gh pr view <n> --repo <PR
remote's repo> --json headRefName,isCrossRepository,state,headRepository,headRepositoryOwner`):

| PR                                                        | `branch.<b>.remote`  | `branch.<b>.merge`  | Remote-tracking ref set at create |
| --------------------------------------------------------- | -------------------- | ------------------- | --------------------------------- |
| Same-repo, PR remote is `origin`, `<b>` = `headRefName`   | `origin`             | `refs/heads/<head>` | `refs/remotes/origin/<head>`      |
| Same-repo, PR remote is `origin`, another `<b>`           | (none: today's rule) | (none)              | none                              |
| Same-repo, PR remote is not `origin` (any `<b>`)          | `<PR remote>`        | `refs/heads/<head>` | `refs/remotes/<PR remote>/<head>` |
| Cross-repo, head repository known (any `<b>`, any remote) | `<head repo URL>`    | `refs/heads/<head>` | none (a URL remote has none)      |
| Cross-repo, `headRepository` null (the fork was deleted)  | (none)               | (none)              | none                              |

Rules for the table:

- `<head repo URL>` is built from `headRepositoryOwner.login` and `headRepository.name`, each
  matching `^[A-Za-z0-9._-]+$` (otherwise the PR gets no upstream). It uses the PR remote's URL
  scheme:
  - an `https://` PR remote gives `https://github.com/<owner>/<name>.git`;
  - `git@github.com:…` or `ssh://git@github.com/…` gives `git@github.com:<owner>/<name>.git`.
- `headRefName` must pass `validBranch`, as today.
- The first row (today's rule) is the only one where the branch name matters. That is because
  devc's Push publishes `origin/<branch>`. A review branch under any other name or remote is never
  pushed by Push: `devc/git_push.ts` refuses with "tracks … devc git pushes a branch under its own
  name".
- The commit comes from `refs/pull/<n>/head` on the PR remote's URL, through its mirror, as it
  does today. Only the remote-tracking ref column above changes from today's hardcoded
  `refs/remotes/origin/<head>`.

### What the page shows and offers

- `WorktreeOptions` gains `prRemote: string | null`, the PR remote's name (`null` when the repo
  has no remotes). `WorktreePr` gains `headOwner: string` (`headRepositoryOwner.login`, `''` when
  unknown). Add `headRepositoryOwner` to the `gh pr list` `--json` fields.
- In the dialog, a PR's `head` (which drives the default branch name and the note) is
  `headRefName` only when `prRemote === 'origin' && !crossRepository`. Otherwise it is `null`,
  so the branch name defaults to `pr-<n>`.
- The PR tab's badge stays `fork` for cross-repo PRs. A non-empty list from a non-origin remote
  shows `<prRemote>` in the list's empty and problem texts, e.g. `upstream: No open pull
  requests`.
- `worktreeNote` for a PR base, once nothing blocks it:
  - an existing local branch: `Checks out <b> as is` (unchanged);
  - the origin same-repo case: `Creates <b> tracking origin/<head>` (unchanged);
  - a same-repo PR on another remote: `Creates <b> tracking <prRemote>/<head>`;
  - a cross-repo PR: `Creates <b> tracking <headOwner>:<head>`;
  - otherwise: `Creates <b> from pull request #<n>, no upstream` (unchanged).

  The note gets `prRemote`, plus `crossRepository`, `headRefName` and `headOwner`, on the PR base.
  Extend `WorktreeBase`'s `pr` variant with those fields.

### Status of a branch that tracks a URL

`parseUpstream` already accepts URL remotes (`trackingRef: null`). `readGitState` already counts
`behind` against the mirror's `<prefix>/upstream`, and `refreshRemote` already fetches it every
5 minutes. Changes:

- `GitStatus.upstream`, the display name:
  - for a URL remote that `gitHubRepoOf` accepts: `<owner>/<name>:<branch>`;
  - for any other URL: `<url> <branch>`;
  - for a named remote: unchanged (`<remote>/<branch>`).
- `GitStatus` gains `foreign?: true`. It is present when the upstream is not `origin`'s branch
  under the same name: `upstream.remote !== 'origin' || upstream.branch !== branch`. Otherwise
  it is absent.

### Fetch and Pull for a URL upstream

The repo has no remote-tracking ref to move, so for a URL upstream:

- **Fetch** (`fetchRepo`) runs only the host-side fetch (`fetchUpstreamProblem`) and answers
  `{ ok: true, updated }`. `updated` is whether the mirror's `<prefix>/upstream` moved. Compare
  `git rev-parse -q --verify` before and after.
- **Pull** (`pullRepo`) fetches on the host, then calls `upstreamBundle`. That function now
  accepts a URL upstream: its prerequisite is `^<prefix>/local` (the branch, which the repo has)
  instead of `^<prefix>/tracking`. When `<prefix>/upstream` is already an ancestor of
  `<prefix>/local`, the result is `{ upToDate: true }`.

  The environment then runs this new script. It writes no ref other than the branch:

  ```sh
  # sh -c SCRIPT pull-url <sha> <local branch>, bundle on stdin (empty when upToDate)
  set -e
  [ "$(git symbolic-ref -q HEAD || true)" = "refs/heads/$2" ] || exit 3
  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  cat > "$tmp"
  if [ -s "$tmp" ]; then git bundle unbundle "$tmp" >/dev/null; fi
  git cat-file -e "$1^{commit}" 2>/dev/null || exit 4
  old=$(git rev-parse HEAD)
  git merge --ff-only --quiet "$1"
  new=$(git rev-parse HEAD)
  printf '%s %s\n' "$old" "$new"
  ```

  `<sha>` is `git rev-parse <prefix>/upstream` in the mirror, and must match
  `^([0-9a-f]{40}|[0-9a-f]{64})$`. Exit 4 answers `the fetched commit is missing: fetch in the
  project and retry`. `git bundle unbundle` writes objects only, and touches no refs.
- A named-remote upstream (including `upstream/<head>` from the table) uses today's
  `FETCH_SCRIPT` and `PULL_SCRIPT` unchanged.

### Reset to PR

A repo card menu item, **Reset to `<upstream>`** (the `GitStatus.upstream` text). It is offered
when `git.foreign && git.behind > 0`, the project is running, and no git request is in flight.
`repoGitItems` order becomes Push, Pull, Reset, Fetch.

- Clicking it asks first, in the page's existing confirm dialog style:
  - title `Reset <branch> to <upstream>?`;
  - body `Moves <branch> to the PR's latest commit.` and, when `ahead > 0`, `Drops <ahead>
    commit(s) not in it (a rebase leaves the old ones here; git's reflog keeps them).`;
  - `Uncommitted changes stay; git stops if one is in the way.`;
  - buttons **Reset** and **Cancel**.
- Protocol: `{ type: 'reset_repo'; id; localFolder; folder }`, answered with `reset_result`. The
  answer has the same shape as `pull_result`: `{ type, id, folder, ok: true, updated } | { …,
  ok: false, problem }`. It is parsed in `protocol.ts`.
- Server (`resetRepoFor`, next to `pullRepoFor`) makes the same checks as Pull:
  - `repoTarget`;
  - no agent working or blocked;
  - a known status;
  - its own rate limit map, as `pullStarts`.

  It also refuses when the status lacks `foreign` (`not a PR branch: reset is for branches you
  don't push`), and when `behind === 0` (`nothing to reset to`). Under `--live`, the page role is
  refused (`resetting a branch is refused under --live`), as `forceRefusal` does. The desktop
  role is allowed. After success, it refreshes `gitWatch` and `changesWatch`, as Pull does.
- `git_fetch.ts` `resetRepo` (one per folder at a time, as `pullRepo`) fetches on the host, then:
  - for a named remote: runs `FETCH_SCRIPT` as Fetch does, then the script below with
    `refs/remotes/<remote>/<branch>` resolved to a SHA in the environment;
  - for a URL remote: sends the bundle as Pull does.

  The script is `pull-url`'s, with `git merge --ff-only --quiet "$1"` replaced by
  `git reset --keep --quiet "$1"`. `--keep` keeps uncommitted changes, and aborts when one is in
  a file the reset changes. Its stderr's first line answers as
  `git reset: <line>`. Exit 3 answers `the branch changed: try again`.

  The bundle's prerequisite for a reset is `^<prefix>/local`, and only when that is an ancestor
  of `<prefix>/upstream`. After a rebase it usually isn't. Then pass the repo's own copies as
  prerequisites, as `git_worktree.ts`'s `prerequisites(mirror, repoFolders)` does for create:
  move that helper to `git_status.ts` and export it.

## Checklist

- [ ] `git_repo.ts`: `prRemote(list)`, picking the PR remote out of `git config -z --list`
      output (the rules above), and a reader over `readConfigList`.
- [ ] `git_worktree.ts`:
  - [ ] `worktreeOptions` lists PRs from the PR remote, and returns `prRemote`;
  - [ ] `WorktreePr.headOwner`;
  - [ ] create fetches `refs/pull/<n>/head` from the PR remote's URL;
  - [ ] create writes the tracking config and remote-tracking ref per the table;
  - [ ] create's result `upstream` is the display name.
- [ ] `git_status.ts`:
  - [ ] the URL display name;
  - [ ] `GitStatus.foreign`;
  - [ ] `upstreamBundle` for URL upstreams;
  - [ ] `prerequisites` moved here and exported.
- [ ] `git_fetch.ts`:
  - [ ] URL-upstream Fetch;
  - [ ] URL-upstream Pull with the `pull-url` script;
  - [ ] `resetRepo` and its script.
- [ ] `protocol.ts`: `reset_repo`, `reset_result`, `WorktreeOptions.prRemote`.
- [ ] `server.ts`: `resetRepoFor`, with the checks above.
- [ ] Page:
  - [ ] `static/lib/sidebar.js` `repoGitItems` adds `reset`;
  - [ ] `static/cards.js` menu item, confirm and request;
  - [ ] `reset_result` handled where `pull_result` is (`cards.js`, `sidebar.js`, `containers.js`);
  - [ ] `static/worktree-dialog.js` and `static/lib/worktree.js`: PR `head`, the notes, and the
        empty and problem texts.
- [ ] Tests (below), and `devc/README.md` (the New worktree dialog's PR tab, and the repo card's
      git items).
- [ ] Rebuild the Mac apps (`devc-desktop`: `npm ci && npm run build:mac`), since
      `containers.js` is bundled.

## Validation

- [ ] `deno task check`, `deno lint`, and `deno fmt --check` on touched files pass.
- [ ] `devc/tests/web_git_repo_test.ts`: `prRemote` picks:
  - [ ] the `gh-resolved = base` remote over `upstream` and `origin`;
  - [ ] `upstream` over `origin`;
  - [ ] `origin` alone;
  - [ ] `null` for no remotes;
  - [ ] the first `gh-resolved` remote when two have it;
  - [ ] not `upstream` when it has no `url`.
- [ ] `devc/tests/web_git_worktree_test.ts` (local bare repos, a stub `gh`, `fetchable` allowing
      `file://`; the scheme rules are tested on the pure URL builder instead), with `origin` a
      fork and `upstream` the base:
  - [ ] options list `upstream`'s PRs, with `prRemote: 'upstream'`;
  - [ ] a cross-repo PR's worktree gets `branch.pr-<n>.remote = <fork URL>` and
        `branch.pr-<n>.merge = refs/heads/<head>`, and no `refs/remotes/*` ref;
  - [ ] a same-repo PR on `upstream` gets `branch.pr-<n>.remote = upstream`, and
        `refs/remotes/upstream/<head>` at the PR's commit;
  - [ ] an origin same-repo PR under its own name is unchanged from today, and under another name
        still gets no upstream;
  - [ ] an existing `branch.<b>.merge` is left alone;
  - [ ] a null `headRepository` gives no upstream.
- [ ] URL builder unit test:
  - [ ] `https://github.com/a/b.git` with `o`/`n` gives `https://github.com/o/n.git`;
  - [ ] `git@github.com:a/b.git` and `ssh://git@github.com/a/b` give `git@github.com:o/n.git`;
  - [ ] an owner with `/` or `:` gives `null`.
- [ ] `devc/tests/web_git_status_test.ts`:
  - [ ] a branch tracking a URL shows `upstream: '<owner>/<name>:<branch>'`, `foreign: true`,
        and the right `behind` after `fetchUpstream`;
  - [ ] `origin/<same name>` has no `foreign`;
  - [ ] `upstream/<b>` and `origin/<other name>` have `foreign: true`.
- [ ] `devc/tests/web_git_fetch_test.ts` (a host environment over temp repos):
  - [ ] URL-upstream Pull fast-forwards and writes no new refs (compare `git for-each-ref`
        before and after, branch excepted);
  - [ ] URL-upstream Fetch reports `updated` once, then `false`;
  - [ ] Reset after the "author" rebases (a force-push to the fork) moves the branch to the new
        tip, keeps an unrelated uncommitted edit, and leaves the old tip in the reflog;
  - [ ] Reset with an uncommitted edit in a changed file fails with `git reset: …` and moves
        nothing;
  - [ ] Reset on a named-remote upstream works the same.
- [ ] Server checks, in `devc/tests/web_server_test.ts` where `pull_repo`'s are. Reset
      is refused:
  - [ ] without `foreign`;
  - [ ] with `behind === 0`;
  - [ ] for the page role under `--live`.

  Allowed for the desktop role under `--live`.
- [ ] `devc/tests/web_worktree_note_test.ts`: the five PR notes above, and the `pr-<n>` default
      when `prRemote !== 'origin'`.
- [ ] `devc/tests/web_sidebar_test.ts`: `repoGitItems` order with `reset`.
- [ ] `devc/tests/web_server_test.ts`: `reset_repo` parses and routes, beside the existing `pull_repo` cases.
- [ ] Live (the user): a repo with `origin` = fork and `upstream` = base.
  - [ ] The PR tab lists upstream's PRs. A fork PR's worktree card shows its PR.
  - [ ] After the author pushes: `↓N`, then Pull.
  - [ ] After the author force-pushes a rebase: Reset to PR, with the confirm text.

## Relevant Files

- `devc/web/git_repo.ts`
- `devc/web/git_worktree.ts`
- `devc/web/git_status.ts`
- `devc/web/git_fetch.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/cards.js`
- `devc/web/static/sidebar.js`
- `devc/web/static/containers.js`
- `devc/web/static/lib/sidebar.js`
- `devc/web/static/worktree-dialog.js`
- `devc/web/static/lib/worktree.js`
- `devc/README.md`
- `devc/tests/web_git_repo_test.ts`
- `devc/tests/web_git_worktree_test.ts`
- `devc/tests/web_git_status_test.ts`
- `devc/tests/web_git_fetch_test.ts`
- `devc/tests/web_worktree_note_test.ts`
- `devc/tests/web_sidebar_test.ts`
- `devc/tests/web_server_test.ts`
