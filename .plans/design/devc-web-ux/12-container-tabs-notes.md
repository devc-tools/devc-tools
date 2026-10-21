# Container-scoped tab explorations: 10 and 11

## Handoff / resume on another machine

**Current state:** design exploration only; no application implementation has been requested or performed. The user likes the general visual style but wants the data hierarchy preserved, not necessarily the existing vertical Terminals / Sessions / Repos / Files expander pattern. The other agent's review is input, not a final decision. No alternative has been selected yet; the current recommendation is to try **10** first.

**Latest artifacts**

- [10 — inline container tabs (interactive HTML)](10-inline-container-tabs.html) · [screenshot](10-inline-container-tabs.png)
- [11 — container inspector with optional second view (interactive HTML)](11-container-inspector.html) · [screenshot](11-container-inspector.png)

**Earlier context**

- [Original populated layout](real-layout.png)
- [04 — first layout-preserving mockup](04-layout-preserving.html): earlier project-centric version, not the current recommendation.
- [05 — other agent's review](05-review-feedback.md)
- [09 — rationale for tree-based alternatives 06–08](09-alternatives-notes.md)

Open the HTML files in a browser to explore their local controls. Keep this entire `devc-web-ux` folder together when moving machines: the HTML files load `real-layout.png` by relative path. No server, live authentication token, or `/tmp` file is needed. The prototypes do not connect to devc or running agents.

The next design decision is whether one view per expanded container (10) is sufficient, or whether routinely keeping two views visible warrants the additional inspector/pinning controls (11). Do not treat the prototype behavior as a finished implementation specification; keyboard integration, state persistence, lifecycle actions, and responsive sizing still need design/validation before coding.

Files being in the working tree does not automatically transfer them to another machine. Ensure the entire design folder is committed/pushed or copied through your normal sync mechanism; no commit or push was performed as part of this design work.

The review's objections to tabs were real but not a prohibition on this design: (1) ordinary tabs hide siblings, preventing simultaneous Repos/Sessions browsing, and (2) the existing application tree keyboard handler does not navigate tab controls. Neither requires changing the underlying data hierarchy. The earlier recommendation to retain vertical child rows was conservative, not a data-model requirement.

These alternatives explore tabs explicitly at **container scope**, not project scope. They retain 06–08's compact tile chrome, flat Layout list, and screenshot-based terminal views. All earlier artifacts remain unchanged.

## Shared invariants

- A container can have multiple repo roots, sessions from different worktrees, several running panes, and its own filesystem. A tab selects a view into that container, not a new owner for the data.
- **Terminals** lists all running Herdr panes in that container, including panes absent from Layout. Existing terminal workspace/order information must remain available.
- **Sessions** retains original container + agent + session identity + root + cwd. Resume must not adopt the currently focused terminal's directory.
- **Repos** remains a multi-root repository/file browser, not a single selected repo's Git/Changes screen.
- **Files** browses the container filesystem. It is not a duplicate of the active repo tree.
- Container lifecycle, bridge-grant scope, status rollups, and stopped/known projects remain container/project-scoped. Not every container or lifecycle action is illustrated in these examples; none is proposed for removal.
- Layout and terminal-input focus stay independent of container browsing. Clicking a container or switching its view does not send input to or focus a different live terminal.
- Agent activity summaries stay visible on the container row even when Terminals is not the active tab.

## 10 — Inline container tabs

Files: `10-inline-container-tabs.html` / `.png`.

Expand a container and select Terminals / Sessions / Repos / Files directly beneath its name. The screenshot intentionally shows **code-wksp → Repos** and **devc-dev → Terminals** at the same time, demonstrating that each container has its own view selection.

**Pros**

- Closest to the earlier tabbed visual idea, corrected to match the actual model.
- Container ownership is unmistakable because the content sits under that container.
- The sidebar drops three inactive subsection headings while focusing on a chosen view.
- Several containers can be expanded simultaneously, each on a different tab.

**Costs**

- One ordinary tab view per container: code-wksp's Repos and Sessions are not simultaneously visible in this version.
- A repeated tab strip per expanded container and deep content can still make the sidebar long.
- Production needs keyboard behavior for a compound tree/disclosure/tab component, not the old tree-only navigation unchanged.

**Suggested production behavior**

Remember the selected tab, tree expansion/selection, and scroll position per container and per view. Do not reset a repo tree when switching to Sessions and back. Keep full repo/worktree paths in tooltips/details when friendly names are ambiguous. Put refresh/new-terminal actions inside the correct tab, keeping their target container explicit.

## 11 — Container picker + scoped inspector, with a second view

Files: `11-container-inspector.html` / `.png`.

Choose a container in the upper list. A separate lower browser is labeled **Browse / code-wksp** and offers that container's four views. The screenshot shows **Repos** as the primary view and **Sessions** kept alongside it below.

**Keep alongside** retains the current view in a second pane and opens another view above it. If that second view is already pinned, choosing its tab swaps primary and secondary, avoiding duplicate views. The × removes the secondary pane. In the prototype, state is maintained separately for each of the three illustrated containers.

**Pros**

- Avoids repeating a tab strip under every container.
- Persistent scope label prevents the inspector from looking like a global Repos or Files view.
- Keeping a second view explicitly addresses the review's Repos-and-Sessions simultaneity concern.
- Container browsing and active-terminal selection stay independent.

**Costs**

- More conceptual machinery: selected container, active view, and optional secondary view.
- Multiple scrolling areas and less room per view when two are open.
- Only one container inspector is visible at a time; it is not ideal for side-by-side browsing of two containers.
- The pinned view is **within the same container**. Switching containers shows that container's own state; it must never silently keep an old container's actions under a new scope heading.

The screenshot keeps sessions compact so the main repo tree remains useful. In production, the inspector boundary and primary/secondary split should have sensible sizing and short-viewport fallback behavior.

## Keyboard design is part of the decision

Tabs do require a real change to the current keyboard interaction; that part of the review should not be dismissed.

- Tab reaches the selected view tab; Left/Right and Home/End navigate the tab strip.
- The tab panel/file tree has its own navigation. Up/Down/Left/Right inside a file tree continue to operate on the tree, not on the view tabs.
- Container disclosure/list selection and Layout focus keep their separate semantics.
- Tab handlers must only act while focus is on those controls. They must not capture arrows intended for xterm, an editor, or an agent.
- Use appropriate tablist/tab/tabpanel relationships and focus indicators. Do not insert buttons into the existing tree and assume its current event handler will work unchanged.

Both HTML examples implement local tab switching, roving tab focus with Left/Right/Home/End, and native example tree disclosures. 11 also implements local container selection and secondary-view pin/swap/unpin. These are illustrative prototypes, **not an application integration or accessibility certification**. In particular, 11 re-renders example panel HTML and does not preserve repo-tree expansion on tab switches; production must retain that state.

## Recommendation

**Try 10 first** if the main goal is a cleaner and more focused container browser. It preserves the data hierarchy with the least new interaction machinery.

Choose **11** if keeping Sessions and Repos visible simultaneously is a regular workflow rather than an occasional convenience. A pin/second-view affordance should be an explicit choice, not default complexity for everybody.

The vertical tree in 07 remains a useful comparison, not a mandatory constraint. The architectural question is "what owns this data and action?"; the interaction question is "how many of its views must I see at once?" These should not be conflated.

## Scope and verification

Only design artifacts were added. Terminal pixels come from adjacent `real-layout.png`; sample sidebar content, abbreviated titles, session metadata, and example directories are illustrative. The HTML files are offline and do not connect to live agents. All source-image paths are relative so the folder can move intact.

Browser checks covered: independent tab state between two inline containers; arrow-key tab navigation; selected-container scope changes without changing terminal highlight; pin/swap/unpin; source image loaded; and no document-level horizontal overflow at 1920 × 1050.
