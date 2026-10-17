# devc-web-open-tab-here

- [ ] Server: `startSession` reports failure (with the tail of Herdr's server log) when the session doesn't come up
- [ ] Server: `open_tab` message: start the session if needed, then reuse a tab already at the folder or create one, with tests for the matching
- [ ] Protocol: `open_tab` in `protocol.ts` and its tests; `.plans/devc-web.md` protocol table
- [ ] Page: "Open Herdr tab here" and "New Herdr tab here" on repo rows and directory rows, replacing "New shell here"
- [ ] Page: the opened pane is focused if it's already in a tile, else placed in the focused stack
- [ ] Verify (below) and ask the user to try it in their open tab

Open a Herdr tab at any folder of a project from the `devc web` sidebar. It uses the project's
Herdr session (`devc` unless `devc web --session` says otherwise), starting it if the container
has none yet. Then it switches to a tab already sitting in that folder, or creates one there.

Today "New shell here" (directory menu) only works while the container is `connected`, and it
always creates a new tab. Clicking **Start Herdr** on a `no-session` container reports success
even when no server came up after its ~6 s of retries, so the row silently stays "no session".

Depends on [devc-web-repos-group](archived/devc-web-repos-group.md), which makes a `no-session`
container expandable so its folders can be reached. Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first. This is a protocol change, so it
needs `devc web --live-yolo` (or an updated `devc`). Save the server side first.

**Not in this plan:** starting a **stopped** container to open a tab in it (the menu item says
"Start the container first", as Open in editor does). Choosing a Herdr workspace (tabs go where
`tab.create` puts them without a `workspace_id`, as "New shell here" does now).

## Concept boundaries

- **Herdr tab vs layout tab.** A Herdr tab (`tab.create`, `tab_id`) is inside the container's
  Herdr session. A Golden Layout tab is a tile header in the page. "Open Herdr tab here" creates
  or finds a **Herdr** tab, then shows its pane in a tile. Menu text says "Herdr tab" for that
  reason.
- **`open_tab` vs `new_shell` vs `open_file` vs `open`.** `new_shell` always creates (it stays,
  used by pane and workspace menus). `open_tab` may reuse. `open_file` runs `$EDITOR`. `open`
  attaches a tile to a pane stream. Keep all four.
- **Session start vs container start.** `open_tab` may start a Herdr **server** (`startSession`)
  inside a running container. It never starts the container.
- **Which tab is "at the folder" (shells only).** A pane that has no `agent` field and whose
  `cwd` (the shell's directory, from the snapshot) equals the folder's container path, compared
  after removing a trailing `/`.
  - **Agent panes never count.** "Open Herdr tab here" always lands in a shell and never jumps
    into a running agent. To reach an agent, use its pane row.
  - **`foreground_cwd` is not used.** A shell running a tool in a subfolder still belongs to
    its shell's folder. A shell running something in the foreground (an editor, a dev server)
    still counts.
  - **`cwd` follows `cd`.** A tab whose shell has moved elsewhere no longer counts, and a new
    tab is created.
  - **Several matches:** the lowest-numbered tab wins (snapshot order).
  - **Unverified:** that Herdr's `cwd` is the shell's directory and `foreground_cwd` the
    foreground process's. Confirm in a throwaway session first (see Verify). If `cwd` turns out
    to track the foreground process too, stop and report rather than picking another field.

## Existing touchpoints

| File                                                                  | Role                                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/herdr_bridge.ts`                                            | `ContainerSession.startSession` / `#awaitServer` (`START_SESSION_TRIES`, `START_SESSION_WAIT_MS`), `createShell`, `runText`. |
| `devc/web/server.ts`                                                  | The `start_session` / `new_shell` / `open_file` cases; `isProjectRepo`, `confine`, `hostToContainerPath`, `mountsOf`.        |
| `devc/web/protocol.ts`                                                | `ClientMessage` union and parser.                                                                                            |
| `devc/web/files.ts`                                                   | `confine`.                                                                                                                   |
| `devc/web/static/app.js`                                              | `dirMenuItems`, repo row menu, `createPane`, `placeInFocusedStack`, tiles lookup by `PaneRef`.                               |
| `devc/tests/web_server_test.ts`, `web_bridge_test.ts`, protocol tests | Tests to extend.                                                                                                             |
| `.plans/devc-web.md`                                                  | Protocol table.                                                                                                              |

## Contracts

### Session start failure

`ContainerSession.startSession()` throws when, after the retries, the state is still
`no-session`:

```ts
new BridgeError(
  'no_session',
  `Herdr didn't come up in ${seconds}s.\n${logTail}`,
);
```

- `logTail` is the last 10 lines of `~/.config/herdr/sessions/<session>/herdr-server.log` in the
  container, read with `docker exec -u <user> <id> tail -n 10 <path>` (`~` resolved by the
  user's shell: `sh -c 'tail -n 10 "$HOME/.config/herdr/sessions/$1/herdr-server.log"' _ <session>`).
  Empty when unreadable.
- The wait grows to about 15 s (`START_SESSION_TRIES` × `START_SESSION_WAIT_MS`). Herdr's first
  start in a fresh container can be slow.
- `start_session` then replies `ok: false, error: {code: 'no_session', message}`. The page shows
  it as a toast (as it does for other `start_failed` errors).

### Browser → server

| Message    | Fields                                              | Server does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_tab` | `id`, `container`, `root`, `path`, `reuse: boolean` | (1) `root` must be one of that container's project's repo folders (`isProjectRepo`), else `bad_request` `unknown repo`. `confine(root, path)` must be a directory, else `forbidden` / `not_found` / `bad_request`. Translate with `hostToContainerPath`; `null` → `not_mounted`. (2) Container state: `connected` → go on. `no-session` → `await startSession()` (its error is the reply). `connecting` → wait for `connected` or another state, up to the same ~15 s, else `not_ready`. Anything else (`no-herdr`, `unsupported`, `error`) → `herdr_unavailable` with the session's error text. (3) When `reuse`, look in the session's current snapshot for a pane at the folder (see Concept boundaries); found → reply `{pane_id, tab_id, reused: true}`. (4) Otherwise `createShell(target, {cwd})` → `{pane_id, tab_id, reused: false}`. |

```ts
// devc/web/herdr_bridge.ts (pure, tested)
/** The shell pane (no `agent`) whose `cwd` is `dir` (a container path), by the rule in the plan, or null. */
export function paneAtFolder(
  snapshot: Record<string, unknown> | null,
  dir: string,
): { pane_id: string; tab_id: string } | null;
```

Tests for `paneAtFolder`: no snapshot, no match, a trailing-slash match, two matches (lowest
tab number wins), a `foreground_cwd` match that must not count, and an agent pane at the folder
that must not count (with and without a shell beside it).

### Page

- **Repo row and directory row menus**, while the project's container is running (any Herdr
  state):
  - **Open Herdr tab here** → `open_tab` with `reuse: true`.
  - **New Herdr tab here** → `open_tab` with `reuse: false`.
  - These replace "New shell here" in these menus. Pane and workspace menus keep their
    `new_shell` items.
  - When the container isn't running, both items show a toast "Start the container first".
  - When the container is `no-session`, a toast "Starting Herdr…" shows while the request is in
    flight.
- **Placement:** if a tile already shows the replied pane (`reused: true` and a tile with that
  `PaneRef`), focus that tile. Otherwise place it with `placeInFocusedStack`, through the
  `createPane` path, so a pane Herdr hasn't listed yet gets the same grace period.
- **The reply can arrive before the page has seen the container turn `connected`** (it was
  `no-session` a moment ago). `createPane`'s placement must not depend on the container's state
  at reply time. The tile attaches once the `containers` / `snapshot` messages catch up.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno check main.ts && deno task check && deno task test
cd .. && deno fmt --check
```

Herdr behaviour without the user's session: a throwaway session in this container (see the
devc-web skill) to confirm `tab.create` with `cwd`, and how `cwd` and `foreground_cwd` differ: in
a shell, `cd /tmp` then run `(cd /etc && sleep 30)`; while it sleeps, `pane list` should show
`cwd` `/tmp` and `foreground_cwd` `/etc`.

Then ask the user, under `--live-yolo`:

1. On a running container, right-click a folder → Open Herdr tab here. A tab opens there.
   Do it again: the same tile is focused, with no second tab.
2. New Herdr tab here on the same folder creates a second tab.
3. Open Herdr tab here on the folder an agent is running in, with no shell there: a new
   shell tab opens; the agent's tile isn't focused.
4. On a container showing "no session", Open Herdr tab here starts Herdr, the row turns
   connected, and the tab opens in that folder.
5. Open Herdr tab here on a repo row (a mounted sibling repo) opens in that repo's container
   path.
6. If Herdr doesn't come up, Start Herdr and Open Herdr tab here both show an error toast with
   the log's last lines, not silence. (Hard to cause on demand. The unit tests cover the throw,
   with `runText` stubbed.)
