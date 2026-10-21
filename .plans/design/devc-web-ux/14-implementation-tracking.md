# devc web UX: implementing mockup 13

Tracks the live implementation of [13-starting-mockup](13-starting-mockup.png) in devc web: which
features are done, and every place the implementation deliberately differs from the mockup
(**exceptions**), with the reason. The user reviews the whole set at the end; nothing here is
signed off yet.

All of it is page code (`devc/web/static/`), so it works under plain `devc web --live`. No server
or protocol change so far. To undo a feature, revert its commit.

## Features

| # | Feature | State | Commit |
| --- | --- | --- | --- |
| F1 | Tile headers: label, then repo / ⎇ branch / container muted, status at the right; framed tiles with a focused-tile highlight | done | `e51ebf3` |
| F2 | Sidebar restyle: the mockup's palette, section headings, row sizes and status badges | done | `ea8f18f` |
| F3 | "In use" zone: tiles, running panes not in the layout, and recent sessions, grouped by repo / worktree | done | (this commit) |
| F4 | Two zones: In use above, Containers below, each scrolling on its own | done | (same commit as F3) |
| F5 | Container tabs: Terminals / Sessions / Repos / Files under each expanded container, remembered per container | pending | |
| F6 | Container row: per-status agent counts, shown expanded too | pending | |
| F7 | Repo labels: parent path muted before the bold name (`.plans/` deephaven-core) | pending | |
| F8 | Tasks as one compact row with counts | pending | |

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
    under the worktree. A session already running in a pane is still listed: nothing ties a
    pane to its session id.
19. **Session rows** show the agent's mark and age; a click resumes, as before. No "resume"
    word on hover.
20. **The zones split at 56%**: In use takes what it needs up to that, Containers the rest.

## Notes for the review

- Verified in a headless browser against the live server's page with a fake WebSocket
  (containers, panes, repos), at 1920×1050 and at a narrow width. Not verified against real
  containers: that is the user's tab.
