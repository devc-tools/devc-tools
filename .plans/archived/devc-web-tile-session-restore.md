# devc web tile session restore — terminal tiles resume their agent session after a container rebuild

A terminal tile saves only `{localFolder, pane_id}`. When a container is rebuilt or restarted, its
Herdr server starts over, the old pane ids are gone, and every agent tile shows "closed". The agent
sessions themselves survive: devc bind-mounts the agent homes, and `resume_session` can already
resume a session in a new pane.

This plan stores the agent session that runs in each tile's pane on the tile's saved ref, as
metadata. When the pane is gone because the container restarted, the tile resumes that session in
a new pane and points itself at it. The tile keeps its place, size and stack.

## Rules (observable behavior)

1. **Metadata only.** `PaneRef.session` never changes what a tile shows while its pane exists. The
   title, badge, tooltip and context still come from the live pane (`refLabel`, `resolveRef`,
   `refTooltip`, `tileContext`). It is read only when the pane is missing.
2. **Auto-resume only after a restart.** A tile whose pane is missing resumes its session when the
   container is `connected`, the tile has `ref.session`, no resume is in flight for it, and either
   of these holds:
   - **A. Rebuilt:** `ref.session.container !== c.id`, so the container now has a new id.
   - **B. Restarted under the same id:** this page saw the container leave `connected` and come
     back, and the pane is missing from the first snapshot after that reconnect.

   Otherwise a missing pane keeps today's "closed" overlay. That covers a pane the person or the
   agent ended while the container kept running. When a live snapshot (not the first after a
   reconnect) drops a pane a tile shows, the client removes that tile's `ref.session`, so a later
   reload never revives a pane that was closed on purpose.
3. **One process per session.** Several tiles, windows or devc-desktop panes can all resume the
   same session at once. They all end up on one pane, and the server never starts a second agent
   process on the session.
4. **Failure is visible and manual.** If a resume fails (not installed, not found, Herdr error),
   the tile's overlay shows `Couldn't resume <agent> session: <message>` with a **Resume** button
   that tries again. Failed resumes are never retried automatically.
5. **Known sessions only.** A pane has a session when devc web started or resumed it (task send,
   `ask_agent`, `resume_session`), or when it runs a live Claude process (`env.runningAgents()`).
   Copilot and pi sessions started by hand have no known id, so their tiles keep the "closed"
   behavior.

## Contracts

### `PaneRef` (`static/lib/layout_state.js`)

```js
/** @typedef {{agent: 'claude' | 'copilot' | 'pi', id: string, container: string}} PaneSession */
/** @typedef {{localFolder: string, pane_id: string, session?: PaneSession}} PaneRef */
```

- `id` must be a lowercase uuid (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`,
  as `isSessionId` in `web/agents.ts`). `container` is the container id the session was recorded
  under and must be non-empty. `agent` must be one of the three ids.
- **Gotcha:** `paneRefFromState` (around line 70) and the pane branch of the tile serializer
  (around line 330) rebuild refs field by field, so they currently drop anything else. Both must
  carry `session` through. An invalid `session` is dropped, and the ref stays valid without it.
- Tile identity is unchanged: tile matching (`t.ref.pane_id === ref.pane_id`, around line 260) and
  `paneKey` ignore `session`.

### Server → client: `pane_sessions` (`web/protocol.ts`)

```ts
| {
  type: 'pane_sessions';
  container: string; // container id
  sessions: { pane_id: string; agent: SessionAgentId; session: string }[];
}
```

- The server sends it to a client right after that client gets the container's `snapshot`. It
  broadcasts it whenever a container's map changes.
- The map for container `id` lists only panes in the current snapshot. Entries come from these
  sources, in order of precedence:
  1. `resumedPanes` entries for `id`
  2. `taskState.sent` entries with `last.containerId === id` (using their `agent` and `sessionId`)
  3. `env.runningAgents()` rows whose `herdrSession` is the container's Herdr session
- Probe for source 3 after a snapshot that contains a pane with `agent === 'claude'` that isn't
  mapped by sources 1 or 2. Probe at most once per 5 s per container (trailing call kept), and
  never throw: a failed probe leaves the map as it was.
- No protocol version bump: `PROTOCOL` (`static/lib/protocol_version.js`) covers only the
  messages devc-desktop's bundled Containers code relies on, and a bump blanks older bundles. A new
  message is ignored by clients that don't know it. `web/protocol.ts` types only client messages,
  so it is unchanged.

### Client (`static/tiles.js`, `static/client.js`)

- **Keep the map.** `client.js` keeps the latest `pane_sessions` per container, cleared when the
  container leaves `connected`.
- **Record the session.** On `pane_sessions`, every pane tile whose ref resolves to that container
  and one of the listed `pane_id`s gets `ref.session = {agent, id: session, container}`. Call
  `saveLayout()` only if a ref changed.
- **Restart tracking for rule B.** For each container id, keep a flag "awaiting first snapshot
  after reconnect". Set it when the container's state goes to `connected` from anything else in
  this page. Page load counts as "from anything else" only when the saved ref's
  `session.container` differs; otherwise a reload alone is no restart. Clear the flag after the
  first `snapshot` for that container has been reconciled.
- **Resume from `reconcileTiles`.** When rule 2 holds, send the existing `resume_session`
  (`{container: c.id, agent, session}`).
  - Keep an in-flight map keyed by `container\nagent\nsession`, so tiles sharing a session send one
    request and all apply its reply.
  - On `ok`, set `ref.pane_id = result.pane_id` and `ref.session.container = c.id`, then call
    `saveLayout()` and reconcile again. The tile opens the pane exactly as it opens any pane.
  - While the request is in flight, the overlay shows `Resuming <agent> session…`.

### Server: `resume_session` (`web/server.ts` `handleAgentSession`)

- **Dedupe in-flight requests.** Add an in-flight `Map<string, Promise<result>>` keyed by
  `resumedKey(containerId, listed)`. A second request for the same key while one is running awaits
  the first and replies with its pane and `reused: true`. Today the `sessionPane` check and
  `resumedPanes.set` are separated by several awaits (`commandInstalled`, `repoShell`,
  `pane.send_text`, `pane.rename`), so two concurrent requests can each create a pane. The
  `ask_agent` resume path (around line 3937) uses the same map.
- **Refresh the list on a miss.** When the session is not in `sessionLists` for the container,
  run `listAgentSessions` once, store its result, and look again before replying `not_found`. The
  folder and title still come only from that listing, never from the page.

## Checklist

- [x] `static/lib/layout_state.js`: `PaneSession` type; `paneRefFromState` and the pane serializer
      keep a valid `session` and drop an invalid one
- [x] ~~`web/protocol.ts`: the `pane_sessions` message, and a protocol version bump~~ — not
      needed (see the `pane_sessions` contract)
- [x] `web/server.ts`: the per-container pane→session map from the three sources, the throttled
      Claude probe, and sending `pane_sessions` after `snapshot` and on change
- [x] `web/server.ts`: in-flight dedupe for `resume_session` and `ask_agent` resumes; refresh the
      session list on a miss
- [x] `static/client.js`: keep `pane_sessions` per container; clear it on disconnect
- [x] `static/tiles.js`: record `ref.session` from `pane_sessions`; remove it when a live snapshot
      drops the pane; restart tracking; auto-resume in `reconcileTiles`; the resuming and failure
      overlays with the **Resume** button
- [x] Tests (see Validation)
- [x] `devc/README.md`: one paragraph under devc web on tiles resuming agent sessions after a
      container rebuild or restart, including the hand-started Copilot/pi limit
- [x] Rebuild the Mac apps (`build:mac` in `devc-desktop`), since the bundled web files change

## Validation

- [x] `tests/web_layout_test.ts`: a ref with a valid `session` round-trips through save and
      `paneRefFromState`; a bad `agent`, a non-uuid `id` or an empty `container` drops `session`
      and keeps `{localFolder, pane_id}`; a ref without `session` is unchanged
- [x] Server test (in `tests/web_sessions_test.ts`, or a new `tests/web_resume_dedupe_test.ts`):
      two concurrent `resume_session` requests for one session create one pane (a single
      `pane.send_text` of the resume command); both replies name the same `pane_id`; the second
      has `reused: true` — covered as a unit test of `ResumeGate` (`web/pane_sessions.ts`, which
      `server.ts` uses for both resume paths) in `tests/web_pane_sessions_test.ts`: no test
      harness runs the whole server against a fake container
- [x] Server test: `resume_session` for a session missing from the cached list but present in a
      fresh listing succeeds; one absent from both replies `not_found` — as a unit test of
      `findListed`, which `server.ts`'s lookup uses
- [x] Server test: the `pane_sessions` map prefers `resumedPanes` over a sent task over the Claude
      probe, and lists only panes in the current snapshot — as a unit test of `paneSessionMap`
- [x] `deno task check`, `deno lint` and `deno fmt --check` on touched files pass; `deno task test`
      shows no new failures (1230 pass; the one failure, `dockerExecArgv` in
      `docker_exec_single_path_test`, predates this plan; lint reports only the `jsr:` import rules
      every file trips)
- [ ] Live: open a Claude tile and a Copilot tile started from a task; rebuild the container. Both
      tiles reconnect to resumed sessions in place, with the same history
- [ ] Live: `docker restart` the container with the page open; the tiles resume (rule B)
- [ ] Live: two browser windows on one layout during a rebuild get one resumed pane per session
      (`herdr` lists one agent pane each)
- [ ] Live: end an agent's pane with the container running, then reload the page. The tile shows
      "closed" and does not resume

**Not run (accepted without them):** the four live checks below need a real container rebuild and
restart with devc web open.

## Relevant Files

- `devc/web/static/lib/layout_state.js`
- `devc/web/static/tiles.js`
- `devc/web/static/client.js`
- `devc/web/server.ts`
- `devc/web/pane_sessions.ts` (new: the pane→session map, the resume gate, the list lookup)
- `devc/tests/web_layout_test.ts`
- `devc/tests/web_pane_sessions_test.ts` (new)
- `devc/README.md`
- `.plans/PLAN.md`
