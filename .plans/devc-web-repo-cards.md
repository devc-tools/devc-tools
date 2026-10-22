# devc web: one repo card, in In use or in Containers

Decided with the user on 2026-10-21. This doc is the spec. Features continue
[14-implementation-tracking](design/devc-web-ux/14-implementation-tracking.md)'s numbering (F17 on);
each gets a row there when done.

## Goal

A container and what is in it are shown one way. The atomic unit is a **repo card**: one repo or
worktree in one container. Each repo card is either **active** and lives under its container's card
in In use, or **inactive** and lives under its container's card in Containers, never both. A
container's card is in In use while it has an active repo card. Every running container always has
a card in Containers (its header carries the lifecycle buttons and the container's own files).
The Terminals / Repos / Sessions / Files tabs go away: their contents become parts of repo cards,
plus a Files row on the container card.

All of it is page code (`devc/web/static/`). No server or protocol change.

## Decisions

### F17 — The repo card

- **Identity.** One card per (container, repo) pair: `localFolder` of the container's project and
  `repo.folder` (host folder) of a repo from `shownRepos(localFolder)`. Worktrees are cards of their
  own, siblings of their main repo's card (no nesting). Panes, tiles and sessions outside every repo
  of the project go on one **container-level card** per container (`repo` null), shown only when it
  has a pane, tile or session.
- **Key.** `repoCardKey(localFolder, repoFolder)` in `static/lib/sidebar.js`:
  `` `card\n${localFolder}\n${repoFolder ?? ''}` ``. It replaces `inUseGroupKey` (delete it and its
  test). The card element is `div.repo-card[data-card-key="<key>"]`.
- **Header** (a `treeRow` at depth 0 inside the card, class `repo-card-head`): the repo's name as
  `repoGroupName` gives it (parent path muted, name), `⎇ <branch>`, then the git sync mark
  (`gitMark(gitSync(repo.git, repo.gitProblem))`). The container-level card's header is the
  container's name (`containerNameOf`) and has no branch or mark. No container name on any repo card
  header: the container card above it names it. Tooltip as today's In use folder row, less the
  `In:` line.
- **Header buttons**, in this order, in the hover strip at the header's right:
  1. `history` — shows/hides the card's past sessions. Present only when the card has any.
  2. Pull request (new icon `pullRequest`, title `LABELS.pullRequest`) — shows/hides the PR. Present
     only for a repo card whose container is running.
  3. Files (new icon `folder`, title `LABELS.files`) — shows/hides the repo's file tree. Present on
     repo cards, not on the container-level card.

  `ICON_PATHS` has neither icon today: add both, drawn on the same 16×16 stroked grid as the
  others (`pullRequest`: two small circles joined by a vertical line, a third circle top right with
  a line curving into the right-hand one; `folder`: a folder outline with a tab).
  4. `task` and `plus` — as `newTerminalButton(row, fr, '')` at the card's folder, while its
  container is running.

  A toggle button that is on has `aria-pressed="true"` and stays visible when the header is not
  hovered. **Gotcha:** `.row-hover` is hidden until its row is hovered or focused, so a pressed
  button inside it would hide with it. Render the toggles that are on in a span of their own in the
  row's trail, before the hover strip, and the ones that are off inside the strip.
- **Header click** toggles history when the card has past sessions; otherwise it does nothing and
  the header has the `inert` class (as today's In use row).
- **Header right-click:** `dirMenuItems(fr, '')` then `jiraItems(branch)`, where
  `fr = { localFolder, root: repo.folder }` (what a Repos-tab repo row gives today: Open in Code,
  reveal, Copy path, Copy container path, …). The container-level card: `projectMenuItems(localFolder)`.
- **Body**, in this order, each at depth 1:
  1. **Terminals, always shown.** Every tile whose `tileRepo` is this card (tile rows, layout order),
     then every pane of the container whose folder (`repoAt(repos, pane.foreground_cwd || pane.cwd)`)
     is this card's repo and that no tile shows: **agents and plain shells alike**. Untiled panes use
     `paneRow` (drag into the layout, click opens as a preview, double-click keeps, right-click
     `paneCodeItems` then `paneMenu`), with the In use label form (`inUseLabel(paneLabel(pane))`)
     and no container name.
  2. **Past sessions**, while history is on: the card's sessions (see F19) newest first, as
     `sessionRow` rows, without a container or repo suffix.
  3. **Pull request**, while PR is on: what an open "Pull request" row shows today (`prRows`'s
     header and file tree), without its own collapsible row. The on/off state **is**
     `sidebarState.prOpen` for `prKey(localFolder, repo.folder)`, so a PR open before stays open.
  4. **Files**, while files is on: `rootEntryRows(fr, 1)`. The on/off state **is** the repo tree's
     root (`fileTree(fr).isOpen('')`), already saved in `filesOpen` / `rootsOpen`.
- **History state** is saved: `sidebarState.cardHistoryOpen` (a `Set` of card keys), saved as
  `cardHistoryOpen` (array of strings), default empty. It replaces the unsaved `inUseSessionsOpen`.
- **All toggles default off.** Their state belongs to the card key, so it is the same wherever the
  card is shown.

### F18 — Active or not, and where a card goes

- **Active** (`repoCardActive` in `static/lib/sidebar.js`, pure, tested): true when the card has
  any of: a tile; an untiled pane with an agent (`pane.agent`); a past session whose `updatedAt` is
  less than `IN_USE_SESSION_MS` (24 h) before now. A plain shell with no tile does **not** make a
  card active (it is still listed in the card wherever the card is). Signature:
  `repoCardActive({ tiles: number, agents: number, lastSessionAt: string | null }, nowMs): boolean`;
  `lastSessionAt` is an ISO time, parsed with `Date.parse`; an unparseable value counts as not recent.
- **In use** lists, per container with an active card, a container card (`.in-use-run`, its name
  centered on top, as today) holding its active repo cards. Container cards are ordered by their
  first active card's position, repo cards by the layout order of their first tile, then cards
  with no tile in `shownRepos` order. (Today's ordering rule, applied to repo cards.)
- **Containers** lists every container as today (running ones, then Not running). An expanded
  running container's card holds, in this order: its **inactive** repo cards in `shownRepos` order
  (each repo, then its worktrees, matching `topRepos` order), then its container-level card if
  inactive and present, then the **Files** row (F20). A container with every card active shows its
  header and the Files row only. A collapsed container card is its header, as today.
- **Not running** is unchanged by this plan.

### F19 — One card per container, sessions on one of them

- A repo mounted in two running containers has a card in each. In use no longer merges a folder
  across containers: delete the per-container label rows inside In use cards
  (`.row.in-use-container`) and the multi-container `inUseGroupActions` menus.
- Agent homes are shared, so every container mounting a repo lists the same sessions. A session
  goes on exactly one card: the card of its `s.root` repo in the container whose `localFolder`
  equals `s.root` if that container is running, else in the first running container (in
  `containers` order) that lists it. Sessions running in a pane (`sessionPane(c, s)` in any
  container) are on no card's history (the pane's row stands for them), as today.
- Sessions are listed (`loadSessions`) for every running container when the page renders (once,
  not on every render), so Containers cards know their sessions. The In use heading's refresh
  button lists every running container's sessions again.

### F20 — The container card's own parts

- **Header** unchanged (chevron, name, pin, git rollup when collapsed, status rollup, `down` /
  `stop`), plus a `plus` button before `down` that opens `newTerminalMenuItems` at the container's
  project folder (`{ localFolder, root: localFolder }`, path `''`), while the container is
  connected.
- **Files row:** last in an expanded running container's card, a `treeRow` at depth 1 with a
  chevron, label "Files", class `container-files`. Open, it shows what the Files tab shows today
  (`containerFileRows(c)`, its rows one level deeper). Its open state is saved:
  `sidebarState.containerFilesOpen` (a `Set` of `localFolder`s), saved as `containerFilesOpen`,
  default closed.
- **Removed:** the tab strip (`containerTabStrip`, `CONTAINER_TABS`, `CONTAINER_TAB_LABELS`,
  `.container-widget`, `.container-panel`, `.row.container-tabs` CSS), `terminalRows`,
  `sessionRows`, `repoRows`, the saved `containerTab` field and `savedContainerTabs`. The
  "＋ New terminal in …" and "↻ Refresh sessions" rows go (the header `plus` and the In use refresh
  replace them). Delete any `sidebarState` field and saved key left unused (`reposOpen`,
  `sessionsOpen`, `terminalsClosed` if nothing reads them after this).

### Styling

- `.repo-card` takes today's `.in-use-card` rules (rename the class; `--card-bg: #151d28`, border
  `#2c394b`, radius 5px). Inside a container card (`.in-use-run` or `.container-card`) cards are
  5px apart, as now. The `.container-card` and `.in-use-run` rules stay as they are.
- Hovering a card's header lights the card (today's `.in-use-card:has(> .row.in-use-group…)`
  rule, on `.repo-card-head`) when the header click does something.

## Out of scope

- Not running projects as repo cards.
- Pinning a card to In use; a plain shell making a card active.
- Left-aligning In use container names (the user decides later).
- Copilot / pi running detection.

## Checklist

- [ ] `lib/sidebar.js`: `repoCardKey`, `repoCardActive`; delete `inUseGroupKey`; tests in
      `web_sidebar_test.ts`
- [ ] F17 one card builder used by both zones: header, buttons, click, right-click, body parts
- [ ] F17 `cardHistoryOpen` saved; `inUseSessionsOpen` removed
- [ ] F18 In use built from active repo cards per container, ordered as specified
- [ ] F19 sessions placed on one card; per-container label rows and multi-container menus removed;
      sessions listed for every running container on first render; In use refresh lists all
- [ ] F18 Containers: expanded container card holds its inactive cards, container-level card, Files row
- [ ] F20 container header `plus`; Files row with saved `containerFilesOpen`
- [ ] F20 tabs and their state, rows and CSS removed; unused saved fields removed
- [ ] Styling: `.repo-card` rename, header hover, pressed toggles stay visible
- [ ] `devc/README.md` sidebar paragraphs describe repo cards, In use and Containers as built
- [ ] 14-implementation-tracking.md: F17–F20 rows (F5 marked superseded by F20), any exceptions

## Validation

- [ ] `cd devc && deno task check` passes
- [ ] `cd devc && deno task test` passes, including new cases: `repoCardKey('/p', '/p/a')` is
      `'card\n/p\n/p/a'` and `repoCardKey('/p', null)` is `'card\n/p\n'`; `repoCardActive` is true for
      `{tiles: 1, agents: 0, lastSessionAt: null}`, true for `{tiles: 0, agents: 1, …}`, true for a
      session 23 h old, false for one 25 h old, false for `lastSessionAt: 'nonsense'`, false for all
      zero / null
- [ ] `cd devc && deno fmt --check web/static/app.js web/static/lib/sidebar.js tests/web_sidebar_test.ts`
      passes (`style.css` has one pre-existing unformatted line; add no new ones)
- [ ] `grep -n "containerTab\|CONTAINER_TABS\|inUseGroupKey\|in-use-container\|inUseSessionsOpen" devc/web/static/app.js devc/web/static/lib/sidebar.js devc/web/static/style.css`
      prints nothing
- [ ] Live, in a browser against the user's devc web (`devc web --live`), checked in the console:
  - every `[data-card-key]` value occurs once in the document
    (`new Set(keys).size === keys.length`)
  - every `.in-use-run .repo-card` card has a tile, an agent pane row, or a session row from the
    last 24 h (open its history to see)
  - no `.container-card .repo-card` card has a tile row or an agent pane row
  - `document.querySelector('.row.container-tabs')` is null
- [ ] Live, by hand: closing the last tile of a repo whose agents are gone and with no session in
      24 h moves its card from In use into its container's card in Containers; opening a terminal from
      that card's `plus` moves it back once the terminal is in a tile
- [ ] Live, by hand: turning on a card's files toggle in Containers, then making the card active,
      shows it in In use with its files still open; after a reload the toggle is still on
- [ ] Live, by hand: a container's Files row opens the container's filesystem as the Files tab did,
      and stays open after a reload

## Relevant Files

- `devc/web/static/app.js` — card builder, `inUseRows`, `containerRows`, removed tab code, saved
  state
- `devc/web/static/lib/sidebar.js` — `repoCardKey`, `repoCardActive`; `inUseGroupKey` removed
- `devc/web/static/style.css` — `.repo-card`, header hover and pressed toggles, removed tab CSS
- `devc/tests/web_sidebar_test.ts` — new helper tests; `inUseGroupKey` test removed
- `devc/README.md` — sidebar description (around "**Sidebar:**" and the In use / Containers
  paragraphs after it)
- `.plans/design/devc-web-ux/14-implementation-tracking.md` — F17–F20 rows and exceptions
- `.plans/PLAN.md` — status and phase row
