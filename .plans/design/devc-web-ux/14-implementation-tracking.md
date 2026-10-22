# devc web UX: implementing mockup 13

Tracks the live implementation of [13-starting-mockup](13-starting-mockup.png) in devc web: which
features are done, and every place the implementation deliberately differs from the mockup
(**exceptions**), with the reason. The user reviews the whole set at the end; nothing here is
signed off yet.

All of it is page code (`devc/web/static/`), so it works under plain `devc web --live`. No server
or protocol change so far. To undo a feature, revert its commit.

## Features

| #   | Feature                                                                                                                                                                                | State | Commit                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------- |
| F1  | Tile headers: label, then repo / ⎇ branch / container muted, status at the right; framed tiles with a focused-tile highlight                                                           | done  | `e51ebf3`                       |
| F2  | Sidebar restyle: the mockup's palette, section headings, row sizes and status badges                                                                                                   | done  | `ea8f18f`                       |
| F3  | "In use" zone: tiles, running panes not in the layout, and recent sessions, grouped by repo / worktree                                                                                 | done  | `b97dddf`                       |
| F4  | Two zones: In use above, Containers below, each scrolling on its own                                                                                                                   | done  | `b97dddf`                       |
| F5  | Container tabs: Terminals / Sessions / Repos / Files under each expanded container, remembered per container (superseded by F17–F20: repo cards and a Files row)                       | done  | `41447e0`                       |
| F6  | Container row: per-status agent counts, shown expanded too                                                                                                                             | done  | `41447e0`                       |
| F7  | Repo labels: parent path muted before the bold name (`.plans/` deephaven-core)                                                                                                         | done  | `41447e0`                       |
| F8  | Tasks as one compact row with counts                                                                                                                                                   | done  | `951f20a`                       |
| F9  | Tasks as a top-level section in a zone of its own, at the top of the sidebar, at most a quarter of it by default (supersedes F8's placement)                                           | done  | `0a09316`, `fa141a0`, `f5c7be6` |
| F16 | Draggable rules between Tasks, In use and Containers: In use (middle) resizes, then moves whole; sizes saved per browser, double-click resets                                          | done  | `f5c7be6`                       |
| F10 | Chevrons drawn, turned when open, centered on the text                                                                                                                                 | done  | `4b664c3`                       |
| F11 | In use group rows: hover new task and + (shell / agent) at the folder, per running container                                                                                           | done  | `df12fd7`                       |
| F12 | In use: one group per host folder across containers; each session once (superseded by F19: a card per container)                                                                       | done  | `df12fd7`                       |
| F13 | Claude sessions running in a pane: not offered in In use, tagged `running` in Sessions, never resumed twice (the tag went with the Sessions tab, F20: a running session is on no card) | done  | `215aa11`                       |
| F14 | Same parts on every row of a kind; labels give way from the right (container first)                                                                                                    | done  | `df12fd7`                       |
| F15 | Containers section collapses; In use may then take the whole sidebar                                                                                                                   | done  | `0a09316`                       |
| F17 | Repo cards: one per repo or worktree per container, terminals always shown, toggles for past sessions, PR and files                                                                    | done  | —                               |
| F18 | Active repo cards (tile, untiled agent, session in the last day) in In use under their container; the rest in their container's card in Containers                                     | done  | —                               |
| F19 | A repo mounted in two containers has a card in each; each past session on one card                                                                                                     | done  | —                               |
| F20 | Container cards lose their tabs: a + on the header and a Files row for the container's filesystem                                                                                      | done  | —                               |

F9–F15 come from a live review on a machine with ~20 containers, specified in
[devc-web-sidebar-scale-fixes](../../archived/devc-web-sidebar-scale-fixes.md). F17–F20 are
specified in [devc-web-repo-cards](../../devc-web-repo-cards.md).

## Exceptions

Each is a place the implementation differs from the mockup on purpose. Say which to revisit.

### F1: tile headers

1. **The agent's or command's title stays in the header.** The mockup shows only the alias. For
   a pane nobody renamed, the title is the most informative text there is. It comes after the
   repo / branch / container and is the first thing to give way when the header is short.
   Hiding it on renamed panes is a one-line change if wanted.
2. **A stack with several tabs** shows each tab's label and status only, and keeps Golden
   Layout's tab strip and stack ×. The context widened the front tab until Golden Layout moved
   the other tabs to its dropdown. The mockup only shows one-tab stacks.
3. **No ⋯ button** in the header. It would be a new menu; the tab's right-click menu has the
   actions today.
4. **Status keeps the app's colors and monospace font**, only smaller (10px, 5px dot). The
   colors are shared with the sidebar's badges; monospace keeps the four-letter words the same
   width so the header doesn't shift when a status changes. F2 can switch the palette for both
   at once.
5. **⤢ and × are text glyphs**, not icon files: the server serves only `.html`, `.js`, `.css`
   and `.png`, so SVG files would need a server change.
6. **File tiles** get the frame and colors but no repo / branch context yet.
7. **Behavior:** in a one-tab stack the right-most × is the tab's own close (which asks before
   closing a file with unsaved edits); Golden Layout's stack × is hidden there because it
   skips that check.
8. **Narrow headers** drop the container, then the branch, then all of the context, at fixed
   header widths (560 / 440 / 320px), rather than squeezing each to an ellipsis.
   The agent's title goes at 440px too; the label keeps its full width until 320px. Known edge:
   a stack with two tabs squeezed to ~450px still lets the front tab's status run under its ×,
   since Golden Layout keeps the other tab at full width.

### F2: sidebar restyle

9. **The palette is the app's own tokens**, changed to the mockup's values (`:root` in
   `style.css`), so menus, dialogs and the host status strip change with it. That also settles
   F1's exception 4 on colors: the status colors are now the mockup's everywhere. The badge stays
   monospace (see 4).
10. **The default sidebar width is now 350px** (the mockup's). A width you dragged to is kept.
11. **The sidebar header is 34px**, level with the tile headers' bottom edge (5px margin + 29px),
    not the mockup's 30px.

### F3 / F4: In use zone, two zones

12. **Pinned files stay**, above In use, while anything is pinned. The mockup has no pins.
13. **The Layout tree stays**, below Tasks, **closed by default**: its row / column / stack rows
    show the nesting and carry actions (close a stack's tiles) that In use doesn't. Its open
    state is saved under a new name, so it starts closed once even if it was open before.
14. **No ⌥N shortcut hints** on tile rows: the README lists them as an unvalidated proposal
    (terminal / OS conflicts).
15. **Row icons are the app's** (agent marks, shell glyph) rather than the mockup's ▣ / ▱ / ↺.
16. **Only agents are listed as "not in layout"**; a plain shell no tile shows is under its
    container's Terminals. Otherwise every forgotten shell would fill In use.
17. **Sessions load on their own:** a container with anything in use has its sessions listed
    once per page (one `list_sessions` each), as opening its Sessions row did before. The ↻ on
    the In use heading lists them again. A repo with nothing open shows up only for a session
    from the last 24 hours, collapsed.
18. **A session matches a repo by the folder it started in**, so a worktree's sessions sit
    under the worktree. A Claude session running in a pane is left out (F13).
19. **Session rows** show the agent's mark and age; a click resumes, as before. No "resume"
    word on hover.
20. **The zones split at 56%**: In use takes what it needs up to that, Containers the rest
    (now enforced: Containers' flex basis is 0, so it no longer squeezes In use). With Containers
    folded, In use may take the whole sidebar (F15).

### F5 / F6 / F7: container tabs, status counts, repo labels

21. **The tab strip is one stop in the sidebar's keyboard tree**: Up / Down reach it like any
    row, Left / Right (Home / End) on it switch the view. Not a separate tab stop per tab.
22. **The views replace the four expanders.** Which view is shown is saved per container
    (Terminals until another is chosen); the old Terminals / Sessions / Repos open states are
    still saved but no longer used (left in place for now; cleanup once this is signed off).
23. **Each view's actions moved into the view**: a "＋ New terminal in <container>" row (the
    - menu: shell or an agent) and a "↻ Refresh sessions" row. The Terminals row's "New task
      here" button is gone from there; repo and folder rows still have it.
24. **Files shows the container's root listing directly.** Right-click on the Files tab gives
    the root's menu (new file, new folder…), which the Files row had.
25. **Repos always lists the repos**, even one (it used to show a single repo straight under
    the container, and several under a Repos row). The mockup's help lines ("Repository roots
    mounted in …") are left out to save room.
26. **Tab counts** on Terminals (panes) and Repos (top-level repos); Sessions and Files have
    none (sessions load on demand, files are a tree).
27. **The container row's status counts show expanded and collapsed** (one dot and count per
    status). Its git push / pull summary still shows only collapsed, as before.
28. **Repo labels:** a worktree listed under its repo shows just its own name; a session row
    shows its repo's short name (a worktree's main repo), like its In use group.

### F8: Tasks

29. **Tasks is one row** in the In use zone ("Tasks · N open · M sent"), opening to its groups
    and Sent as before; its + (new task) and collapse-all are hover buttons on that row. Its open
    state is the one saved before, so it stays open if it was.

### F9–F15: many-container fixes

30. **One group per host folder, so the same path can appear twice:** two different host folders
    mounted at the same container path show as two groups with the same name. Resolved as no UI
    issue: the one case seen was a mis-mounted `.plans` folder (`~/.plans/vscode-deephaven` at
    `/workspaces/vscode-deephaven` in one container); every other container keeps `.plans` in the
    container path, so names stay distinct.
31. **A session's container is where it will be resumed, not where it ran.** Agent homes are
    shared, so every container mounting a folder lists the same sessions and nothing records which
    one ran it. In use keeps one row per session, in the folder's own container when it has one,
    else the first that mounts it.
32. **A group several containers mount has long + / task menus:** a block per container (15 items
    for a worktree in three containers). Fine for now; a container picker could replace it.
33. **Running detection is Claude only**, from Claude Code's undocumented per-process records
    (`~/.claude/sessions/<pid>.json`). Copilot and pi keep the old reuse (panes this server
    resumed). `pane_id` is as of the last listing; the page also checks the pane still has an
    agent, and `resume_session` re-checks just before launching. Needs a `devc web` restart.
34. **A resumed pane is renamed to the session title** (unchanged): its label differs from a pane
    started by hand in the same folder. Out of scope here.
35. **A session row's container is part of its label in In use**, so it gives way before the
    title; the age stays.
36. **No `not in layout` tag on agent rows:** an agent no tile shows has a white icon (a tile's
    is the accent color), as in a container's Terminals tab; the In use heading keeps its
    "N not in layout" count, and the row's tooltip says it.

## Notes for the review

- **How it was checked:** a headless browser against the live server's page, with a fake
  WebSocket supplying one container, six panes (four in tiles, one agent outside the layout, one
  shell), five repos with a worktree and five sessions, at 1920×1050 and at a narrow width.
  Not against real containers, Herdr or real session lists: that is your tab.
- **Worth trying live:** keyboard through the sidebar (Up / Down across both zones, Left / Right
  on a tab strip); a container with many panes or repos (zone split, scrolling); the Files view
  on a real container; resuming a session from In use; a renamed vs unrenamed pane in a header.
- **Server / protocol:** none changed. `deno task check` and all tests pass after each commit.
- **Not done:** file tiles' header context (exception 6); cleanup of the now-unused
  Terminals / Sessions / Repos open states (exception 22).
