# devc web: Push with no confirmation, under the container's own `gh-push` grant

Decided with the user on 2026-11-05.

## Starting point

`devc web`'s only push is **Push…** on a repo card's menu. It is shown only with
`--desktop-channel`, and it sends `request_push`: devc-desktop works out the plan
(`devc git push-plan`), and the user confirms it in the HOST drawer. That push runs `gh-push` in
**user mode**, which waives two refusals (the default branch, workflow changes), so it needs a
human.

A container granted `gh-push` (`devc up --bridge-allow gh-push`, or a default grant) can already
push its pinned branch with no human: its agent runs `devc-bridge gh-push`. This plan lets the page
run that same command. It runs **in the container**, as `pr_review.ts` runs `gh-pr-*`. So the page
gains no reach: it can already type into a terminal in that container. The bridge applies the
grant and every agent-mode refusal: the default branch, workflow and action changes, LFS pointers,
a non-fast-forward, and a moved branch (it pushes the SHA it checked).

Nothing changes in the policy format, in `gh-push`, in the bridge, or in devc-desktop.

## Checklist

- [x] `RepoView.pushGrant` (below), computed on the server and sent in every `projects` message.
- [x] Protocol: `push_repo` in, `push_result` out; parsed in `protocol.ts`.
- [x] Server: `push_repo` handler with the checks below; `gitWatch.refresh()` after a success.
- [x] Page: a **Push** item in the repo card's menu while `pushGrant`; the card's spinner while a
      push runs; a toast with the outcome. **Push…** (ask devc-desktop) stays as it is.
- [x] Tests: protocol parsing, the server handler's checks and outcomes, `pushGrant`, the menu
      items (sidebar test).
- [x] Docs: `devc/README.md`, `devc-bridge/README.md`, `devc-desktop/README.md` (below).
- [ ] Manual (the user): the Validation states, against a real container and GitHub repo.

**2026-11-05:** `devc-web-push-arrow` replaced this plan's page side. `RepoView.pushGrant` became
`push` / `pushUnavailable`, the separate **Push…** item is gone, and `↑N` is the same action as
Push. Run the manual checks in that plan instead of the menu checks below.

**2026-11-05:** implemented; everything but the manual check is done (`deno task check`,
`deno fmt --check` on every touched file, and the new and affected tests). The full
`deno task test` has one failure that has nothing to do with this plan:
`docker_exec_single_path_test` trips on `devc-core/dist/container.d.ts`, an ignored build output
from 2026-11-02. Choices beyond the contracts:

- The checks and the run live in `devc/web/granted_push.ts` (`pushRepo`, with injected deps).
  The server's `pushRepoFor` only wires them up and answers `push_result`, so the handler tests
  are in `devc/tests/web_granted_push_test.ts` instead of `web_server_test.ts`.
- `GitStatusWatch` gains `onPass` (after every pass, changed or not). The grant map is recomputed
  there and when a container is removed. A sequence number drops stale results.
- `RepoView.pushGrant` is typed `true` (present or absent). `buildProjects` also requires the
  project to be running.
- The menu's git items come from `repoGitItems` (`static/lib/sidebar.js`), so the sidebar test
  covers the order: Push, Pull, Fetch, Push….
- A push of a branch with no upstream still shows the card's spinner.
- `web/granted_push.ts` is added to `devc/deno.json`'s `check` list.

## Contracts

### `RepoView.pushGrant` (`devc/web/projects_view.ts`)

```ts
export interface RepoView extends MountedRepo {
  // …existing fields
  /** Push runs `devc-bridge gh-push` in the container with no confirmation: see below. */
  pushGrant?: boolean;
}
```

`true` only when all of the following hold. Otherwise the field is absent, never `false`, so
existing tests' expected objects stay valid:

1. The project's environment is `container` and its container is running (a session exists).
2. `readPolicy(await projectKey(localFolder), { home })` (`devc/bridge.ts`) returns
   `kind: 'present'`.
3. Some line's `repo`, with trailing slashes dropped (as `containerPrBackend.pin` does), equals the
   repo's `folder`, and that line's `grants` include `'gh-push'`.
4. That line's `branch` equals the repo's `git.branch` (the checked-out branch, from `gitWatch`).
   Exact string compare.

Read the policy files on the server, never from the container. Recompute on every `gitWatch`
refresh and whenever a session is added or removed, then broadcast `projects` if any value changed.
Don't read policy files on every `projects` broadcast: keep the last computed map and pass it to
`buildProjects` as a new trailing parameter. A malformed or unreadable policy counts as no grant,
and must not throw.

Host projects never get `pushGrant`: their `PrBackend` writes its own policy, and this plan relies
on a grant the user gave at `devc up`.

### Protocol (`devc/web/protocol.ts`)

In, beside `pull_repo`:

```ts
/** Runs `devc-bridge gh-push --repo <target>` in the repo's container. Answered with `push_result`. */
| { type: 'push_repo'; id: string; localFolder: string; folder: string }
```

Parsed like `pull_repo`: `id`, `localFolder` and `folder` must be non-empty strings, and no other
field is read.

Out, sent only to the requester, shaped like `pull_result`:

```ts
| { type: 'push_result'; id: string; folder: string; ok: true; message: string }
| { type: 'push_result'; id: string; folder: string; ok: false; problem: string }
```

`message` is `gh-push`'s last non-empty stdout line, trimmed and cut to 300 characters
(`pushed: <branch> at <short> to <remote> (<repo>)` or `up to date: …`). If stdout has no
non-empty line, it is `pushed`.

### Server handler (`devc/web/server.ts`, `pushRepoFor`)

Checks, in this order. The first that fails answers `ok: false` with exactly this `problem`.
Everything is re-checked here and never trusted from the page: under `--live`, the page's code
comes from a checkout agents can edit.

1. `repoTarget(msg)` fails → its problem (`unknown repo`, `not running`, or not mounted).
2. `session.env.kind !== 'container'` →
   `push from a project on this machine: use Push… (devc-desktop)`.
3. Re-read the policy as in `pushGrant` steps 2–3 (fresh, never the cached map). There is no line
   for `msg.folder`, or its grants lack `gh-push` →
   `not granted: on the host, devc up --bridge-allow gh-push`.
4. `gitWatch.statuses.get(msg.folder)` is missing or a problem → `git status unknown: try again
   soon`.
5. The status's `branch !== line.branch` →
   `<branch> is not the pinned branch <line.branch>: use Push… (devc-desktop)`.
6. Rate limit: one start per folder per `FETCH_INTERVAL_MS`, in its own `pushStarts` map, with
   `startAllowed`. A request while a push of that folder is running shares that push's outcome, as
   `pull_repo` does → `pushed moments ago: try again soon`.

No ahead/behind check: a pinned branch that was never pushed has no upstream, and `gh-push` itself
reports `up to date`. No agent-working check either: a push changes no working tree, and `gh-push`
pushes the SHA it checked.

Then run `session.env.pr.run('gh-push', line.target, [], { timeoutMs: 900_000, maxOutput: 65_536 })`.
That is `containerPrBackend.run`, i.e. `devc-bridge gh-push --repo <target>` in the container.
**Don't call `pr.pin()`**: it requires `gh-pr-read`, and push must not.

The 900 s timeout is because `gh-push` runs several network steps, each with a limit of up to
300 s (`DEVC_BRIDGE_GIT_TIMEOUT`), and the bridge client has no timeout of its own.

Outcomes:

- `kind: 'exit'`, `code === 0` → `ok: true` with `message` as above; then `void gitWatch.refresh()`.
- `kind: 'exit'`, other code → `ok: false`, `problem: bridgeMessage(stderr, code)` (`pr_review.ts`,
  already exported; it caps at 300).
- `kind: 'timeout'` → `devc-bridge gh-push timed out`.
- `kind: 'too_large'` → `bridge output too large`.
- `run` throws → its message.

Allowed under `--live` and `--live-yolo`: it runs only what the container could run itself. The
output comes back through the container (it could shadow `devc-bridge` on its `PATH`), so treat it
as untrusted text: capped, and shown with `toast`'s text only.

### Page (`devc/web/static/`)

- `ui.js`: `LABELS.push: 'Push'`.
- `cards.js`, the repo card menu: while `repo.pushGrant`, a **Push** item that sends `push_repo`.
  Put it first among the git items, before Pull and Fetch. **Push…** keeps its current condition
  (`desktopChannel`), so with both, both show: **Push** runs now, and **Push…** asks devc-desktop.
  The separator after the git items shows when any of them does.
- The card's in-flight map (`repoGitOps`) gains kind `'push'`. The card shows its spinner while a
  push runs, and clicking Push, Pull or Fetch does nothing during that time, as for fetch and pull.
- `push_result` is handled wherever `pull_result` is (`cards.js`, `sidebar.js`, `containers.js`):
  the spinner stops; `ok` → `toast(message)`; otherwise →
  `errorToast(`${LABELS.push} failed: ${problem}`)`.
- The `↑N` mark's click is unchanged (it shows the card's commits).

### Docs

- `devc/README.md`, the devc web git paragraph (Fetch/Pull/Commits, around "a `gh-push` shows"):
  **Push** on a repo card's menu, when it shows (container running, a `gh-push` grant on that repo,
  the pinned branch checked out), what it runs, that it needs no confirmation and why, its
  refusals, and that **Push…** remains for everything else. The `--desktop-channel` paragraph:
  one sentence saying **Push** never goes through the app.
- `devc-bridge/README.md` § Publishing a branch: one sentence saying devc web's **Push** runs this
  command in the container, under the same grant.
- `devc-desktop/README.md`, where it says the page can only _ask_ for a push: note that a granted
  container's **Push** in devc web runs without the app, because it does only what the container's
  agent can.

## Validation

- [x] `cd devc && deno task check` passes.
- [ ] `cd devc && deno task test` passes, including new tests:
  - [x] `parseClientMessage` accepts `push_repo` with the three strings, and refuses a missing or
        empty `id`, `localFolder` or `folder`.
  - [x] `pushGrant`: `true` for a running container whose policy line for the repo grants
        `gh-push` with `branch` equal to the checked-out branch. Absent for each of: no policy, a
        malformed policy, a line without `gh-push` (e.g. only `gh-pr-read`), a different checked-out
        branch, a stopped container, and a host project.
  - [x] The handler answers each problem string in checks 1–6, exactly as written, with a fake
        `PrBackend` that records calls. In every refused case, `run` is never called.
  - [x] With a policy granting `gh-push` but not `gh-pr-read`, the handler still runs
        `run('gh-push', <target>, [], …)` (proves `pin()` is not used).
  - [x] Exit 0 with stdout `pushed: b at abc to r (x)\n` → `ok: true`,
        `message: 'pushed: b at abc to r (x)'`, and a git-watch refresh. Exit 3 with stderr ending
        `gh-push: refused: b changes .github/workflows/x.yml relative to main` → `ok: false` with
        that last line as `problem`. A timeout → `devc-bridge gh-push timed out`.
  - [x] Sidebar test: the menu has **Push** only when `pushGrant`, and **Push…** only with
        `desktopChannel`; with both, both show, Push first.
- [x] `deno fmt --check` on every touched file.
- [ ] Manual (the user), a container with `devc up --bridge-allow gh-push` on a non-default pinned
      branch:
  - [ ] Commit in the container. **Push** shows with no devc-desktop. Clicking it shows the spinner,
        then `pushed: …`, and `↑N` clears.
  - [ ] Click again → `up to date: …`.
  - [ ] Check out another branch in the container: **Push** goes away within one git-watch refresh.
  - [ ] Commit a change under `.github/workflows/` on the pinned branch. **Push** fails with
        gh-push's `refused: … changes .github/workflows/…`, and **Push…** (with devc-desktop) still
        offers the confirmed push.
  - [ ] A container without the grant: no **Push**, and **Push…** works as before.

## Relevant Files

- `devc/web/granted_push.ts` (new) — the grant lookup, `pushRepo`'s checks, the run.
- `devc/web/git_status.ts` — `GitStatusWatch`'s `onPass`.
- `devc/web/static/lib/sidebar.js` — `repoGitItems`.
- `devc/tests/web_granted_push_test.ts` (new) — the handler's checks and outcomes.
- `devc/deno.json` — `check` list.
- `devc/web/projects_view.ts` — `RepoView.pushGrant`; `buildProjects` takes the grant map.
- `devc/web/server.ts` — the grant map and its refreshes, `pushRepoFor`, `push_repo` dispatch.
- `devc/web/protocol.ts` — `push_repo` in `ClientMessage`, and its parsing.
- `devc/web/pr_review.ts` — `bridgeMessage` is reused from here (already exported); no change unless
  an import cycle forces moving it.
- `devc/web/static/ui.js` — `LABELS.push`.
- `devc/web/static/cards.js` — the menu item, `repoGitOps` kind `'push'`, `push_result`.
- `devc/web/static/sidebar.js` — route `push_result` as `pull_result` is.
- `devc/web/static/containers.js` — route `push_result` as `pull_result` is.
- `devc/tests/web_server_test.ts` — handler tests.
- `devc/tests/web_projects_test.ts` — `pushGrant` tests.
- `devc/tests/web_sidebar_test.ts` — menu tests.
- `devc/tests/web_desktop_test.ts` — only if its `projects` fixtures break; keep `request_push`
  behavior unchanged.
- `devc/README.md` — devc web git paragraph; `--desktop-channel` paragraph.
- `devc-bridge/README.md` — § Publishing a branch (`gh-push`).
- `devc-desktop/README.md` — the "page can only ask" passage.
