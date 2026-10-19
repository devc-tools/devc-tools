# devc-web-workspace-paths

Three asks for `devc web`, all about where things are inside the container:

1. **Repo rows show their path under `/workspaces`.** A repo mounted at
   `/workspaces/tools/devc-tools` is labelled `tools/devc-tools`, not `devc-tools`.
2. **The window title follows the active tile's repo**: `<repo label>:<branch> — devc web`,
   updated as the focus or the shell's directory changes. In the browser this is the tab
   title; in devc-desktop, the window's.
3. **A container's Files row gets two shortcut rows** above the `/` listing: `/workspaces` and
   the remote user's home (e.g. `/home/vscode`).

It builds on the current sidebar (`devc/web/static/app.js`). Other open `devc web` plans
(devc-web-task-default, devc-web-tasks-actions, devc-web-worktree-git-marks) also edit
`app.js`; rebase on whatever has landed and keep their behavior.

## Decisions

### Repo labels

- **The server names repos.** `RepoView.name` (the `projects` message) is computed from the
  repo's container path, so every place that shows a repo by name changes together.
- `MountedRepo` gains `containerFolder: string | null`: the repo's path inside the container,
  `hostToContainerPath(folder, mounts)` (`devc-core/mount_paths.ts`) over the container's
  mounts, or `null` when no mount covers it or the mounts aren't read yet. In `server.ts`'s
  `loadRepos`, read the mount table once with `inspectMounts(record.id)`, pass its bind
  sources to `mountedRepos` as today, then set `containerFolder` on each result. The
  placeholder entry written before the read has `containerFolder: null`. `mountedRepos`'s
  signature and ordering don't change.
- **The name rule**, as an exported pure function `repoName(folder, containerFolder)` in
  `devc/web/projects_view.ts`, used by `buildProjects`:
  - `containerFolder` (trailing `/` removed) starts with `/workspaces/` and has something after
    it → that remainder: `/workspaces/tools/devc-tools` → `tools/devc-tools`,
    `/workspaces/app` → `app`, `/workspaces/a.worktrees/fix` → `a.worktrees/fix`.
  - Anything else (`null`, `/workspaces` itself, `/src/app`, `/home/vscode/x`) →
    `basename(folder) || folder`, as today.
- **Where the name shows:** the repo row (`repoRows`), the task dialog's Repo select (now
  `basename(r.folder)`), and a task route's repo part in `taskProjectLabel` (now
  `basename(root)`). The last two use the repo's `name` from `projects` when the repo is
  listed there, and fall back to `basename` otherwise. Project and container rows keep
  `containerLabel`: they are not repo rows.
- **Repo row tooltip:** the host folder, then the container path on a second line when
  `containerFolder` is set and differs from it.

### Window title

- **Text:** `<repo>:<branch> — <pane title> — devc web` (em dashes, U+2014, with a space each
  side). `<pane title>` is the active pane's terminal title as its tab shows it after the name
  (`paneLabel(pane).title`: `terminal_title_stripped`, left out when it repeats the name or,
  for a non-agent pane, its folder), so an agent's title follows it as it works through
  `pane_updated`. A file tile, an empty tile or a pane with no such title has none, and its
  `—` goes with it.
  `<repo>` is the basename of the main repo of the repo the tile is in (`primaryFolder`, so a
  worktree `some-repo.worktrees/fix` gives `some-repo`; its own folder's basename when
  `primaryFolder` is null). The repo the tile is in: a repo file's own repo (`root`); for a pane, its directory (`foreground_cwd || cwd`), and for a container file, its
  path, matched against the project's repos' `containerFolder`s, the innermost winning
  (`repoAt` in `lib/sidebar.js`). `<branch>` is that repo's `git.branch` from the `projects`
  message, so it updates on the next git read (about 15 s), not on the checkout itself.
  Without a branch (not read yet, detached HEAD, or a failed read, which carries only
  `gitProblem`): `<repo> — devc web`. Outside every repo, `<repo>` is the project's name as its
  container row shows it (`containerLabel`), with no branch. An empty tile or no tile:
  `devc web`, as in `index.html`. (The title went through `<folder> — devc web`, `<folder> —
  <project> — devc web`, `<folder>: <project> — devc web` and `<folder>: <repo> — devc web`
  `<repo label>:<branch> — devc web` and `<main repo>:<branch> — devc web` as the user
  refined it.)
- **The active tile** is `targetTile()`: the focused tile, else the last focused, else the
  first — the same tile the sidebar marks current.
- **Pure helpers** in `devc/web/static/lib/sidebar.js`, tested in
  `devc/tests/web_sidebar_test.ts`: `windowTitle(repo, branch, paneTitle)` and `repoAt(repos, path)`.
- **When it updates:** `document.title` is set (only when it changed) every time
  `updateCurrent()` runs, and after each `snapshot`, `pane_updated` and `projects` message, so
  a `cd` into another repo or a new branch read retitles the window. A tile closing or a preview tile switching files goes
  through the focus hook or a reconcile already; make sure each path ends in `updateCurrent()`.
- **devc-desktop** holds the page in a `WebContentsView` inside a `BaseWindow`, so the window
  title doesn't follow the page by itself. In `devc-desktop/src/main/main.ts`:
  `devcView.webContents.on('page-title-updated', (e, title) => …)` calls
  `win.setTitle(title || 'devc web')` while the devc view is the one shown, and every switch
  to the status view (`showStatus()`, a restart's `about:blank`) sets `win.setTitle('devc web')`.

### Files shortcuts

- **Rows:** under a running container's **Files** row (open), in this order, at depth 2:
  1. `/workspaces`
  2. the remote user's home, labelled with its absolute path (e.g. `/home/vscode`, `/root`)
  3. the `/` entries, at depth 2 as today.

  Each shortcut row is a folder row of its own file root (chevron, collapsed until opened,
  its entries at depth 3), with the same tooltip (its path), context menu
  (`dirMenuItems(fr, '')`) and folder-terminal button as the Files row has for `/`.
- **The home row is left out** until the home is known, when it can't be read, when it is `/`,
  and when it is `/workspaces` or inside it. The `/workspaces` row always shows; a container
  without the folder shows the listing's error under it, as any unreadable folder does.
- **Home comes from the server.** Each entry of the `containers` message gains an optional
  `home: string`, the container's remote user's `$HOME`. New in
  `devc/web/container_files.ts`: `containerHome(info, run = runDocker): Promise<string | null>`
  runs `dockerExecArgv(info, { cwd: '/', cmd: ['sh', '-c', 'printf %s "$HOME"'] })` and returns
  the output when it is an absolute path with no newline and no NUL, else `null` (a non-zero
  exit, empty output, `~`, a relative path). Docker sets `HOME` from `/etc/passwd` for `-u`
  `remoteUser`; a `remoteEnv` `HOME` wins, which is what that user's shells see too.
- **When it is read:** lazily, once per container id, the first time the server handles a
  `list_container_dir`, `read_container_file` or `preview_container_file` for that container
  (it already resolves the connection then via `connectionOf`). The result is cached in a
  per-id map in `server.ts`, a `null` result too (it is not retried); a failed connection
  isn't cached. When the read finishes with a path, broadcast `containers` again.
  `removeContainer` drops the entry. Opening the Files row lists `/` first, so the home row
  appears just after the `/workspaces` row on first open.
- **File roots:** a shortcut is `{ localFolder, root: '/workspaces' | <home>, container: true }`.
  The `/` root stays `{ localFolder, root: '/', container: true }` (`containerRoot`). Every
  place that turns a container root's relative path into an absolute one uses
  `childPath(fr.root, path)` instead of `childPath('/', path)`.
- **Keys** (the saved ones are a storage contract):
  - tree id: `/` root unchanged (`${localFolder}\ncontainer`); a shortcut
    `${localFolder}\ncontainer:${root}`.
  - `sidebarState.filesOpen` key (saved as `rootsOpen` in `devc-web-sidebar-v1`): `/` root
    unchanged (`container:${localFolder}`); a shortcut `container:${localFolder}\n${root}`.
    Collapse all on Containers already empties every key, so shortcuts close with it.
- **Files opened under a shortcut are ordinary container files.** `fileRefOf` for a container
  root returns `{ localFolder, root: '/', path: <absolute path without its leading '/'>,
  container: true }`, so file tiles, saved layouts, pins and `sameFile` see one file whatever
  row it was opened from. Create, rename and delete send absolute container paths as today.
- **Expand state is independent:** opening `/workspaces/tools` under the shortcut doesn't open
  `workspaces/tools` in the `/` listing, and the reverse.

## Checklist

- [x] `devc/web/git_repo.ts`: `MountedRepo.containerFolder: string | null`; `mountedRepos`
      sets it to `null` (the server fills it in)
- [x] `devc/web/git_repo.ts`: `MountedRepo.primaryFolder: string | null`, `dirname` of the
      repo's real git common dir (its own folder for a primary, the main repo's for a linked
      worktree, listed or not); `null` for the server's placeholder and `buildProjects`'s
      default entry
- [x] `devc/tests/web_git_repo_test.ts`: `primaryFolder` in every expected repo, and a project
      opened on a worktree with its main repo unmounted still gets the main repo's folder
- [x] `devc/web/server.ts` `loadRepos`: one `inspectMounts` read; bind sources to
      `mountedRepos`; `containerFolder` via `hostToContainerPath`; placeholder `null`
- [x] `devc/web/projects_view.ts`: exported `repoName(folder, containerFolder)`;
      `buildProjects` uses it for `RepoView.name`; the default single-repo entry gets
      `containerFolder: null`
- [x] `devc/tests/web_projects_test.ts`: `repoName` cases from Validation; `buildProjects`
      names a repo with a `/workspaces/…` container folder by its relative path
- [x] `devc/tests/web_git_repo_test.ts`: expectations include `containerFolder: null`
- [x] `app.js` `repoRows`: tooltip adds the container path line
- [x] `app.js` task dialog Repo select and `taskProjectLabel`: the repo's `name`, falling back
      to `basename`
- [x] `lib/sidebar.js`: exported `windowTitle(folder, repo)` and `repoAt(repos, path)`
- [x] `devc/tests/web_sidebar_test.ts`: `windowTitle` cases from Validation
- [x] `app.js`: the repo and branch of `targetTile()`; `document.title` set in `updateCurrent()`
      and after `snapshot` / `pane_updated`
- [x] `devc-desktop/src/main/main.ts`: window title follows the devc view's page title;
      `devc web` while the status view shows
- [x] `devc/web/container_files.ts`: `containerHome(info, run)`
- [x] `devc/tests/web_container_files_test.ts`: `containerHome` cases from Validation
- [x] `devc/web/server.ts`: per-container home cache, read on the first container file
      request, broadcast on success, dropped in `removeContainer`; `home` on each
      `containers` entry that has one
- [x] `app.js`: `ContainerInfo` typedef gains `home?: string`; `containerFileRows` renders the
      `/workspaces` and home shortcut rows before the `/` entries, with the skip rules above
- [x] `app.js`: container roots other than `/` — `treeId`, `openKey`, `fileTree`'s list call,
      `fileRefOf`, and every `childPath('/', path)` for a container root use `fr.root`
- [x] `devc/README.md`: the **Sidebar** bullet says repo rows show their path under
      `/workspaces` and the window title follows the active tile's folder; the **Files and
      editing** bullet mentions the `/workspaces` and home rows under a container's **Files**

## Validation

- [x] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists. If
      it fails here, move `devc-core/dist/` aside (don't delete it; devc-desktop's build uses
      it), rerun, and put it back.
- [x] `cd devc-desktop && npm ci && npm run check && npm test` pass.
- [x] `deno fmt --check` passes on every changed `.ts`, `.js`, `.css` and `.md` file under
      `devc/` and on `.plans/devc-web-workspace-paths.md`.
- [x] `repoName` tests: (`/h/devc-tools`, `/workspaces/tools/devc-tools`) → `tools/devc-tools`;
      (`/h/app`, `/workspaces/app/`) → `app`; (`/h/a.worktrees/fix`,
      `/workspaces/a.worktrees/fix`) → `a.worktrees/fix`; (`/h/ws`, `/workspaces`) → `ws`;
      (`/h/app`, `/src/app`) → `app`; (`/h/app`, `null`) → `app`; (`/`, `null`) → `/`;
      (`/h/x`, `/workspacesx/y`) → `x`.
- [x] `windowTitle(repo, branch, paneTitle)` tests: (`'devc-tools'`, `'main'`,
      `'✳ Fixing the title'`) → `'devc-tools:main — ✳ Fixing the title — devc web'`;
      (`'devc-tools'`, `'main'`) and (…, `''`) → `'devc-tools:main — devc web'`; (`'app'`,
      `'feature/x'`) → `'app:feature/x — devc web'`; (`'app'`, `undefined`, `'Claude Code'`) →
      `'app — Claude Code — devc web'`; (`'app'`, `''`) → `'app — devc web'`; (`undefined`,
      `'main'`) and no arguments → `'devc web'`; (`undefined`, `undefined`, `'vim'`) →
      `'vim — devc web'`.
- [x] `repoAt` tests: repos `/workspaces/app`, `/workspaces/app/wt/` (nested), `/src/lib` and
      one with `containerFolder: null`: `/workspaces/app` and `/workspaces/app/src` → app;
      `/workspaces/app/wt/src` → wt; `/src/lib` → lib; `/workspaces/application`, `/tmp`,
      `''` → `null`; no repos → `null`.
- [x] `containerHome` tests with a fake `run`: the argv ends in
      `['-u', <remoteUser>, '-w', '/', <containerId>, 'sh', '-c', 'printf %s "$HOME"']`;
      stdout `/home/vscode` → `'/home/vscode'`; `/root` → `'/root'`; exit 1 → `null`; empty →
      `null`; `home/vscode` → `null`; `/a\n/b` → `null`.
- [x] Headless Chromium (Playwright, installed in a scratch folder for the run) against
      `devc/web/static`, with a fake WebSocket as in devc-web-tasks' Verification. One project
      `/h/devc-tools`, container `connected`, `containers` entry with `home: '/home/vscode'`,
      repos `{folder: '/h/devc-tools', containerFolder: '/workspaces/tools/devc-tools',
      name: 'tools/devc-tools'}` and `{folder: '/h/lib', containerFolder: '/src/lib',
      name: 'lib'}`; a snapshot with pane `p1` (`cwd: '/workspaces/tools/devc-tools'`) and pane
      `p2` (`cwd: '/home/vscode'`), each in a tile. Check:
  - opening **Repos** shows rows labelled `tools/devc-tools` and `lib`; the first's `title`
    is `/h/devc-tools\n/workspaces/tools/devc-tools`;
  - New task's Repo select shows `tools/devc-tools` and `lib`;
  - with the first repo's `git: {branch: 'main', …}` and `primaryFolder: '/h/devc-tools'`, focusing `p1`'s tile:
    `document.title === 'devc-tools:main — devc web'`; focusing `p2`'s:
    `'devc-tools — devc web'` (no repo holds `/home/vscode`: the project);
  - a `pane_updated` for `p2` with `foreground_cwd: '/workspaces/tools/devc-tools/devc'` while
    it is focused: `'devc-tools:main — devc web'`;
  - a `projects` message with that repo's branch `next`: `'devc-tools:next — devc web'`;
    with `git: null, gitProblem: 'detached HEAD'`: `'devc-tools — devc web'`;
  - a third repo, the worktree `{folder: '/h/some-repo.worktrees/fix', containerFolder:
    '/workspaces/some-repo.worktrees/fix', primaryFolder: '/h/some-repo', name:
    'some-repo.worktrees/fix', git: {branch: 'fix', …}}`, with a pane in it focused:
    `'some-repo:fix — devc web'`;
  - a `pane_updated` giving the focused agent pane (`agent: 'claude'`)
    `terminal_title_stripped: '✳ Fixing the title'`: `'devc-tools:main — ✳ Fixing the title —
    devc web'`, and the next title it sets replaces it;
  - opening a container file `/src/lib/x.ts` in a tile and focusing it: `'lib — devc web'`
    (`lib` has no git state in the fixture);
  - closing every tile: `'devc web'`;
  - opening **Files**: the rows under it start `/workspaces`, `/home/vscode`, then the `/`
    listing's entries; opening `/workspaces` sends `list_container_dir` with path
    `/workspaces`, and its child `tools` with `/workspaces/tools`; `workspaces` in the `/`
    listing stays closed;
  - opening a file `x.txt` under the `/workspaces` row produces a tile whose saved layout
    (`localStorage`) holds `{root: '/', path: 'workspaces/x.txt', container: true}`;
  - after a reload, `/workspaces` is still open and `rootsOpen` has key
    `container:/h/devc-tools\n/workspaces`;
  - a `containers` entry with no `home` shows only the `/workspaces` row; `home: '/'` and
    `home: '/workspaces/me'` likewise;
  - Collapse all on Containers closes the shortcut rows too.
- [ ] Against a real running devcontainer (`devc web`): the repo row reads `tools/devc-tools`,
      Files shows `/workspaces` and `/home/vscode` and both list their contents, and `cd /tmp`
      in the active terminal of `devc-tools` retitles the browser tab `devc-tools — devc web`, and
      `cd` back into the repo shows `devc-tools:<branch> — devc web`.
- [ ] Ask the user to check the window title in devc-desktop (switch tiles, `cd`, restart
      devc web from the status view).

## Verification (2026-10-19)

- `deno task check` clean; `deno task test` 493 passed, 0 failed.
- devc-desktop: `npm ci` (node-pty built from source: it has no linux-arm64 prebuild, and
  `node-gyp` needs the full Python standard library, added to the container), then `npm run
  check` (clean) and `npm test` (27 passed). The host needs its own `npm ci` in
  `devc-desktop/` afterwards.
- Headless Chromium against `devc/web/static` with a fake WebSocket: all 21 checks pass. The
  fake lists `src/` and `a.txt` in every folder, so the file-tile check opened
  `/workspaces/src/a.txt`: title `src — devc web`, saved as `{root: '/', path:
  'workspaces/src/a.txt', container: true}`. It caught a shortcut's own folder being sent
  as `/workspaces/` (fixed: `containerFilePath`). That run used the first title format
  (`<name> — devc web`); after the switch to `<repo>:<branch> — devc web` only the unit
  tests were rerun (the container rebuild removed the scratch Playwright install).
- Not done here (no Docker in this container): the real-container check and the devc-desktop
  check, both left for the user.

## Relevant Files

- `devc/web/git_repo.ts`
- `devc/web/projects_view.ts`
- `devc/web/server.ts`
- `devc/web/container_files.ts`
- `devc/web/static/app.js`
- `devc/web/static/lib/sidebar.js`
- `devc/tests/web_projects_test.ts`
- `devc/tests/web_git_repo_test.ts`
- `devc/tests/web_sidebar_test.ts`
- `devc/tests/web_container_files_test.ts`
- `devc-desktop/src/main/main.ts`
- `devc/README.md`
- `.plans/devc-web-workspace-paths.md`
- `.plans/PLAN.md`
