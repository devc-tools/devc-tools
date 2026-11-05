# devc web: one Herdr workspace per repo

Decided with the user on 2026-11-05.

## Starting point

Every pane devc web creates goes through `createShell` (`devc/web/herdr_bridge.ts`), which calls
`tab.create` with no `workspace_id` (except a page's split/stack items, below). So a container's
Herdr session ends up as one workspace holding one tab per pane. A Herdr TUI attached to the
session sees one workspace, so its sidebar's per-workspace status and token rollups lump every repo
together.

Decisions:

- **Keep one Herdr tab per pane.** Herdr can only add a pane to an existing tab by splitting it
  (`pane.split`, `pane.move`), which would shrink every pane to a slice in the TUI and give its
  size two owners. Unchanged.
- **One Herdr workspace per repo.** A new pane goes into the workspace of the repo its `cwd` is in.
  It is keyed by repo, not by exact `cwd`: `open_file` starts in the file's own folder, and keying
  by folder would make a workspace per folder.
- **A `cwd` in no repo goes to the project's primary repo's workspace** (the repo whose `folder` is
  the environment's `localFolder`).
- **An explicit `workspace_id` on `new_shell` still wins**, and the protocol is unchanged. The page
  stops sending one (below), so in practice the `cwd` decides.
- **Existing panes stay where they are.** Nothing is moved.
- **Herdr's live state is the only record.** No map is stored: the workspace is found again by its
  label on every create, so it survives server restarts and works with workspaces the user made in
  the TUI with the same label.

Out of scope: `host_starts.ts`'s `devcd` session (start scripts run on the host, one pane per
project start). It keeps calling `createShell` with no repos and so keeps today's behavior.

## Checklist

- [ ] Server: a repo workspace lookup-or-create in front of `createShell` (contract below), used by
      every container pane creation in `devc/web/server.ts`.
- [ ] Server: creations for the same environment are serialized (below).
- [ ] Page: `shellOptsNear` (`devc/web/static/menus.js`) stops sending `workspace_id`.
- [ ] Page: a pane row in a repo card doesn't show its space when the space is that card's repo
      workspace (below).
- [ ] Tests (below).
- [ ] Docs: `devc/README.md` (the **Menus** bullet's "always its own Herdr tab" sentence).
- [ ] Manual (the user): the Validation states.

## Contracts

### Choosing the repo (`devc/web/herdr_workspaces.ts`, new)

Input: the pane's `cwd` (a container path, or absent) and the environment's repos as
`containerRepos.get(record.id)` holds them (`{folder, containerFolder, …}`), plus the environment's
`localFolder`.

1. Drop repos whose `containerFolder` is `null`. Strip trailing `/` from each `containerFolder`.
2. With a `cwd`: the repo with the **longest** `containerFolder` such that
   `cwd === containerFolder || cwd.startsWith(containerFolder + '/')` (same rule as
   `sessions.ts`' `mounted.find`, longest first so a nested repo beats its parent).
3. No `cwd`, or no match: the repo whose `folder === localFolder`.
4. Still none (the primary isn't mounted, or repos aren't loaded yet): **no repo**. `createShell`
   is called exactly as today (no `workspace_id`).

### The workspace label

`repoName(repo.folder, repo.containerFolder)` from `devc/web/projects_view.ts`
(`/workspaces/tools/devc-tools` → `tools/devc-tools`, else the folder's basename). This is the name
the page already shows on the repo's card, so the TUI's sidebar and devc web agree.

A user who renames that workspace in the TUI gets a new one with the original label on the next
create; that is accepted.

### Lookup-or-create

With a repo and no explicit `workspace_id`:

1. `workspace.list {}` over the bridge (live, **not** the cached snapshot: a workspace created a
   moment ago may not be in it yet). The result is `{workspaces: WorkspaceInfo[]}`. Pick the first
   by ascending `number` whose `label` equals the label exactly.
2. Found → `createShell(target, {workspace_id, cwd})` (today's `tab.create` path).
3. Not found → `workspace.create {cwd, label, focus: false}`. Its result carries the new
   workspace's first tab (`{tab: {tab_id, workspace_id}, root_pane?}`), whose root pane **is** the
   new pane: resolve it exactly as `createShell` does after its `workspace_not_found` fallback
   (`root_pane.pane_id`, else `pane.list {workspace_id}` and the pane with that `tab_id`). Do not
   then call `tab.create` (that would make a second, empty-shell tab).
4. A `tab.create` that answers `workspace_not_found` (closed between list and create) → go to
   step 3 once.

Factor `createShell`'s pane-resolution tail into a helper both paths share; keep `createShell`'s
signature and its no-workspace fallback for the no-repo case and for `host_starts.ts`.

The page's `new_shell` result shape (`{pane_id, tab_id}`) is unchanged.

### Serialization

Two creates for the same repo at once (e.g. two agent resumes) would each miss in `workspace.list`
and make two workspaces. Run lookup-or-create one at a time **per environment id** (a promise chain
keyed by `record.id`). Different environments run in parallel.

### Call sites (`devc/web/server.ts`)

Every `createShell` call in `server.ts` goes through the new function, passing its existing `cwd`:

| Site                                                                       | `cwd` today                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `editorPane` (`open_file`)                                                 | the file's directory                            |
| `openTab` (`open_tab`)                                                     | the folder                                      |
| `handleTask` (`send_task`, `open_sent`, and the queue runner `pumpQueues`) | the task's repo folder                          |
| `handleAgentSession` (`resume_session`)                                    | the session's `cwd`                             |
| `askAgent` (`ask_agent`)                                                   | the session's `cwd`, or the repo folder         |
| `new_shell` case                                                           | `msg.cwd`; `msg.workspace_id` wins when present |

### Page

- `shellOptsNear` keeps sending `cwd` (`foreground_cwd || cwd` of the neighbor pane) and stops
  sending `workspace_id`; `paneWorkspace` goes if nothing else uses it. A split from a pane that
  has `cd`ed into another repo then lands in that repo's workspace.
- `paneSpaces` (`devc/web/static/cards.js`) is unchanged; where a pane row is pushed into a card
  (`.panes.push({c, pane, space})`), `space` becomes `''` when it equals that card's repo `name`.
  A pane in some other workspace (made in the TUI, or an older default one) still shows its space.

## Validation

- [ ] `cd devc && deno task check` passes (add `web/herdr_workspaces.ts` to the `check` task's
      list).
- [ ] `cd devc && deno task test`: no new failures. New `devc/tests/web_herdr_workspaces_test.ts`
      covers the pure parts:
  - [ ] `cwd` `/workspaces/a/b/src` with repos at `/workspaces/a` and `/workspaces/a/b` → `/workspaces/a/b`.
  - [ ] `cwd` `/workspaces/ab` with a repo at `/workspaces/a` → no match → the primary repo.
  - [ ] `cwd` `/` → the primary repo; primary with `containerFolder: null` → no repo.
  - [ ] A repo with a trailing-slash `containerFolder` matches its own folder exactly.
  - [ ] Label pick: two workspaces labeled `tools/devc-tools` → the lower `number`; a label that
        differs only in case → not found.
- [ ] `cd devc && deno lint` and `deno fmt --check` on touched files pass.
- [ ] Manual (the user), in a container whose project mounts two repos, with a Herdr TUI attached
      (`herdr` inside the container):
  - [ ] Starting from a fresh session, a new shell on repo A's card makes a workspace labeled with
        A's card name, and the TUI keeps its focus.
  - [ ] A second shell on A adds a tab to that workspace; a shell on repo B makes B's workspace.
  - [ ] Opening a file in A (`open_file`) lands in A's workspace; a shell at `/` lands in the
        primary repo's.
  - [ ] Split a pane in A after `cd`ing into B: the new pane is in B's workspace.
  - [ ] Pane rows in repo cards show no space label; a pane in a TUI-made workspace still does.
  - [ ] Closing every pane in A's workspace, then making a new shell on A, works (whether Herdr
        kept the empty workspace or closed it).
  - [ ] Two agent resumes started together on A make one workspace, not two.

## Relevant Files

- `devc/web/herdr_workspaces.ts` (new): repo choice, label, lookup-or-create, per-environment
  serialization.
- `devc/web/herdr_bridge.ts`: `createShell`'s pane-resolution tail factored into a shared helper.
- `devc/web/server.ts`: the six `createShell` call sites.
- `devc/web/static/menus.js`: `shellOptsNear`, `paneWorkspace`.
- `devc/web/static/cards.js`: the pane row's `space`.
- `devc/tests/web_herdr_workspaces_test.ts` (new).
- `devc/deno.json`: the `check` task's file list.
- `devc/README.md`: the **Menus** bullet.
