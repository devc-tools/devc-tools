# devc web: sidebar fixes from a many-container review

Follow-up to the mockup-13 implementation ([design/devc-web-ux/14-implementation-tracking.md](../design/devc-web-ux/14-implementation-tracking.md)),
from a live review on a machine with ~20 containers. Decisions were made with the user on
2026-10-21; this doc is the spec. Features continue 14's numbering (F9 on) and each gets a row
there when done.

## Decisions

### F9 — Tasks is a top-level section

Tasks stops being a row inside the In use zone's list and becomes a section heading of its own
(`sectionRow`, uppercase "TASKS" like "IN USE"), **first in the upper zone**, above Pinned and In
use. The heading is collapsible (the existing `tasksOpen` state), and carries the counts
(`2 open · 13 sent`) and the hover + (new task) and collapse-all buttons on its right. What it holds
when open does not change.

### F10 — Chevrons are drawn, and turn when open

Every chevron is drawn with two borders of a small square (a glyph `›` turned 90° still sat low:
neither glyph is centered in its own box), pointing right, and down when its row is expanded
(`[aria-expanded='true']`), instead of switching from `›` to `⌄`. Centered on the text's middle.

### F11 — In use repo rows open terminals and tasks

An In use group's row gets the hover buttons a repo row in the container tree has
(`newTerminalButton`: "New task here" and the + menu of shell / agents), at the group's repo
folder (a container's root when the group has no repo). Shown only while a container that mounts
the folder is running (`containerByFolder`). When more than one running container mounts it
(F12), each menu lists one block per container, divided, each item suffixed `· <container>`;
the task button then opens a menu of `New task · <container>` items. With one, behavior is
exactly the repo row's.

### F12 — One In use group per folder

In use groups by the **host folder** (`repo.folder`), not by container + folder, so a worktree
mounted in several containers is one group. Key: `repo\n<repo.folder>`; a pane or tile outside
every repo keeps a per-container group, key `container\n<localFolder>`. Inside a group: its tiles,
then its agents not in the layout, then its sessions from every container, newest first
(`updatedAt`), the first shown and the rest behind "N more sessions" as now. Which containers'
sessions are listed is unchanged: a container is listed once anything of it is in use. The
24-hour rule for a group with only sessions is unchanged, applied to the merged group. Saved
open/closed state (`inUseToggled`) is keyed by the new key; old keys are simply ignored.

### F13 — A running session is not offered as history

The server learns which listed Claude session runs in which Herdr pane, from Claude Code's
per-process records, and the page uses it:

- **Source.** In the container, for each `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` (default
  `$HOME/.claude`): the process is live and the record is its own when `/proc/<pid>/stat`'s
  field 22 (start time, counted after the `)` that ends field 2) equals the record's
  `"procStart":"<digits>"`; then `"sessionId":"<uuid>"` from the record and `HERDR_PANE_ID` and
  `HERDR_SESSION` from `/proc/<pid>/environ`. Records whose pid is gone, whose start time differs,
  or that lack any of these are skipped. `pidDomain` is not used (its format varies between Claude
  Code versions). The records are Claude Code's internal state, not a documented interface:
  anything that doesn't parse is skipped, never an error.
- **Script output.** The listing script (`SESSIONS_SCRIPT`) appends one line per running
  session: `R <sessionId> <HERDR_SESSION> <HERDR_PANE_ID>`. The same lines come from a separate
  `RUNNING_SCRIPT` constant that the listing script includes, so `resume_session` can run it alone.
  Neither may contain `${` (they are template literals): use `basename`, `sed`, `awk`.
- **Protocol.** A listed session gains `pane_id: string` when it is running in a pane of the
  server's Herdr session (`HERDR_SESSION` equal to the session name devc web serves, `opts.session`).
  Absent otherwise. Copilot and pi sessions never get it.
- **resume_session** checks before launching: after the existing `resumedPanes` reuse, it runs
  `RUNNING_SCRIPT`; if the session runs in a pane present in the container's snapshot, it replies
  `{pane_id, tab_id, reused: true}` for that pane and starts nothing. A failed check falls through
  to today's launch.
- **Page, In use:** a session whose `pane_id` names a pane the page's snapshot has, with an agent
  in it, is left out of its group's sessions (the pane's own row stands for it) and out of the
  "N more" count.
- **Page, container Sessions tab:** the same session keeps its row, with a `running` tag (the
  `.tag` style "not in layout" uses) before its age. A click goes through `resumeSession` as now;
  the server's reply reuses the pane.

### F14 — Rows of one kind show the same parts; labels truncate from the right

- **In use group row:** `<repo name> ⎇ <branch>` and nothing else on every row; the container
  leaves it (it is in the tooltip, with every container that mounts the folder). A group with no
  repo shows its container's name, as now.
- **Rows inside a group** (tiles, agents not in the layout, sessions) all end their label with the
  container's name, muted (`.row-container`), on every row, even in a group with one container.
- **Truncation:** a row's label tokens give way from the right: the last token (the container)
  is cut first, then the one before it. Trailing items (status badge, `not in layout` / `running`
  tags, a session's age, hover buttons) are never cut. A session row's container moves from its
  trail into its label for this.

### F15 — The Containers section collapses

The CONTAINERS heading gets a chevron and collapses like Tasks. Saved as `containersOpen`
(default open). Collapsing hides every container and "Not running" row below it.

## Out of scope

- Merging sessions across containers in the container tree (F12 is In use only).
- Copilot / pi running detection.
- Making a resumed pane's label match an unrenamed one (`resume_session` renames the pane to the
  session title, so the two differ). Noted in 14 for review.

## Checklist

- [x] F10 chevron: `style.css` `.chevron` drawn with two borders, turned down when expanded
- [x] F9 Tasks section: `taskRows` heading is a `sectionRow`; first in the upper zone
- [x] F15 Containers section collapsible, `containersOpen` saved
- [x] F12 In use groups keyed by host folder; sessions merged across containers
- [x] F14 group row without container; inner rows end with the container; session container in label
- [x] F11 group row hover buttons (new task, + menu), multi-container menus
- [x] F13 server: `RUNNING_SCRIPT`, parse `R` lines, `pane_id` on listed sessions, `resume_session` check
- [x] F13 page: `parseSessions` keeps a string `pane_id`; In use hides running sessions; Sessions tab tags them
- [x] Unit tests for the parsing and the pure grouping / running helpers
- [x] 14-implementation-tracking.md: F9–F15 rows and their exceptions; README "Current state" points here

## Validation

- [x] `cd devc && deno task check` passes
- [x] `cd devc && deno task test` passes, including new cases: `parseSessionsOutput` reads `R`
      lines into a running map and ignores malformed ones; `pickSessions` (or its caller) sets
      `pane_id` only for a matching Herdr session; the page's `parseSessions` keeps a string `pane_id`
      and drops a non-string one; the In use grouping helper puts one folder's items from two
      containers in one group
- [x] `cd devc && deno fmt --check` passes
- [x] In the container, `RUNNING_SCRIPT` run by hand (`sh -c "$RUNNING_SCRIPT"`) prints an `R` line
      for this Claude session whose pane id equals this shell's `$HERDR_PANE_ID`
- [x] Live, headless browser against the user's devc web (read-only):
  - the upper zone's first row is the TASKS heading
  - every expanded chevron's glyph box is vertically centered on its row (within 1px), checked
    with `getBoundingClientRect` on `.chevron` vs its row
  - no two `.in-use-group` rows share a host folder (their tree keys, `repo\n<host folder>`, are
    unique); `/workspaces/vscode-deephaven.worktrees/DH-23855_npm-audit-fix` is one group
  - no `.in-use-group` row contains `.repo-container`
  - every in-group tile / pane / session row has a `.row-container`
  - CONTAINERS collapses and stays collapsed after a reload
- [x] After the user restarts `devc web` (server code): this Claude session's session row is absent
      from In use and has a `running` tag in code-wksp's Sessions tab
- [x] `resume_session` for a session running in a pane returns `reused: true` and no new pane
      appears (checked live by the user, resuming a running session from code-wksp's Sessions tab)

## Relevant Files

- `devc/web/sessions.ts` — `RUNNING_SCRIPT`, `R` parsing, `pane_id`
- `devc/web/server.ts` — `list_sessions` filters running by Herdr session; `resume_session` check
- `devc/web/static/lib/sessions.js` — `parseSessions` keeps `pane_id`
- `devc/web/static/app.js` — Tasks section, Containers collapse, In use grouping and rows, session rows
- `devc/web/static/style.css` — chevron, `.row-container`, Tasks heading
- `devc/tests/web_sessions_test.ts`, `devc/tests/web_sessions_page_test.ts` — new cases
- `devc/README.md` — the `devc web` paragraph naming the Tasks row (line ~294), if its wording changes
- `.plans/design/devc-web-ux/14-implementation-tracking.md`, `.plans/design/devc-web-ux/README.md`
- `.plans/PLAN.md`
