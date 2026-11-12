# devc web: create and delete git worktrees

A repo card's right-click menu gains **New worktree…** (on a primary repo) and **Delete
worktree…** (on a linked worktree). Worktrees follow the `<repo>` + `<repo>.worktrees/<name>`
convention and are created for one of three sources:

- an open **pull request** (same-repo or fork),
- an existing **remote branch** on `origin`,
- a **new branch**, based on `origin/<default branch>` or on the primary's current branch.

A new worktree becomes a repo card in every running environment that mounts `<repo>.worktrees`.
It is **not** added to `projects.json`, and no container is started. Delete runs
`git worktree remove`, always keeps the branch, and touches no container or project entry.

## Context (what exists, what this builds on)

- `web/git_repo.ts`'s `mountedRepos` already lists every folder in a mounted `<repo>.worktrees`
  as a worktree under its repo, and the sidebar indents worktree cards under their repo's card.
  `server.ts` caches each environment's repos in `containerRepos`, read once per environment.
- **The host never runs git in a repo** (`web/git_status.ts` header). Fetch and Pull
  (`web/git_fetch.ts`) fetch the remote into a host-owned bare mirror (`mirrorFor`, host
  credentials), write a bundle, and the repo's own git fetches the bundle **in the project's
  environment** (`Environment.run`, bundle on stdin). This plan reuses that pattern exactly.
- **Git protection** mounts `<repo>/.git/config` and `.git/hooks` read-only in containers.
  `git worktree add` works with them frozen. Anything that writes config (`--track`,
  `branch --set-upstream-to`) fails inside the container.

## Decisions

1. **Where git runs.** `git worktree add`/`remove` run in the environment (`Environment.run`) of
   the project whose card the request came from. That environment must be running and must have
   both the primary repo and `<primary>.worktrees` mounted (`hostToContainerPath` maps both).
   Otherwise the request is refused with the exact problem text listed under
   [Problems](#problems). A host-environment project runs it directly on the host. That is the
   same `env.run` path, so there is no special case.
2. **No project entry, no container start.** Create and delete never touch `projects.json` or
   any container.
3. **Relative paths.** Every worktree is created with `git worktree add --relative-paths`
   (git ≥ 2.48). Container paths differ from host paths, so absolute `gitdir:` pointers written
   in the container would not resolve on the host (`resolveRepo` would reject the folder). The
   devcontainer CLI's `--mount-git-worktree-common-dir` also needs relative pointers. Before
   adding, the server runs `git version` in the environment and refuses older versions.
   Relative pointers only work when the container keeps the host's sibling layout. Require that
   the container paths of `<primary>` and `<primary>.worktrees` have the same `dirname`, and
   that their basenames equal the host basenames.

   **Found while implementing:** the first `--relative-paths` add writes
   `core.repositoryformatversion = 1` and `extensions.relativeWorktrees = true` into the repo
   config (twice, by lock + rename), which fails against a protected container's read-only
   config. Once both are set, git leaves the config alone. So the host sets them in place first
   ([Host config write](#host-config-write), `enableRelativeWorktrees`), refusing the create with
   `could not enable relative worktrees in the repo config: <why>` when it can't. From then on,
   git older than 2.48 refuses the repo (`unknown repository extension`), the host's own git
   included; the README says so.
4. **Upstream is written by the host, in place.** Inside a protected container the config is
   frozen, so the environment runs `git worktree add --no-track`. Afterwards the host sets
   `branch.<b>.remote = origin` and `branch.<b>.merge = refs/heads/<remote branch>` in
   `<commonDir>/config`. This applies to the remote-branch source and same-repo PRs, and only
   when the branch has no `branch.<b>.merge` yet. See the gotcha in
   [Host config write](#host-config-write).
5. **Fork PRs** are fetched from `refs/pull/<n>/head` on `origin`'s URL, default to local branch
   `pr-<n>`, and get **no upstream**. Their card shows `↑N` against no remote branch, as any
   branch without an upstream does today, and Fetch/Pull are not offered.
6. **Existing local branch.** For the PR and remote-branch sources, if local branch `<b>` already
   exists and no worktree has it checked out, the new worktree checks it out **as is** (no reset).
   The fetched commits still update `refs/remotes/origin/<b>` (same-repo only), so `↓N` and Pull
   bring the branch up to date. For **New branch**, an existing `<b>` is refused. A branch checked
   out in another worktree is refused for every source.
7. **Delete keeps the branch, always.** A dirty worktree is refused unless the request carries
   `force: true` (`git worktree remove --force`). The dialog asks for that explicitly.
8. **`--live`.** `worktree_options`, `worktree_create` and `worktree_remove` without `force` are
   allowed in every mode. They publish nothing, and create only adds a folder, a branch and a
   remote-tracking ref. `worktree_remove` with `force: true` discards work, so it is **refused for
   the page role under `--live` and `--live-yolo`**: page code there comes from a checkout agents
   can edit. The desktop role may always send it.
9. **One worktree operation per primary repo at a time.** A second request while one runs gets
   a problem, not a shared result: the requests differ.
10. **PR and branch lists come from the host.** Open PRs come from `gh pr list` run by the
    server with the host's `gh`, `cwd: /`. Remote branches come from `git ls-remote --heads` with
    no repo (`cwd: /`). Neither runs anything in the repo. This applies to container projects
    too: it is read-only and uses the user's own credentials, as the mirror fetch already does.

## Wire contract (`web/protocol.ts`)

Leave `PROTOCOL` in `web/static/lib/protocol_version.js` at `1`: every change here is additive.
An older devc-desktop bundle never sends the new messages and ignores `worktreesFolder`. A newer
bundle talking to an older server gets no `worktreesFolder`, so it never shows the menu items.
A bump would only blank the Containers pane of every devc-desktop until it is rebuilt.

Client → server:

```ts
| { type: 'worktree_options'; id: string; localFolder: string; folder: string }
| { type: 'worktree_create'; id: string; localFolder: string; folder: string;
    name: string;      // folder name under <folder>.worktrees
    branch: string;    // local branch
    source:
      | { kind: 'pr'; number: number }
      | { kind: 'remote'; remoteBranch: string }
      | { kind: 'new'; base: 'default' | 'current' } }
| { type: 'worktree_remove'; id: string; localFolder: string; folder: string; force: boolean }
```

`folder` is the **primary** repo's host folder for options and create, and the **worktree's**
host folder for remove. The protocol parser rejects anything else, as it does for `fetch_repo`:
missing fields, a `number` that is not a positive integer, an unknown `kind` or `base`, or a
non-boolean `force`.

Server → client (sent to the requester only):

```ts
| { type: 'worktree_options_result'; id: string; folder: string; ok: true;
    worktreesFolder: string;          // host path, <folder>.worktrees
    defaultBranch: string | null;     // origin's HEAD branch, null when unknown
    currentBranch: string | null;     // the primary's checked-out branch
    remoteBranches: string[];         // origin's heads, sorted, at most 5000
    remoteProblem: string | null;     // why remoteBranches is empty, if it failed
    prs: { number: number; title: string; author: string; headRefName: string;
           crossRepository: boolean; draft: boolean }[];   // open PRs, newest first, ≤ 100
    prsProblem: string | null;        // e.g. not a GitHub remote, gh missing
    localBranches: string[];          // refs/heads, short names, sorted
    checkedOut: string[];             // branches checked out in any worktree (primary too)
    folders: string[] }               // existing entries of worktreesFolder
| { type: 'worktree_options_result'; id: string; folder: string; ok: false; problem: string }
| { type: 'worktree_create_result'; id: string; folder: string; ok: true;
    worktree: string;                 // host path of the new worktree
    branch: string; upstream: string | null }   // e.g. 'origin/feature-a'
| { type: 'worktree_create_result'; id: string; folder: string; ok: false; problem: string }
| { type: 'worktree_remove_result'; id: string; folder: string; ok: true }
| { type: 'worktree_remove_result'; id: string; folder: string; ok: false; problem: string;
    dirty: boolean }                  // true: refused only because of local changes
```

`hello` already carries `live`. The page decides whether to offer force from `live` and its
role. The server enforces it regardless (decision 8).

The repo objects sent in `projects` (`MountedRepo` / the `projects_view.ts` repo view) gain
`worktreesFolder: string | null`. It is the host path `<folder>.worktrees` when the repo is a
primary (`resolveRepo(folder).gitDir === commonDir`) and that path is a directory on the host
that the environment's bind mounts map (`worktreesFolderOf`). Otherwise it is `null`. (As built:
not `repoSources()`, which for a host project lists worktrees, not the `.worktrees` folder.) The page shows **New worktree…** only when it is
non-null.

## Server behavior

### Shared checks (all three messages)

Use a `repoTarget`-style lookup: `folder` is a listed repo of `localFolder`'s project, its
session is running, and `hostToContainerPath(folder)` is non-null. For options/create, `folder`
must be a primary (`resolveRepo` → `gitDir === commonDir`). For remove, `folder` must be a
linked worktree (`gitDir !== commonDir`), and its primary, `dirname(commonDir)`, must also map
into the same environment. All container paths come from the session's mounts.

### `worktree_options`

1. Check that `<folder>.worktrees` is a directory on the host and maps into the environment, and
   check the sibling layout (decision 3).
2. Read `origin`'s URL (`readRemoteUrl(commonDir, 'origin')`). If it is missing or not
   `isFetchableRemote`: set `remoteBranches: []`, `remoteProblem: 'origin is not an https or ssh
   remote'`, `prs: []`, and `defaultBranch: null`.
3. In parallel:
   - `git ls-remote --symref <url> HEAD` (host, `cwd: /`, `GIT_TERMINAL_PROMPT=0`, the
     existing `FETCH_TIMEOUT_MS`). The default branch is the capture of
     `/^ref: refs\/heads\/(.+)\tHEAD$/m`.
   - `git ls-remote --heads <url>`, same environment. Each line is `<sha>\trefs/heads/<name>`;
     keep the names that pass `validBranch`, sort them, and cut the list at 5000.
   - When `gitHubRepoOf(url)` (devc-core `bridge.ts`) is non-null: run `gh pr list --repo
     <owner/name> --state open --limit 100 --json
     number,title,author,headRefName,isCrossRepository,isDraft` with `cwd: /`,
     `GH_PROMPT_DISABLED=1` and a 15 s timeout. Parse the output defensively: drop entries
     whose types are wrong, and map `author.login` → `author`. If `gh` is not on PATH, set
     `prsProblem: 'gh not found on this machine'`. If it exits non-zero, use
     `gh: <first non-empty stderr line>`. If the remote is not a GitHub remote, use
     `prsProblem: 'origin is not a GitHub repo'`.
   - In the environment (`cwd` = the primary's container path): `git for-each-ref
     --format=%(refname:short) refs/heads/` → `localBranches`, and `git worktree list
     --porcelain` → `checkedOut` (the `branch refs/heads/<b>` lines).
   - Host `Deno.readDir(<folder>.worktrees)` → `folders` (every entry name).
4. `currentBranch` comes from `readBranch(gitDir)`.

### `worktree_create`

Refuse, in this order, with the [Problems](#problems) texts:

1. Run the shared checks and the layout checks from options step 1.
2. Another worktree operation is running for this primary (decision 9).
3. `name` must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` and must not end in `.lock`.
   `<folder>.worktrees/<name>` must not exist on the host (`Deno.lstat` throws `NotFound`).
4. `branch` must pass `validBranch`. For `remote`, `remoteBranch` must pass it too.
5. `git version` in the environment must be ≥ 2.48. Parse `/^git version (\d+)\.(\d+)/`.
6. For `pr`, `remote` and `new`/`default`, origin must be fetchable.

Then:

1. **Mirror fetch on the host** (`mirrorFor(opts, url)`, `FETCH_FLAGS`, host credentials, the
   existing `FETCH_TIMEOUT_MS`), into `refs/devc/worktree/<hash(folder + '\0' + branch)>/head`:
   - `remote`: `+refs/heads/<remoteBranch>:<ref>`
   - `pr`: look up the PR again with `gh pr view <n> --repo <owner/name> --json
     headRefName,isCrossRepository,state`. Refuse unless `state === 'OPEN'`. Fetch
     `+refs/pull/<n>/head:<ref>`. A same-repo PR's remote branch is its `headRefName`.
   - `new` + `default`: get the default branch as in options (`ls-remote --symref`), then fetch
     `+refs/heads/<default>:<ref>`.
   - `new` + `current`: no fetch. The base is the primary's `HEAD`, which the repo already has.
2. **Bundle.** `sha` = `git --git-dir=<mirror> rev-parse <ref>`. The prerequisites are every
   existing `refs/devc/<p>/local` and `refs/devc/<p>/tracking` in that mirror for the folders of
   this repo: the primary and its listed worktrees, with `<p>` being `locate()`'s prefix per
   folder. Those are commits the repo had when the mirror fetched from it.
   - **Gotcha:** `git bundle create` fails with "Refusing to create empty bundle" when `<ref>`
     is reachable from the prerequisites. Check `git merge-base --is-ancestor <ref> <prereq>`
     against each prerequisite first. If any holds, send no bundle (empty stdin), and the script
     checks that the commit exists instead.
   - Cap the bundle at `MAX_BUNDLE_BYTES` with `runCapped`. If it is over,
     `'worktree fetch too large for devc web: fetch the branch in the project'`.
3. **In the environment** (`cwd` = the primary's container path, `GIT_TERMINAL_PROMPT=0`,
   no timeout: `env.run` has none, and `runLimited` takes no stdin, as for Fetch), first
   `enableRelativeWorktrees` on the host, then run `sh -c WORKTREE_ADD_SCRIPT worktree-add <bundle ref or ''> <sha>
   <tracking ref or ''> <branch> <container path of the new worktree> <mode>`, bundle on stdin:
   - With a non-empty bundle ref: write stdin to a `mktemp` file, then `git fetch --quiet
     --no-tags --no-write-fetch-head --no-recurse-submodules "$tmp" "$bundleRef"`, then remove
     the file (`trap`).
   - Run `git cat-file -e "$sha^{commit}"`. If it fails, exit 4.
   - With a non-empty tracking ref (`refs/remotes/origin/<remote branch>`, for `remote` and
     same-repo `pr`): `git update-ref "$trackingRef" "$sha"`.
   - `mode` is `existing` or `new-at-commit` (`<sha>` is `HEAD` for New branch from current):
     - `existing`: `git worktree add --relative-paths "$path" "$branch"`
     - `new-at-commit`: `git worktree add --relative-paths --no-track -b "$branch" "$path" "$sha"`

     The server picks `existing` when the branch is in `localBranches` (read fresh, as in
     options). It refuses before running when that branch is in `checkedOut`, or when the source
     is `new` and the branch exists.
   - Non-zero exit: `git worktree add: <first non-empty stderr line>`, or exit 4's text.
4. **Upstream** (decision 4) for `remote` and same-repo `pr` when the branch has no
   `branch.<b>.merge`: write it as described below. `upstream` in the result is
   `origin/<remote branch>`, otherwise `null`. If the write fails, the result is still
   `ok: true` (the worktree exists) with `upstream: null`, and the server logs the reason.
5. **Verify** `resolveRepo(<host path>) !== null`. If it fails, send `ok: false` with the
   problem `created <name>, but its .git does not resolve on the host`. Leave the folder: the
   user decides.
6. **Refresh**: every running environment whose bind mounts map `<folder>.worktrees` (for a
   remove: the removed folder) lists its repos again (`loadRepos(env, true)`, which keeps the
   old list until the new one is read), broadcasts `projects`, and calls `gitWatch.refresh()`. No page reload is needed for the card to appear.

### Host config write

Gotcha: a host rewrite of `.git/config` by lock + rename replaces the inode. Docker then keeps
the container's read-only bind mount on the **old** inode, and protection silently stops
covering the live file (see `git-protect-live-check`). `git config --file <real config>` does
exactly that rename. So write in place:

1. Create `<commonDir>/config.lock` with `Deno.open(..., { createNew: true, write: true })`. If
   it already exists, give up. This is the lock git itself honours, so a concurrent git in the
   container fails cleanly instead of being clobbered.
2. Copy `<commonDir>/config` to a temp file. Run `git config --file <temp> branch.<b>.remote
   origin` and `git config --file <temp> branch.<b>.merge refs/heads/<remote branch>` with
   `cwd: /`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and
   `GIT_CEILING_DIRECTORIES=/`. Git quotes the subsection, so a branch name with `"` is safe.
3. Write the temp file's bytes into `<commonDir>/config` with `Deno.writeFile` (truncate +
   write on the same inode; **no rename**). Remove the temp file and `config.lock` in `finally`.

### `worktree_remove`

Refuse, in this order:

1. Run the shared checks (linked worktree, with its primary mapped).
2. Another worktree operation is running for its primary.
3. `folder` equals, or is inside, any `projects.json` `localFolder`:
   `<name> is a project: remove the project first`.
4. An agent whose pane's cwd is inside `folder` is working or blocked. Reuse the check Pull uses
   (`snapshotPanes` and agent status): `an agent in <name> is working`.
5. `force` while the client is the page role and the server runs with `--live`/`--live-yolo`:
   `discarding changes is refused under --live`.

Then, in the environment (`cwd` = the primary's container path, timeout 60 s via `runLimited`), run `git worktree
remove [--force] <container path>`:

- If stderr contains `contains modified or untracked files`: `ok: false`,
  `problem: '<name> has uncommitted changes'`, `dirty: true`.
- If stderr contains `is not a working tree`, the worktree was made on the host with absolute
  paths. Run `git worktree repair --relative-paths <container path>` once, then retry the
  remove once.
- Any other failure: `git worktree remove: <first non-empty stderr line>`, `dirty: false`.
- On success, refresh as create does. The branch stays.

### Problems

Use these exact texts (validated by tests). `<name>` is the folder's basename.

| Case                                                 | `problem`                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| not a listed repo of the project                     | `unknown repo`                                                  |
| environment not running                              | `not running`                                                   |
| options/create on a worktree                         | `<name> is a worktree: create worktrees from its main repo`     |
| remove on a primary                                  | `<name> is not a linked worktree`                               |
| `<folder>.worktrees` missing on the host             | `create <name>.worktrees beside <name> and mount it here`       |
| `<folder>.worktrees` not mapped into the environment | `<name>.worktrees is not mounted here`                          |
| sibling layout differs in the container              | `<name>.worktrees is not beside <name> in the container`        |
| operation already running                            | `a worktree change is already running for <name>`               |
| bad `name`                                           | `invalid folder name: <name given>`                             |
| target exists                                        | `<name>.worktrees/<name given> already exists`                  |
| bad branch                                           | `invalid branch name: <branch>`                                 |
| `new` and the branch exists                          | `branch <branch> already exists`                                |
| branch checked out elsewhere                         | `branch <branch> is checked out in another worktree`            |
| old git                                              | `needs git 2.48 or newer here (found <x.y>)`                    |
| origin unusable                                      | `origin is not an https or ssh remote`                          |
| PR not open                                          | `pull request #<n> is not open`                                 |
| commit missing after fetch (exit 4)                  | `the fetched commit is missing: fetch in the project and retry` |

## Page

- **Menu** (`cards.js` repo card menu, before `dirMenuItems`): **New worktree…** shows when
  `repo.worktreesFolder` is non-null and the project's environment is connected. **Delete
  worktree…** shows when `repo.primaryFolder !== null && repo.primaryFolder !== repo.folder`
  and the environment is connected. Both appear in devc-desktop's Containers pane too (it
  bundles `cards.js`). Add the labels to `LABELS` in `ui.js`.
- **New worktree dialog** (new `web/static/worktree-dialog.js`, built with `h()` like
  `draft-dialog.js`, no native dialogs): it opens at once showing "Loading…" and sends
  `worktree_options`. The top is a three-way segmented control: **Pull request** | **Remote
  branch** | **New branch**. It defaults to Pull request when `prs` is non-empty, otherwise
  Remote branch.
  - **Pull request:** a filter box and a list of `#<n> <title>`, with the author muted, plus
    `fork` and `draft` badges. When `prs` is empty it shows `prsProblem` or `No open pull
    requests`. Picking a PR sets Branch to `headRefName` (same-repo) or `pr-<n>` (fork).
  - **Remote branch:** a filter box and a list of `remoteBranches`, or `remoteProblem`.
    Picking one sets Branch to the same name.
  - **New branch:** a Branch input and a **Base** radio: `origin/<defaultBranch>` (default,
    hidden when `defaultBranch` is null) or `<currentBranch> (current)` (hidden when null).
  - **Folder:** `<repo>.worktrees/` as a muted prefix, then an input. It follows Branch, with
    every `/` replaced by `-`, until the user edits it.
  - Inline notes, recomputed on every change:
    - `uses the existing local branch as is` (PR/remote, branch in `localBranches`)
    - `branch already exists` (New branch, disables Create)
    - `checked out in another worktree` (disables Create)
    - `folder already exists` (name in `folders`, disables Create)
  - **Create** sends `worktree_create` and shows a spinner on the button while it waits. On
    `ok: false`, the problem shows in the dialog, which stays open. On `ok: true`, the dialog
    closes, a toast shows `created <repo>.worktrees/<name> on <branch>`, and the repo's
    worktrees are shown (`sidebarState.worktreesOpen.add(<the primary card's key>)`).
- **Delete worktree dialog** (same file): the text is `Delete <repo>.worktrees/<name>? The
  folder is removed; branch <b> stays.` When the card's git mark shows `● N > 0`, or a previous
  answer said `dirty: true`, a checkbox `Discard N uncommitted changes` appears, and **Delete**
  stays disabled until it is ticked. Under `hello.live` in the page role, the checkbox is
  replaced by `Commit or discard them first (not allowed under --live)`. **Delete** sends
  `worktree_remove` with `force` = the checkbox. The result is handled as for create. The
  success toast is `deleted <repo>.worktrees/<name>`.
- Style additions go in `style.css`, using the existing dialog and segmented-control tokens.

## README

In `devc/README.md`'s sidebar section, after the paragraph on worktree cards under
**Projects**, document both menu items, the three sources, the mount requirement (`<repo>` and
`<repo>.worktrees` beside each other in a running environment), `--relative-paths` and git
≥ 2.48, the upstream behaviour (including fork PRs having none), that the branch is never
deleted, and the `--live` force rule.

## Checklist

- [x] `web/git_worktree.ts`: options, create (mirror fetch, bundle with the empty-bundle check,
      `WORKTREE_ADD_SCRIPT`, in-place upstream write, verify), remove (with the repair retry),
      the per-primary lock, and every problem text from the table
- [x] `web/git_repo.ts` / `web/projects_view.ts`: `worktreesFolder` on repo objects
- [x] `web/git_status.ts`: export what `git_worktree.ts` needs (`FETCH_TIMEOUT_MS`, `git`/`run`
      helpers, `locate`), with no behaviour change
- [x] `web/protocol.ts`: the three client messages with parse validation and the three results
- [x] `web/server.ts`: handlers, shared checks, the `--live` force refusal for the page role, the
      agent-working refusal, and the `containerRepos` refresh + `projects` broadcast
- [x] `web/static/ui.js`: labels; `web/static/cards.js`: menu items
- [x] `web/static/worktree-dialog.js`: both dialogs; `web/static/style.css`
- [x] `devc/deno.json`: add `web/git_worktree.ts` to the `check` task
- [x] `tests/web_git_worktree_test.ts` (see Validation)
- [x] `devc/README.md`
- [x] `deno fmt` on every touched file

## Validation

- [x] `cd devc && deno task check` passes.
- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env
      tests/web_git_worktree_test.ts` passes. It uses temp repos: a bare "remote", a primary
      clone with `<primary>.worktrees`, a host-style `Environment` fake whose `run` executes
      locally, and `MirrorOpts.fetchable` overridden as `web_git_fetch_test.ts` does. Cases:
  - [x] remote branch → the worktree exists with a **relative** `.git` pointer, `resolveRepo`
        accepts it, the branch is checked out at the remote's commit,
        `refs/remotes/origin/<b>` equals it, and `branch.<b>.merge` is
        `refs/heads/<b>`. The config file's **inode is unchanged** (`Deno.stat(...).ino`
        before and after) and no `config.lock` is left behind.
  - [x] PR source with `refs/pull/<n>/head` created in the bare remote and a stubbed `gh` on
        PATH → a fork PR gets `pr-<n>` with no upstream, and a same-repo PR gets an upstream.
  - [x] new branch at `default` and at `current`, both with no upstream. The empty-bundle path
        (base already in the repo) succeeds.
  - [x] an existing local branch is checked out as is (its commit unchanged). An existing
        branch with `new` gives `branch <b> already exists`. A branch checked out elsewhere is
        refused.
  - [x] every problem in the table that does not need a container, asserted by exact text.
        _Done for most: unknown/operation-running/not-mounted-on-remove and the `gh pr view`
        parse failure are not asserted._
  - [x] a `config.lock` present before the upstream write → `ok: true`, `upstream: null`, and
        config untouched.
  - [x] remove: clean → the folder is gone and the branch still exists. Dirty without force →
        `dirty: true`, and the folder still exists. Dirty with force → gone. A worktree made with
        absolute paths whose path differs from the one passed (simulate it by moving the repo
        pair and passing the new path) → the repair + retry succeeds.
        _Clean, dirty and forced are tested. The repair + retry is **not**: on one machine a
        moved pair no longer resolves on the "host" side either, so `removeWorktree` refuses it
        before running git. Left for the live check._
- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env
      tests/web_git_repo_test.ts tests/web_projects_test.ts tests/web_no_native_dialogs_test.ts
      tests/web_server_test.ts` passes, including new cases: `worktreesFolder` is set only for a
      primary whose `.worktrees` is a source; protocol parse rejects a bad `source`/`force`; and
      the server refuses `force: true` from a page-role client under `live`.
      _As built: `worktreesFolder` and the force rule (`forceRefusal`) are tested in
      `web_git_worktree_test.ts`; `buildProjects` passing `worktreesFolder` through in
      `web_projects_test.ts`; parsing in `web_server_test.ts`._
- [x] `cd devc && deno task test`: no new failures. Note any failures that were already there.
      _1101 passed; the one failure, `docker_exec_single_path_test.ts`, is the known one about
      gitignored `devc-core/dist` output._
- [x] `cd devc-desktop && npm ci && npm run build:mac` builds (it bundles `cards.js`).
- [x] Headless Chromium against `devc web` with a host-environment project whose repo has a
      `.worktrees` folder: **New worktree…** shows on the primary card and not on a worktree's;
      each of the three tabs creates a worktree; the card appears indented under the repo
      without a reload; **Delete worktree…** with changes shows the checkbox; delete removes
      the card.
      _Done with a real host session (`herdr`), `origin` a GitHub URL rewritten to a local bare
      repo by `insteadOf`, and a stub `gh`: all three tabs and a fork PR created; the remote tab
      blocks a checked-out branch; dirty delete needs the tick, forced and clean deletes remove
      the cards, branches kept._
- [ ] Live check on the Mac (may be left open; **not run**). Also check there: the repair +
      retry on a worktree made on the host with absolute paths, and that the host's git is 2.48+
      once `extensions.relativeWorktrees` is set: in a real container mounting `<repo>` and
      `<repo>.worktrees`, create from a real PR, then `devc status` still reports `protected`
      for the repo afterwards (the in-place config write kept the mount), and `↓N`/Pull work on
      the new card.

## Relevant Files

- `devc/web/git_worktree.ts` (new)
- `devc/web/git_status.ts`
- `devc/web/git_repo.ts`
- `devc/web/projects_view.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/ui.js`
- `devc/web/static/cards.js`
- `devc/web/static/worktree-dialog.js` (new)
- `devc/web/static/style.css`
- `devc/deno.json`
- `devc/tests/web_git_worktree_test.ts` (new)
- `devc/tests/web_git_repo_test.ts`
- `devc/tests/web_projects_test.ts`
- `devc/tests/web_server_test.ts`
- `devc/README.md`
- `.plans/PLAN.md`
