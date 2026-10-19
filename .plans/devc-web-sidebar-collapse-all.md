# devc-web-sidebar-collapse-all

The user asked for two things in the `devc web` sidebar: a **Collapse all** control, and
expand/collapse state that survives a reload. The second one is already done. Every row that
can be opened or closed is saved per browser in `localStorage` `devc-web-sidebar-v1`
(`SIDEBAR_KEY`, `loadSidebarState` / `saveSidebarState` in `devc/web/static/app.js`):

| Row                                 | Saved as                                  | Default |
| ----------------------------------- | ----------------------------------------- | ------- |
| Pinned / Tasks / Layout sections    | `pinnedOpen` / `tasksOpen` / `layoutOpen` | open    |
| Task group nodes                    | `taskGroupsClosed` (group keys)           | open    |
| Sent                                | `sentOpen`                                | closed  |
| Container                           | `collapsed` (local folders)               | open    |
| Container › Terminals               | `terminalsClosed` (local folders)         | open    |
| Container › Repos                   | `reposOpen` (local folders)               | closed  |
| Repo / Files rows and their folders | `rootsOpen` (file root → open paths)      | closed  |
| Not running                         | `inactiveOpen`                            | closed  |
| A project under Not running         | `projectsOpen` (local folders)            | closed  |

Layout rows (rows, columns, stacks, tiles) and the Containers heading can't be collapsed, so
there is nothing to save for them. So this plan does not change what is saved. It adds the
buttons and a reload check to Validation.

The page is the only thing that changes. There are no new messages and no server changes. It
edits `app.js`, as do the other open `devc web` page plans. Implement it on top of
[devc-web-tasks-grouped](devc-web-tasks-grouped.md), because `taskGroupsClosed` and
`groupTasks` come from that plan.

## Decisions

- **Where: on the section headings, as in VS Code's views.** The **Tasks** and **Containers**
  headings each get a hover icon button, `Collapse all`. It sits after the heading's **+** (VS
  Code puts Collapse all last). The Containers heading always shows it, even when its **+**
  (`Add project…`) is absent. There is no button in the sidebar header. (A first version put
  one there; the user moved it to the headings.)
- **Not on Layout or Pinned.** Layout's rows can't be collapsed and Pinned's rows are flat, so
  a Collapse all there would do nothing.
- **Icon:** VS Code's collapse-all shape, two stacked squares with a minus on the front one,
  added to `ICON_PATHS` as `collapseAll`: `M5.5 2.5h8v8M2.5 5.5h8v8h-8zM4.5 9.5h4`.
- **The heading itself stays as it is.** Collapse all closes what is under the heading, not the
  section, as in VS Code. So **Tasks** stays open after its Collapse all.
- **Tasks' Collapse all** adds every key that `groupTasks(tasks)` returns now to
  `taskGroupsClosed`, and sets `sentOpen` to `false`. A group created later starts open, as it
  does today.
- **Containers' Collapse all closes everything under it, at every level, the way VS Code's
  does.** After a click, the section shows only the container rows and the closed **Not
  running** row. Opening a container again shows its Terminals, Repos and Files rows, all
  closed. This includes Terminals, even though Terminals rows start open. Leaving inner rows
  open, so that one click brings a container back as it was, was rejected, because the button
  would then behave differently from VS Code's.
  - Every container shown now and every known project (the `projects` map) is added to
    `collapsed` and to `terminalsClosed`. Projects are included so that a project started
    later also starts collapsed. Folders already in these lists stay there. A container
    unknown at the click still starts open.
  - `reposOpen`, `projectsOpen` and `filesOpen` (saved as `rootsOpen`) are emptied, and
    `inactiveOpen` is set to `false`. `filesOpen` is emptied for every file root, including
    roots that have no tree in `fileTrees` yet. Otherwise a repo that was never drawn would
    reopen its saved folders the first time it is drawn. Every file tree belongs to the
    Containers section, so clearing them all is correct.
- **Not touched:** other sections, the sidebar's `width` and `hidden` state, the tiles, and focus
  in a terminal. Any **New file…** / **New folder…** row being typed in disappears if its folder
  gets closed, as it does when that folder is closed by hand.
- **No Expand all.** The user didn't ask for one, and expanding every file tree would list
  every folder.
- **Saved once.** Each click writes `SIDEBAR_KEY` and calls `renderTree()` once, after all of its
  changes.

## Contracts

### Pure helpers (`devc/web/static/lib/sidebar.js`)

```js
/** @param {{taskGroupsClosed: Set<string>}} state @param {Iterable<string>} taskGroups */
export function collapseTasksState(state, taskGroups);
// → { taskGroupsClosed: state.taskGroupsClosed ∪ taskGroups, sentOpen: false }

/** @param {{collapsed: Set<string>, terminalsClosed: Set<string>}} state @param {Iterable<string>} folders */
export function collapseContainersState(state, folders);
// → { collapsed: state.collapsed ∪ folders, terminalsClosed: state.terminalsClosed ∪ folders,
//     reposOpen: new Set(), projectsOpen: new Set(), filesOpen: {}, inactiveOpen: false }
```

Both return new objects and Sets, and leave `state` unchanged.

### Buttons (`app.js`)

| Heading    | Hover buttons, in order                                                       |
| ---------- | ----------------------------------------------------------------------------- |
| Tasks      | `plus` `New task…`, `collapseAll` `Collapse all`                              |
| Containers | `plus` `Add project…` (when projects can start), `collapseAll` `Collapse all` |

Both use `iconButton('collapseAll', LABELS.collapseAll, …)`, with `LABELS.collapseAll =
'Collapse all'`. `iconButton` stops the click from toggling the heading.

**Containers click handler:**

1. Call `tree.clear()` on every tree in `fileTrees`. This empties each tree's open set and
   listings, so rows already drawn close as well.
2. Clear `restoringFiles`.
3. `Object.assign(sidebarState, collapseContainersState(sidebarState, folders))`, where
   `folders` is the `localFolder` of every value in `containers` and every key in `projects`.
4. `saveSidebarState()`, then `renderTree()`.

**Gotcha:** each `clear()` runs `onFilesChange`, which writes that root's `filesOpen` entry, so
step 3 has to come after step 1. `tree.clear()` calls `onChange` synchronously, so the order
above is enough.

**Gotcha:** `saveSidebarState` writes an explicit list of fields. Every field above is already
in that list. Don't add new ones.

**Not in this plan:** Expand all, a keyboard shortcut, context-menu entries, and any change to
what is saved or to its defaults.

## Checklist

- [x] `lib/sidebar.js`: `collapseTasksState` and `collapseContainersState`
- [x] `app.js`: the `collapseAll` icon, `LABELS.collapseAll`, the two hover buttons, and the two
      click handlers
- [x] `index.html`: no Collapse all button in the sidebar header
- [x] `tests/web_sidebar_test.ts`: cases for both helpers
- [x] `devc/README.md`: in the **Sidebar** bullet, after "Click a container to collapse it…",
      say that open and closed rows are remembered per browser, and that **Collapse all** on the
      Tasks or Containers heading closes every row under it, at every level

## Validation

- [x] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists (see
      devc-web-tasks' Verification). If it fails, move `devc-core/dist/` aside (don't delete
      it: devc-desktop's build may use it), rerun, and put it back.
- [x] `deno fmt --check devc/web/static/app.js devc/web/static/lib/sidebar.js
      devc/web/static/index.html devc/tests/web_sidebar_test.ts devc/README.md
      .plans/devc-web-sidebar-collapse-all.md` passes
- [x] Unit tests (`web_sidebar_test.ts`):
  - `collapseTasksState({taskGroupsClosed: {'k1'}}, ['k2', ''])` gives `{'k1', 'k2', ''}` and
    `sentOpen: false`, and the input Set is unchanged and not reused;
  - `collapseContainersState` with `collapsed {'/a'}`, `terminalsClosed {}` and folders
    `['/b', '/c']` gives `collapsed` `{'/a', '/b', '/c'}`, `terminalsClosed` `{'/b', '/c'}`,
    empty `reposOpen` / `projectsOpen`, `filesOpen` `{}` and `inactiveOpen: false`. The input
    Sets are unchanged and not reused;
  - with no folders, the result is still all closed.
- [x] Headless Chromium (Playwright, installed in a scratch folder for the run) against
      `devc/web/static`, with a fake WebSocket as in devc-web-tasks' Verification, answering
      `list_dir` / `list_container_dir`. Set up one `connected` container `/src/app` with two
      repos `/src/app` and `/src/lib`, one pane, one routed task, one sent entry, one pinned
      file, and a stopped project `/src/old`. Open these rows by clicking them: Repos, the `app`
      repo row and one folder inside it, the container's Files row, Not running, `old`, and
      Sent. Then check:
  - after a reload with the same `localStorage`, each of those rows is still open
    (`aria-expanded="true"`), and so are the open-by-default Pinned, Tasks, Layout, container,
    Terminals and task group rows;
  - the sidebar header holds brand, `#conn`, `#copy-url` and `#sidebar-hide` only;
  - the Tasks heading's buttons are `plus` `New task…` then `collapseAll` `Collapse all`. The
    Containers heading has `collapseAll` `Collapse all`, and Layout and Pinned have none;
  - Tasks' Collapse all closes the task group and Sent, leaves Tasks open, and leaves the
    Containers rows as they were;
  - Containers' Collapse all leaves only the closed `app` container row and the closed
    `Not running (1)` row under Containers. Pinned, Tasks and Layout stay open. Neither click
    sends a WebSocket message;
  - after a reload, the tree is the same as right after the clicks;
  - clicking the `app` container row then shows its Terminals, Repos and Files rows, all
    closed, and no repo or file rows;
  - a container that starts after the click for `/src/old` (a project known at the click) is
    shown collapsed, while one for `/src/new` (unknown at the click) is open. A task with a new
    route added after the click shows an open group;
  - the sidebar's width and hidden state are unchanged, and there are no page errors.
- [ ] Ask the user to try both Collapse all buttons and a reload in their tab.

## Verification (2026-10-19)

- `deno task check` passes. `deno task test`: 489 passed, 0 failed (no `devc-core/dist/` was
  present). `deno fmt --check` passes for every touched file.
- Headless Chromium (Playwright, chromium 1148), with the setup above: all 29 checks passed. A
  reload kept 13 open rows. Tasks' Collapse all closed the task group and Sent only, and
  Containers' left just the closed `app` and `Not running (1)` rows, with no message sent. Both
  results survived a reload. A container started later for `/src/old` came up collapsed, and
  one for `/src/new` came up open. A new route's task group came up open. There were no page
  errors. A 4× screenshot shows the icon as two stacked squares with a minus, after the **+**.
- **Not verified — needs the user:** both buttons and a reload in their tab.

## Relevant Files

- `devc/web/static/app.js`
- `devc/web/static/index.html`
- `devc/web/static/lib/sidebar.js`
- `devc/tests/web_sidebar_test.ts`
- `devc/README.md`
- `.plans/devc-web-sidebar-collapse-all.md`
- `.plans/PLAN.md`
