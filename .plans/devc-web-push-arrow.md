# devc web: one Push — the ↑N mark and the menu item are the same action

Decided with the user on 2026-11-05. Follows `devc-web-granted-push` and replaces its
`RepoView.pushGrant` and its menu items.

## Starting point

After `devc-web-granted-push`, a repo card has up to two push items (**Push**, the container's
`gh-push` grant, and **Push…**, which asks devc-desktop). Its **↑N** mark is decided separately
from both:

- `↑N` counts commits ahead of the branch's upstream. A branch with no upstream has no mark at all,
  and that includes the usual `gh-push` branch: `gh-push` never writes the repo's refs or tracking
  config.
- A click on `↑N` opens the Commits section, which the card's **Commits** button already does.
- Push shows when nothing is ahead, and is missing when `↑N` shows but no grant applies.
- After a Push, `↑N` does not clear until the git watch's next 5-minute fetch. `gh-push` publishes
  from the bridge's own mirror, so devc web's mirror never sees the push.

Decisions:

- **`↑N` always means what a push would publish**, whether or not this page can push it.
- **One action, one rule.** `↑N` is clickable exactly when the menu has **Push**, and both do the
  same thing. When nothing can push, `↑N` is read-only text, and its tooltip says why.
- **One label: Push.** Whether a confirmation follows depends on the case, not on the user's
  choice, so the label never shows it (no `…`). The confirmation in devc-desktop is a safety net
  for the cases only the user may waive.
- **Push's route:**
  1. The container's own `gh-push` grant applies → `devc-bridge gh-push` in the container at once
     (`devc-web-granted-push`'s handler).
  2. That run exits 3 (a content or default-branch refusal) and devc-desktop is connected → the
     server queues devc-desktop's push request itself. The user confirms or dismisses it in the
     HOST drawer.
  3. No grant applies, but devc-desktop is connected → devc-desktop's push request directly
     (today's **Push…**).
  4. Neither → no Push; `↑N` is read-only.
- **The Commits section opens only from its button.**

## Checklist

- [ ] `GitStatus.ahead` for a branch with no upstream: commits not on any remote branch (below).
- [ ] `fetchAll` and a successful push refresh what the mirror knows of `origin/<branch>`.
- [ ] `RepoView.push` and `RepoView.pushUnavailable` replace `RepoView.pushGrant`.
- [ ] `push_result` gains `asked`; the server escalates exit 3 to a devc-desktop push request.
- [ ] Page: `↑N` clickable or read-only; one **Push** menu item; the toasts below.
- [ ] Tests (below).
- [ ] Docs: `devc/README.md`, `devc-desktop/README.md`, `devc-bridge/README.md`.
- [ ] Manual (the user): the Validation states.

## Contracts

### `ahead` with no upstream (`devc/web/git_status.ts`, `devc/web/git_history.ts`)

`readGitState` for a branch with **no upstream** keeps `upstream: null`, `behind: 0`,
`gone: false` and `unfetched: 0`. It now sets `ahead` to the number of commits on the branch that
are on no remote branch the host knows of. That is exactly the `localTotal` the Commits section
already shows for such a branch (`readCommitHistory`'s no-upstream path):

- The branch is fetched from the folder into the mirror (`+refs/heads/<branch>:<prefix>/local`).
- The repo's remote-tracking refs are copied in (`pushedRefs`'s `+refs/remotes/*:<prefix>/remotes/*`,
  with `--prune`).
- `origin/<branch>` as last found on the remote is `<prefix>/pushed`.
- `ahead = rev-list --count <prefix>/local --not <every ref under <prefix>/remotes/> [<prefix>/pushed]`.

Move the shared part (copy the refs, list the excludes) out of `git_history.ts` into one function
both files call, so the two numbers cannot drift apart. `readGitState` never makes the network
call: the remote check (`checkRemote`) runs only where listed below.

`ahead` stays `0` when the repo has no `origin` remote (`readRemoteUrl(commonDir, 'origin')` is
null): there is nowhere to push.

Branches **with** an upstream are unchanged.

### Refreshing what the mirror knows of the remote

- `GitStatusWatch.fetchAll` (every `GIT_FETCH_MS`): for a folder whose branch has no upstream and
  whose `origin` is fetchable, run the same remote check `pushedRefs` runs with
  `checkRemote: true` (fetch `refs/heads/<branch>` from `origin` into `<prefix>/pushed`; delete it
  on `couldn't find remote ref`). Folders with an upstream keep `fetchUpstream`.
- After a successful push (`push_result` with `ok: true`), before `gitWatch.refresh()`, the server
  refreshes that one folder the same way: `fetchUpstream(folder)` with an upstream, the remote check
  without. So `↑N` clears within one refresh of the toast.

### `RepoView` (`devc/web/projects_view.ts`)

```ts
export interface RepoView extends MountedRepo {
  // …existing fields; `pushGrant` is removed
  /** What Push does: 'now' (route 1, escalating to 2), 'confirm' (route 3). Absent: no Push. */
  push?: 'now' | 'confirm';
  /** Why there is no Push although `git.ahead > 0`: the read-only ↑N's tooltip. */
  pushUnavailable?: string;
}
```

Both are computed on the server. At most one is present, and neither is present when `git` is
null/absent or `git.ahead === 0`. With `git.ahead > 0`, in this order:

1. `git.upstream !== null && git.upstream !== 'origin/' + git.branch` → `pushUnavailable`:
   `` `tracks ${git.upstream}; Push publishes origin/${git.branch}` ``. Both `gh-push` and
   `devc git push` publish `refs/heads/<branch>` on the repo's origin, so the count would not
   describe the push.
2. The `devc-web-granted-push` conditions hold (container running, its policy line for the repo
   grants `gh-push`, the line's `branch` is the checked-out branch) → `push: 'now'`.
3. devc-desktop is connected (`--desktop-channel`, i.e. the server has a desktop token) →
   `push: 'confirm'`.
4. Otherwise → `pushUnavailable`, the first that applies:
   - a line grants `gh-push` but the container is not running → `start the container to push`
   - a line grants `gh-push` for another branch →
     `` `${git.branch} is not the pinned branch ${line.branch}` ``
   - otherwise → `needs a gh-push grant (on the host: devc up --bridge-allow gh-push) or devc-desktop`

A host project goes by steps 1, 3 and 4 (its last reason applies).

### `push_result` and escalation (`devc/web/server.ts`, `devc/web/granted_push.ts`)

```ts
| { type: 'push_result'; id: string; folder: string; ok: true; message: string }
| { type: 'push_result'; id: string; folder: string; ok: false; problem: string; asked?: true }
```

`pushRepo` reports the exit code of a failed `gh-push` run to its caller. Internal shape is at
the implementer's discretion. When the run exits **3** and the server has a desktop token, the
server calls `desktopRequests.add('push', localFolder, folder)`, as `request_push` does:

- `added.ok` → answer `ok: false`, `problem` (gh-push's line), `asked: true`.
- not `ok` (a queue limit) → answer `ok: false` with
  `` `${problem}; and devc-desktop could not be asked: ${added.problem}` `` (no `asked`).

Exit 3 with no desktop token, and every other failure, answer as now. The handler's checks are
unchanged (`devc-web-granted-push`). A `push_repo` for a repo whose `push` is `'confirm'` is refused
there as before (`not granted: …`). The page sends `request_push` for that route, never
`push_repo`.

### Page (`devc/web/static/`)

- **Menu:** one **Push** item (`LABELS.push`), first among the git items, shown exactly when
  `repo.push` is set:
  - `'now'` → `push_repo` (spinner, as `devc-web-granted-push`)
  - `'confirm'` → `requestPush(localFolder, folder)` (unchanged: `appActions.push` in
    devc-desktop's pane, else `request_push`)

  The separate **Push…** item is removed. `repoGitItems` becomes `push`, `pull`, `fetch`.
- **`↑N` (`gitMark`)**: with `repo.push`, a button that does exactly what the menu item does. Its
  title is `` `Push: publish ${branch} to origin` ``. Without it, plain text (no `role="button"`,
  no click), whose title is the sync title plus a line `` `Push unavailable: ${pushUnavailable}` ``
  when that is set. It never opens the Commits section. The `↓N`, faded `↓N` and `+N` marks are
  unchanged.
- **No upstream:** `pushPull` (`static/lib/sidebar.js`) shows `↑N` for `upstream: null` when
  `ahead > 0`, titled `` `${ahead} to push: on no remote branch` ``. With `ahead === 0` and no
  upstream it shows nothing, as now. `gitRollup` sums these `↑` counts like any other.
- **Toasts** on `push_result`:
  - `ok` → `toast(message)` (as now)
  - `asked` → ``toast(`needs your confirmation in devc-desktop: ${problem}`)``
  - otherwise → ``errorToast(`Push failed: ${problem}`)``

## Validation

- [ ] `cd devc && deno task check` passes.
- [ ] `cd devc && deno task test`: no new failures. (`docker_exec_single_path_test` fails on an
      ignored `devc-core/dist/` build output, which is unrelated.) New or changed tests:
  - [ ] `readGitState`, no upstream, with a local `origin`: a branch with 2 commits on no remote
        branch → `ahead: 2`. After copying the branch to `origin` and running the remote check →
        `ahead: 0`. With no `origin` remote → `ahead: 0`. A branch with an upstream: counts
        unchanged.
  - [ ] The Commits section's `localTotal` equals `ahead` for the same no-upstream repo.
  - [ ] `RepoView.push` / `pushUnavailable` for each case in order: an upstream mismatch, `'now'`,
        `'confirm'`, each of the three unavailable reasons (exact strings), and neither when
        `ahead === 0`.
  - [ ] Escalation: exit 3 with a desktop token → `asked: true`, and one pending `push` request
        for the folder. Exit 3 without one → no `asked`, nothing queued. Exit 4 with one → no
        `asked`, nothing queued. A full queue → the combined problem string.
  - [ ] Sidebar: `pushPull` with `upstream: null, ahead: 3` → one `↑3` mark; with `ahead: 0` →
        null. `repoGitItems` order `push`, `pull`, `fetch`.
- [ ] `deno fmt --check` on every touched file.
- [ ] Manual (the user):
  - [ ] Granted container, pinned branch with no upstream: `↑N` shows after a commit. A click
        pushes with no confirmation, and `↑N` clears within ~15 s of the toast.
  - [ ] Same container, a commit under `.github/workflows/`, inside devc-desktop: clicking `↑N`
        shows `needs your confirmation in devc-desktop: …`, and the HOST drawer has the push card.
  - [ ] No grant, inside devc-desktop: `↑N` click and menu Push both open the drawer's push card.
  - [ ] No grant, plain browser: `↑N` is not clickable, its tooltip gives the reason, and the menu
        has no Push.
  - [ ] **Commits** button opens the section; `↑N` never does.

## Relevant Files

- `devc/web/git_status.ts` — `readGitState` no-upstream `ahead`; `fetchAll`'s remote check.
- `devc/web/git_history.ts` — the shared ref copy and excludes, moved out and called from both.
- `devc/web/granted_push.ts` — the failed run's exit code; the `push` / `pushUnavailable` rules.
- `devc/web/projects_view.ts` — `RepoView.push`, `pushUnavailable`; drop `pushGrant`.
- `devc/web/server.ts` — the route map, escalation, the post-push refresh of the folder.
- `devc/web/static/lib/sidebar.js` — `pushPull` no-upstream `↑N`; `repoGitItems`.
- `devc/web/static/cards.js` — `gitMark` clickable/read-only `↑N`; the single Push item; toasts.
- `devc/web/static/ui.js` — `LABELS`: the `↑N` titles; `requestPush` stays for the toast label.
- `devc/tests/web_git_status_test.ts`, `devc/tests/web_git_history_test.ts`,
  `devc/tests/web_granted_push_test.ts`, `devc/tests/web_projects_test.ts`,
  `devc/tests/web_sidebar_test.ts`.
- `devc/README.md` — the devc web git paragraph (↑N, Push, Commits); the `--desktop-channel`
  paragraph (Push… gone; Push may queue a push request).
- `devc-desktop/README.md` — § Host actions: requests now come from Push (no grant, or an
  escalated refusal), not a Push… item.
- `devc-bridge/README.md` — § Publishing a branch: the devc web sentence (refusals escalate to
  devc-desktop).
