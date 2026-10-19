# devc-web-task-default

A **default route and agent for new tasks** in `devc web`, set from the task dialog with a pin
icon. Today a new task starts on the focused tile's project, that project's first repo, and the
agent last sent with. With a default pinned, it starts on the pinned project, repo and agent.

Builds on [devc-web-tasks](devc-web-tasks.md), [devc-web-tasks-actions](devc-web-tasks-actions.md)
and [devc-web-pinned-hide-save-primary](archived/devc-web-pinned-hide-save-primary.md). All three edit the
same dialog in `app.js`. Page-only: there are no new messages and no server changes.

```
New task                                             [▤] [</>]
┌──────────────────────────────────────────────────────────────┐
│ What should be done? …                                       │
└──────────────────────────────────────────────────────────────┘
Project            Repo               Agent
[devc-tools   ▾]   [devc-tools   ▾]   [Claude ▾]          [📌]   ← accent while these are the default
Sending starts the agent in the repo                 [Cancel] [▓Save▓]
```

## Decisions

- **One pin for all three fields.** The pin saves the dialog's current Project, Repo and Agent
  together as the default. There are no per-field pins.
- **Stored in the browser:** `localStorage` key `devc-web-task-default-v1`, the same as
  `devc-web-task-agent-v1`. A browser tab and the devc-desktop window each keep their own
  default. Sharing it across windows would need a host-side store and new messages, which this
  plan does not add.
- **Pin is a toggle.** It is _pressed_ when a default is saved **and** it equals the dialog's
  current Project, Repo and Agent. Clicking it while pressed clears the default (removes the
  key). Clicking it while not pressed saves the current values, replacing any other default.
  The pressed state is recomputed on open and after every change to Project, Repo or Agent.
  Pinning does not save the task, close the dialog, or touch the textarea's focus.
- **Unrouted can be pinned.** With Project `(not routed)`, the pin saves only the agent. New
  tasks then start unrouted, on that agent. The focused tile's project is not used, because a
  saved default without a route means "not routed".
- **Where the default applies** (precedence, first match wins):
  - Project and Repo of a **new** task: the `route` passed in (**New task here…**), then the
    default's route if its `localFolder` is in `projects`, then (only when no default is saved)
    the focused tile's project, then `(not routed)`. If a default is saved but its project is
    no longer in `projects`, fall through to the focused tile, as if no route was saved.
  - Repo: the route's `root`, or the default's `root` when the project came from the default.
    `fillTaskRepos` already selects the first repo when that root is not one of the project's
    repos. Do not add another fallback.
  - An **existing** task (edit) keeps its own route. The default does not change it.
  - Agent, in the dialog (new and edit): the default's agent, else the last sent agent
    (`savedTaskAgent(storedTaskAgent())`), else Claude.
  - Agent, in a **task row's** send icons and their tooltips: the same rule. The default's agent
    wins over the last sent agent.
- **Sending from the dialog still writes `devc-web-task-agent-v1`.** It no longer decides
  anything while a default is saved. Clearing the default brings it back into use. Keep that
  write.
- **No toast** on pin or unpin. The button's pressed look and tooltip are the feedback.

## Contracts

### Storage: `localStorage['devc-web-task-default-v1']`

JSON text, one of:

```json
{ "localFolder": "/src/app", "root": "/src/lib", "agent": "pi" }
{ "agent": "copilot" }
```

`localFolder` and `root` are both present (non-empty strings) or both absent. `agent` is one of
`TASK_AGENT_IDS`.

A pure parser in `lib/tasks.js`, exported as `parseTaskDefault(text)`:

| Input                                                | Result                                  |
| ---------------------------------------------------- | --------------------------------------- |
| `null`, `''`, text that isn't JSON, a non-object     | `null`                                  |
| `agent` missing or not in `TASK_AGENT_IDS`           | `null`                                  |
| valid `agent`, both `localFolder` and `root` strings | `{localFolder, root, agent}`            |
| valid `agent`, either one missing/empty/non-string   | `{agent}` (no route)                    |
| extra keys                                           | ignored, and not included in the result |

The page reads the key through try/catch, as `storedTaskAgent` does, and treats a throw as
`null`. Writes and the removal are wrapped in try/catch too, and a failure is ignored.

**Gotcha:** `JSON.parse('null')` and `JSON.parse('"x"')` succeed. Check that the result is a
non-null object (and not an array) before reading `agent`.

### The pin button

- `iconButton('pin', …)`, using the existing `pin` path in `ICON_PATHS`. It is the last child of
  `.task-route`, after the Agent label.
- `aria-pressed` is `"true"` or `"false"`, as described above.
- `title` and `aria-label` (both updated with the pressed state; `iconButton` sets them only once):

  | Pressed | Text                                    |
  | ------- | --------------------------------------- |
  | no      | `Make these the default for new tasks`  |
  | yes     | `Default for new tasks: click to clear` |

  Add both strings to `LABELS` (`pinTaskDefault`, `unpinTaskDefault`).
- Disabled while the dialog is busy, together with Save and the sends (put it in
  `taskDialog.$buttons`).

**Equality for "pressed":** a saved default with a route matches when `$project.value ===
localFolder`, `$repo.value === root` and `$agent.value === agent`. A saved default without a
route matches when `$project.value === ''` and the agents are equal.

### Layout (`style.css`)

`.task-route` becomes a flex row, so the pin takes only its own width:

```css
.task-route {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
}
.task-route label {
  flex: 1 1 140px;
  min-width: 0;
}
```

Keep the existing `.task-route label` grid rules (`display: grid; gap: 4px; …`) and
`label[hidden] { display: none; }`. The pin sits at the bottom of the row, beside the selects.
A pressed pin is shown in the accent colour: `.icon-btn[aria-pressed='true'] { color:
var(--accent); }`, also on hover.

**Gotcha:** `.icon-btn` is `display: block; flex: none`, so it already doesn't stretch. Give it
`margin-bottom` only if it doesn't line up with the selects (they are taller than 18px); check
in the screenshot.

**Not in this plan:** a host-side default shared by windows, per-field pins, showing the default
anywhere outside the dialog, a default for the Sent list or New note.

## Checklist

- [ ] `lib/tasks.js`: `parseTaskDefault(text)` as specified; its doc comment
- [ ] `app.js`: `TASK_DEFAULT_KEY = 'devc-web-task-default-v1'`; read / save / clear helpers
      (try/catch); one helper for the agent a send uses (default's agent, else the last sent,
      else Claude), used by the dialog, `sendTaskFromRow` and the task rows' tooltips
- [ ] `app.js`: `openTaskDialog` picks Project and Repo for a new task by the precedence in
      Decisions, and passes the default's `root` to its **first** `fillTaskRepos` call
- [ ] `app.js`: the pin button in `.task-route`; pressed state, title and aria-label refreshed
      on open and on Project/Repo/Agent change; click saves or clears; part of `$buttons`;
      `LABELS.pinTaskDefault` / `LABELS.unpinTaskDefault`; update `openTaskDialog`'s doc comment
- [ ] `style.css`: `.task-route` as a flex row; pressed `.icon-btn` in the accent colour
- [ ] `devc/tests/web_tasks_page_test.ts`: `parseTaskDefault` cases from the table above
- [ ] `devc/README.md`: the **Tasks** bullet says the dialog's pin makes its project, repo and
      agent the default for new tasks (kept per window), and that row sends use the default's
      agent when one is set
- [ ] `.plans/devc-web-tasks.md` `### Page`: the **Agent** default and "A new task with no route
      defaults its project to the focused tile's project" point to this plan

## Validation

- [ ] `cd devc && deno task check && deno task test` pass. One failure is known and unrelated:
      `docker_exec_single_path_test.ts` fails when a git-ignored `devc-core/dist/` exists. If
      it fails here, move `devc-core/dist/` aside (don't delete it; devc-desktop's build uses
      it), rerun, and put it back.
- [ ] `deno fmt --check devc/web/static/app.js devc/web/static/lib/tasks.js
      devc/web/static/style.css devc/tests/web_tasks_page_test.ts devc/README.md
      .plans/devc-web-task-default.md .plans/devc-web-tasks.md` passes
- [ ] `parseTaskDefault` tests cover: `null`; `''`; `'nope'`; `'null'`; `'"pi"'`; `'[]'`;
      `{"agent":"opencode"}` → `null`; `{"agent":"pi"}` → `{agent:'pi'}`;
      `{"localFolder":"/a","agent":"pi"}` → `{agent:'pi'}`;
      `{"localFolder":"/a","root":"","agent":"pi"}` → `{agent:'pi'}`;
      `{"localFolder":"/a","root":"/b","agent":"pi","x":1}` →
      `{localFolder:'/a',root:'/b',agent:'pi'}`
- [ ] Headless Chromium (Playwright, installed in a scratch folder for the run) against
      `devc/web/static`, with a fake WebSocket as in devc-web-tasks' Verification. Projects
      `/src/app` (repos `/src/app`, `/src/lib`) and `/src/other` (one repo), both containers
      `connected`, a tile of `/src/other` focused, one routed task (`/src/app` + `/src/app`).
      Check:
  - with no default saved, New task opens on Project `/src/other`, the pin has
    `aria-pressed="false"` and title `Make these the default for new tasks`;
  - choose `/src/app`, Repo `/src/lib`, Agent `Pi`, click the pin: no message is sent, the
    dialog stays open, the pin is `aria-pressed="true"` with title `Default for new tasks: click
    to clear` and computed `color` equal to `--accent`, and
    `localStorage['devc-web-task-default-v1']` parses to `{localFolder:'/src/app',
    root:'/src/lib', agent:'pi'}`;
  - changing Agent to `Claude` makes the pin not pressed; changing it back makes it pressed;
  - close and reopen New task (the `/src/other` tile still focused): Project `/src/app`, Repo
    `/src/lib`, Agent `Pi`, pin pressed;
  - **New task here…** on the `/src/other` repo row: Project `/src/other`, Agent `Pi`, pin not
    pressed;
  - opening the existing task keeps its route (`/src/app` + `/src/app`) and shows Agent `Pi`;
  - the task row's send icons are titled `Send to Pi: plan` / `Send to Pi: implement`, even with
    `devc-web-task-agent-v1` set to `copilot`, and clicking `implement` sends `send_task` with
    `agent: 'pi'`;
  - clicking the pressed pin removes the key; reopening New task falls back to the focused
    tile's project `/src/other` and the last sent agent;
  - pinning with Project `(not routed)` and Agent `Copilot` saves `{agent:'copilot'}`; New task
    then opens unrouted (not `/src/other`) on `Copilot`;
  - a saved default whose `localFolder` is `/src/gone` opens New task on `/src/other` with the
    default's agent;
  - the pin's bounding box is inside `.task-route`, on the same row as the Agent select, at the
    dialog's default width.
- [ ] Ask the user to pin a default in their tab, and to look at the pin in devc-desktop.

## Relevant Files

- `devc/web/static/app.js`
- `devc/web/static/lib/tasks.js`
- `devc/web/static/style.css`
- `devc/tests/web_tasks_page_test.ts`
- `devc/README.md`
- `.plans/devc-web-tasks.md`
- `.plans/devc-web-task-default.md`
- `.plans/PLAN.md`
