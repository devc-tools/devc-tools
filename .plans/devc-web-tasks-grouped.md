# devc-web-tasks-grouped

The Tasks section of `devc web` lists every task flat, each with its route dimmed after the
title. This plan groups the tasks under one collapsible node per **project + repo** route
(the same `project` / `project · repo` text the rows show today). Unrouted tasks go under a
last `not routed` node. Task rows move one level deeper and drop their dimmed route, because
the node above them names it.

```
before                                   after
TASKS                          +         TASKS                          +
  Retry gh-push on 502   devc-tools        ▾ devc-tools                 2
  Dark mode for picker   not routed          Retry gh-push on 502
  Bump core              devc-tools          Bump core
  Lint lib               app · lib         ▾ app · lib                  1
  ▸ Sent (3)                                 Lint lib
                                           ▾ not routed                 1
                                             Dark mode for picker
                                           ▸ Sent (3)
```

The page is the only thing that changes. There are no new messages and no server or store
changes. Builds on [devc-web-tasks](devc-web-tasks.md),
[devc-web-tasks-actions](devc-web-tasks-actions.md) and
[devc-web-pinned-hide-save-primary](devc-web-pinned-hide-save-primary.md) (all edit `app.js`;
implement this one on top of them). It is independent of
[devc-web-task-default](devc-web-task-default.md): that one changes the task dialog, this one
only the Tasks section rows, so either can go first.

## Decisions

- **One node per route, not a project node with repo nodes under it.** A route is the pair
  (`localFolder`, `root`). Most projects have one repo, so a two-level tree would add a level
  that holds one child. The node's label is `taskProjectLabel(localFolder, root)`, the text the
  rows show today: the project's label, plus `· <repo basename>` when `root` is another folder
  than `localFolder`.
- **Node order: by the route's first task.** `tasks` arrives in creation order, so the groups
  come in the order of each route's oldest task, and tasks inside a group keep their order.
  The `not routed` node is always last. This order doesn't move when projects are used or
  pinned. (Sorting by `byPinThenRecent` was rejected: the list would reshuffle as projects are
  used.)
- **A node is shown for every non-empty group, even when there is only one group.** There are no
  empty nodes. With no tasks at all, the section still shows the single `No tasks` row.
- **Nodes are open by default.** Closed nodes are kept in the sidebar state (`SIDEBAR_KEY`) as
  `taskGroupsClosed: string[]` of group keys, read the way `terminalsClosed` is (non-string
  entries dropped, missing means `[]`). Keys of groups that no longer exist are left in the
  list; that does no harm and matches `collapsed` / `terminalsClosed`.
- **Group key:** `` `${localFolder}\n${root}` `` for a route, `''` for `not routed`. Paths never
  contain `\n`, so keys cannot collide.
- **Count:** each node shows its number of tasks, dimmed, at the right (open or closed).
- **Node actions:** a routed node has a hover `task` icon button **New task here…** and a context
  menu with **New task here…**. Both open the New task dialog routed to that node's
  `{localFolder, root}` (the existing `openTaskDialog(undefined, route)`), whether or not the
  container is running. The `not routed` node has neither (the section header's **+** already
  makes an unrouted task).
- **A click on a node toggles it.** It never opens a dialog.
- **Task rows:** `--depth: 2`. The dimmed route (`span.pane-title`) is removed from task rows.
  Hover icons, tooltip and click are unchanged.
- **Sent is unchanged.** It stays one flat, newest-first history under the task nodes at
  `--depth: 1`, and its entries keep their dimmed route.
- **A project that is no longer listed** keeps its group, labelled with the folder's basename,
  as `taskProjectLabel` already does.

## Contracts

### Pure helper (`devc/web/static/lib/tasks.js`)

```js
/**
 * @param {Task[]} tasks  in creation order
 * @returns {{key: string, localFolder?: string, root?: string, tasks: Task[]}[]}
 */
export function groupTasks(tasks);
```

- Routed groups in the order of their first task, then one unrouted group (`key: ''`, no
  `localFolder` / `root`) if any task is unrouted.
- Each group's `tasks` keeps the input order. No group is empty. `[]` for no tasks.

### Group row

| Attribute / part      | Value                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| element               | `div.row.task-group`                                                                 |
| `style`               | `--depth: 1`                                                                         |
| `data-task-group`     | the group key                                                                        |
| `aria-expanded`       | `"true"` / `"false"`                                                                 |
| `title`               | the routed group's `root` (host path); no `title` on `not routed`                    |
| label                 | `chevron()`, then `taskProjectLabel(localFolder, root)` (`not routed` when unrouted) |
| count                 | `span.pane-title` with the number of tasks, e.g. `2`                                 |
| hover (routed only)   | `iconButton('task', LABELS.newTaskHere, …)` inside `rowTrail(hoverActions(…))`       |
| context menu (routed) | `[[LABELS.newTaskHere, …]]`                                                          |
| click                 | toggles the key in `sidebarState.taskGroupsClosed`, saves, `renderTree()`            |

Section row order inside an open Tasks section: for each group, its node then (when open) its
task rows; then the `Sent (n)` row and (when open) its entries.

**Gotcha:** `saveSidebarState` writes an explicit object. `taskGroupsClosed` must be added to it
and to `loadSidebarState`, or the closed nodes are lost on reload.

**Not in this plan:** grouping Sent entries, reordering groups or tasks, drag and drop, any server
or protocol change.

## Checklist

- [x] `lib/tasks.js`: `groupTasks`
- [x] `app.js`: `taskGroupsClosed` in the sidebar state (load and save) and a toggle function
- [x] `app.js`: `taskRows()` renders a group row per `groupTasks(tasks)` group, then its task
      rows when open; the group row's hover button and context menu for routed groups
- [x] `app.js`: `taskRow` at `--depth: 2` without the dimmed route; update the doc comments of
      `taskRows` / `taskRow`
- [x] `tests/web_tasks_page_test.ts`: `groupTasks` cases
- [x] `devc/README.md`: the **Tasks** bullet says tasks are grouped under a node per project and
      repo (unrouted ones under **not routed**), and that a node's **New task here…** opens the
      dialog routed there
- [x] `.plans/devc-web-tasks.md` `### Page`: the **Task rows** bullet points to this plan for the
      grouping

## Validation

- [x] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists (see
      devc-web-tasks' Verification). If it fails, move `devc-core/dist/` aside (don't delete
      it: devc-desktop's build may use it), rerun, and put it back.
- [x] `deno fmt --check devc/web/static/app.js devc/web/static/lib/tasks.js
      devc/tests/web_tasks_page_test.ts devc/README.md .plans/devc-web-tasks-grouped.md
      .plans/devc-web-tasks.md` passes
- [x] Unit tests (`web_tasks_page_test.ts`) for `groupTasks`:
  - `[]` → `[]`;
  - tasks `a` (`/src/app` + `/src/app`), `b` unrouted, `c` (`/src/app` + `/src/lib`), `d`
    (`/src/app` + `/src/app`) → keys `"/src/app\n/src/app"` (`a`, `d`), `"/src/app\n/src/lib"`
    (`c`), `''` (`b`), in that order;
  - only unrouted tasks → one group with key `''`;
  - two projects whose `root`s share a basename stay two groups.
- [x] Headless Chromium (Playwright, installed in a scratch folder for the run) against
      `devc/web/static`, with a fake WebSocket as in devc-web-tasks' Verification. One project
      `/src/app` with repos `/src/app` and `/src/lib`, container `connected`. Tasks, in order:
      `A` (`/src/app` + `/src/app`), `B` unrouted, `C` (`/src/app` + `/src/lib`), `D`
      (`/src/app` + `/src/app`). Check:
  - the `.row.task-group` labels are, in order, `app`, `app · lib`, `not routed`, with counts
    `2`, `1`, `1`, and each is directly followed by its task rows (`A`, `D` / `C` / `B`);
  - task rows have `--depth: 2` and no `.pane-title` child; `Sent (n)` still follows the last
    group;
  - clicking the `app · lib` node hides `C`, sets `aria-expanded="false"`, and after a reload
    (same `localStorage`) it is still closed while the other two are open;
  - the `app · lib` node's `[data-icon=task]` button, titled `New task here…`, opens `New task`
    with Project `/src/app` and Repo `/src/lib` selected; its context menu has
    `New task here…`; the `not routed` node has no hover button, and right-clicking it opens no
    devc menu;
  - a task row's `implement` icon still sends exactly one `send_task` with its route;
  - with `tasks: []` the section shows `No tasks` and no `.row.task-group`;
  - no page errors.
- [ ] Ask the user to look at the grouped Tasks section in their tab.

## Verification (2026-10-19)

- `deno task check` passes. `deno task test`: 486 passed, 0 failed (no `devc-core/dist/` was
  present). `deno fmt --check` passes for every touched file.
- Headless Chromium (Playwright, chromium 1148) against `devc/web/static`, with a fake
  WebSocket and the tasks `A`–`D` above plus one sent entry: the nodes read `app` (2),
  `app · lib` (1), `not routed` (1), each followed by its tasks, then `Sent (1)`; task rows at
  `--depth: 2` with no `.pane-title`; the `app · lib` node closed by a click stays closed after
  a reload while the others stay open; its **New task here…** button opens `New task` on
  `/src/app` + `/src/lib`, and its menu is exactly `New task here…`; the `not routed` node has
  no hover button and no devc menu; a click on a node opens no dialog; a row's `implement`
  sends one `send_task` with its route; `tasks: []` shows only `No tasks`. No page errors.
- **Not verified — needs the user:** the grouped section in their tab.

## Relevant Files

- `devc/web/static/app.js`
- `devc/web/static/lib/tasks.js`
- `devc/tests/web_tasks_page_test.ts`
- `devc/README.md`
- `.plans/devc-web-tasks.md`
- `.plans/devc-web-tasks-grouped.md`
- `.plans/PLAN.md`
