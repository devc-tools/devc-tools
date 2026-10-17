# devc-web-usage

Show the account-wide agent usage limits (Claude's 5-hour and 7-day windows first) once,
globally, in `devc web` — fresh from whichever session reported last, instead of the
stale number in each idle session's status line.

## Checklist

- [ ] Capture one real status-line input and confirm the `rate_limits` shape and the
      `resets_at` unit (see "Verify first")
- [ ] Reporter: `scripts/devc-usage-tap` (or a documented snippet) that turns status-line
      JSON into the usage file
- [ ] Server: `web/usage.ts` (pure parse + watch), with tests
- [ ] Server: `usage` message sent on connect and on every change (`server.ts`)
- [ ] Spec: add `usage` to the protocol table in `.plans/devc-web.md`
- [ ] Page: usage in the host status strip (from `devc-web-bridge-status`)
- [ ] Docs: `devc/README.md` — how to wire the reporter into a status line
- [ ] Verify: `deno check main.ts`, `deno task check`, `deno task test`, `deno fmt --check`
- [ ] Manual (user, host): two containers, use one, the strip updates; leave both idle past
      `resets_at`, the strip shows "reset" rather than the old percentage

## Why this shape

- **The only source is the status line.** Claude Code hands `rate_limits` to the
  `statusLine` command on stdin (the user's `~/.claude/statusline.sh` already prints
  `rate_limits.five_hour.used_percentage`). Hooks don't get it, and Herdr doesn't have
  it: `herdr agent list` / `api snapshot` carry `agent`, `agent_status` and titles, no
  usage. So something in the status-line path has to write it down.
- **The numbers are account-wide**, so per-session values are just observations of
  different ages. The newest observation is the truth; the status line only runs when a
  session is active, which is why idle panes go stale. "Last writer wins" on one shared
  file gives exactly "newest observation".
- **`~/.claude` is already the host's**: devc bind-mounts the host's `~/.claude` into
  every container (`/home/vscode/.claude` here), and host-side Claude sessions use it
  too. A file written there by any session, in any container or on the host, is
  directly readable by the host's `devc web` server. No docker exec, no polling
  containers, no bridge round-trip.
- **Staleness is visible, not hidden**: each window carries `resets_at`, so once it
  passes the page knows the shown percentage no longer applies, and the observation's
  age is shown.

Context-window % is per session and is **not** part of this plan.

## Verify first

Run one session with a status line that also dumps its stdin (e.g. `tee` to the
scratchpad) and record the actual shape. Expected (from Claude Code's status-line docs,
to confirm):

```json
"rate_limits": {
  "five_hour": { "used_percentage": 42.0, "resets_at": 1760000000 },
  "seven_day": { "used_percentage": 18.0, "resets_at": 1760400000 }
}
```

`rate_limits` is absent early in a session and on non-subscription auth. Confirm whether
`resets_at` is epoch seconds or an ISO string, and whether a status line re-render can
happen while the session is idle (it would re-report an old value as new; see Risks).

## Existing touchpoints

| File                                                | Role                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `~/.claude/statusline.sh` (user's, not in the repo) | gains one line piping its input to the reporter; the user makes this edit                       |
| `scripts/` (repo root)                              | home for `devc-usage-tap` if it ships as a script; otherwise the README snippet is the reporter |
| `devc/web/server.ts`                                | `watchProjectsFile()` precedent; add the usage watch beside it and the bridge-status watch      |
| `devc/web/static/app.js`                            | `onmessage` switch; the host status strip added by `devc-web-bridge-status`                     |
| `devc/web/static/style.css`                         | strip styling                                                                                   |
| `.plans/devc-web.md`                                | protocol table                                                                                  |
| `devc/README.md`                                    | wiring instructions                                                                             |

## Contracts

### Usage file (written by reporters, read by devc web)

Path, per agent: `<agent home>/devc-usage.json`. For Claude: `~/.claude/devc-usage.json`.
Written atomically (temp file in the same dir, then rename).

```json
{
  "v": 1,
  "agent": "claude",
  "observed_at": 1760000123,
  "windows": [
    {
      "id": "five_hour",
      "label": "5h",
      "used_percentage": 42.0,
      "resets_at": 1760000000
    },
    {
      "id": "seven_day",
      "label": "7d",
      "used_percentage": 18.0,
      "resets_at": 1760400000
    }
  ]
}
```

- Times are epoch **seconds** (convert on write if the source differs). `resets_at` may be
  `null`.
- `windows` keeps the source's order; include every window present (e.g. a future
  `seven_day_opus`), using the source key as `id` and a short `label`. Window length is
  not fixed: Claude reports 5h and 7d today, while other agents' quotas may be monthly
  (Copilot's premium requests reset monthly), so the page must render any window
  generically from `label`, `used_percentage` and `resets_at`, never by known `id`.
- `used_percentage` means "share of this window's limit already used" (0–100; 100 = limited).
- The reporter **never writes when `rate_limits` is absent or empty** (it would erase a
  good observation), never prints to stdout (it runs inside the status line), and never
  fails the status line (exit 0, errors swallowed).

### Reporter `devc-usage-tap`

`devc-usage-tap` reads one status-line JSON object on stdin and writes
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/devc-usage.json`. Requires only `jq`. Wired as:

```bash
input=$(cat)
printf '%s' "$input" | devc-usage-tap &
```

Whether it is installed by the `agents` Feature or kept as a README snippet is the
implementer's call; if it goes into the Feature, follow PLAN.md's standing Feature rules
(own version bump, `"agents": {}` still installs cleanly).

### Server module `devc/web/usage.ts`

```ts
export interface UsageWindow {
  id: string;
  label: string;
  usedPercentage: number;
  resetsAt: number | null;
}
export interface UsageSource {
  agent: string;
  observedAt: number;
  windows: UsageWindow[];
}
/** Validates a parsed file; null for anything malformed or with an unknown `v`. */
export function parseUsageFile(json: unknown): UsageSource | null;
export function watchUsage(
  files: string[],
  onChange: (sources: UsageSource[]) => void,
): { stop(): void };
```

- `files` for v1: `[~/.claude/devc-usage.json]` (honor `CLAUDE_CONFIG_DIR` on the host).
  The list is the extension point for other agents.
- Watch each file's directory (the file is replaced by rename and may not exist yet),
  debounced, never throws, never creates the directory. Malformed or missing files are
  simply absent from `sources`.

### WebSocket message (server → browser)

| `type`  | Fields                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage` | `sources: [{agent, observedAt, windows: [{id, label, usedPercentage, resetsAt}]}]` (times epoch s). Sent on connect after `projects` and on every change; broadcast |

### Page

- Per source, per window: `5h 42%` with a title/tooltip giving the reset time and the
  observation age ("as of 4 min ago"). Re-evaluate on a minute timer, page-side, with no
  server traffic:
  - `resetsAt` in the past → show the window as reset (e.g. `5h —`, tooltip "reset at
    15:10, no newer report"), never the old percentage.
  - Optional: visually de-emphasize when `observedAt` is older than ~15 min.
- No sources yet (no session has reported) → show nothing for usage. Pure formatting (age, reset state) goes in `web/static/lib/` with a test.

## Concept boundaries

- **"usage" vs "context"**: this is the account's rate-limit usage
  (`rate_limits.*.used_percentage`), not the per-session context window
  (`context_window.used_percentage`). Don't name anything `context*`.
- **`agent` / `agent_status`** in the protocol are Herdr's per-pane detection
  (`agent_status` message). A usage source's `agent` is just the name of whoever wrote
  the file; it is not joined to panes.
- Not to be confused with Claude Code's own `/usage` command or the Anthropic API's
  `usage` (token counts) objects.

## Other agents

There is no shared API: Herdr exposes no usage, and each CLI reports (or doesn't)
differently. The file contract is the generic layer — any agent whose status line,
extension or hook can see its limits writes `<its home>/devc-usage.json` in the same
shape, and devc web adds the path to its list. Candidates to check later: pi (an
extension in `pi-dev-extensions` could write it), Copilot CLI (`~/.copilot`, mounted the
same way). Out of scope here.

## Alternative considered

Polling the account's usage directly from the host (the endpoint behind Claude Code's
`/usage`) would be fresh even with no session running, but it is undocumented and needs
the OAuth token from the host's credential store. Not pursued.

## Risks

- If Claude Code re-renders the status line while idle with an old `rate_limits`, that
  session re-stamps an old value as new. `resets_at` bounds the damage (a passed reset
  still shows as reset). If "Verify first" shows idle re-renders happen, have the reporter
  skip the write when its values equal what that session last wrote (cache keyed on
  `session_id` under `$TMPDIR`).

## Compatibility

devc web is greenfield: no compatibility with older installed servers or pages is
required, and a contract change needing a server restart is expected. Change server and
page together. The one constraint is the live tab: until the new message arrives the page
just lacks the feature; it must not throw or break the sidebar. Depends on `devc-web-bridge-status` for the
strip (or creates it if that plan has not landed).
