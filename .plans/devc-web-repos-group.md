# devc-web-repos-group

- [x] `gitRollup`: `•` when every repo with git status has no upstream, with tests
- [x] Page: a collapsible **Repos** row first under each expanded container (when it has more than one repo)
- [x] Page: a repo's worktrees and files both hide behind its chevron, worktrees first
- [x] Page: running containers without a usable Herdr stay in the main list (expandable, with Start / Retry); "Not running" holds only projects without a running container
- [x] `sidebarState.reposOpen` saved and restored
- [x] `.plans/devc-web.md` "Browser UI" section updated
- [x] Verify (below) and ask the user to try it in their open tab

Reshapes the Projects section of the `devc web` sidebar, from what a real dump showed (the
"Copy sidebar as JSON" item on a section heading). With many mounted repos, the panes sit at the
bottom of a container, under up to a dozen repo rows. Repo rows and pane rows share one indent.
And a running container whose Herdr session isn't up is filed under "Not running".

```
PROJECTS
  ▾ dev-wksp                  no session  [▶ Start Herdr] [Retry]
    ▸ Repos            ↑3 ↓1                ← collapsed: the rollup of every repo
  ▾ devc-dev                  ● done
    ▾ Repos
      ▾ devc-dev       ↑3                    ← project folder
          ▸ scripts
            README.md
      ▾ devc-tools     ✓
        ▸ wt-testa     •                     ← worktree before the repo's files
        ▸ devc
          README.md
      ▸ herdr-plugins  ✓
    shell
    Devc web UI roadmap      ● done
  ▾ space-platformer-2
    ▸ space-platformer-2 •                   ← only one repo: no Repos row
    2d platformer game setup ○ idle
  ▾ Not running (4)
    ▸ agentsprite   ✓   stopped
```

Read `/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first. Page only, with no protocol
change, so it works under plain `--live`. Builds on
[devc-web-repo-tree](archived/devc-web-repo-tree.md). Precedes
[devc-web-open-tab-here](devc-web-open-tab-here.md).

## Concept boundaries

- **Repos row vs repo row.** The **Repos** row (class `repos`) is a grouping row with no folder
  of its own. A **repo row** (class `repo`) is one entry of `repos`, with a file tree. The dump
  must tell them apart, so they need different first classes.
- **Container state vs project state.** "Not running" is about the **container** (a
  `ProjectView` whose `container` is not `running`). A container in `no-session`, `no-herdr`,
  `unsupported` or `error` is running. Its **Herdr** isn't usable, and that's a state on its row,
  not a reason to file it elsewhere. The `INACTIVE_STATES` set stops deciding placement; it
  still decides which rows show Start / Retry and have no panes.
- **Rollup marks.** `gitRollup` stays the only place that combines marks. The Repos row and a
  collapsed container row both use it.

## Existing touchpoints

| File                                  | Role                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devc/web/static/lib/sidebar.js`      | `gitRollup`. Tested in `devc/tests/web_sidebar_test.ts`.                                                                                         |
| `devc/web/static/app.js`              | `renderTree` (placement), `containerRows`, `repoRows`, `inactiveRows`, `projectRow`, `INACTIVE_STATES`, `loadSidebarState` / `saveSidebarState`. |
| `devc/web/static/lib/sidebar_dump.js` | Unchanged. Its output is how to check the shape (see Verify).                                                                                    |
| `devc/web/static/style.css`           | `.row.repos` (styled like `.row.repo`: muted, clickable).                                                                                        |
| `.plans/devc-web.md`                  | "Browser UI" section.                                                                                                                            |

## Contracts

### `gitRollup(repos)` (`static/lib/sidebar.js`)

Unchanged, except for the case where no repo has `ahead` / `behind` / `gone` marks:

- at least one `synced` mark → `[{dir: 'synced', text: '✓'}]` (as now);
- no `synced`, at least one `local` → `[{dir: 'local', text: '•'}]`, title listing each repo's
  title;
- neither → `null`.

Tests: all local → `•`; local and synced → `✓`; local and ahead → the arrows.

### Rows under an expanded container

In this order:

1. **Repos row**, depth 1, only when the container's `repos` has more than one entry that gets a
   row (the first entry always does; later ones when `git !== null`).
   - It shows a chevron, the text `Repos`, and `gitMark(gitRollup(repos))` **only while collapsed**
     (as the container row does).
   - It starts collapsed. Click or Enter toggles it. Open state is saved in
     `sidebarState.reposOpen: string[]` of `localFolder`s, under `SIDEBAR_KEY`.
   - While it is open, the repo rows follow at depth 2.
   - With a single repo, there's no Repos row: that repo's row sits directly at depth 1.
2. **Repo rows** (in `repos` order, top-level repos only), each followed while it is expanded
   by:
   - its **worktree** rows (repos whose `worktreeOf` is this repo's folder), at the repo's
     depth + 1, each one a repo row with its own chevron and files;
   - then its **file entries** at the repo's depth + 1.
   - A collapsed repo hides both. A repo row has a chevron when it has worktrees or can list
     files (always, today).
3. **Workspace and pane rows**, unchanged (depth 1, or 2 under a workspace row).

### Placement

- `renderTree` puts every container in `containers` in the main list through `containerRows`,
  whatever its state.
- For a container in an `INACTIVE_STATES` state, the container row shows the state text, and on
  hover **Start Herdr** (`no-session` only) and **Retry**, as the "Not running" rows do today. It
  is expandable and shows its Repos / repo rows. It has no workspace or pane rows. The `error`
  state keeps its message in the row's tooltip.
- "Not running (N)" counts and lists only idle projects (`projectRow`), and appears only when
  there are some.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Also, in a headless page with a fake WebSocket (see the devc-web skill), feed a `projects`
message shaped like the user's dump. Several repos, worktrees and a `no-session` container are
enough. Check `devcSidebarTree()` for:

- `repos` at depth 1, its repos at 2, a worktree at 3 coming before its parent's `file-entry`
  rows;
- a single-repo container with no `repos` row;
- the `no-session` container under Projects, not under the `group`.

Then ask the user, in their open tab:

1. Each container shows a collapsed **Repos** row first with the combined mark, and the panes
   right under it.
2. Expanding a repo shows its worktrees, then its files. Collapsing it hides both.
3. A container without a Herdr session sits with the others, expandable, with Start Herdr and
   Retry. "Not running" lists only stopped projects.
4. A stopped project whose repos have no upstream shows `•`, not `✓`.
5. Reload: the Repos rows you left open are still open.
