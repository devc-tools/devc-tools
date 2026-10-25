# devc-web-activity-tracking

## Checklist

- [ ] `devc/web/activity.ts` (new, pure where possible): event types, the append-only log writer,
      the reader, and `rollupDay`. Tests in `devc/tests/web_activity_test.ts` (new)
- [ ] `devc/web/server.ts`: records `server`, `agent`, `pane`, `input` and `focus` events (see
      Contracts); writes rollups; prunes old raw logs
- [ ] `devc/web/protocol.ts`: new client message `page_state`. Tests in
      `devc/tests/web_server_test.ts`
- [ ] `devc/web/static/tiles.js`: sends `page_state` on connect and on every visibility or focus
      change (pages with a tiling area: `/` and `/main`)
- [ ] `devc time` CLI: `devc/main.ts` dispatch, `devc/help.ts`, and the command module (new)
- [ ] Docs: `devc/README.md` (a **Time tracking** section and `devc time`), the protocol table in
      `.plans/archived/devc-web.md`, and a pointer from `.plans/design/activity-tracking-proposal.md`
      to this plan
- [ ] Cockpit (`/workspaces/cockpit`, a separate repo): `scripts/dashboard.ts` reads the rollups
      when they are mounted (see "Cockpit"), and falls back to commits when they aren't

Records how time is spent, by the user and by agents, per Herdr pane. Each span is attributed to
container, repo, branch, agent and pane title. The source design and its reasoning are in
[design/activity-tracking-proposal.md](design/activity-tracking-proposal.md); this plan settles its
open questions (below). The first consumer is the user's cockpit dashboard, which today uses commit
counts as its measure of attention.

Read `.claude/skills/devc-web/SKILL.md` first. The user runs `devc web --live`: page edits reach
their tab immediately, and server code runs only under `--live-yolo` or an updated `devc`.

## Decisions (the proposal's open questions)

| # | Question              | Decision                                                                                                                                                                                                                           |
| - | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Coverage              | **Only while devc web runs.** The server records what it already observes. Gaps while it is down are real gaps; `server` events bound them                                                                                         |
| 2 | User activity sources | **devc web pages only:** input through any page (browser, devc-desktop, `/main` in VS Code's webview), counted only while that page is visible and focused. VS Code's own editor and a directly attached Herdr TUI are not counted |
| 3 | Idle timeout          | **5 minutes** with no input → idle. A hidden or unfocused page is idle at once                                                                                                                                                     |
| 4 | Reporting             | **`devc time`** (text table, `--json`) plus **daily rollup files** that other tools read                                                                                                                                           |
| 5 | Session ids           | **Not in v1.** No Claude hook. Attribution is container + repo + branch + agent + pane title. Exception: a pane started by **send task** carries its task's `sessionId` when the server already knows it                           |
| 6 | Container identity    | The project's **`localFolder`** (host path), as everywhere else in devc web                                                                                                                                                        |
| 7 | Retention             | Raw logs kept **90 days**, then deleted, but only once their day's rollup exists. Rollups are kept forever                                                                                                                         |
| 8 | Where                 | `~/.config/devc/activity/` (raw) and `~/.config/devc/activity/rollup/`                                                                                                                                                             |

## Concept boundaries

- **Not `usage.ts`.** "Usage" in devc web means account rate limits. This feature is **activity**:
  code says `activity`, never `usage` or `time tracking` in identifiers. The CLI command is `devc
  time` because that is what a person types.
- **State changes, not samples.** Events are written when something changes, except `input`, which
  is throttled. Spans are derived later, by `rollupDay`.
- **Agent status values** are Herdr's: `working`, `blocked`, `idle`, `unknown`. Only `working`
  and `blocked` count as time. `unknown` counts as idle.
- **Repo** is the pane's `cwd` mapped to its repo through the container's mounts, the same lookup
  devc web already uses to show a pane's repo. **Branch** is that repo's current branch from
  `gitWatch.statuses`, or null.
- **Local only.** Titles can hold sensitive task text. Nothing is sent anywhere. The log is in the
  user's devc config folder.
- **No change for pages talking to an old server.** Under `--live` the installed server doesn't
  know `page_state`. Check what that server does with an unknown message that has no `id`: the tab
  must show no toast or error because of it. If it would, guard the send (the server's `hello`
  can say `activity: true`).

## Contracts

### Raw log: `~/.config/devc/activity/YYYY-MM-DD.jsonl`

One JSON object per line, appended. The date is the event's local date on the host. Every event has
`t` (ISO 8601 with offset) and `e` (its kind).

| `e`      | Fields                                                                                                                           | Written when                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `server` | `state: 'start' \| 'stop'`                                                                                                       | devc web starts; devc web stops cleanly. Rollups treat a missing `stop` as one at the last event                                   |
| `agent`  | `container`, `pane`, `terminal`, `agent`, `status`                                                                               | Herdr's `pane.agent_status_changed` (the `onAgentStatus` hook in `server.ts`), and once per agent pane at startup                  |
| `pane`   | `container`, `pane`, `terminal`, `agent` (or null), `title`, `cwd`, `repo` (host path or null), `branch` (or null), `sessionId?` | First sight of a pane, and whenever any of `title`, `cwd`, `repo`, `branch` or `agent` changes (from snapshots and `pane_updated`) |
| `input`  | `container`, `pane`, `client`                                                                                                    | A page's `input`, `mouse` or `scroll` message for that pane, throttled to at most one per pane per client every 30 s               |
| `focus`  | `client`, `visible`, `focused`, `container?`, `pane?`                                                                            | A `page_state` message, an `active_pane` change from that client, or the client disconnecting (`visible: false, focused: false`)   |

`client` is a per-connection id (random, not the token). Writes are appends with no locking. A
line that is cut off or isn't valid JSON is skipped by the reader.

### `page_state` (page → server, no `id`)

`{ type: 'page_state', visible: boolean, focused: boolean }`, from `document.visibilityState ===
'visible'` and `document.hasFocus()`. Sent on connect (after `hello`), on `visibilitychange`, and on
window `focus` and `blur`. `protocol.ts`: both fields must be booleans.

### `rollupDay`

```ts
export interface ActivityRow {
  date: string; // YYYY-MM-DD
  container: string; // localFolder
  repo: string | null;
  branch: string | null;
  agent: string | null; // null on a user row
  title: string | null; // the title with the most time in this row's group (for display)
  userActiveMs: number;
  agentWorkingMs: number;
  agentBlockedMs: number;
}
export function rollupDay(
  date: string,
  events: ActivityEvent[],
  idleMs = 300_000,
): ActivityRow[];
```

Rules:

- **User time.** A span starts at an `input` and runs to the next `input` or `idleMs` after it,
  whichever comes first. It counts only while that client's latest `focus` says visible and
  focused, and only up to a `server` stop. It is attributed to the pane's `repo` and `branch` at
  that moment. Several clients active at once count once (take the union, per pane).
- **Agent time.** From each `agent` event to the pane's next one, ending at a `server` stop or the
  end of the day. `working` adds to `agentWorkingMs` and `blocked` to `agentBlockedMs`.
- Spans crossing midnight split at local midnight. Rows group by (container, repo, branch, agent);
  user rows have `agent: null`.

### Rollup files: `~/.config/devc/activity/rollup/YYYY-MM-DD.json`

`{ "version": 1, "date": "YYYY-MM-DD", "complete": boolean, "rows": ActivityRow[] }`.

The server rewrites today's file every 5 minutes and on stop (`complete: false`). At startup it
writes any missing or incomplete past day (`complete: true`), then deletes raw logs older than 90
days whose rollup is complete. Writes are atomic, as in `pinned_files.ts`.

### `devc time`

```
devc time [--days N] [--by repo|branch|agent] [--json]
```

- Default: the last 7 days, grouped by repo, as a text table with columns for your time, agent
  working and agent blocked, in hours and minutes, plus a total row.
- `--json` prints the rows as-is.
- It reads rollups and computes today from the raw log, so it works whether or not devc web is
  running.
- Listed in `help.ts`.

## Cockpit

The cockpit (`/workspaces/cockpit`, a separate repo, committed on its `main`) is the first
consumer.

- The cockpit's container can't see `~/.config/devc`. The user adds a read-only mount to the
  cockpit's machine-specific devc overlay (`/workspaces/cockpit/.devc/`, managed by `devc config`):
  `type=bind,source=${localEnv:HOME}/.config/devc/activity/rollup,target=/workspaces/.activity-rollup,readonly`.
  **Don't edit `.devc/` yourself.** Report this line to the user.
- `scripts/dashboard.ts`: when `/workspaces/.activity-rollup` exists and has files for the last 14
  days, the attention panel uses them. Each row's `repo` maps to a project through `cockpit.json`'s
  `repos`; anything unmatched counts as unplanned.
  - The heatmap cell is hours of user active time plus agent working time.
  - Share vs target is computed from hours.
  - Add an "Agents blocked on you" figure for today.
  - With no rollups, keep today's commit-based panel unchanged.
  - `--text` mode says which source it used.

## Verify

- `deno task check`, `deno task test` (in `devc/`), and `deno fmt --check` at the repo root.
- `rollupDay` tests: idle cutoff, page hidden mid-span, two clients overlapping, a missing `stop`,
  splitting at midnight, `unknown` status, and a cut-off last line.
- Run the server here with a stub `docker` (see the skill) and drive a page with `agent-browser`:
  input produces `input` events, hiding or blurring produces `focus` events, and the log and today's
  rollup appear.
- Check `page_state` inside a VS Code webview if one is available. If not, say it is unverified.
  Never touch the user's own Herdr session or panes.
- Cockpit: `deno task status` and the dashboard render with and without a rollup folder (use a
  temp folder of fixture rollups).
