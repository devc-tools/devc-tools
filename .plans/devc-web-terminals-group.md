# devc-web-terminals-group

- [ ] Space rows removed: panes listed flat under the container, the space named in the tooltip (already in the working tree, uncommitted; commit it with this plan)
- [ ] Page: a **Terminals** row first under every expanded container, expanded by default, with the agent rollup while collapsed
- [ ] Page: the **Repos** row always shown (also for a single repo), after Terminals, collapsed by default
- [ ] Page: user-visible "pane" / "Herdr tab" / "shell" wording → "terminal", from one set of label constants
- [ ] `sidebarState.terminalsClosed` saved and restored
- [ ] `.plans/devc-web.md` "Browser UI" section updated (vocabulary included)
- [ ] Verify (below) and ask the user to try it in their open tab

Page only, with no protocol change, so it works under plain `--live`. Read
`/workspaces/devc-dev/.claude/skills/devc-web/SKILL.md` first. Builds on
[devc-web-repos-group](archived/devc-web-repos-group.md) and
[devc-web-open-tab-here](archived/devc-web-open-tab-here.md).

The sidebar stops talking Herdr. What it lists under a container are **terminals**: each is a
Herdr pane, shown in a tile when opened. Herdr's spaces, tabs and splits get no rows (devc web
doesn't manage them). Every container gets the same two groups, Terminals first:

```
PROJECTS
  ▾ devc-dev
    ▾ Terminals      (rollup only while collapsed: ● done)
        shell
        Devc web UI roadmap      ● done
    ▸ Repos          ↑3 ↓1
  ▾ space-platformer-2
    ▾ Terminals
        2d platformer game setup ○ idle
    ▸ Repos          •           ← one repo: still grouped
  ▾ dev-wksp                     no session  [▶ Start Herdr] [Retry]
    ▸ Repos          ↑3 ↓1       ← no Terminals row while Herdr isn't usable
  ▾ Not running (4)
    ▸ agentsprite   ✓   stopped  ← unchanged: files straight under it
```

## Concept boundaries

- **Terminal (UI) = Herdr pane (code and API).** User-visible text says "terminal". Code keeps
  `pane`, `pane_id`, `paneRow`, `PaneRef` and the protocol's `new_shell` / `open_tab`, because
  they name Herdr's objects. Don't rename identifiers or messages.
- **Terminal vs tile.** A tile is a panel in the browser layout. It shows a terminal (or a
  file). Tile menus keep saying "tile"; what a tile _shows_ is a terminal.
- **Terminal vs xterm.** `renderer.js` uses xterm's `Terminal` class. That's the emulator in a
  tile, not the sidebar's notion. No change there.
- **Herdr stays named where it's infrastructure.** The container states (`no session`,
  `no herdr`, `unsupported`), **Start Herdr** and its errors keep the word "Herdr": they're
  about the server the terminals run on, and the user needs that name when it's broken.
- **Herdr space = API workspace.** Only the pane tooltip mentions it: `Space: <label>`, and only
  when a container has more than one.

## Existing touchpoints

| File                        | Role                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devc/web/static/app.js`    | `containerRows` (pane rows, rollup badge), `repoRows` (Repos row, single-repo special case), `toggleRepos`, `loadSidebarState` / `saveSidebarState`, every menu / toast / overlay string listed below. |
| `devc/web/static/style.css` | `.row.terminals`, styled like `.row.repos`.                                                                                                                                                            |
| `.plans/devc-web.md`        | "Browser UI" section: the sidebar bullet and a vocabulary note.                                                                                                                                        |

## Contracts

### Rows under an expanded container

In this order:

1. **Terminals row** (class `terminals`), depth 1, only when the container is `connected`.
   - It shows a chevron, the text `Terminals`, and `rollupBadge(panes)` **only while
     collapsed**. The container row's own rollup badge is unchanged (shown while the container
     is collapsed).
   - Expanded by default. Collapsed ones are saved as
     `sidebarState.terminalsClosed: string[]` of `localFolder`s under `SIDEBAR_KEY` (a "closed"
     set, so new containers start open).
   - While open: one pane row per Herdr pane, at depth 2, in Herdr's order (space by space,
     then tab by tab, then panes the snapshot didn't place).
   - A connected container with no panes still gets the row, with an empty-state note under it
     ("No terminals").
2. **Repos row** (class `repos`), depth 1, **always**, whatever the repo count (drop the
   `repos.length === 1` shortcut). Collapsed by default (`reposOpen`, unchanged). Repo rows at
   depth 2, worktrees and files below them as now.

A container in an `INACTIVE_STATES` state shows only the Repos row. Idle projects under
"Not running" are unchanged.

### Wording

Collect the user-visible strings in one place in `app.js` (e.g. a `LABELS` object), so that a
later rename is a single edit. At least:

| Now                                                       | Becomes                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Open Herdr tab here` / `New Herdr tab here`              | `Open terminal here` / `New terminal here`                                            |
| `New shell` (container menu, and its failure toast)       | `New terminal`                                                                        |
| `Kill pane…` (menu and row button), its confirm and toast | `Close terminal…` (confirm: `Close terminal "<label>"? Its process ends.`)            |
| `Rename pane`                                             | `Rename terminal`                                                                     |
| `Split pane vertically` / `horizontally`                  | `New terminal below` / `New terminal to the right` (check which is which in the code) |
| `New pane in this stack` / `New pane at end`              | `New terminal in this stack` / `New terminal at end`                                  |
| `Pane gone` (tile overlay)                                | `Terminal closed`                                                                     |
| `Click a pane in the sidebar to open it here.`            | `Click a terminal in the sidebar to open it here.`                                    |
| `Drag a pane here, or click one in the sidebar.`          | `Drag a terminal here, or click one in the sidebar.`                                  |

Then grep `app.js`, `layout.js` and `index.html` for any other user-visible `pane` / `Herdr tab`
text and apply the same rule. Code comments may keep "pane" where they mean Herdr's object.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

In a headless page with a fake WebSocket (see the devc-web skill), with a connected container
with two repos, a connected container with one repo and no panes, and a `no-session` container,
check the rendered `#tree` rows (classes and `--depth`):

- `terminals` (depth 1) before `repos` (depth 1) for both connected containers; pane rows at
  depth 2; the empty container shows "No terminals";
- the one-repo container still has a `repos` row;
- the `no-session` container has `repos` and no `terminals`;
- collapsing Terminals shows the rollup badge on it and survives a reload.

Then ask the user, in their open tab:

1. Every running container shows **Terminals** (open) then **Repos** (closed).
2. Collapse Terminals: the most urgent agent status shows on its row. Reload: still collapsed.
3. A one-repo container still has a Repos row.
4. Right-click a folder: "Open terminal here" / "New terminal here". Right-click a terminal row:
   "Close terminal…". No "pane" or "Herdr tab" left in menus, buttons or overlays.
