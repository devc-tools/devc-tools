# devc web UX exploration — start here

## Current state

**Implemented from mockup 13, awaiting review.** The user accepted [13](13-starting-mockup.png) as a good starting point (2026-10-20). It is now implemented in devc web, feature by feature; progress and every deliberate difference from the mockup are in [14-implementation-tracking.md](14-implementation-tracking.md), awaiting the user's review. Repo labels put their parent path in front, muted (`.plans/deephaven-core`), so labels are never ambiguous. Interactive details are meant to be worked out live in devc web.

The user likes the proposed visual styling, especially clearer tile headers and a stronger active-terminal highlight. The main open question is how to make container navigation more compact while preserving the existing data relationships.

**Latest alternatives:**

| Concept | Idea | Preview | Explore |
| --- | --- | --- | --- |
| **10 — Inline container tabs** | Each expanded container has its own Terminals / Sessions / Repos / Files tabs. Several containers can remain open on different tabs. | [Screenshot](10-inline-container-tabs.png) | [HTML prototype](10-inline-container-tabs.html) |
| **11 — Container inspector** | Select a container, then browse its tabs in a separate, explicitly scoped area. Optionally keep a second view visible. | [Screenshot](11-container-inspector.png) | [HTML prototype](11-container-inspector.html) |

**Starting mockup (combines the above with the repo-first decision):** [13 — screenshot](13-starting-mockup.png) · [HTML](13-starting-mockup.html). The top "In use" zone groups tiles, running panes that aren't in the layout, and recent sessions by repo/worktree, with the container muted. Below it, the container tree uses 10's inline tabs. Tile headers show the alias, then the repo and worktree, then the container muted. Interaction details are meant to be worked out live in devc web.

**Current assistant recommendation:** try **10** first for simplicity. Consider **11** if seeing Repos and Sessions simultaneously is a frequent need. This is a recommendation, not a user decision.

## Where to pick up

1. Open the screenshots or HTML prototypes for **10 and 11** above.
2. Decide whether one active view per expanded container is sufficient, or whether keeping two views visible is important enough to justify extra controls.
3. Refine the chosen visualization while retaining the ownership rules below.
4. Before implementing, resolve keyboard navigation, per-container/per-view state persistence, scope-specific actions, and behavior at smaller window sizes.

The original request was for investigation and mockups, **not application changes**. Do not begin implementing without a new request.

## User preferences and structural requirements

- Preserve a dense, three-terminal workspace with flexible cross-project tiling. Avoid tall global toolbars or dashboards that take space away from terminals.
- Keep the improved visual styling: compact short-name tile headers, muted context, status pinned to the right, consistent status colors, and a strong active-panel highlight.
- **The current vertical expander pattern is not mandatory.** The user explicitly wants to explore tabs or other compact ways of presenting the same hierarchy.
- The other agent's feedback is useful input, **not the final say**.
- **Containers come first for finding things; repos and folders come first for work in progress.**
  The user starts from containers when looking for something they know is in a particular
  container, or when managing its lifecycle. Once a repo is in use, its container is secondary and
  the repo/folder is what matters. So the surfaces for active work (tile headers, the Layout list,
  running agents, Recent sessions) should lead with the repo/folder (plus the worktree or branch when
  it differs) and show the container muted or only in a tooltip. Keep the container tree as the
  browse and manage view. This favors a two-zone sidebar: an "in use" area organized by repo/folder
  above the container tree. This revises `05-review-feedback.md`, which treated containers as the top
  level everywhere.

### Preserve the data model, not necessarily its current visualization

- **Containers** remain the management boundary for lifecycle, connection identity, and bridge scope. Do not replace them with a flat project/repo list.
- One container can hold **multiple repos**. Repos must remain a multi-root browser, not become a single-repo Git/Changes screen.
- **Files** means the container filesystem, not merely the currently selected repo's files.
- **Sessions** retain their original container, agent, session identity, repo root, and cwd/worktree. Resume must target those, not the focused terminal's directory.
- **Terminals** are running Herdr panes, including panes not currently visible. **Layout** lists browser tiles. They are different entities: one pane may appear in several tiles.
- Proposed short tile aliases are browser-layout labels, not automatic task summaries or renames of the underlying panes.
- Browsing a container or changing its view must not silently change the active terminal/input target.
- Container-scoped actions, routing, and status summaries must retain their scope even when their view is hidden behind a tab.

## High-level history

### Initial investigation and concepts 01–03

The assistant inspected the app source and connected to the running web app. A fresh browser had no saved panel layout. Three broad concepts explored a refined workspace, an agent overview, and a focus mode.

These initial artifacts were created under `/tmp/devc-ux` and later copied here (`01`–`03-*.png`, source `concepts.html`) for reference; **they are not needed to continue**. Their larger headers, dashboard emphasis, and task inspector are not the current recommendation.

### User's real layout → concept 04

The user supplied a screenshot of their populated workspace, now preserved as [real-layout.png](real-layout.png). It showed three dense terminals and a busy sidebar. This shifted the emphasis toward preserving terminal density and improving navigation rather than replacing the workspace.

[04 — layout-preserving concept](04-layout-preserving.html) introduced clearer headers, short labels, a stronger active-panel highlight, and simplified sidebar sections. However, its project-centric navigation blurred containers and repositories. Its proposed Git tab was corrected to Repos. **04 is an earlier exploration, not the latest direction.**

### Other agent's review → concepts 06–08

The user preserved the artifacts here and requested alternatives based on [05-review-feedback.md](05-review-feedback.md).

The review identified legitimate structural issues with 04 and favored retaining container roots, independent tree branches, compact headers, and a flat Layout list. This led to:

- [06 — compact sidebar](06-compact-container-sidebar.png): flat Layout, Tasks, global Recent sessions, and collapsed containers.
- [07 — container-first tree](07-container-first-tree.png): an expanded container with independently open Terminals, Sessions, Repos, and Files branches.
- [08 — two-zone sidebar](08-two-zone-sidebar.png): persistent upper navigation and a separately scrolling container tree.

Reasoning and caveats: [09-alternatives-notes.md](09-alternatives-notes.md).

### User clarification → concepts 10–11 (latest)

The user clarified that preserving the hierarchy does **not** mean preserving the vertical sequence of expanders. Tabs remain interesting if container/repo/session ownership stays intact.

The review had two reasons against tabs: ordinary tabs hide sibling views, and the existing tree keyboard handler does not support them. These are interaction trade-offs to address, not proof that tabs violate the data model.

Concept **10** explores container-scoped inline tabs. Concept **11** explores a scoped inspector with an optional second view to address simultaneous browsing.

Detailed trade-offs and interaction notes: [12-container-tabs-notes.md](12-container-tabs-notes.md).

## Unresolved implementation questions

These are not settled by the mockups:

- **Tab navigation:** keyboard focus must work across container controls, tab strips, and file trees without intercepting terminal/editor input.
- **State:** remember each container's selected view and each view's expansion, selection, and scroll position. The example prototypes do not implement all of this persistence.
- **Global Recent sessions:** existing session data loads per container on demand. A global list needs explicit refresh/loading/error behavior; it cannot claim complete global recency from a partial cache.
- **Statuses:** the code recognizes `blocked`, `working`, `done`, `unknown`, and `idle`; displayed short labels are `wait`, `work`, `done`, `unkn`, and `idle`. Do not invent a new semantic “needs input” state from `idle` or equate agent `done` with a completed task.
- **Shortcuts:** Option-number hints are proposals. Validate OS/browser and option-as-meta conflicts before adopting them.
- **Flat Layout:** flattening its sidebar representation must not remove Golden Layout's nested rows/columns/tab stacks, hidden tabs, drag/drop targets, or existing menu actions.
- **Small windows:** sidebar width, scrolling regions, tab-strip fit, and optional second-view sizing need validation beyond the example desktop screenshots.

## Opening and transferring the artifacts

- Open the HTML prototypes directly in a browser; no server or live app token is needed.
- Terminal content is cropped/scaled from `real-layout.png`, not a connection to live agents. Sidebar data and suggested aliases are illustrative.
- The HTML uses relative image paths. **Keep this whole folder together** when switching machines.
- This README is the entry point; numbered documents preserve the detailed reasoning and review history.
- No commit or push has been performed by the assistant. Files in a working directory do not automatically transfer to another machine: commit/push or copy the folder through your normal sync mechanism.
