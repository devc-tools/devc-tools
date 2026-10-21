# Alternatives after review: concepts 06–08

These supersede 04 as the post-review, tree-based design explorations. 04 remains unchanged for comparison. No application code was changed.

**Follow-up:** container-scoped tabs are explored in 10 and 11, with rationale in `12-container-tabs-notes.md`. The vertical subsection pattern used here is an alternative, not a required consequence of preserving container/repo/session ownership.

Open the HTML files directly; each loads the adjacent `real-layout.png`. The PNGs are rendered at 1920 × 1050. Terminal content is cropped/scaled from that screenshot, not queried from live agents. Sidebar content and suggested short aliases illustrate the design rather than claiming a new live state. Native disclosure controls expand/collapse example tree branches; clicking a Layout row or panel header updates the mockup's active highlight. They are not production implementations of renaming, shortcuts, terminal controls, or complete data loading.

## Structural corrections to 04

- **Container is the management boundary.** Containers remain first-class roots, not renamed projects or repositories. Start/stop, bridge grants, and connection identity remain container-scoped.
- **Multiple repos remain children of one container.** Repos still opens a multi-root tree, including its file/folder hierarchies. It is not replaced by a single-repo Changes/Git view.
- **Files is the container filesystem.** It coexists with Repos; it is not the active repository's file tab. The example shows `/workspaces` and `/home/vscode` as roots.
- **Terminals are running Herdr panes; Layout entries are browser tiles.** These are two views of different entities. Retaining both is intentional, not needless duplication: panes can run offscreen and one pane can appear in several tiles. Terminals keeps the original pane names; only Layout and tile headers use the proposed browser-local aliases. A Layout entry focuses its specific tile, not simply a pane ID.
- **Sessions retain container, agent, session ID, root, and cwd.** Global Recent sessions is an additional navigation index, not a relocation or flattening of session ownership. Resume must use the original session's container and cwd/worktree, regardless of the currently focused tile. Worktree details should remain accessible via tooltip/details even if the row uses a friendlier repo name.
- **Tasks retain routing/grouping.** Container/repo grouping and Sent stay available, not a free-floating list that loses the launch target.

## 06 — Compact container sidebar

Files: `06-compact-container-sidebar.html` / `.png`.

Closest to the review's recommended baseline. A flat Layout list, grouped Tasks, five global Recent sessions, then compact collapsed containers. No top header, workbar, commands/search placeholder, named layouts, or speculative task inspector. All three terminal views start immediately below their own title strips.

**Benefit:** minimal navigation redesign; many containers fit without exposing all of their subtrees.

**Cost:** Recent sessions occupies substantial height before Containers. Expanding several containers can push them offscreen in the single scrolling sidebar. A collapsed-by-default global Recent section may suit frequent file/repo browsing better.

## 07 — Container-first tree

Files: `07-container-first-tree.html` / `.png`.

A wider sidebar with Layout first, a collapsed global Recent section above Containers, the active container expanded, and Tasks below the container tree. Shows Terminals, Repos, and Files open simultaneously. Per-container Sessions remains independently expandable. Repos shows several roots rather than assuming one repo per container.

**Benefit:** clearest expression of the existing hierarchy; useful when file/repo browsing is central. Minimal change to the tree's navigation concept.

**Cost:** more indentation and duplicated pane/tile names in view, and Tasks can move below the fold. The wider sidebar uses slightly more horizontal terminal space. This deliberately varies the review's preferred emphasis, not the underlying data model.

## 08 — Two-zone sidebar

Files: `08-two-zone-sidebar.html` / `.png`.

A persistent upper zone for Layout, Tasks, and three Recent sessions; a separately scrolling lower zone for the complete container tree. The separator indicates a proposed resizable split, but resizing is not implemented in this static prototype. No tabs replace the child branches. Screenshot shows the lower zone's scroll position at the top.

**Benefit:** expanding a repo or browsing a deep file tree cannot scroll the Layout shortcuts away. Container/repo/session ownership stays visible in the lower tree.

**Cost:** two scroll regions, a smaller container viewport, and an extra adjustable boundary to understand. At short viewport heights the zones would need sensible minimums and collapse behavior; do not fix their proportions to this screenshot.

## Recommended direction

Use **07's full hierarchy inside 06's restrained shell**, with global Recent collapsed initially. If the chief frustration is losing Layout while browsing the tree, use **08's two-zone organization** instead. The three variants share the same compact panel headers and strong focus treatment; the choice is sidebar prioritization and scrolling behavior.

## Code-informed qualifications to the review

1. **Statuses:** `devc/web/static/lib/sidebar.js` already recognizes `blocked`, `working`, `done`, `unknown`, and `idle`; its displayed short labels are `wait`, `work`, `done`, `unkn`, and `idle`. The screenshots use only the original screenshot's `idle`/`work`/`done`. Do not infer "needs input" from `idle`, or equate `done` with completed task delivery. A future unseen-done marker is a separate browser notification state, not a new Herdr status.
2. **Recent loading:** `sessionLists`/`loadSessions()` in `app.js` fetch per-container data on demand. A truly global index requires an explicit policy. Prefer fetching connected containers when global Recent expands or refreshes, using cached results with loading/error indicators per source. Do not silently claim "latest across all containers" when only one container has been loaded. Deduplicate by container + agent + session identity, not title or repo name. Keep the existing per-container Sessions view.
3. **Tile alias vs pane rename:** an existing Herdr pane label and a proposed browser-local tile alias are different. The example short headers should be explicit user-provided tile aliases saved with the browser layout; do not assume automatic task summarization. Preserve original agent title and container/repo identity in tooltip/details. Define what happens when a pane is shown in two tiles before implementing.
4. **Flat Layout need not flatten the actual layout.** Keep Golden Layout rows, columns, stacks, drag/drop splitting, and persistence. The sidebar list should include every tile, including inactive tabs, with stable ordering and a hidden-tab indicator where applicable. The screenshots happen to contain three visible tiles and no tab stack. Do not remove existing split/new-shell/close menu actions just because their nested tree rows are gone.
5. **Shortcuts:** the displayed Option-number hints are proposals, not implemented bindings. Validate conflicts with Mac option-as-meta, browser/OS shortcuts, non-Mac terminals, and inactive stack tabs before choosing defaults. Aliases and focus styling do not depend on introducing shortcuts.
6. **Tree keyboard navigation:** these HTML prototypes use native disclosures, not the application's custom tree navigation. Production arrow-key focus, selection, expanded-state persistence, drag sources, and context menus must be preserved. Only the Layout visualization may become flat; the container and file trees remain trees.
7. **Container summaries:** prefer accessible dot + word/count summaries or tooltips (e.g. `work 1 · done 1 · idle 1`). The examples use colored dot + word/count rollups; color alone must not be the only status signal. Non-agent shells must not become `unknown` agents.

## Scope

These are design artifacts only. No live app connection was made for this iteration. Existing 00/04/05 artifacts and `real-layout.png` were preserved.
