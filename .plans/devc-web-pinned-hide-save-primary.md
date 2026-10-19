# devc-web-pinned-hide-save-primary

Two page-only changes to `devc web`, after [devc-web-tasks-actions](devc-web-tasks-actions.md)
(both edit `app.js`; implement this one on top of it):

1. **No empty Pinned section.** While nothing is pinned, the sidebar has no Pinned section: no
   header, no `No pinned files` row. The first pin makes it appear. Unpinning the last one makes
   it disappear again.
2. **Save is the New task dialog's primary action.** The footer holds **Cancel** and **Save**,
   with **Save** the accent (`primary`) button at the right end. The two sends leave the footer
   and become icon buttons in the dialog's header, the same `plan` and `implement` icons that
   task rows use.

There are no new messages and no server changes.

```
before                                   after (nothing pinned)
PINNED                         +         TASKS                          +
  No pinned files                          Retry gh-push on 502  devc-tools
TASKS                          +         LAYOUT
  …                                        …

New task dialog
before:  header  New task                                        [Cancel]
         footer  Sending starts …   [Save] [Send: plan] [▓Send: implement▓]
after:   header  New task                                        [▤] [</>]
         footer  Sending starts …                         [Cancel] [▓Save▓]
```

## Decisions

- **New note… with nothing pinned:** it is not offered anywhere. Its only entry points are the
  Pinned header's **+** and the header's context menu, and both go away with the section. With
  nothing pinned, a note starts with **Pin file** on a repo file (a file tile's or a repo file's
  menu). Once one pin exists, **New note…** is back on the header. Do not add it to any other
  menu. (This is the user's decision.)
- **Hidden means not rendered.** `pinnedFileRows()` returns `[]` when `pinnedFiles.length === 0`,
  before it builds the `sectionRow`. The section's collapsed state does not matter then.
- **The open/collapsed state is kept.** `sidebarState.pinnedOpen` is not changed when the
  section hides or reappears. `pinFile` and `submitNewNote` already open it after a successful
  pin, so the first pin always shows its row. A pin that arrives from another window
  (`pinned_files` broadcast) shows the section in whatever state `pinnedOpen` was saved in.
- **Before the first `pinned_files` message** `pinnedFiles` is `[]`, so the section is absent
  until the server's reply arrives, then appears. Accept that. Do not add a "loaded" flag.
- **Remove `LABELS.noPinnedFiles`**: it has no use left.
- **Ctrl+Alt+N** (toggle the first pin) is unchanged. With nothing pinned it already does nothing
  useful. Do not change its handler.
- **Footer: `Cancel` then `Save`, primary at the right end.** This matches `confirmDialog`
  (Cancel, then its primary OK). The `picker-hint` text `Sending starts the agent in the repo`
  stays on the left, unchanged. Cancel closes the dialog (`el.close()`), as the header's Cancel
  did. Cancel is **not** in `taskDialog.$buttons`, so it stays enabled while busy, as today.
- **Header: the title on the left, the two send icons on the right**, in the order `plan`,
  `implement`, built with the existing `iconButton(icon, title, action)` (its click handler
  calls `submitTask('plan' | 'implement')`). The header's text Cancel button is removed.
  Escape still closes the dialog (the native `<dialog>` behavior).
- **The icon titles name the dialog's agent** and follow the Agent dropdown: on open, and on
  every `change` of `$agent`, set both buttons' `title` **and** `aria-label` to
  `Send to <Agent>: plan` / `Send to <Agent>: implement`, the same text as the task-row icons
  (`LABELS.agents[$agent.value]`). `iconButton` sets both attributes only once, at creation.
- **Disabled icons look disabled.** `.icon-btn` has no disabled style today. Add
  `.icon-btn:disabled { opacity: 0.45; cursor: default; }` (the `button.primary:disabled`
  values), and keep the hover highlight off: `.icon-btn:disabled:hover { color: var(--muted);
  background: none; }`. This applies to every icon button, which are never disabled elsewhere
  today.
- **Keyboard is unchanged:** Ctrl/⌘+Enter in the textarea already calls `submitTask(null)`
  (Save), so it now matches the primary button. Do not make plain Enter submit.
- **Send's enable/disable rules are unchanged:** the two send icons are disabled while the task
  is not routed or the dialog is busy (`fillTaskRepos`, `busy`). Save is disabled only while
  busy. `taskDialog.$send` is the two icon buttons; `taskDialog.$buttons` is Save plus them.

## Contracts

### Sidebar section order

| Pins         | Top-level section headers (`.row.section`), top to bottom |
| ------------ | --------------------------------------------------------- |
| none         | `Tasks`, `Layout`, `Containers`                           |
| at least one | `Pinned`, `Tasks`, `Layout`, `Containers`                 |

The page never shows the text `No pinned files`.

### New task / Task dialog

`header.dialog-header`: the title span (`New task` or `Task`), then a `span.task-send` holding,
left to right:

| Element                                | `title` / `aria-label`       | Click                     |
| -------------------------------------- | ---------------------------- | ------------------------- |
| `button.icon-btn[data-icon=plan]`      | `Send to <Agent>: plan`      | `submitTask('plan')`      |
| `button.icon-btn[data-icon=implement]` | `Send to <Agent>: implement` | `submitTask('implement')` |

`<Agent>` is `LABELS.agents[id]` for the Agent dropdown's current value (`Claude`, `Copilot`,
`Pi`). `.task-send` is `display: inline-flex; gap: 6px; align-items: center`.

`footer.dialog-footer`: the `picker-hint` span, then `span.task-buttons` holding, left to right:

| Button text | `class`   | Click              |
| ----------- | --------- | ------------------ |
| `Cancel`    | (none)    | `el.close()`       |
| `Save`      | `primary` | `submitTask(null)` |

The dialog has no other buttons with the text `Cancel`, `Send: plan` or `Send: implement`.

**Not in this plan:** a different entry point for New note…, keyboard shortcuts for the sends,
changes to the Tasks section or other dialogs.

## Checklist

- [x] `app.js`: `pinnedFileRows()` returns no rows while `pinnedFiles` is empty; remove
      `LABELS.noPinnedFiles` and its use
- [x] `app.js`: the file header comment (line 2, "three sections: Pinned, …") and
      `renderTree`'s doc comment say the Pinned section is shown only while something is pinned
      (and name the Tasks section, which the header comment leaves out)
- [x] `app.js`: `openTaskDialog` header has the title and the `plan` / `implement` icon buttons
      (no Cancel); their title and aria-label follow the Agent dropdown
- [x] `app.js`: `openTaskDialog` footer `.task-buttons` is `Cancel`, `Save` (`primary`); update
      the function's doc comment, which names **Send: plan** / **Send: implement**
- [x] `style.css`: `.task-send` layout; `.icon-btn:disabled` and `.icon-btn:disabled:hover`
- [x] `devc/README.md`: the **Pinned files and notes** bullet says the section appears once
      something is pinned (and so **New note…** needs one pin first; with none, start with
      **Pin file**). The **Tasks** bullet's "under Pinned" still reads correctly when Pinned
      is absent ("the **Tasks** section, at the top of the sidebar or under Pinned"), and it
      says the dialog's two send icons at its top are **Send: plan** and **Send: implement**
- [x] `.plans/devc-web-tasks.md` `### Page`: the sentence "Footer: **Save**, **Send: plan**,
      **Send: implement**." describes the new header icons and footer, with a pointer to this
      plan

## Validation

- [x] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists (see
      devc-web-tasks' Verification). If it fails here, delete `devc-core/dist/` and rerun.
- [x] `deno fmt --check devc/web/static/app.js devc/web/static/style.css devc/README.md
      .plans/devc-web-pinned-hide-save-primary.md .plans/devc-web-tasks.md` passes
- [x] `grep -n "noPinnedFiles\|No pinned files" devc/web/static/app.js` prints nothing
- [x] Headless Chromium (Playwright, installed for the run) against `devc/web/static`, with a
      fake WebSocket as in devc-web-tasks' Verification. One project `/src/app`, its container
      `connected`. Check:
  - after `pinned_files` with no pins, the `.row.section` labels are exactly `Tasks`, `Layout`,
    `Containers`, and the page text has no `No pinned files`;
  - after `pinned_files` with one pin (`/src/app`, `notes.md`), the labels are `Pinned`,
    `Tasks`, `Layout`, `Containers`, the pin's row is shown, and right-clicking the Pinned
    header offers `New note…`;
  - with `devc-web-sidebar-v1` saved as `pinnedOpen: false`, that same message shows the Pinned
    header collapsed (no pin row);
  - a following `pinned_files` with no pins removes the Pinned header again;
  - in the New task dialog: the header has no `Cancel` button, and `.task-send` holds
    `[data-icon=plan]` then `[data-icon=implement]`, titled `Send to Claude: plan` and
    `Send to Claude: implement` (no saved agent). Choosing `Pi` in the Agent dropdown changes
    both titles and aria-labels to `Send to Pi: …`. The footer `.task-buttons` texts are
    `Cancel`, `Save` in that order, and only `Save` has class `primary`;
  - while not routed, both send icons are `disabled` with computed `opacity` `0.45`, and Save is
    enabled;
  - footer `Cancel` closes the dialog and sends nothing;
  - typing text and clicking `Save` sends `add_task` and no `send_task`; Ctrl+Enter in the
    textarea does the same;
  - with the project chosen, clicking the `implement` icon sends `add_task` then `send_task`
    with `action: 'implement'` and `agent: 'pi'`, and the dialog closes.
- [ ] Ask the user to look at the sidebar with no pins and at the New task dialog's header icons
      and footer in their tab.

## Relevant Files

- `devc/web/static/app.js`
- `devc/web/static/style.css`
- `devc/README.md`
- `.plans/devc-web-tasks.md`
- `.plans/devc-web-pinned-hide-save-primary.md`
- `.plans/PLAN.md`
