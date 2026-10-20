# devc-web-agent-sessions

A **Sessions** node under each running container in `devc web` lists the 20 most recent agent
sessions (Claude, Copilot, pi) whose working folder is in one of that project's repos, newest
first. Clicking one resumes it in a new terminal in the folder it started in. A session devc web
already resumed is focused instead while its pane is alive.

```
CONTAINERS
  ▾ devc-tools                       ■
    ▸ Terminals
    ▾ Sessions                       ⟳
        ✳ Devc up --bridge-repo wi…   2h
        ✳ Claude CLI mods for PR …    1d
        π Reply with exactly the …    3d
    ▸ Repos …
    ▸ Files
```

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Concept boundaries

- **Where it shows.** One node per running container, between Terminals and the repo rows
  (`renderTree` order: Terminals, **Sessions**, repos, Files). Not a top-level section: a session
  can only be resumed in its own project's container, in its own folder, so it belongs to that
  container. Sent tasks stay where they are (a task's session also shows here; no dedupe).
- **Read through `docker exec`, never on the host.** The default config bind-mounts the agent
  homes from `~/.config/devc/` (shared by every devc container), but project-mode containers may
  use volumes (the `agents` Feature's default). One path for both: the listing reads the agent
  homes inside the running container as the remote user (`dockerExecArgv`), like
  `list_container_dir`. So a stopped project lists nothing (no Sessions node), and Herdr's state
  doesn't matter for listing (it does for resuming: `readyTarget`, as `open_sent`).
- **Shared homes hold other projects' sessions.** A session is listed only when its `cwd` is a
  repo's container path or under it (`cwd === p || cwd.startsWith(p + '/')`), for the repos of
  the container's project. Two projects mounted at the same container path see each other's
  sessions; accepted.
- **Container data is untrusted.** Nothing read is stored or written anywhere. Titles are shown
  as text only. The resume command is built by the existing `resumeTaskCommand(agent, id)` from
  the agent id and a uuid-checked session id; `cwd` goes to `createShell` as its `cwd`, never on
  a command line. `resume_session` carries only `container`, `agent` and `session`: the server
  takes `cwd` and `title` from its own last listing for that container, never from the page.
- **No live-session detection.** devc web can't tell whether a session is already running in
  some other terminal (Claude's `~/.claude/sessions/<pid>.json` is shared across containers,
  so pids collide). Only panes devc web itself resumed are reused.
- **Fixed count.** `MAX_SESSIONS = 20` per container. No paging, no setting.

## Contracts

### Where each agent keeps its sessions (in the container)

`$HOME` is the remote user's. The script uses these roots, each skipped when absent:

| Agent     | Root                                            | One session                                                             |
| --------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `claude`  | `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`  | `<root>/<dir>/<uuid>.jsonl` (top level only; skip `<uuid>/` subfolders) |
| `copilot` | `${COPILOT_HOME:-$HOME/.copilot}/session-state` | `<root>/<uuid>/workspace.yaml`                                          |
| `pi`      | `$HOME/.pi/agent/sessions`                      | `<root>/<dir>/<timestamp>_<uuid>.jsonl`                                 |

Per session (all verified on claude 2.1.304, copilot 1.0.100, pi 1.3.0 except where Step 0 says):

| Agent     | `session` (id)                                       | `cwd`                                                                            | `updatedAt`                                                        | `title`, first that is non-empty                                                                                       |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `claude`  | file name without `.jsonl`                           | the **first** `"cwd":"…"` in the file (where it started; later ones follow `cd`) | file mtime                                                         | last `"customTitle":"…"`, last `"aiTitle":"…"`, last `"lastPrompt":"…"`                                                |
| `copilot` | directory name                                       | `cwd:` line of `workspace.yaml`                                                  | newest mtime of `workspace.yaml` and `events.jsonl` (when present) | `name:` line (Step 0: `--name` writes it, with `user_named: true`), then `summary:` line                               |
| `pi`      | `"id"` of the first line (`"type":"session"` header) | `"cwd"` of that header                                                           | file mtime                                                         | last `"name"` of a `"type":"session_info"` line (Step 0), else the first `"text"` of the first `"role":"user"` message |

No title → `(untitled)`. Titles are cut like task titles: first non-empty line, at most 80
characters, `…` when cut (reuse `taskTitle`'s rule). A session whose id fails the uuid regex in
`agents.ts`, or whose `cwd` isn't absolute or contains `\n`/`\0`, is dropped. pi's ids are
UUIDv7 and pass that regex.

**Directory pre-filter** (keeps the scan small in a shared home; the `cwd` check above is still
the authority). From each repo container path `p`:

- claude dir names start with `p.replace(/[^A-Za-z0-9]/g, '-')` (`/workspaces/deephaven-core.worktrees/x`
  → `-workspaces-deephaven-core-worktrees-x`);
- pi dir names start with `'--' + p.slice(1).replaceAll('/', '-')` (`/workspaces/devc-dev` →
  `--workspaces-devc-dev--`; a subfolder's dir continues with `-<name>--`).

Copilot has no per-folder directory: every `session-state/*/workspace.yaml` is a candidate.

### The listing script (`devc/web/sessions.ts`)

- One `docker exec` per `list_sessions`: `dockerExecArgv(info, {cwd: '/', cmd: ['sh', '-c',
  SCRIPT, 'sh', ...args]})` where `SCRIPT` is a fixed string constant and `args` are the
  pre-filter prefixes and the per-agent candidate cap, as separate argv entries (never
  interpolated into the script). POSIX `sh` + `ls`/`stat -c`/`grep`/`head` only (the image may be
  Alpine/busybox: no `find -printf`, no `jq`, no Python/Node assumed).
- Per agent it takes at most `2 × MAX_SESSIONS` candidates, newest mtime first, after the
  pre-filter, and reads only those. Fields are extracted with `grep -m1 -o` / `grep -o` and the
  JSON-string pattern `"<key>":"(\\.|[^"\\])*"` (`grep -E`), never by printing whole lines (one
  Claude line can be megabytes). TS decodes each extracted literal with `JSON.parse('"…"')`.
- The output format between script and parser is internal; the parser is a pure exported
  function, tested with fixed output, and drops anything malformed (never throws on content).
- The server merges the three agents, applies the `cwd` filter, sorts by `updatedAt` descending
  and keeps `MAX_SESSIONS`.

### Browser → server

| Message          | Fields                                | Server does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`  | `id`, `container`                     | Unknown container: `bad_request` `unknown container` (the existing path). Runs the script; a non-zero exit or exec failure is `list_failed`. Stores the result as that container's last listing (in memory, replaced on every list, dropped when the container's session goes). `result {sessions: AgentSession[]}`.                                                                                                                                                                                                                                                                                                                                                                          |
| `resume_session` | `id`, `container`, `agent`, `session` | `agent` must be `claude`/`copilot`/`pi` (`isSessionAgentId`), `session` a uuid (else `bad_request`). Not in the container's last listing: `not_found` `no such session`. When devc web resumed it before and that pane is in the current snapshot (`reusablePinnedPane` with the stored `{containerId, paneId}`): `result {pane_id, tab_id, reused: true}`. Else `readyTarget` (starts Herdr when there's no session), `not_installed` as `send_task`, `createShell` at the listed `cwd`, `pane.send_text` `resumeTaskCommand(agent, session) + '\n'`, `pane.rename` to the title (best-effort), remember the pane: `result {pane_id, tab_id, reused: false}`. Herdr failures as `open_sent`. |

```ts
// result of list_sessions, newest first
interface AgentSession {
  agent: 'claude' | 'copilot' | 'pi';
  session: string; // uuid
  title: string; // already cut to 80
  cwd: string; // container path where it started
  root: string; // host path of the repo whose container path contains cwd
  updatedAt: string; // ISO, from the mtime (epoch seconds × 1000)
}
```

The resumed-pane memory is in-memory only (`Map` keyed `${containerId}\n${agent}\n${session}`),
lost on restart.

**Gotchas**

- Both messages carry `container`, not `localFolder`, so they reach the per-container `switch`
  in `server.ts`'s `handle` (after the `localFolder` → `handleProject` check). Add parser cases
  in `protocol.ts` and `case`s in that switch.
- `repoContainerPath` answers the client on refusal. Computing every repo's container path for
  the filter needs a variant that returns null without replying (a repo not mounted is just
  skipped).
- `claude --resume <id>` only finds a session from the folder it started in (its project dir is
  the slug of the start `cwd`), and `pi --session-id <id>` is a _project_ session id: both must
  be run at the listed `cwd`, which is why the first `cwd` is used, not the last.
- Under `devc web --live` the installed server doesn't know the new messages; testing needs
  `--live-yolo` or an updated `devc` (as for tasks).

### Page

- `sidebarState.sessionsOpen`: the local folders whose Sessions node is open, saved in
  `SIDEBAR_KEY` state. Default closed.
- The node row (depth 1, label `Sessions`) shows for every running container (`connected` or
  not), like Files. Opening it sends `list_sessions` and shows `Loading…` until the reply. Its
  hover action is a refresh icon (`Refresh sessions`) that re-sends `list_sessions`. Every open
  re-lists; the page keeps the last result per container to render while a new one loads.
- Rows (depth 2): the agent icon (`static/lib/agent_icons.js`), the title, and dimmed on the right
  the age: `now` under a minute, else `<n>m`, `<n>h` (under a day), `<n>d`. When the project has
  more than one repo, the age is preceded by the repo's name (`lib · 2h`).
- Empty result: a `No sessions` note row. A failure: a note row with the error message.
- Tooltip: `<title>\n\n<Agent label> · <updatedAt toLocaleString>\n<cwd>\n<session>\nClick to resume`.
- Click: sends `resume_session`, then places the pane in the focused stack, or focuses the tile
  already showing it (as a Sent entry's click). Errors show as a toast.
- Menu: `Resume session`, `Copy session id`.
- Pure helpers (age text, tooltip, result parsing) live in `static/lib/sessions.js`.

**Not in this plan:** opencode (no resume by id in `resumeTaskCommand`), stopped projects,
paging past 20, detecting sessions already open in other terminals, deleting sessions, a
Sessions view across all projects.

## Checklist

- [x] Step 0: in this container, record in this plan where `pi --name` and `copilot --name` store
      the session name (start one short session each where signed in); set the pi/copilot title
      rules above to match, or drop the name rule for an agent that stores none.
      **Result (2026-10-20):** pi 1.3.0 writes a line
      `{"type":"session_info",…,"name":"<name>"}` (second line of the file; `"name"` also occurs
      in tool schemas, so only `session_info` lines are read). copilot 1.0.100 (not signed in
      here, but the session is still created) writes `name: <name>` and `user_named: true` into
      `workspace.yaml`, and an `events.jsonl` beside it. The probe sessions were deleted.
- [x] `devc/web/sessions.ts` (new): `MAX_SESSIONS`, prefix helpers, `SCRIPT`, output parser,
      `cwd` filter + merge, `listAgentSessions(info, repos, run = runDocker)`
- [x] `devc/web/protocol.ts`: `list_sessions`, `resume_session` types and parser cases
- [x] `devc/web/server.ts`: handlers, per-container last listing, resumed-pane map, cleanup when
      a container's session goes
- [x] `devc/web/static/lib/sessions.js` (new) + `app.js` + `style.css`: the Sessions node, rows,
      refresh, menu, sidebar state
- [x] `devc/deno.json`: add `web/sessions.ts` to the `check` task
- [x] Tests: `devc/tests/web_sessions_test.ts` (new), `devc/tests/web_sessions_page_test.ts` (new)
- [x] `devc/README.md` devc web section: a **Sessions** bullet after **Tasks**

## Validation

- [x] `cd devc && deno task check && deno task test` pass
- [x] `deno fmt --check` passes for every touched file
- [x] Unit tests cover: both prefix helpers on the examples above; the parser on fixed script
      output (title precedence per agent, escaped quotes and `\n` in titles decoded, a bad uuid,
      a relative or missing `cwd`, garbage lines dropped); the `cwd` filter (`/workspaces/app`
      matches `/workspaces/app` and `/workspaces/app/sub`, not `/workspaces/app2`); the 20 cap and
      newest-first order across agents; title cut at 80 with `…`; both message parsers (unknown
      agent, `opencode`, non-uuid `session`, missing `container`); age text at 30 s, 5 min,
      3 h, 2 d
- [x] The script, run for real with `sh` in this container against copies of real session files
      in a scratch `HOME` (one per agent, plus one Claude session from another folder and one
      Claude `<uuid>/subagents` folder), lists exactly the expected sessions with the right
      titles and `cwd`s; run it once more under `busybox sh` if `busybox` is available
- [x] Against this container's real (shared) homes, the script for repo `/workspaces/tools/devc-tools`
      finishes in under 2 s and lists this repo's recent Claude sessions
- [x] Resume works from the listed `cwd`: `claude -p --resume <id> 'Reply OK'` and
      `pi -p --session-id <id> 'Reply OK'` for a listed session each recall that session; copilot
      too if signed in here (record any that could not be run)
- [x] Headless browser against the page with a fake WebSocket: the Sessions node sits between
      Terminals and the repos and starts closed; opening it sends `list_sessions` and shows the
      rows with icon, title and age (repo name shown for a two-repo project); refresh re-sends;
      `No sessions` for an empty result; a click sends `resume_session` and places the pane;
      a `reused: true` reply focuses the existing tile; the menu has both items
- [x] Ask the user to check, in their tab: open Sessions on a running project, resume a Claude
      session they recognise, and see it continue in a new terminal named after it; click it
      again and see that terminal focused

## Verification (2026-10-20)

- `deno task check` passes; `deno task test`: 538 passed, 0 failed. `deno fmt --check` passes
  for every touched file.
- The real script runs in `web_sessions_test.ts` against a scratch `HOME` (one session per
  agent plus a Claude session from another folder, one under `-workspaces-app2`, a
  `<uuid>/subagents` file, a non-uuid file name and a Copilot session elsewhere): exactly the
  expected five, with titles and `cwd`s. `/bin/sh` here is `dash`; **BusyBox is not installed**,
  so the BusyBox run was not done (the script uses only `stat -c`, `grep -E -o -m1 -F`, `sort`,
  `uniq`, `awk`, `sed`, `head`, `tail`, which BusyBox has).
- Against this container's shared homes, for `/workspaces/tools/devc-tools` and
  `/workspaces/devc-dev`: 0.4 s, 20 Claude sessions, titles as Claude shows them.
- Resume, on throwaway sessions in a scratch folder (deleted afterwards): **claude** 2.1.304
  listed it and `claude -p --resume <id>` recalled it (this version also finds it from another
  folder; the start folder is still used). **pi** 1.3.0 listed its UUIDv7 session and
  `pi -p --session-id <id>` from that folder recalled it (`--model
  github-copilot/claude-haiku-4.5`: pi's default model is refused by the provider here).
  **copilot** 1.0.100 is not signed in here, so its resume could not be run.
- Headless Chromium (Playwright, installed for the run, with its system libraries) against
  `devc/web/static` with a fake WebSocket: 17 checks pass. Sessions sits between Terminals and
  Repos, starts closed and lists nothing until opened; opening sends `list_sessions` for the
  container; rows show icon, title and `app · 2h` / `lib · 3d` for a two-repo project, and the
  tooltip; refresh re-sends; a click sends `resume_session` with only container, agent and
  session, and opens a tile; a `reused: true` reply opens no new tile; the menu has both items;
  an empty result reads `No sessions`; `sessionsOpen` is saved; no page errors. Session rows
  first rendered one step deeper than terminal rows (a chevron slot) and were changed to put the
  icon in that slot, as Sent rows do.
- Beyond the plan: a reconnect (`hello`) clears the page's lists so open Sessions rows list
  again, and a `not_found` from `resume_session` re-lists with a toast, since the server's
  listing is in memory and lost on restart.
- **Confirmed by the user (2026-10-20)** in their own tab: a real listing and resume in a running
  container work. (There is no Docker where this was built, so that part could only be checked
  there.)

## Relevant Files

- `devc/web/sessions.ts` (new)
- `devc/web/agents.ts` (export the uuid check if `sessions.ts` needs it)
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/app.js`
- `devc/web/static/lib/sessions.js` (new)
- `devc/web/static/style.css`
- `devc/web/static/lib/sidebar.js` (Collapse all closes Sessions rows too)
- `devc/tests/web_sidebar_test.ts`
- `devc/deno.json`
- `devc/tests/web_sessions_test.ts` (new)
- `devc/tests/web_sessions_page_test.ts` (new)
- `devc/README.md`
- `.plans/PLAN.md`
