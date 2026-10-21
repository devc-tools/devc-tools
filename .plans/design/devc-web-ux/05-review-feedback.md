# Review of concept 04 (layout-preserving)

> **Revised after this review was written:** the user starts from containers when finding or
> managing things, but once a repo is in use the repo/folder matters more than its container. The
> "keep containers as the top level" point below applies to the browse and manage tree only. Surfaces
> for active work (tile headers, Layout list, Recent sessions) should lead with the repo/folder and
> show the container last. See the README's user preferences.

Reviewer feedback on `04-layout-preserving.{html,png}` (all paths here are relative to `.plans/design/devc-web-ux/`), checked against:

- `real-layout.png` — the user's real populated three-tile layout. "Real layout"
  below always means this file.
- `00-current-app.png` — fresh browser, no tiles. Used only for the default sidebar
  structure (each container expanded into Terminals / Sessions / Repos / Files).

Overall: about half of 04 is cosmetic polish worth keeping as is. The rest changes navigation, and in
a few places it moves away from how the user actually works. Revise 04 using the decisions below.

## What 04 changes, apart from looks

1. The sidebar is reorganised around "Open panels" and "Projects" instead of containers. Each project
   becomes one row with Files / Repos / Sessions tabs.
2. Tile headers get a title bar: a short name, a muted context label, a status dot and word, and
   `⋯ ⤢ ×` buttons.
3. A new top header and a "workbar": + New task, ⌘K Commands, Connected, a named layout, + Terminal,
   Split, Focus panel, Save layout.
4. ⌥1–3 panel shortcuts, plus a strong active-panel highlight.
5. "Recent sessions" becomes a flat list across all projects.

## Keep

- **Tile header styling.** In the real layout, tab titles are long task prompts ("I want a Github PR
  review feature added to my devc web tool. It needs to show a…"), which crowd out the status pill
  and the close button. 04's header (bold short title, muted context, status pinned right) is the
  biggest readability win.
  - Open question: nothing in the app produces short names like "VSIX SBOM" today. Decision: let
    the user rename a tile by double-clicking its title, save the name with the layout, and keep
    the full prompt as the tooltip. Titles from the agent or task are a possible later step, not
    part of this work.
- **A strong active-panel highlight** (tinted header plus accent border). With three Claude TUIs that
  look alike, knowing where keystrokes will go matters more than anything else on screen. Today the
  only cue is a small tab highlight.
- **Status as a dot plus a word, coloured the same in the sidebar and tile headers.** Use exactly the
  values herdr reports and the app already shows (`idle`, `work`, `done`). Don't invent new states
  such as "Needs input" without a data source.
- **⌥1–9 to focus tiles.** Handle them in the capture phase, the way Cmd+B already is
  (`devc/web/static/app.js` near line 6263), so xterm doesn't swallow them. Check for clashes with
  option-as-meta on Mac.
- **Spacing, contrast and section labels.** Free win.

## Change or drop

- **Keep containers as the top level of the sidebar.** Containers are what the user starts and
  stops, and what bridge grants are scoped to. A container can hold several repos (in the real
  layout, Repos under code-wksp lists `.plans/deephaven-core`, `.plans/deephaven-plugins`, …), and
  sessions belong to worktrees, so "Projects" doesn't map onto the data cleanly. Borrow 04's density
  instead: collapse each container to one row by default, with status dots summarising its
  terminals, and expand on click.
- **No Files / Repos / Sessions tabs inside a tree row.** With tabs you can't keep two open at once,
  and the existing keyboard tree navigation (`app.js` near line 3966) can't reach tab state. Keep
  them as child rows.
- **Replace the "Open panels" cards with a flat LAYOUT list.** The cards repeat the tile headers. The
  current LAYOUT section shows Golden Layout internals (`row · 3`, `column · 2`); flatten it to one
  row per tile with status and its ⌥N hint, and no nesting.
- **Drop the top header and the workbar.** That's about 70px of chrome above the terminals in an app
  whose job is terminal density, and most of the buttons repeat something already possible: drag to
  split, maximise for focus, a layout that saves itself. Host and bridge status stays in the existing
  footer. Named or saved layouts are a separate feature; leave them out unless the user asks.
- **Leave out ⌘K Commands and ⌘P search.** Search is worth doing, but as its own planned feature
  (what it searches, and what Enter does), not a placeholder in the mockup.
- **Keep "Recent sessions" as a global section above Containers.** It's a good idea. Limit it to
  about five items, built from the data that already feeds the per-container Sessions rows, and show
  each item's title and project, not worktree paths.

## From concepts 01–03, worth keeping

- **02's "Needs your input" idea**, without the dashboard. A cheap version that fits the data the app
  already has: mark a tile "unseen" when its agent turns `done` while the tile isn't focused, clear
  the mark on focus, and show the count in the sidebar. If herdr ever reports a waiting or blocked
  state, extend this to it.
- **Skip 03's task context panel and deliverables list.** They need structured data the agents don't
  produce.

## Suggested order

1. Tile header redesign, renaming, active-panel highlight.
2. ⌥N focus shortcuts.
3. Compact container rows with status summaries, plus the flat LAYOUT list.
4. A global Recent sessions section.
5. Later, and only if wanted: unseen-`done` badges, search.

## Asked of you

Produce `06-*.png` (and its HTML) in this folder applying the decisions above to the real layout: no top header or
workbar, the container-first sidebar with collapsed rows, the flat LAYOUT list, Recent sessions, and
the new tile headers with renamed short titles. Keep the real terminal pixels from `real-layout.png` as 04
did.
