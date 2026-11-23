# devc web orchestrator — one routing agent per container, in a docked panel

A dedicated Pi session per running container that takes any prompt, works out which of the
container's repos it belongs to (or asks), and starts a worker agent there in a new Herdr pane
with the prompt. It is reached from one known place, like an IDE's global chat: a docked panel on
the right of devc web's tile area, opened from a button in the sidebar header (and devc-desktop's
**View → Orchestrator**). The panel shows no repo, branch or git information, and the
orchestrator's own pane never appears among the container's terminals, agents or sessions. The
panes it starts are ordinary agent panes in their repos.

Nothing runs until the panel is opened for a container: the first open writes the orchestrator's
files into the container and starts Pi there.

The orchestrator is **Pi only**. It is not built on the Tasks feature: it does not add, queue or
send tasks, and nothing goes through devc-bridge. It drives the container's own Herdr from inside
the container, which any agent with a shell there can already do, so it adds no new capability to
a container.

Out of scope (follow-ups, not built here):

- Reaching repos in a different container. Herdr is per container; each container has its own
  orchestrator, and the panel's container picker switches between them.
- A `devc orchestrate` terminal command: the panel is the one entry point, and a second Pi on the
  same session id would fight the panel's.
- A keyboard shortcut to open the panel (the user decided: none for now).
- A tool listing what the orchestrator has started, and starting workers in a new worktree.

## Checklist

- [ ] `devc/web/orchestrator_files/` (new): `orchestrator.ts` (the Pi extension), `SYSTEM.md`,
      `routing.md` (the default routing notes template), per Contracts § Files and § Extension
- [ ] `devc/deno.json`: `--include web/orchestrator_files` in `build` and `build:release`;
      `web/orchestrator.ts` added to `check`; `web/orchestrator_files/` added to `lint.exclude`
- [ ] `devc/web/orchestrator.ts` (new): the pure helpers — orchestrator folder, launch command,
      orchestrator-pane rule, `repos.json` content, host routing file path and default text
- [ ] `devc/web/protocol.ts`: the `orchestrator` request; `toggleOrchestrator` in
      `VIEW_INTENT_NAMES`
- [ ] `devc/web/server.ts`: the `orchestrator` request (open / restart / new), writing the files,
      finding or creating the pane; the routing file watch and `repos.json` refresh
- [ ] `devc/web/static/lib/orchestrator.js` (new): `isOrchestratorPane`, the panel's storage keys,
      the hash parameter parser
- [ ] `devc/web/static/lib/view.js`: `toggleOrchestrator` in `VIEW_INTENT_NAMES`
- [ ] `devc/web/static/orchestrator.js` (new) + `style.css`: the docked panel
- [ ] `devc/web/static/index.html`, `main.html`: the panel's host element beside `#tiles`
- [ ] `devc/web/static/index.html`, `sidebar.html`, `sidebar.js`: the header button, lit while the
      panel is open, with the waiting dot
- [ ] `devc/web/static/main-page.js`, `app.js`: the `orchestrator` hash parameter and the
      `toggleOrchestrator` intent toggle the panel
- [ ] `devc/web/static/sidebar.js`, `cards.js`, `containers.js`: the orchestrator pane is left out
      of In use, terminal rows, agent counts and urgency (Contracts § Hidden)
- [ ] `devc-desktop/src/main/main.ts`: **View → Orchestrator**; `orchestrator` added to the hash
      keys `setMainHash` clears
- [ ] `devc/tests/web_orchestrator_test.ts` (new), `devc/tests/web_orchestrator_page_test.ts` (new)
- [ ] `devc/README.md`: an **Orchestrator** entry beside **Tasks**; `devc-desktop/README.md`: the
      menu item

## Contracts

### Files

On the host:

- `~/.config/devc/orchestrator/routing.md` — the routing notes, shared by every container. devc web
  creates it from `devc/web/orchestrator_files/routing.md` the first time any orchestrator opens and
  it is missing; it never overwrites it.

In the container, in `$HOME/.local/share/devc-orchestrator/` (the container's remote user's
`$HOME`, read with `printf %s "$HOME"` in the container; not under `/workspaces`, so it is never a
repo card), devc web writes on **every** `orchestrator` request, whatever the mode:

| File              | Content                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `orchestrator.ts` | the embedded extension, verbatim                                                 |
| `SYSTEM.md`       | the embedded system prompt, verbatim                                             |
| `routing.md`      | the host's `routing.md`, verbatim                                                |
| `repos.json`      | the container's repos (below)                                                    |
| `session-id`      | a UUID (`crypto.randomUUID()`), one line; written only when missing or for `new` |

`repos.json`:

```json
{
  "repos": [
    { "name": "tools/devc-tools", "path": "/workspaces/tools/devc-tools" }
  ]
}
```

One entry per mounted repo of the container that has a container folder (the list `containerRepos`
holds, worktrees included), in that order. `name` is the repo's card name (`repoName` in
`projects_view.ts`: its path under `/workspaces`, else its folder name), which is also the label of
its Herdr workspace (`herdr_workspaces.ts`). `path` is its container folder.

devc web also rewrites `routing.md` in every container whose snapshot has an orchestrator pane when
the host file changes (watch the **folder** `~/.config/devc/orchestrator/`, since editors replace
the file by rename; debounce 300 ms), and rewrites `repos.json` there when the container's repo list
changes. Failed writes are logged, never shown.

### The `orchestrator` request

Client → server: `{ type: 'orchestrator', id, localFolder, mode: 'open' | 'restart' | 'new' }`.
Reply on success: `{ id, ok: true, result: { pane_id, tab_id, reused: boolean } }`. Failures use the
existing `fail` codes:

- `not_running` — `the container is not running`
- `not_installed` — exactly `This container needs the agents feature's installPiCli and installHerdr.`
  when `pi` is not installed (checked as `send_task` checks agents, `commandInstalled`)
- write failures and Herdr errors as `send_task` reports them

Steps, in order: find the running session for `localFolder`; check `pi`; write the files above;
find the orchestrator pane in the container's snapshot (§ Hidden's rule).

- `open`: a pane found → reply with it, `reused: true`. None → create one.
- `restart`: a pane found → close it (`pane.close`); then create one. Same `session-id`.
- `new`: write a fresh `session-id`; a pane found → close it; then create one.

Creating: a new pane in its own tab in the Herdr workspace labeled `Orchestrator` (found by label
in Herdr's live state, created when missing, as `herdr_workspaces.ts` does for repos), with `cwd`
the orchestrator folder; rename the pane `Orchestrator`; then `pane.send_text` the launch command
followed by `\n`:

```sh
exec pi --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve \
  --no-builtin-tools -e ./orchestrator.ts --system-prompt "$(cat SYSTEM.md)" \
  --session-id <session-id> --name Orchestrator
```

`exec`: quitting Pi closes the pane, and the next open starts Pi again on the same session id,
which resumes the conversation (`--session-id` uses the folder's existing session with that id,
creating it otherwise).

### Extension (`orchestrator.ts`)

A Pi extension (`pi.registerTool`, `pi.on`, `pi.registerCommand`; Pi's docs are in the installed
package under `docs/extensions.md`). It only ever reads files and runs `git` and `herdr`; with
`--no-builtin-tools` its tools are the only ones the model has. Paths it reads are relative to its
own folder (`process.cwd()`).

Tools (names and parameters exact):

| Tool                                   | Does                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_repos()`                         | every repo in `repos.json` with its summary (below)                                                                                            |
| `search(pattern, repo?)`               | `git -C <path> grep -n -I -E --max-count 20 -e <pattern>` in that repo, or in each repo; at most 200 lines in all, then `… (more matches cut)` |
| `read_file(repo, path)`                | the file, at most 400 lines / 40 000 characters with a cut note; refused when the resolved path leaves the repo                                |
| `ask_user(question, options)`          | `ctx.ui.select(question, [...options, 'Something else…'])`; the last opens `ctx.ui.input`; returns the answer                                  |
| `dispatch(repo, agent, title, prompt)` | starts a worker (below); returns `Started <agent> in <repo name> (pane <pane id>)`                                                             |

`repo` is a repo **name** from `repos.json`, validated on every call (unknown → an error listing the
names). `agent` is `claude`, `copilot` or `pi`. `title` is at most 60 characters.

Repo summary, built lazily: on the first prompt of a Pi process, and again for any repo new in
`repos.json` since: `name`, current branch (`git -C <path> branch --show-current`), the README's
first paragraph (at most 600 characters), the `#`/`##` headings of `AGENTS.md` and `CLAUDE.md` if
present, and the last 5 commit subjects. `/reindex` (a registered command) clears the cache.

On every prompt (`before_agent_start`) the extension rereads `routing.md` and `repos.json` and puts
the routing notes and the repo summaries into `systemPromptOptions.sections` (`routing` and `repos`),
so a changed file takes effect on the next prompt without a restart. Pi patches only changed
sections.

`dispatch`:

1. Find the Herdr workspace whose label is the repo's name (`herdr workspace list`). None → create
   it (`herdr workspace create --cwd <path> --label <name> --no-focus`) and use the pane it comes
   with. Otherwise `herdr tab create --workspace <id> --cwd <path> --label <title>` and use its
   pane. The CLI prints JSON; read the ids from `result`. Neither focuses.
2. Rename the pane to `title` (`herdr pane rename`).
3. `herdr agent start <title> --kind <agent> --pane <pane id> -- <args>`: `claude` and `pi` take the
   prompt as one positional argument, `copilot` as `-i <prompt>`. Arguments are passed as an argv
   array (no shell), so the prompt needs no quoting.

The prompt the worker gets is the user's request **verbatim**, then, only when the model gives
notes, a blank line, `## Routing notes`, and the notes. `SYSTEM.md` tells the model this.

Settling (`agent_before_settle`): when a run used `list_repos`, `search` or `read_file` but neither
`dispatch` nor `ask_user`, continue once with the hidden message `Finish by calling dispatch, or
ask_user if more than one repo fits.` At most once per run.

`SYSTEM.md` says, in substance: you route requests, you never do the work; pick the repo from the
repo summaries and routing notes, searching only when they don't decide it; when more than one
repo fits, call `ask_user` with the candidates as options; default the agent to `claude` unless the
user names one; pass the user's words through unchanged; one request may become several
`dispatch` calls when it clearly spans repos.

### Hidden

A pane is the orchestrator's when its `cwd` in the Herdr snapshot ends with
`/.local/share/devc-orchestrator` (`isOrchestratorPane`, shared by the pages). Such a pane is left
out of: In use's cards and the agent counts, statuses and urgency order they show; each container's
terminal rows in the sidebar and in Containers (`containers.js`); the collapsed container's most
urgent status. Its Pi sessions are already outside every repo's session folder, so the Sessions
row never lists them (no change; validated below).

No message changes for this: the pages apply the rule to the snapshots they already get, so no
`PROTOCOL` bump. devc-desktop's bundled `containers.js` hides it once the app is rebuilt.

### The panel

- Docked on the right of the tile area in `/` and `/main`, outside the tile layout: opening,
  closing or focusing tiles never moves or covers it. A drag handle on its left edge resizes it
  (min 280 px, default 420 px). When the tile area would be narrower than 480 px, it lies over the
  tiles instead of beside them.
- Header: `Orchestrator`; a container picker (running containers by project name; hidden when
  only one is running); **Restart** (`mode: 'restart'`); **New session** (`mode: 'new'`); close.
  No repo, branch or git information.
- Body: the orchestrator pane's terminal, as a terminal tile draws one, focused when the panel
  opens. While a request is pending: `Starting the orchestrator…`. On a failure: its message and
  **Retry**. No running container: `No running container.`
- Opening the panel, or picking a container, sends `orchestrator` with `mode: 'open'` for the
  selected container. The selected container is the last one picked, else the focused tile's,
  else the first running.
- Saved per browser (`localStorage`, wrapped in try/catch): `orchestratorOpen` (`'1'`/`'0'`),
  `orchestratorWidth` (px), `orchestratorContainer` (the container's `localFolder`).

### The button and the menu item

- Sidebar header (`index.html`, `sidebar.html`): a button, id `orchestrator-toggle`, title
  `Orchestrator`, placed before `#dashboard`. Lit (`aria-pressed="true"`) while the panel is open.
  A dot on it when the panel is closed and any running container's orchestrator pane has agent
  status `blocked` or `done`.
- In `/`, the button toggles the panel directly. In `/sidebar`, it sends the view intent
  `toggleOrchestrator` (no arguments), which the view's `/main` page carries out; `/main` puts
  `orchestratorOpen: boolean` in its `view_state` so the sidebar can light the button.
- devc-desktop **View → Orchestrator** (after the Developer Tools items' separator, before
  **Appearance**; no accelerator) calls `setMainHash({ orchestrator: <nonce> })`; the page toggles
  the panel and removes the parameter as it does `host-slot`.

## Implementation notes / gotchas

- **Hash commands need a changing value.** Setting the same hash twice fires no `hashchange`, and
  `setMainHash` reloads the URL; use a fresh nonce (`Date.now().toString(36)`) each time.
- **Pi project trust.** Nothing goes in a `.pi/` folder: Pi would ask to trust the folder at
  startup. The system prompt comes in through `--system-prompt`, the extension through `-e`
  (explicit `-e` paths load under `--no-extensions`), and `--no-approve` ignores anything
  project-local.
- **`--system-prompt` takes text, not a path** (only `--append-system-prompt` reads files), hence
  `"$(cat SYSTEM.md)"`.
- **Extension imports.** The extension imports what Pi's extension docs show (TypeBox's `Type`,
  Pi's types). Deno can't resolve those, which is why the folder is out of `check` and `lint`, and
  no Deno test imports it. Test the pure parts that matter through `devc/web/orchestrator.ts` and
  the live checks.
- **`herdr agent start` needs the pane at its shell prompt**, and waits for the agent (default
  30 s). A workspace created in step 1 comes with a shell pane: use that pane, don't add a tab.
- **The orchestrator pane's `cwd`** is the shell's folder in the snapshot (`cwd`, not
  `foreground_cwd`), which stays the orchestrator folder while Pi runs.
- **Embedding.** `STATIC_ROOT`'s pattern: read `orchestrator_files` relative to the module
  (`new URL('./orchestrator_files/', import.meta.url)`), so both a checkout and the compiled binary
  find them. Not under `static/`: those files are served to browsers.

## Relevant Files

- `devc/web/orchestrator_files/orchestrator.ts` (new)
- `devc/web/orchestrator_files/SYSTEM.md` (new)
- `devc/web/orchestrator_files/routing.md` (new)
- `devc/web/orchestrator.ts` (new)
- `devc/web/server.ts`
- `devc/web/protocol.ts`
- `devc/deno.json`
- `devc/web/static/lib/orchestrator.js` (new)
- `devc/web/static/lib/view.js`
- `devc/web/static/orchestrator.js` (new)
- `devc/web/static/index.html`
- `devc/web/static/main.html`
- `devc/web/static/sidebar.html`
- `devc/web/static/sidebar.js`
- `devc/web/static/cards.js`
- `devc/web/static/containers.js`
- `devc/web/static/main-page.js`
- `devc/web/static/app.js`
- `devc/web/static/style.css`
- `devc-desktop/src/main/main.ts`
- `devc/tests/web_orchestrator_test.ts` (new)
- `devc/tests/web_orchestrator_page_test.ts` (new)
- `devc/README.md`
- `devc-desktop/README.md`
- `.plans/PLAN.md`

## Validation

Automated:

- [ ] `cd devc && deno task check` passes (includes `web/orchestrator.ts`)
- [ ] `deno check` on every changed or new file under `devc/web/static/` passes
- [ ] `cd devc && deno lint` reports nothing new
- [ ] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env tests/web_orchestrator_test.ts tests/web_orchestrator_page_test.ts tests/web_views_test.ts tests/web_sidebar_test.ts`
      passes, covering:
  - the launch command is exactly the one in Contracts for a given session id
  - `repos.json` content: names from `repoName`, container paths, repos without a container folder
    left out, order kept
  - the default `routing.md` is written only when the host file is missing
  - `isOrchestratorPane`: true for `/home/vscode/.local/share/devc-orchestrator` and
    `/root/.local/share/devc-orchestrator`; false for `/workspaces/x`, for a `foreground_cwd`
    match alone, and for `/home/vscode/.local/share/devc-orchestrator-old`
  - the hash parser takes `orchestrator=<nonce>` and the cleaned hash no longer has it
  - `VIEW_INTENT_NAMES` in `protocol.ts` and `lib/view.js` both list `toggleOrchestrator`
- [ ] `cd devc && deno task test` (the full suite) passes
- [ ] `deno fmt --check` on the touched files passes
- [ ] `cd devc && deno task build` succeeds, and `strings devc | grep -c 'devc-orchestrator'` is
      non-zero (the files are embedded)
- [ ] `cd devc-desktop && npm run check` passes and `npm run build:mac` builds the Mac apps

Live, in a running devc web with a container that has `installPiCli` and `installHerdr`:

- [ ] Before opening the panel, `ls ~/.local/share/devc-orchestrator` in the container fails (no
      start before first open)
- [ ] The header button opens the panel; Pi starts in it within a few seconds, with no trust
      prompt; the folder holds the five files
- [ ] No orchestrator pane in In use, the container's terminal rows, Containers, or the Sessions row
- [ ] "Add a README badge to <repo>" with one clear repo starts `claude` in a new pane in that repo's
      Herdr workspace, named after the title; the worker's prompt starts with the request verbatim
- [ ] A request that fits two repos gets an `ask_user` choice; picking one dispatches there
- [ ] Editing the host `routing.md` while the panel is open changes the next prompt's routing with
      no restart (check the container's copy changed)
- [ ] Close the panel and reopen it: the same pane, reused. Quit Pi (`/quit`) and reopen: a new
      pane, same conversation. **New session**: empty conversation, different `session-id`
- [ ] **Restart** keeps the conversation
- [ ] With two containers running, the picker switches between their orchestrators, each its own
      conversation
- [ ] While the panel is closed and the orchestrator asks a question, the button shows the dot
- [ ] In devc-desktop, **View → Orchestrator** toggles the panel each time it's chosen, and the
      sidebar button lights with it
- [ ] In a container without Pi, the panel shows `This container needs the agents feature's
      installPiCli and installHerdr.`
