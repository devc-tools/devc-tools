# devc-web-containers-kill-closes

- [x] Page: the sidebar's Projects section heading reads **Containers**, and "Reveal in Projects" reads "Reveal in Containers"
- [x] Page: comments and docs that name the Projects _section_ say Containers (not the `projects` message, nor "Add project…")
- [x] Page: Kill pane closes every tile showing the pane once Herdr confirms the kill; a failed kill leaves them and toasts as today
- [x] Verify (below) and ask the user to try it in their open tab

Two small fixes to the `devc web` sidebar and tiles. Page only (`devc/web/static/app.js`), no
server or protocol change, so `devc web --live` picks it up.

**1. "Projects" → "Containers".** Every top-level row of the Projects section is a devcontainer:
one row per running container (`containers`, from `docker ps`, Herdr or not), then the
"Not running" group of devc projects whose container is stopped (`stopped`) or not created yet
(`missing`, e.g. a folder just pinned with Add project…). The heading should say so. The `<nav>`
in `index.html` is already `aria-label="Containers"`.

**2. Kill pane leaves the tile behind.** `killPane` sends `pane.close` and stops there. Herdr
ends the process and drops the pane from its next snapshot, and `reconcileTiles` /
`updateOverlay` then leave each tile showing it with a "Pane gone" overlay that has to be
closed by hand. After a kill from this page, those tiles should close.

**Not in this plan:** closing tiles for panes that end any other way (`exit` typed in the shell,
a kill from the Herdr TUI or from another `devc web` tab): they keep the "Pane gone" overlay.
Renaming anything below the heading (see Concept boundaries).

## Concept boundaries

- **The Containers section vs devc projects.** Only the section's _name_ changes. A project is
  still a devc project (`~/.config/devc/projects.json`, the `projects` message, `ProjectInfo`,
  the `projects` Map, `projectRow`, `projectMenuItems`, `start_project` / `stop_project` /
  `pin_project` / `forget_project` / `add_project`). **Add project…** stays: it pins a folder,
  which has no container until started. **Not running** stays.
- **Saved sidebar state keeps its keys.** `sidebarState.projectsOpen` and the
  `devc-web-sidebar-v1` key are not renamed, so nobody's expanded rows reset.
- **The Layout section is unchanged.** It is the other top-level section and isn't renamed.
- **Close vs Kill pane.** **Close** (tile menu, Layout row ×) closes a tile and leaves the
  pane's process running in Herdr. **Kill pane…** ends the process (`pane.close`, a Herdr
  method). After this plan Kill pane also closes the pane's tiles. Close does not change.
- **`pane.close` (Herdr request) vs `close` (page → server message).** `pane.close` goes through
  `request` and kills the Herdr pane. `close` (sent by `closeTilePane` when the last tile showing
  a pane unmounts) only drops this page's control stream for the pane. Closing a tile after a
  kill can send `close` for a pane that has already ended, if `pane_closed` hasn't arrived yet.

## Existing touchpoints

| File                                   | Role                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/static/app.js`               | `renderTree` (the `sectionRow('Projects', …)` heading); `tileMenuItems` ("Reveal in Projects"); `revealInProjects`; `killPane` / `killPaneItem` (used by the pane row's trash button, the pane row menu, and the tile menu); `request`, `call`, `onResult`; `tiling.tiles()` / `tiling.close`. |
| `devc/web/server.ts`                   | The `close` case. Read only: confirm a `close` for a pane whose stream already ended is a no-op (no error frame, no throw). If it isn't, stop and report rather than changing the server here.                                                                                                 |
| `devc/README.md`, `.plans/devc-web.md` | Wherever they describe the sidebar's Projects section by name: say Containers.                                                                                                                                                                                                                 |
| `devc/tests/`                          | Any test or headless check asserting the `Projects` heading or "Reveal in Projects" text (grep for both).                                                                                                                                                                                      |

## Contracts

### Rename

- `sectionRow('Projects', …)` → `sectionRow('Containers', …)`. Its trail and context menu
  (**Add project…**) are unchanged.
- Tile menu item `'Reveal in Projects'` → `'Reveal in Containers'`; `revealInProjects` →
  `revealInContainers`. Behaviour unchanged.
- Comments that mean the section (the file header, `renderTree`'s doc, `updateCurrent`'s doc,
  the `// Sidebar: Projects section` banner, `revealInProjects`' doc) say Containers. Comments
  about devc projects (`// Sidebar: projects without a running container`, `projectRow`, …)
  stay.

### Kill pane closes its tiles

`killPane(c, pane)`, after the existing `confirm`:

1. Sends the same Herdr request as today (`container: c.id`, method `pane.close`,
   `params: {pane_id}`), but awaits its result. `call({type: 'request', container, method,
   params})` already does this: `onResult` checks `pendingCalls` first.
2. **ok** → `tiling.close(tile.id)` for every pane tile whose `ref` is
   `{localFolder: c.localFolder, pane_id: pane.pane_id}`. Collect the tiles before closing any,
   since closing changes `tiling.tiles()`. File tiles are never matched.
3. **error** → toast `Kill pane failed: <message>` (today's text, from `onResult`'s generic
   path) and leave the tiles alone.

The closed tiles go through the normal `unmountTile` path (`closeTilePane`, layout save, Layout
section re-render). Nothing new is needed for that.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

In headless Chromium against the checkout's page with a fake WebSocket (as the
devc-web-repos-group and devc-web-file-viewer runs did):

- The section heading reads **Containers**, with Add project… on hover and right-click.
- A tile's menu shows **Reveal in Containers**, and it still scrolls to and flashes the pane row.
- Kill pane… from the pane row, the pane's hover trash button and the tile menu: after the fake
  server answers `ok: true`, every tile showing that pane (put it in two tiles) closes and
  others stay. On `ok: false`, a toast shows and the tiles stay. Cancelling the `confirm` sends
  nothing.

Then ask the user, in their open tab:

1. The sidebar heading reads Containers.
2. Open a shell in two tiles, then Kill pane… from its sidebar row: both tiles close and the
   row goes away.
3. Kill pane… from a tile's own menu: that tile closes.
4. Type `exit` in another shell: its tile still shows "Pane gone" (unchanged, out of scope).
