# devc-web-projects

- [x] `devc/projects.ts`: the projects file (pinned + recent), with tests
- [x] CLI start paths record each project they start (`devc/container.ts` `startContainer`)
- [x] Discovery reports stopped containers too (`docker ps -a`, `die` → stopped, `destroy` → gone)
- [x] Server: `projects` message; `start_project`, `stop_project`, `pin_project`, `forget_project`, `add_project`
- [x] Sidebar: projects that aren't running sit under the "Not running" group, with Start / Pin / Forget
- [x] Tiles whose project isn't running offer Start in their overlay
- [x] `.plans/devc-web.md` protocol section and `devc/README.md` (`devc web`) updated
- [ ] Verify (below) and ask the user to try it in their open tab

Let `devc web` list **projects**, not only running containers. The sidebar's Projects section
(from [devc-web-layout-sidebar](archived/devc-web-layout-sidebar.md)) gains:

- projects whose container is stopped;
- projects devc has started before but whose container is gone;
- projects the user pinned.

Each can be started from the page. A project is a host folder (`localFolder`); a container is
what the project is currently running as.

```
PROJECTS
  ▾ api                    ● working
      …
  ▸ Not running (4)
      devc-tools      stopped      [Start]
      feature1 · api  no session   [Start]
      blog  📌        not created  [Start]
```

Depends on [devc-web-layout-sidebar](archived/devc-web-layout-sidebar.md). Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first: the user runs `devc web` in live
mode, so every save reaches their tab, and a server-side save restarts the server.

## Concept boundaries

- **Project vs container vs session.**
  - A **project** is a `localFolder`.
  - A **container** is a Docker container with the `devcontainer.local_folder` label (`ContainerRecord`).
  - A **session** is `devc web`'s `ContainerSession` for a _running_ container's Herdr.
  - `ContainerState` (`connecting`, `connected`, `no-session`, …) describes a session and stays
    as it is.
  - A project's container status is a separate field, `container: 'running' | 'stopped' | 'missing'`.
    Don't add `stopped` to `ContainerState`.
- **"Start" is already taken.** The current `start_session` message (and its Start button) starts
  a _Herdr server_ in a running container. Starting a container is `start_project`. In the UI,
  label them differently: "Start Herdr" vs "Start container".
- **The projects file is not the global config.** `~/.config/devc/config.json` (devc-core's global
  config: code/skills roots, `recentSkills`) is user configuration that the config wizard edits.
  The projects list goes in its own file, so that `devc web` and every start path can rewrite it
  without touching the config.
- **`~/.cache/devc/projects/<key>/`** is devc-core's generated merged-config cache. It has
  nothing to do with this, despite the name. Don't read it as a project list: its keys are hashes.
- **The `containers` message stays.** It still lists running containers and their session states.
  The new `projects` message is the list of folders. The page joins the two on `localFolder`.

## Existing touchpoints

| File                                                      | Role                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc/container.ts`                                       | `startContainer`, the CLI binding every start path goes through (`up`, `build`, `attach`, `claude`, `herdr`, `exec`). Record the project here, after a successful start.                 |
| `devc/web/containers.ts`                                  | `listDevcontainers`, `parseEventLine`, `Discovery`. Add stopped containers and `destroy`.                                                                                                |
| `devc/web/server.ts`                                      | `containersMessage`, `addContainer` / `removeContainer`, `handle()`. Add the `projects` message and the new client messages.                                                             |
| `devc/web/protocol.ts`                                    | New `ClientMessage` variants and their validation.                                                                                                                                       |
| `devc/devcontainer_selfexec.ts`                           | How devc re-invokes itself, both compiled and from source. Reuse that approach to spawn `devc up` / `devc stop`.                                                                         |
| `devc/git_root_guard.ts`                                  | `terminalConfirm()` returns `null` without a TTY, so the ancestor-repo guard refuses instead of prompting. A start from the web is never interactive; surface that refusal as the error. |
| `devc/web/static/app.js`                                  | `containerRows`, `inactiveRows`, the tile overlay (`updateOverlay`), `STATE_TEXT`.                                                                                                       |
| `devc/tests/web_containers_test.ts`, `web_server_test.ts` | Existing tests to extend.                                                                                                                                                                |

## Contracts

### Projects file

The path is `~/.config/devc/projects.json` (`$HOME` resolved the way devc-core resolves its config
dir):

```json
{
  "version": 1,
  "projects": [
    {
      "localFolder": "/Users/b/code/api",
      "pinned": true,
      "lastUsed": "2026-10-16T14:02:11.000Z"
    },
    {
      "localFolder": "/Users/b/code/blog",
      "pinned": false,
      "lastUsed": "2026-10-12T09:30:00.000Z"
    }
  ]
}
```

```ts
// devc/projects.ts
export interface ProjectEntry {
  localFolder: string;
  pinned: boolean;
  lastUsed: string | null;
}
export const PROJECTS_PATH: string;
export const MAX_RECENT = 20;
/** Missing or unreadable file → []. Drops malformed entries; never throws. */
export function loadProjects(path?: string): Promise<ProjectEntry[]>;
/** Pure: bump `localFolder` to `now` (adding it unpinned if new), then keep every pinned entry plus the MAX_RECENT most recent unpinned. */
export function recordUse(
  list: ProjectEntry[],
  localFolder: string,
  now: Date,
): ProjectEntry[];
/** Pure. Pinning an unknown folder adds it with lastUsed null. */
export function setPinned(
  list: ProjectEntry[],
  localFolder: string,
  pinned: boolean,
): ProjectEntry[];
/** Pure. */
export function forget(
  list: ProjectEntry[],
  localFolder: string,
): ProjectEntry[];
/** Load → `change` → atomic write (temp file + rename in the same dir). */
export function updateProjects(
  change: (list: ProjectEntry[]) => ProjectEntry[],
  path?: string,
): Promise<ProjectEntry[]>;
```

- **Recording is best-effort.** `startContainer` calls
  `updateProjects((l) => recordUse(l, localFolder, new Date()))` after a successful start. If that
  call fails, print one warning to stderr and still return the container.
- **Folder paths** must be absolute. Store them exactly as the start path got them: this is the same
  string that the `devcontainer.local_folder` label carries, so the page can join on it.
- **Tests** cover `recordUse` (new entry, bump, cap that keeps pinned entries), `setPinned`, `forget`, and
  `loadProjects` on a missing, malformed or partly valid file.

### Discovery

- **`listDevcontainers`** takes a flag to include stopped containers (`docker ps -a`). Its records
  gain `running: boolean`, from `{{.State}}`.
- **Events** add `destroy` to the filter.
  - `start`: the container is running.
  - `die`: the container is stopped. Its record stays known, and its session is disposed, as on remove today.
  - `destroy`: the record is removed.
- **Several containers for one `localFolder`** (an old stopped one next to a running one):
  prefer the running one, otherwise the most recently created.

### Server → browser: `projects`

Sent on connect after `containers`, and broadcast whenever the list changes. Changes come from a
`fs.watch` on the projects file (debounced, about 200 ms), from discovery, and from the messages
below.

```json
{
  "type": "projects",
  "projects": [
    {
      "localFolder": "/Users/b/code/api",
      "name": "api",
      "pinned": true,
      "lastUsed": "2026-10-16T14:02:11.000Z",
      "container": "running",
      "starting": false
    }
  ]
}
```

- **What's listed:** every entry of the projects file, plus every `localFolder` that discovery
  knows a container for, running or stopped.
- **`container`:**
  - `running` when a running container exists for the folder;
  - `stopped` when only stopped containers exist;
  - `missing` when no container exists.
- **`starting`** is `true` while a `start_project` for that folder is in flight.
- **`name`** is the same rule `containersMessage` uses. The page still applies `containerLabel` for twins.

### Browser → server

| Message          | Fields                        | Server does                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_project`  | `id`, `localFolder`           | Only for a folder listed in `projects`. Spawns `devc up <localFolder>` (self-exec, stdin null). Broadcasts `project_output {localFolder, line}` for each stdout/stderr line. `result {ok}`, or `ok: false` with `code: "start_failed"` and the last stderr lines as `message`. A second start while one is running fails with `code: "already_starting"`. |
| `stop_project`   | `id`, `localFolder`           | `devc stop <localFolder>` (self-exec). `result {ok}`.                                                                                                                                                                                                                                                                                                     |
| `pin_project`    | `id`, `localFolder`, `pinned` | `updateProjects(setPinned…)`. `result {ok}`.                                                                                                                                                                                                                                                                                                              |
| `forget_project` | `id`, `localFolder`           | `updateProjects(forget…)`. The project stays listed while a container exists for it. `result {ok}`.                                                                                                                                                                                                                                                       |
| `add_project`    | `id`, `localFolder`           | The folder must be an absolute path to an existing directory; anything else gets `bad_request`. Then `setPinned(…, true)`. `result {ok}`.                                                                                                                                                                                                                 |

These carry `localFolder` and no `container`. `handle()` currently rejects any message whose
`container` it doesn't know, so route these before that check.

### Page

- **Running projects** (`container: 'running'`) render as the Projects section does today.
  Every other project goes under the "Not running" group, alongside the existing `no-session`
  / `error` sessions.
- **Row text** shows the state ("stopped", "not created"). While `starting`, it shows "starting…"
  with a spinner, and the last `project_output` line is the row's `title`.
- **Menus:**
  - running project: Stop container… (confirm) · Pin/Unpin
  - not running: Start container · Pin/Unpin · Forget (only when not pinned and `container: 'missing'`)
- **Projects header:** an "Add project…" item that, until
  [devc-web-files](devc-web-files.md) adds the folder picker, does a `prompt()` for an absolute
  host path.
- **Pins** show as a small pin icon. Pinned projects sort first within the group, then by `lastUsed`.
- **Start output:** a failed start shows a toast with the error. "Show output" (in the not-running
  row's menu while starting, or after a failure) opens a plain `<pre>` dialog of the buffered
  `project_output` lines for that folder. Keep the last 500 lines per folder in memory; nothing
  is persisted.
- **Tile overlay:** when a tile's `ref.localFolder` belongs to a project whose container isn't
  running, the overlay says "Container stopped" (or "Container not created"). It has a
  **Start container** button that sends `start_project`. Once the container runs and its
  snapshot has the pane, the tile reconnects through the existing reconcile. If the pane didn't
  survive the restart, it says "Pane gone" as today.

## Implementation notes

- **Start runs in-process, not `devc up`.** A bare `devc up` _revokes_ the project's devc-bridge
  policy (only `--bridge-allow` grants), so the server calls the CLI's own `startContainer`
  (`web/project_control.ts`), with the policy refreshed as `devc attach` does. The devcontainer
  CLI's stderr streams through a self-exec runner (`streamingRunner`) as `project_output`.
- **The ancestor-repo guard doesn't refuse without a TTY** (it warns and carries on), and the
  `devc web` process usually _has_ a TTY, the user's host terminal, where a prompt would hang
  unseen. `CliStartOptions.guard` lets the web start answer "no" and route the warning into the
  output, so such a start fails with the guard's message.
- **Stop** calls core's `stopContainer` in-process too.
- `devc exec` records its project as well (it can start the container).
- The merge of the projects file with discovery is a pure function, `web/projects_view.ts`.
- Discovery keeps stopped containers in its own map (`Discovery.stopped`); the running-container
  hooks (`onAdd`/`onRemove`) are unchanged, plus `onStoppedChange`.
- Checked against a fake WebSocket in a headless browser: row order (pinned, then recent),
  menus per state, every message the page sends, streamed output and its dialog, the failure
  toast, and the tile overlays for a stopped and a starting project. Not checked end to end:
  this container has no Docker.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

Then ask the user to check:

1. `devc stop` a project from a host terminal. It should move to "Not running" as "stopped", and
   its tiles should show Start.
2. Start it from the page. Output should show as progress, and the row and tiles should come back.
3. Pin a project that has never started (via Add project…). It should be listed as "not created",
   and Start should create it.
4. Unpin and forget it. It should disappear.
5. `devc up` some other project from a terminal. It should appear in the list.
6. Start a project from the page whose ancestor-repo guard would prompt. It should fail with the
   guard's message, not hang.
