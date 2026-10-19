# devc-web-tasks-actions

Three changes to the Tasks section [devc-web-tasks](devc-web-tasks.md) added to `devc web`:

1. **New task from a folder.** Folders that offer a new terminal also offer **New task here…**.
   It opens the New task dialog with that folder's project and repo already chosen.
2. **Row actions on tasks.** A task row gets hover icons: **Send: plan**, **Send: implement**
   and a trash can for **Delete…**. The row's context menu (`Edit…`, `Delete…`) goes away.
   Clicking the row still opens the dialog to edit the task.
3. **Focus ring in the dialogs.** The Project / Repo / Agent dropdowns use the browser's default
   focus outline. It overlaps the dropdown beside it and is clipped at the dialog's edge. They
   get the accent border that the task textarea already uses.

The page is the only thing that changes. There are no new messages and no server changes: a
row's send is the same `send_task` that the dialog sends.

```
TASKS                                   [▤][</>][🗑]   ← hover icons on a routed task
  Retry gh-push on 502   devc-tools
  Dark mode for picker   not routed           [🗑]   ← a task with no route: trash only
```

## Decisions

- **Which folders:** the same rows that get the new-terminal **+** today. That is
  `folderTerminalButton` (a repo root or a folder in a project's Files/repo tree, while its
  container is running; never in a container's own `/` tree, `fr.container`) and the
  **Terminals** row's `newTerminalButton`. On those rows, a task button goes **before** the +, in
  the same `hoverActions`. The **context menu** of every project folder (`dirMenuItems` when
  `!fr.container`) also gets **New task here…**, whether or not the container is running. A
  task can be saved without a running container.
- **Prefill:** project = `fr.localFolder`, repo = `fr.root`. The Terminals row passes
  `{localFolder: c.localFolder, root: c.localFolder}`, as it already does for +. A subfolder
  routes to its repo, because tasks carry no subfolder (devc-web-tasks: "There is no subfolder
  choice"). When `fr.localFolder` is not in `projects`, the dialog opens unrouted, which is what
  the Project select does for any unknown value. When `fr.root` is not one of
  `fillTaskRepos`'s repos, it selects the first repo, which is its existing behavior.
- **Row send uses the remembered agent:** `savedTaskAgent(localStorage[devc-web-task-agent-v1])`,
  the agent the dialog last sent with, else Claude. The button tooltips name it, for example
  `Send to Claude: plan`. A row send does not write the key. Only the dialog chooses an agent.
- **Send icons only on routed tasks.** An unrouted task shows only the trash can. There is
  nothing to send it to, and clicking the row opens the dialog to route it.
- **Row send flow** (the dialog's send without its save step):
  - no running container (`containerByFolder` undefined) → `notRunningToast(localFolder, title)`,
    nothing sent;
  - `c.state === 'no-session'` → `toast('Starting Herdr…')` first;
  - then `call({type: 'send_task', task, localFolder, root, agent, action})`;
  - success → `placePane(localFolder, result, placeInFocusedStack)`;
  - `not_running` → `notRunningToast`; any other error →
    `errorToast(\`Send failed: ${message}\`)`.

  A task with a send in flight ignores further send clicks, the same guard that
  `openingSentTasks` gives Sent rows.
- **Delete keeps its confirmation.** The trash can calls the existing `deleteTask(task)`, which
  shows the danger `confirmDialog`.
- **Task rows have no context menu.** Remove `oncontextmenu` from `taskRow`. A right-click on a
  task row then opens no devc menu (the browser's own, like the sidebar's other rows without
  one, such as `No tasks`). Sent rows keep their menu (Open session, Copy task text, Back to tasks, Remove).
- **Row tooltip:** `` `${task.text}\n\nClick to edit` `` (it was "Click to edit or send it").
- **Focus fix in CSS only:** `.new-note-project:focus { outline: none; border-color:
  var(--accent); }`, the same rule as `.task-text:focus`. It also fixes the New note dialog's
  project select, which uses the same class. Add `min-width: 0` to `.new-note-project` so a long
  project label cannot widen a `.task-route` grid column past `1fr`.

## Contracts

### Icons (`ICON_PATHS` in `app.js`, 16×16 viewBox, stroked like the others)

| `data-icon` | Path `d`                                                     | Used for                              |
| ----------- | ------------------------------------------------------------ | ------------------------------------- |
| `plan`      | `M4 2h8v12H4zM6 5h4M6 7.5h4M6 10h2.5`                        | Send: plan (a page of lines)          |
| `implement` | `M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9`                 | Send: implement (`</>`)               |
| `task`      | `M3 4l1.2 1.2L6.5 3M8.5 4.5H13M3 9l1.2 1.2L6.5 8M8.5 9.5H13` | New task here… (a checklist)          |
| `trash`     | existing                                                     | Delete… (already used for Close pane) |

### Labels and tooltips (exact text)

| Where                           | Text                           |
| ------------------------------- | ------------------------------ |
| Folder hover button title       | `New task here…`               |
| Folder context-menu item        | `New task here…`               |
| Task row send-plan button title | `Send to <Agent>: plan`        |
| Task row send-implement title   | `Send to <Agent>: implement`   |
| Task row trash button title     | `Delete…`                      |
| Task row tooltip                | `<task text>\n\nClick to edit` |

`<Agent>` is `LABELS.agents[id]` (`Claude`, `Copilot`, `Pi`). Add `newTaskHere: 'New task here…'`
to `LABELS`.

### Task row button order

Inside the row's `hoverActions`, from left to right: `plan`, `implement`, `trash`. A routed task
shows all three, an unrouted task only `trash`. All of them are `iconButton`s, so a click does
not reach the row, and the dialog does not open.

### The dialog with a prefilled route

`openTaskDialog` gains a way to open a **new** task with a given `{localFolder, root}` (the
signature is up to the implementer). With a route given, it overrides the focused-tile default,
the Project select shows `localFolder`, and `fillTaskRepos(root)` picks the repo. The text
starts empty and focused, Send is enabled (because the task is routed), and the header reads
`New task`.

**Gotcha:** `fillTaskRepos(null)` runs on every Project change and resets the repo to the first
one. The prefilled `root` has to reach the **first** `fillTaskRepos` call that `openTaskDialog`
makes (today `fillTaskRepos(task?.root ?? null)`). Setting `$repo.value` afterwards does not
work, because the options are built inside that call.

**Gotcha:** `folderTerminalButton` and the Terminals row put their buttons inside
`newTerminalButton`'s `hoverActions(...)`. Add the task button to that same `row-hover` span:
build both buttons inside one `hoverActions`, or give `newTerminalButton` the extra button.
A second `hoverActions` span would overlap the first, because each is positioned at the row's
right end.

**Not in this plan:** choosing the agent per row, a keyboard shortcut, row actions on Sent
entries, any server or protocol change.

## Checklist

- [x] `app.js`: `plan`, `implement`, `task` icons; `LABELS.newTaskHere`
- [x] `app.js`: `openTaskDialog` opens a new task with a given route
- [x] `app.js`: **New task here…** hover button on folder rows and the Terminals row (before
      the +), and in `dirMenuItems` for project folders
- [x] `app.js`: task row hover actions (plan / implement on routed tasks, trash on all), the
      row-send function with its in-flight guard, no context menu, new tooltip
- [x] `style.css`: `.new-note-project:focus` accent border without an outline, and `min-width: 0`
- [x] `devc/README.md`: the Tasks bullet describes the row icons, **New task here…**, and that
      a row send uses the last agent chosen in the dialog
- [x] `.plans/devc-web-tasks.md` `### Page`: replace the task-row menu sentence with a pointer
      to this plan

## Validation

- [x] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists (see
      devc-web-tasks' Verification). If it fails here, delete `devc-core/dist/` and rerun.
- [x] `deno fmt --check devc/web/static/app.js devc/web/static/style.css devc/README.md
      .plans/devc-web-tasks-actions.md .plans/devc-web-tasks.md` passes
- [x] Headless Chromium (Playwright, installed for the run) against `devc/web/static`, with a
      fake WebSocket as in devc-web-tasks' Verification. One project `/src/app` with repos
      `/src/app` and `/src/lib`, and its container `connected`. Two tasks: one routed
      (`/src/app` + `/src/lib`), one unrouted. `localStorage['devc-web-task-agent-v1'] = 'pi'`.
      Then check:
  - the routed task row has buttons `[data-icon=plan]`, `[data-icon=implement]`,
    `[data-icon=trash]` in that order, titled `Send to Pi: plan`, `Send to Pi: implement` and
    `Delete…`. The unrouted row has only `[data-icon=trash]`;
  - clicking `implement` sends exactly one message, `send_task` with `{task, localFolder:
    '/src/app', root: '/src/lib', agent: 'pi', action: 'implement'}`, with no `update_task`
    before it, and no dialog opens. Replying `{pane_id, tab_id, reused: false}` places a tile;
  - a second click on `implement` before the reply sends nothing more;
  - with the container removed from the fake `containers` state, `plan` sends nothing and shows
    the "container is not running" toast;
  - trash opens the confirm dialog, and confirming sends `delete_task`;
  - right-clicking a task row opens no devc menu (`openMenu` is not called). Clicking the row's label opens the `Task` dialog
    with its text;
  - the `/src/lib` repo row in the Files tree shows a `[data-icon=task]` button titled
    `New task here…`, placed before the `+`. Clicking it opens `New task` with Project `/src/app`
    selected, Repo `/src/lib` visible and selected, and Send enabled. Its context menu has
    `New task here…`, and the same holds with the container stopped (menu item present, hover
    button absent);
  - the Terminals row's task button opens `New task` with Repo `/src/app`;
  - with the task dialog open, focusing the Project select gives it a computed `outline-style`
    of `none` and a `border-color` equal to `--accent`. Its bounding box stays inside the
    `.task-route` box, and it does not overlap the Repo select.
- [ ] Ask the user to look at the dialog's dropdown focus in devc-desktop on macOS and in a
      browser tab, and to send a routed task with a row icon in their tab.

## Verification (2026-10-19)

- `deno task check` passes. `deno task test` failed only `docker_exec_single_path_test.ts`, as
  expected with `devc-core/dist/` present. With that folder moved aside, rather than deleted
  (devc-desktop's npm build may use it), the run gave 482 passed, 0 failed, and the folder was
  put back. `deno fmt --check` passes for every touched file.
- Headless Chromium (Playwright 1.49.1, installed in a scratch folder) against
  `devc/web/static`, with a fake WebSocket. All the Validation checks above passed, with no
  page errors. The stopped-container case was run on the stopped project's own row, which is
  where a stopped project's folder menu lives. It has no hover task button (only **Start**),
  its menu has **New task here…**, and that item opens the dialog routed to the project. The
  screenshots show the three row icons, the task icon before the + on Terminals, and the
  focused Project dropdown with an accent border that stays inside its column.
- **Not verified — needs the user:** the dropdown focus in devc-desktop on macOS, and a real
  send from a row icon.

## Relevant Files

- `devc/web/static/app.js`
- `devc/web/static/style.css`
- `devc/README.md`
- `.plans/devc-web-tasks.md`
- `.plans/devc-web-tasks-actions.md`
- `.plans/PLAN.md`
