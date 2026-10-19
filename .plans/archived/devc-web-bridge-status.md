# devc-web-bridge-status

Show devc-bridge's state in `devc web`: whether the bridge is running, and whether
keepawake (`caffeinate`) is currently holding the host awake.

## Checklist

- [x] Server: `web/bridge_status.ts` (pure read + watch), with tests
- [x] Server: `bridge_status` message sent on connect and on every change (`server.ts`)
- [x] Spec: add `bridge_status` to the protocol table in `.plans/devc-web.md`
- [x] Page: host status strip in the sidebar
- [x] Verify: `deno check main.ts`, `deno task check`, `deno task test`, `deno fmt --check`
- [ ] Manual (user, host): strip flips to "awake" within a second of a ping, back to idle after
      `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS`

## Why this shape

The bridge already has a generic "is anything active" mechanism, and the tray and
`devc-bridge status` both read it: **every file in the bridge's state dir is an active
marker** (`scanActive` in `devc-bridge/host/core.ts`). The shipped `caffeinate` command
(`devc-bridge/host/commands/caffeinate`) writes its pid to `<state>/caffeinate` on
`start` and removes it on `stop`. So devc web, which runs on the same host as the
bridge, can show the same thing by watching the same directory — no new bridge
endpoint, no token, no change to devc-bridge at all.

Deliberately **not** in v1: the keepawake countdown (`KeepawakeStatus.remainingMs`).
It lives only in the bridge process's memory and would need a new authenticated
query on the bridge's TCP protocol. See "Follow-on" below.

## Existing touchpoints

| File                         | Role                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc-core/bridge.ts`        | `BRIDGE_BASE_SUBPATH` (`.config/devc-bridge`): reuse it for the base path                                                                                                   |
| `devc-bridge/host/config.ts` | `loadConfig()`: the authority on paths. Mirror its overrides: `DEVC_BRIDGE_BASE` (base), `DEVC_BRIDGE_STATE` (state dir, default `<base>/state`), pidfile `<base>/tray.pid` |
| `devc-bridge/host/core.ts`   | `scanActive()`: semantics to match (regular files only, sorted names)                                                                                                       |
| `devc-bridge/host/main.ts`   | `status()` / `readPid` / `pidAlive`: precedent for "running" (pidfile exists and the pid is alive)                                                                          |
| `devc/web/server.ts`         | `watchProjectsFile()`: the precedent for a debounced, never-throwing directory watch. Add the bridge watch beside it and broadcast on change                                |
| `devc/web/static/app.js`     | `onmessage` switch (`case 'hello'`, …) and `renderTree()` for the sidebar                                                                                                   |
| `devc/web/static/style.css`  | strip styling                                                                                                                                                               |
| `.plans/devc-web.md`         | § "Browser ⇄ server WebSocket protocol" table                                                                                                                               |

## Contracts

### Server module `devc/web/bridge_status.ts`

```ts
export interface BridgeStatus {
  /** Pidfile present and its pid alive. */
  running: boolean;
  /** Sorted names of regular files in the state dir, e.g. ["caffeinate"]. [] when none or no dir. */
  active: string[];
}
export function bridgeStatePaths(
  env: { get(k: string): string | undefined },
  home: string,
): { stateDir: string; pidfile: string };
export function readBridgeStatus(
  paths: { stateDir: string; pidfile: string },
): Promise<BridgeStatus>;
export function watchBridgeStatus(
  paths: { stateDir: string; pidfile: string },
  onChange: (s: BridgeStatus) => void,
): { stop(): void };
```

- Never throws. A missing base or state dir is `{running: false, active: []}`.
- `watchBridgeStatus` watches the state dir (marker changes) and the base dir
  (pidfile appearing/going), debounced like `watchProjectsFile`, and only calls
  `onChange` when the status actually differs. Directories that don't exist yet: retry
  creating the watch on a slow timer (e.g. 30 s) rather than `mkdir`-ing the bridge's
  directories — devc web must not create devc-bridge's tree.
- A bridge that dies without removing its pidfile leaves `active` stale too (the
  caffeinate pidfile survives a `kill -9`). Re-read on a slow timer (30 s) as well as on
  watch events so `running` corrects itself.

### WebSocket message (server → browser)

| `type`          | Fields                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `bridge_status` | `running` (bool), `active` (string[]). Sent on connect after `projects`, and on every change; broadcast to every client |

Add the row to the spec table. No browser → server message.

### Page

- A compact host status strip in the sidebar (top or bottom; implementer's choice, keep
  it one line). Shows e.g. `bridge ●` / `bridge ○ off`, and `☕ awake` when `active`
  includes `caffeinate`. Other active marker names show as text (they come from the
  host filesystem: insert as text, never HTML).
- The strip is the shared home for host-level indicators; `devc-web-usage` adds to it.

## Concept boundaries

- **"bridge"** in `devc/web/` already means Herdr's `remote-api-bridge`
  (`web/herdr_bridge.ts`, `BridgeError`, `bridgeRequest`). Name everything here
  `bridge_status` / `BridgeStatus` / "devc-bridge" in prose, and keep it out of
  `herdr_bridge.ts`.
- **`devc/bridge.ts`** is devc's devc-bridge _policy/pin_ integration (keys, policy
  files). This feature only reads the state dir and pidfile; don't route it through
  `devc/bridge.ts`.
- **keepawake vs caffeinate**: keepawake is the bridge's ping/idle state machine;
  `caffeinate` is just the default command it drives (`DEVC_BRIDGE_KEEPAWAKE_COMMAND`).
  The page keys its "awake" label on the marker named `caffeinate`, and shows any other
  marker name verbatim.
- **herdr-plugins' `caffeinate`** (`caffeinate-grace-tuning`, `bridge-keepawake`) is a
  _client_ that pings the bridge; it is not what the page reads.

## Compatibility

devc web is greenfield: no compatibility with older installed servers or pages is
required, and a contract change needing a server restart is expected. Change server and
page together. The one constraint is the live tab: until the new message arrives the page
just lacks the feature; it must not throw or break the sidebar.

## Follow-on (not this plan)

Countdown ("awake, 3m left"): add a `keepawake-status` request to the bridge's TCP
protocol that returns `KeepawakeStatus`, authenticated with the shared run token
(`<base>/run/token`, host-readable). devc web would then query it on each state-dir
change and at a slow cadence while active.
