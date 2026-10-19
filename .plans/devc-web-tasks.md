# devc-web-tasks

A task list in `devc web`: write down a to-do whenever it comes up, then later send it to an
agent in the project it belongs to, either to **write a plan** or to **implement** it. Sending
moves the task off the list and into a **Sent** history. That history keeps the agent's session id
and where it ran, so its session can be found again (the live pane, or `--resume` in a new tab).

**Security boundary:** sending is one-way. The host writes the task's text into the container
and starts an agent. Nothing in a container ever writes to the task list, and agents do not
report back. The only thing that flows the other way is devc web watching Herdr's pane list,
which the host already does.

```
PINNED                         +
  notes.md      devc-tools
TASKS                          +
  Retry gh-push on 502   devc-tools
  Dark mode for picker   (not routed)
  ▸ Sent (3)
LAYOUT
CONTAINERS
```

Depends on nothing pending. Follows the pattern of
[devc-web-pinned-files](archived/devc-web-pinned-files.md): server-side store in
`~/.config/devc/`, a broadcast message, request/reply client messages, a sidebar section.

## Decisions

- **Store on the host, not in repos:** `~/.config/devc/tasks.json`, read and written like
  `pinned-files.json` (tolerant read, atomic write, the file watched so every devc web window
  agrees).
- **Part of devc web, not a separate host UI.** Sending needs devc web's Herdr sessions, its
  project and repo lists and its `createShell`. The store gives the page no new host capability.
- **Agents:** only those whose CLI accepts a session id chosen at launch: `claude`, `copilot`,
  `pi`. `opencode` is not offered (it cannot be given a session id).
- **The task text never goes on a command line.** It is written to
  `/tmp/devc-tasks/<sessionId>.md` in the container, through `docker exec -i` stdin, and the
  command typed into the new tab is built only from fixed strings and the server-generated
  uuid.
- **Sending needs a running container.** Starting it is the page's job (the toast offers
  **Start**), as for pinned files.
- **The agent starts in the repo folder** (`root`). There is no subfolder choice.
- **Sent history** keeps the 50 newest entries. Older ones are dropped on write.

## Contracts

### Store: `~/.config/devc/tasks.json`

```ts
// devc/web/tasks.ts
export const TASKS_PATH: string; // `${CONFIG_DIR}/tasks.json`
export type SessionAgentId = 'claude' | 'copilot' | 'pi';
export type TaskAction = 'plan' | 'implement';
export interface Task {
  id: string; // crypto.randomUUID() at creation
  text: string; // markdown; first line is its title
  createdAt: string; // ISO
  localFolder?: string; // route: project (host path); both or neither of these two
  root?: string; // route: repo folder (host path) of that project
}
export interface SentTask {
  id: string; // the Task's id
  text: string;
  createdAt: string;
  action: TaskAction;
  agent: SessionAgentId;
  sentAt: string; // ISO
  localFolder: string;
  root: string;
  cwd: string; // container path the agent started in (shown; resume recomputes it)
  sessionId: string; // the uuid passed as the agent's session id
  last?: { containerId: string; paneId: string }; // hint, never sent to the page
}
export interface TasksFile {
  version: 1;
  tasks: Task[];
  sent: SentTask[];
}
```

- Read: a missing or unreadable file, or a wrong shape, gives `{tasks: [], sent: []}`. Malformed
  entries are dropped, and so is a repeated `id` (across both lists). Never throws.
- Write: a temp file in the same folder (`.tasks-` prefix), then rename. `sent` is trimmed to
  the 50 newest by `sentAt` on every write.
- `text`: after trimming, non-empty and at most 20 000 characters. It is stored trimmed.
- Title = the first non-empty line of `text`, at most 80 characters (with `…` when cut).
  The page and the pane name both use it.

### Agent commands (`devc/web/agents.ts`)

The uuid is `crypto.randomUUID()` from the server. `<file>` = `/tmp/devc-tasks/<uuid>.md`.
The prompts contain no `'`, so the single-quoted forms below are the exact text sent with
`pane.send_text` (followed by `\n`):

| Agent     | Start                                       | Resume                    |
| --------- | ------------------------------------------- | ------------------------- |
| `claude`  | `claude --session-id <uuid> '<prompt>'`     | `claude --resume <uuid>`  |
| `copilot` | `copilot --session-id <uuid> -i '<prompt>'` | `copilot --resume <uuid>` |
| `pi`      | `pi --session-id <uuid> '<prompt>'`         | `pi --session-id <uuid>`  |

Prompts:

- `implement`: `Implement the task described in <file>.`
- `plan`: `Write an implementation plan for the task described in <file>, following the
  conventions this project uses for plans (a .plans/ doc if the project has a .plans/ folder).
  Do not implement it yet.` (one line). **No `'` in either prompt**: it is single-quoted on the
  command line (a test enforces it).

The file's content is the task text plus a trailing `\n`. It is written as the container's
remote user with `sh -c 'mkdir -p "$1" && cat > "$2"' sh /tmp/devc-tasks <file>`, through
`dockerExecArgv` with `interactive: true`, piping the bytes to stdin.

Verified from `--help` (claude 2.1.303, copilot 1.0.98, pi 1.3.0): claude and copilot set a new
session's id with `--session-id`; pi's `--session-id` "creates it if missing"; copilot `-i`
starts interactive with a prompt; pi takes positional messages interactively.

### Server → browser

`{type: 'tasks', tasks: Task[], sent: Omit<SentTask, 'last'>[]}`. Tasks are in creation order,
and sent entries newest first. It is sent on connect and, to every client, after every change
(including changes another devc web made to the file).

### Browser → server

All of these reply with `result` and `error.code` as below. Every handler re-reads the file,
applies the change and writes it (as `changePinnedFiles` does).

| Message        | Fields                                                 | Server does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_task`     | `id`, `text`, `localFolder?`, `root?`                  | Validates text (else `bad_request`). A route needs both fields: `localFolder` a listed project and `root` one of its repos, else `bad_request` (`unknown project` / `unknown repo`). Appends. `result {task: <id>}`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `update_task`  | `id`, `task`, `text`, `localFolder?`, `root?`          | Same checks. Replaces text and route (no route fields = not routed). Unknown task `not_found`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `delete_task`  | `id`, `task`                                           | Removes it from `tasks` or `sent`. Unknown `not_found`. Never touches a pane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `restore_task` | `id`, `task`                                           | Moves a sent entry back to the end of `tasks` (text, createdAt, its `localFolder`/`root` as the route). Unknown `not_found`. Its pane is left alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `send_task`    | `id`, `task`, `localFolder`, `root`, `agent`, `action` | The task must be in `tasks` (`not_found`). `agent` ∈ `claude`/`copilot`/`pi` and `action` ∈ `plan`/`implement` (else `bad_request`). Route checks as `add_task`. The project's running container (`not_running`), its Herdr ready (started when it has no session, as `open_tab`), `root` mounted (`not_mounted`), the agent installed (`not_installed`). Then: write the file, `createShell` at the repo's container path, `pane.send_text` the start command, `pane.rename` to the title (best-effort), move the task to `sent`. `result {pane_id, tab_id, reused: false}`. A failure before `createShell` leaves the task in `tasks`. |
| `open_sent`    | `id`, `task`                                           | The sent entry (`not_found`), its project's running container (`not_running`). When `last` names that container and its pane is in the session's current snapshot: `result {pane_id, tab_id, reused: true}`. Otherwise it recomputes the container path of `root` (`not_mounted`), `createShell` there, `send_text` the resume command, renames the pane, stores `last`: `result {pane_id, tab_id, reused: false}`.                                                                                                                                                                                                                      |

**Gotcha:** `server.ts`'s `handle` routes any message that has `localFolder` to
`handleProject`. The task messages have to be dispatched by `type` **before** that check.

### Page

- **Tasks section** between Pinned and Layout. It is collapsible: `tasksOpen` in `SIDEBAR_KEY`
  state, default open. The header's **+** (and its context menu) opens **New task…**. With no
  tasks, the empty row reads `No tasks`.
- **Task rows** show the title and, dimmed, the project's label or `not routed`. The tooltip is
  the whole text. A click opens the task dialog. Hover icons (send, delete) replaced the
  `Edit…` / `Delete…` menu: see [devc-web-tasks-actions](devc-web-tasks-actions.md).
- **Sent** row (under the task rows, collapsible, `sentOpen`, default closed): `Sent (n)`.
  Each entry shows the agent icon, the title and the project label dimmed. Its tooltip gives the
  action (`Plan` / `Implement`), the sent time and `cwd`. A click sends `open_sent` and places
  the pane in the focused stack, or focuses it if a tile already shows it. On `not_running` it
  shows a toast with **Start**. Menu: `Open session`, `Copy task text`, `Back to tasks`, `Remove`.
- **Task dialog** (one `<dialog>` for new and edit), with these fields:
  - a textarea (the text);
  - **Project**: `(not routed)` plus the projects, by `byPinThenRecent`;
  - **Repo**: that project's repos (hidden when not routed or when the project has only one);
  - **Agent**: Claude / Copilot / Pi, defaulting to the last one used (`localStorage`
    `devc-web-task-agent-v1`), else Claude.

  Footer: **Save**, **Send: plan**, **Send: implement**. A new task with no route defaults its
  project to the focused tile's project. The send buttons are disabled while not routed. A send
  saves the text and route first (`add_task` or `update_task`), then sends `send_task`. On
  success, the dialog closes and the pane is placed in the focused stack. An error is shown
  inside the dialog, and the task stays.
- Code in `app.js` and `lib/tasks.js` says `task` / `sentTask`. Pure helpers (message parsing,
  title) live in `lib/tasks.js`.

**Not in this plan:** a keyboard shortcut, reordering, agents reporting back, opencode,
starting a stopped container from Send, choosing a subfolder.

## Checklist

- [x] `devc/web/tasks.ts`: store (read/write/trim), pure list changes, title, `tasksMessage`
- [x] `devc/web/agents.ts`: session agents, start/resume command builders, prompts
- [x] `devc/web/container_files.ts`: write a file in a container through stdin
- [x] `devc/web/protocol.ts`: the six messages
- [x] `devc/web/server.ts`: handlers, `tasks` on connect and broadcast, file watch
- [x] `devc/web/static/lib/tasks.js` + `app.js` + `style.css`: Tasks section, Sent, dialog
- [x] Tests: `web_tasks_test.ts`, `web_tasks_page_test.ts`, parser cases in `web_tasks_test.ts`,
      write helper in `web_container_files_test.ts`
- [x] Docs: `devc/README.md` devc web section, `.plans/devc-web.md` protocol tables

## Validation

- [x] `cd devc && deno task check && deno task test` pass (see Verification: one unrelated
      failure from git-ignored `devc-core/dist/`)
- [x] `deno fmt --check` passes for every touched file
- [x] Unit tests cover:
  - the store: missing or corrupt file, malformed and repeated entries, atomic write, trimming
    `sent` to 50, `last` never in the message;
  - the command builders: the exact strings in the table above for all three agents and both
    actions;
  - `open_sent`'s reuse decision: alive, dead, or in another container;
  - the parsers: unknown agent, `opencode`, a bad action, a route with only one of its two
    fields, empty text, text over 20 000.
- [x] Each CLI really honours a chosen id. `claude -p --session-id <uuid> 'Reply OK'`, then
      `claude -p --resume <uuid> 'What did you reply?'`, recalls it. Do the same for copilot
      and pi where they are signed in here; record any that could not be run.
- [x] Headless browser against the page with a fake WebSocket:
  - New task saves (`add_task`), and the row shows the title and `not routed`;
  - edit changes the route (`update_task`);
  - Send: implement sends `update_task` then `send_task` and places the pane;
  - the Sent row lists it with the agent icon, and a click sends `open_sent`;
  - Back to tasks sends `restore_task`;
  - Delete confirms and then sends `delete_task`.
- [ ] Ask the user to check, in their tab: send a real task to Claude in a running project,
      and see the tab named after it with the task file read; close that tab, then click the
      Sent entry and see the conversation resumed.

## Verification (2026-10-19)

- `deno task check` passes. `deno task test`: 481 passed, 1 failed. The failure is
  `docker_exec_single_path_test.ts`, which finds `docker exec` in
  `devc-core/dist/container.d.ts`, a git-ignored build output from earlier the same day. It
  fails the same way with this plan's changes stashed. The 68 tests in the touched test files
  all pass. `deno fmt --check` passes for every touched file.
- Session ids, run here with a chosen uuid and then resumed with `-p`: **claude** 2.1.303 and
  **pi** 1.3.0 both recalled the first answer (pi prints "No project session found … creating
  a new session with that id" on the first run). **copilot** 1.0.98 is not signed in here, so
  it could not be run. Its own error output lists `copilot --session-id=<valid-uuid>` to
  start a new session with that id.
- The real server (this checkout's `main.ts web`, a stub `docker`, a scratch `HOME` with one
  project), driven by a Deno WebSocket client: `tasks` on connect; `add_task` unrouted and
  routed; unknown project, unknown repo and empty text refused with `bad_request`;
  `update_task` and an unknown id `not_found`; `send_task` with no container `not_running`;
  `opencode` refused with `bad_request`; unknown task `not_found` for `send_task`, `open_sent`
  and `restore_task`; `delete_task` twice (`not_found` the second time); a sent entry written
  to the file from outside was broadcast with `last` left out; `open_sent` for it gave
  `not_running`; and `restore_task` moved it back, routed.
- The page in headless Chromium (Playwright) against `devc/web/static`, with a fake
  WebSocket: the sections in order (Pinned, Tasks, Layout, Containers) and `No tasks`; in the
  New task dialog, Send disabled and Repo hidden while not routed; Save sends `add_task`
  and the row reads `not routed`; editing keeps the text, shows Repo for a two-repo
  project, and **Send: implement** with Pi sends `update_task` then `send_task` (route
  `/src/app` + `/src/lib`), closes the dialog, opens a tile and saves the agent; `Sent (1)`
  with the pi icon, the label `app · lib` and its tooltip; a click sends `open_sent`; the menu
  (Open session, Copy task text, Back to tasks, Remove); Back to tasks sends `restore_task`; the
  dialog reopens on its route and agent; Delete… confirms in the in-page dialog, then sends
  `delete_task`; empty text is refused in the page; Ctrl+Enter saves (routed to the focused
  tile's project). No page errors (the one 404 is the static server's missing favicon).
- **Not verified — needs the user's tab:** a real send into a running container (the task
  file written by `docker exec -i`, the agent starting in the repo, the tab named after the
  task), and resuming from Sent after closing that tab. There is no Docker here. Under
  `devc web --live` the installed server doesn't know the new messages, so this needs
  `--live-yolo` or an updated `devc`.

## Relevant Files

- `devc/web/tasks.ts` (new)
- `devc/web/agents.ts`
- `devc/web/container_files.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/app.js`
- `devc/web/static/lib/tasks.js` (new)
- `devc/web/static/style.css`
- `devc/tests/web_tasks_test.ts` (new)
- `devc/tests/web_tasks_page_test.ts` (new)
- `devc/deno.json` (the `check` task)
- `devc/tests/web_container_files_test.ts`
- `devc/README.md`
- `.plans/devc-web.md`
- `.plans/PLAN.md`
