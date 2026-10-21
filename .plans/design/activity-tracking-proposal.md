# Activity tracking — draft proposal

> **Status: draft, not a plan.** Nothing here is decided. It records the idea, what devc web can
> already observe, a candidate design, and the open questions to settle before writing a plan.
> Not listed in `.plans/plan.md`.

## Goal

Track time spent by the user and by agents, per Herdr pane:

- when an agent is working (and when it is waiting on the user),
- when the user is active, and which pane they are focused on,

with each span attributable to **container + repo + agent + title + session id**, plus whatever
other dimensions turn out to be meaningful (see [Other data worth recording](#other-data-worth-recording)).

## What devc web can already observe

| Signal | Source today |
|---|---|
| Agent working state | Herdr `pane.agent_status_changed`, already subscribed per container (`devc/web/herdr_bridge.ts`, `onAgentStatus` → `agent_status` messages in `server.ts`). Values seen: `working`, `idle`, `blocked`, `unknown`. Agent-agnostic: claude, copilot, pi, opencode. |
| Pane metadata | Herdr snapshot / `pane list`: `agent`, `agent_status`, `cwd`, `foreground_cwd`, `terminal_title_stripped`, `focused` (the Herdr TUI's focus), `pane_id`, `tab_id`, `workspace_id`, `terminal_id`, `label`. |
| User activity in the page | Every keystroke / mouse / scroll passes through the server as `input`, `mouse`, `scroll` client messages. |
| Page's focused pane | `active_pane` client message (already sent for devc-desktop's host terminal `cd`). |
| Container ↔ repo | Server knows each container's record (`localFolder`), its mounts, and maps container paths to host paths (`hostToContainerPath`, `repoContainerPath`). |
| Session id | **Not exposed by Herdr.** Known only for agents started via "send task" (`tasks.ts`, `sessionId`). |

Example `pane list` entry (agent pane):

```json
{"agent":"claude","agent_status":"working","cwd":"/workspaces/tools/devc-tools","focused":false,
 "pane_id":"w1:p5","tab_id":"w1:t5","terminal_id":"term_65e3d4e5251805",
 "terminal_title_stripped":"Time tracking for user and agent activity","workspace_id":"w1"}
```

### Joining a session id to a pane

Agents run with Herdr's env in the pane: `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`,
`HERDR_SESSION`, `HERDR_SOCKET_PATH`. A Claude Code hook (`SessionStart`, and probably
`UserPromptSubmit` to catch `/clear` and `--resume` changing the id) can write
`{hostname, pane_id, session_id, transcript_path, model}` to a file the server reads.

- The devc-shared Claude home (`~/.config/devc/.claude`) is bind-mounted into **every**
  container, and pane ids like `w1:p5` repeat across containers — so key by
  container identity (hostname, or something more stable) **and** pane id.
- Precedent: `scripts/devc-usage-tap` already writes a file from Claude's status line into the
  Claude home that `devc web` watches (`usage.ts`). A hook is preferable to the status line here
  because the status line only runs when it renders.
- Other agents (copilot, pi, opencode) would need their own equivalent, or go without a session id.

## Candidate design

The devc web server records **state changes** (not samples) to an append-only JSONL log on the
host, e.g. `~/.config/devc/activity/YYYY-MM-DD.jsonl`. Spans are derived at report time.

| Event | Fields |
|---|---|
| `agent` | ts, container, pane_id, terminal_id, agent, status |
| `pane_meta` (on change) | ts, container, pane_id, title, cwd, repo, branch, session_id, model |
| `focus` | ts, page's active pane (or none), page visible/hidden, window focused/blurred |
| `user_active` | ts, container, pane_id — throttled to at most one per N seconds; idle after a timeout with no input |

- **Repo** derived from pane `cwd` → git root → project / `localFolder` via the mounts the
  server already resolves.
- **Title** changes during a session (Claude retitles), so it is recorded on change and
  attributed to spans at report time.
- **Visibility/focus** of the page matter: a focused pane in a hidden tab is not user time.
- `terminal_id` is likely more unique over time than `pane_id`; record both.

## Other data worth recording

- **Blocked / waiting-on-user time** — how long an agent sits in `blocked` (or `idle` after
  `working`) before the user responds. Probably the most useful number after working time.
- **Concurrency** — how many agents are working at once, and whether the user was watching one
  of them.
- **Branch** — time per feature, often more useful than time per repo.
- **Claude's own numbers** from the status-line JSON: `cost.total_cost_usd`,
  `cost.total_api_duration_ms`, `cost.total_duration_ms`, lines added/removed. A cross-check on
  Herdr's notion of "working".
- **Task link** — agents started with "send task" can attribute time directly to the task.

## Known limitations

1. **Nothing is recorded while devc web isn't running.** Agents keep working in their
   containers unobserved. The alternative is a small in-container recorder subscribing to Herdr
   — more complete, but one log per container to gather and merge.
2. **Input outside the page is invisible**: a directly attached Herdr TUI or VS Code. Only Herdr's
   `focused` flag is visible for the TUI.
3. **Titles may contain sensitive text** (task descriptions). The log stays local.
4. **Herdr's `agent_status` is heuristic**; `unknown` needs a policy (count as idle?).

## Open questions

1. **Coverage:** is "only while devc web runs" acceptable, or is an in-container recorder needed?
2. **User activity sources:** page input only, or also the Herdr TUI / VS Code (and how)?
3. **Idle timeout** for user activity (2–5 min?), and whether hidden-but-focused counts.
4. **Reporting surface:** `devc time` CLI report, a devc web view, CSV/JSON export — which, and
   grouped how (day / repo / branch / agent / session)?
5. **Session ids for non-Claude agents:** needed, or Claude-only for now?
6. **Container identity** for the hook's key: hostname, container id, or devc's record id?
7. **Retention:** keep forever, rotate, or roll up old days into summaries?
8. **Where the log lives** — `~/.config/devc/activity/`, or somewhere already backed up/synced?
