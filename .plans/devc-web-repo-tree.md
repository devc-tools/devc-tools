# devc-web-repo-tree

- [ ] `gitSync` / `gitRollup` (`static/lib/sidebar.js`): an in-sync mark and a no-upstream mark, with tests
- [ ] Server: `list_dir` and `open_file` take a `root` (one of the project's repo folders) instead of always using `localFolder`, with tests
- [ ] Page: each repo row (and the project folder's own row, repo or not) is a file tree root; the **Files** node is gone
- [ ] Page: a project under "Not running" with only its own folder lists the files straight under its project row
- [ ] `sidebarState.filesOpen` keyed by root folder
- [ ] `.plans/devc-web.md` protocol section updated
- [ ] Verify (below) and ask the user to try it in their open tab

Two sidebar changes in `devc web`:

1. **A repo with nothing to push or pull still looks like a repo.** Today `gitSync` returns
   `null` when a branch is level with its upstream, so a clean repo's row looks the same as a
   folder that is no repo at all. It gets a quiet mark instead, in the same slot as `↑2 ↓1`.
2. **Files live under the repo they belong to.** The per-project **Files** node goes away. Each
   repo row a container shows (the project folder first, then every mounted repo and worktree)
   expands into that repo's files. Extra mounted repos become browsable for the first time:
   today `list_dir` is confined to the project's `localFolder`, so a sibling repo mounted beside
   it can't be listed.

```
PROJECTS
  ▾ api                          ● working
    ▾ api               ✓            ← project folder: its files below
      ▸ src
        package.json
    ▸ shared-lib        ↑2
    ▸ api.worktrees/fix ✓            (worktree, depth 2)
      claude   👁
      shell
  NOT RUNNING (1)
    ▾ web   •   stopped              ← only its own folder: files right under it
      ▸ src
        README.md
```

Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first. Precedes
[devc-web-file-viewer](devc-web-file-viewer.md), which uses the same `root` addressing.

No compatibility with older pages or servers: page and server change together, and saved
`filesOpen` entries keyed the old way are dropped on load.

## Concept boundaries

- **Repo row vs repo.** A repo row is any entry in a project's `repos` (`RepoView`,
  `devc/web/projects_view.ts`). The first entry is always the project folder itself, and its
  `git` may be `null` (no repo, or a detached HEAD). Today `repoRows` skips `git === null`;
  after this plan the **first** entry always gets a row (it is the project's file root), and
  later entries with `git === null` still get none (`mountedRepos` only lists repos there anyway).
- **`root` vs `localFolder`.** `localFolder` still identifies the project (what is listed, what
  `start_project` takes, what `containerByFolder` looks up). `root` is the host folder a file
  path is relative to: one of that project's `repos[].folder`. For the project folder they are
  the same string. Don't use `root` to look up a project or container.
- **In sync vs clean.** The new mark means "branch level with its upstream, as of the last
  fetch". `GitStatus` has no working-tree state (uncommitted changes), and this plan doesn't
  add one. Tooltips must not say "clean" or "no changes".
- **Tree root vs Files node.** The removed Files node was a synthetic row whose path was `''`.
  The repo row now plays that part: it is the `''` node of its root's tree. There is one tree per
  root (`fileTree(root)`), not per project.
- **Repo row click vs container row click.** The container row still expands and collapses the
  container. A repo row's click toggles only its files.

## Existing touchpoints

| File                                                                                                  | Role                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devc/web/static/lib/sidebar.js`                                                                      | `gitSync`, `gitRollup`: the marks. Pure, tested in `devc/tests/web_sidebar_test.ts`.                                                                                                 |
| `devc/web/static/app.js`                                                                              | `containerRows`, `repoRows`, `projectRow`, `inactiveRows`, `filesRows`, `fileEntryRow`, `fileTree`, `dirMenuItems`, `openInEditor`, `savedFilesOpen`, `copyPath`, `containerPathOf`. |
| `devc/web/static/style.css`                                                                           | `.git-sync [data-dir=…]` colors; `.row.repo` (now clickable, with a chevron).                                                                                                        |
| `devc/web/protocol.ts`                                                                                | `list_dir` and `open_file` gain `root`.                                                                                                                                              |
| `devc/web/server.ts`                                                                                  | `list_dir` and `openFile` handling; `reposByFolder()` / the mounted-repo cache tell which roots a project has.                                                                       |
| `devc/web/files.ts`                                                                                   | `confine`, `listProjectDir`: unchanged signatures, now called with `root`.                                                                                                           |
| `devc/tests/web_files_test.ts`, `web_server_test.ts`, `web_files_page_test.ts`, `web_sidebar_test.ts` | Tests to extend.                                                                                                                                                                     |
| `.plans/devc-web.md`                                                                                  | Protocol table.                                                                                                                                                                      |

## Contracts

### Git marks (`static/lib/sidebar.js`)

`gitSync(git)` returns `null` only when `git` is `null`/absent (no repo, detached, not read yet).
Otherwise it returns the same `{marks, diverged, title}` shape as today, with two new mark
`dir`s:

| Case                                  | marks                                   | title                                                   |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| upstream, ahead 0, behind 0, not gone | `[{dir: 'synced', text: '✓'}]`          | `<branch> → <upstream>: in sync (as of the last fetch)` |
| no upstream (`git.upstream === null`) | `[{dir: 'local', text: '•'}]`           | `<branch>: no upstream`                                 |
| anything else                         | unchanged (`ahead` / `behind` / `gone`) | unchanged                                               |

`gitRollup(repos)`:

- If any repo has an `ahead`/`behind`/`gone` mark: unchanged from today (sums, and its title
  lists only the repos that have marks).
- Else, if at least one repo has a `synced` or `local` mark: `{marks: [{dir: 'synced', text:
  '✓'}], diverged: false, title}` where the title lists every repo's own title, one per line.
  A rollup of only `local` repos still shows `✓`: the collapsed row just says "repos, nothing to
  sync".
- Else `null`.

CSS: `[data-dir='synced']` and `[data-dir='local']` use `var(--muted)`, so they read as a
quieter version of the arrows.

Tests: each table row for `gitSync`; `gitRollup` with all synced, all local, mixed synced and
ahead (arrows win), and no git at all (`null`).

### Browser → server

| Message     | Fields                              | Change                                                                                                                                                                                                                                                                                                        |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_dir`  | `id`, `localFolder`, `root`, `path` | `localFolder` must be a listed project (unchanged), and `root` must equal one of that project's current `repos[].folder` (as sent in `projects`), else `bad_request` with message `unknown repo`. Then `listProjectDir(root, path)`. `containerPath` is computed from the `root`-relative host path as today. |
| `open_file` | `id`, `container`, `root`, `path`   | `root` must be one of the repo folders of that container's project, else `bad_request` `unknown repo`. `confine(root, path)` replaces `confine(localFolder, path)`. Everything after (mounts, `hostToContainerPath`, `not_mounted`, `createShell`, `send_text`) is unchanged.                                 |

- The repo list used for the check is the same one the server sends in `projects` (from
  `mountedRepos`), not recomputed per request. A root that a just-stopped container used to
  mount may be refused until the page re-renders; that's fine.
- Tests: a sibling-repo root lists; a root that isn't in the project's repos is refused; a path
  escaping a non-primary root is `forbidden`.

### Page

- **Rows under a running container** (expanded), in `repos` order, before the workspaces:
  - Each repo row: depth 1, or 2 for a worktree (`worktreeOf`). It shows a chevron, the repo
    name and its `gitMark(gitSync(r.git))`. The first entry always gets a row; later ones only
    when `git !== null` (as today).
  - Click or Enter toggles that root's tree. While it is open, its entries follow it directly,
    at the row's depth + 1, before the next repo row. So a repo's worktree rows come after the
    repo's own open files.
  - Context menu: the directory menu for `''` (New shell here, Refresh, Copy path), as the Files
    node had.
- **Collapsed container row:** keeps `gitMark(gitRollup(...))`, so it now shows `✓` when every
  repo is in sync.
- **Projects under "Not running":** their `repos` is just the project folder, so expanding the
  project row lists that folder's files directly under it (depth 2), with no extra repo row.
  The project row shows `gitMark(gitRollup(repos))` as today, which now includes `✓` / `•`.
  The project row's context menu gains the `''` directory items (Refresh, Copy path) after the
  project items.
- **One tree per root:** `fileTree(root)` replaces `fileTree(localFolder)`. File and directory
  rows carry both `localFolder` (for the container lookup) and `root` (for paths), and send
  `root` in `list_dir` / `open_file`.
- **Saved state:** `sidebarState.filesOpen: {[root]: string[]}` (same `SIDEBAR_KEY`). The `''`
  entry records whether the root itself is open. Repo roots start collapsed. On load, re-list
  saved paths and drop the ones that fail, as today; entries for roots that no project has
  are kept until a listing for them fails, so a stopped container's repos come back when it
  starts.
- **Copy path:** container path when the container is running and the root is mounted, else
  the host path (`root` joined with `path`).

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Then ask the user to check, in their open tab:

1. A repo level with its upstream shows a muted `✓`; one without an upstream shows `•`; the
   tooltip says which. A repo with commits to push still shows `↑n`.
2. Collapse the container: the row shows `✓` when nothing needs syncing, arrows otherwise.
3. No "Files" node. Expand the project folder's row: its files appear under it. Expand a
   second mounted repo: its files list (this didn't work before).
4. Open a file from the second repo: the editor opens in the container on the right path.
5. Reload: the same repos and folders are still open.
6. A stopped project under "Not running": expanding it lists its files straight away.
