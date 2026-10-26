# bridge-task-add — agents add tasks to devc web's task list

An agent in a container adds a to-do to devc web's task list (`~/.config/devc/tasks/tasks.json`)
through a new host-granted devc-bridge built-in, `task-add`. The task is routed to the repo the
agent works in and marked as coming from an agent. It is only **added**: queueing and sending stay
with the person at the page, so an agent can never start another agent.

The bridge writes the task itself, using a task store moved into `devc-core`. It never runs devc.
`task-add` is the first **native** built-in: the bridge handles it in its own code instead of
running a script from `devc-bridge/builtin/`.

## Checklist

- [x] Move `devc/web/tasks.ts` to `devc-core/tasks.ts`, with `SessionAgentId`, `TaskAction`,
      `isSessionAgentId` and `isTaskAction` (now in `devc/web/agents.ts`). `devc/web/agents.ts`
      re-exports those four from core; every other importer of `devc/web/tasks.ts` (`server.ts`,
      `sessions.ts`, `protocol.ts`, `devc/tests/web_tasks_test.ts`,
      `devc/tests/web_tasks_page_test.ts`) imports `@devc-tools/core/tasks.ts`, and
      `devc/web/tasks.ts` is deleted
- [x] `devc-core/tasks.ts`: optional `source` on `Task` (see Contracts); `isTask`/`cleanTask`
      validate and keep it; `updateTask`, `queueTasks`, `unqueueTask` and `queueFailed` keep it
- [x] `devc-core/tasks.ts`: `withTasksLock` and `appendAgentTask` (see Contracts)
- [x] `devc/web/server.ts`: `changeTasks` runs inside `withTasksLock`
- [x] `devc-core/bridge.ts`: capability `task-add`, appended last to `BRIDGE_CAPABILITIES`, with
      command `task-add`; no entry in `BRIDGE_CAPABILITY_REQUIRES`; new export
      `BRIDGE_NATIVE_COMMANDS = ['task-add']`, the built-in commands with no script. Update the
      `BRIDGE_CAPABILITY_COMMANDS` doc comment ("every name here is also the name of a script")
      to say native commands are the exception
- [x] `devc/args.ts`: `gh` / `gh-*` still expand to the `gh-` capabilities only;
      `--bridge-allow task-add` and `--bridge-allow gh,task-add` are accepted
- [x] `devc-bridge/host/core.ts`: in `dispatch`, after `grantRefusal` passes, a command in
      `BRIDGE_NATIVE_COMMANDS` runs its handler and never resolves a script; `warnShadowed` also
      warns for `commands/task-add`
- [x] `devc-bridge/host/task_add.ts` (new): the `task-add` handler
- [x] `devc/web/static/lib/tasks.js`: the page's task parser keeps `source`
- [x] Task row shows the agent marker (see Contracts)
- [x] Help and docs: `devc-bridge/client/devc-bridge.ts` usage, `devc/help.ts` capability list,
      `devc/bridge.ts` header comment, `devc-bridge/README.md`, `devc/README.md`
- [x] Tests listed under Relevant Files

## Contracts

### Capability

- Name `task-add`, last in canonical order. Command list `['task-add']`. Requires nothing.
- It is a per-line grant like every other. A policy line granting `task-add` lets the agent add
  tasks routed to that line's repo. Only repos devc can pin (GitHub remote, git-protected) can carry
  it. That limitation is accepted; a non-GitHub grant is out of scope.
- `--bridge-allow gh` does **not** include it. The user grants it by name, e.g.
  `devc up --bridge-allow gh,task-add`, or via `bridgeDefaultAllow` / `bridgeRepoAllow`.

### In the container

```
devc-bridge task-add [--repo <path>] <text>
```

- `<text>`: one argument, Markdown, whose first non-empty line is the title. Multi-line text goes
  as one argument, e.g. `devc-bridge task-add "$(cat note.md)"`.
- `--repo <path>`: a pinned repo's container path. It is recognized only as the first argument,
  in the space form only. Required when the policy has more than one line. Trailing `/`s are
  dropped, then the path is compared to each line's target as a plain string (as `gh-push`'s
  `select_repo` does).
- Exactly one argument must remain after `--repo` is taken.
- Success: stdout is the new task's id (a UUID) plus `\n`; exit 0.
- Errors go to stderr, prefixed `task-add:` and one space. Exit codes:
  - `1`: not granted (from the existing `grantRefusal`, unchanged)
  - `2`: wrong arguments (usage line `usage: task-add [--repo <path>] <text>`); more than one
    line and no `--repo` (`this container has <n> pinned repos — pass --repo <path>, one of:
    <targets>`); no line at `--repo` (`no pinned repo at <path> — pinned: <targets>`); the
    selected line not granting `task-add` (`this container was not granted task-add`, plus
    a space and `for <target>` when there are several lines)
  - `3`: text the agent should fix: `taskText` gives null (blank, or more than 20 000 UTF-16
    code units once trimmed); a control character other than `\n` and `\t`; or the
    per-container cap reached (`20 tasks from this container are waiting; ask the user to send
    or delete some`)
  - `4`: host failure: no container for this workspace (`no devc container for workspace
    <key>`), `docker ps` failing, the tasks file unreadable as JSON or unwritable, or a lock
    timeout
- A native built-in answers with the same `Response` shape scripts do
  (`{ ok: true, exitCode, stdout, stderr }`), so the client is unchanged.

### The handler (`devc-bridge/host/task_add.ts`)

1. Parse args as above. The policy was already read and checked by `grantRefusal`. Read it again
   with `parsePolicy`; the handler does not trust state shared with `grantRefusal`.
2. Select the line. Check that its grants include `task-add`.
3. Check the text (exit 3 rules above).
4. Resolve the project: `listContainerFolders()` (`devc-core/container.ts`), then the first folder
   with `await projectKey(folder) === key` (`devc-core/merged_config.ts`). This is the same
   function that names the policy file. No match → exit 4.
5. `appendAgentTask({ text, localFolder, root: <line's repo>, key })`, then print the id.

`root` is the selected line's `repo` field (the host working-tree path), never anything the
container sent. The running devc web picks up the change on its own: `watchConfigFile(TASKS_PATH)`
reloads, broadcasts and runs the queue pump, which does nothing for an unqueued task.

The handler's docker lookup and tasks path are injectable (an optional field on the
`ServerOptions` / `Dispatch` the tests pass), so the tests need neither docker nor a real
`~/.config/devc`.

### `Task.source` in `tasks.json`

```json
{
  "id": "…",
  "text": "…",
  "createdAt": "…",
  "localFolder": "/…",
  "root": "/…",
  "source": { "kind": "agent", "key": "myrepo-1a2b3c4d" }
}
```

- Optional; when it's absent the task was added at the page. `kind` is exactly `"agent"`; `key`
  is non-empty.
- An invalid `source` is **dropped** and the task kept, just as a malformed `queued` unqueues
  rather than drops.
- `update_task` keeps `source`: it records where the task came from, not who last edited it.
  `SentTask` does not carry it (`markSent` drops it).
- `tasksMessage` sends it to the page unchanged.

### `appendAgentTask({ text, localFolder, root, key }, path = TASKS_PATH)`

It works on the **raw parsed JSON**, never on `readTasks` → `writeTasks`. A bridge built from an
older devc-core must not drop fields or entries that a newer devc added, and `readTasks` /
`cleanTask` drop everything they don't know.

- Inside `withTasksLock(path)`:
  - Read the file. If it is missing, start from `{"version":1,"tasks":[],"sent":[]}`. If it does
    not parse, or its top level is not an object, or `tasks` is present but not an array, throw
    (exit 4); never overwrite a file it can't read.
  - Count the entries of `tasks` that are objects with `source.kind === 'agent'` and
    `source.key === key`. 20 or more → the cap error (exit 3).
  - Push `{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), localFolder,
    root, source: { kind: 'agent', key } }` onto `tasks`. Leave every other key and entry as
    parsed.
  - Write atomically (temp file in the same directory, then rename), as
    `JSON.stringify(obj, null, 2) + '\n'`, the same format as `writeTasks`.
- Returns the new id.

### `withTasksLock(fn, path = TASKS_PATH)`

- Lock file `${path}.lock`, taken with `Deno.open(lock, { createNew: true, write: true })`. It
  creates the directory first, as `writeTasks` does.
- On `Deno.errors.AlreadyExists`: if the lock's `mtime` is more than 10 s old, remove it and
  retry at once; otherwise wait 25 ms and retry. Give up after 5 s by throwing
  `tasks file is locked (<lock path>)`.
- Runs `fn`, then removes the lock in `finally` (ignoring `NotFound`).
- Both writers take it: devc web's `changeTasks` (read → change → write) and `appendAgentTask`.

### Page marker

A task with `source.kind === 'agent'` shows `🤖` before its title in the task list. Its tooltip
reads `Added by an agent`. The rest of the row is unchanged.

## Implementation notes / gotchas

- `watchConfigFile` filters events by file name (`configEventMatches`), so creating and removing
  `tasks.json.lock` in the same directory does not trigger reloads.
- `grantRefusal` only checks the policy **union** (any line granting any of the command's
  capabilities). The per-line check is the handler's job (step 2), just as it is the scripts' job.
- `materializeBuiltins` copies `devc-bridge/builtin/` and must not expect a `task-add` script.
  `capabilities_test.ts` asserts that the materialized scripts equal `builtinCommandNames()`;
  change it to `builtinCommandNames()` minus `BRIDGE_NATIVE_COMMANDS`.
- The bridge host's compile and run permissions already include `--allow-run` (for `docker ps`)
  and read/write. `deno.json`'s `build` / `build:release` need no new `--include`. `check` must
  list `task_add.ts` and the new test.
- `devc-core/container.ts` pulls in more of core than the bridge imports today. That is accepted:
  the import map already maps all of `@devc-tools/core/`.
- Version skew: the bridge runs the devc-core it was built with. `appendAgentTask` only appends
  and leaves everything else untouched, so an older bridge and a newer devc web can share the
  file. A newer `source` shape that an older devc web doesn't know is dropped from that task (it
  shows without 🤖), and the task itself is kept.
- The route's `root` is the repo's host working-tree path. devc web's repo folders
  (`ProjectView.repos[].folder`) use the same paths, so the task lands in that repo's queue.
  devc web's `badRoute` is not applied to tasks written outside it.
- `projectKey` lowercases the normalized folder before hashing. Compare keys as strings and never
  try to invert one.

## Relevant Files

- `devc-core/tasks.ts` (new, moved from `devc/web/tasks.ts`): store, `source`, `withTasksLock`,
  `appendAgentTask`
- `devc-core/tests/tasks_test.ts` (new): `source`, lock and `appendAgentTask` cases
- `devc/web/tasks.ts`: deleted
- `devc/web/agents.ts`: re-exports the agent and action types and guards from core
- `devc/web/server.ts`, `devc/web/sessions.ts`, `devc/web/protocol.ts`: import path; `changeTasks`
  under the lock
- `devc/tests/web_tasks_test.ts`, `devc/tests/web_tasks_page_test.ts`: import path; page parser
  keeps `source`
- `devc/web/static/lib/tasks.js`: keep `source`
- `devc/web/static/sidebar.js`: where the task row's title is rendered (the 🤖 marker; the plan
  first named `tiles.js`, but the task list is drawn in the sidebar)
- `devc-core/bridge.ts`: capability, command map, `BRIDGE_NATIVE_COMMANDS`
- `devc-core/tests/bridge_test.ts`: capability list, `capabilitiesForCommand`, `grantsProblem`
- `devc/args.ts`: `--bridge-allow` help text for valid names (expansion unchanged)
- `devc/tests/args_test.ts`: `gh` excludes `task-add`; `gh,task-add` accepted
- `devc/bridge.ts`: header comment's capability list
- `devc/help.ts`: `--bridge-allow` capability list
- `devc/tests/help_test.ts`: if it pins the capability list text
- `devc-bridge/host/core.ts`: native dispatch, `warnShadowed`
- `devc-bridge/host/task_add.ts` (new)
- `devc-bridge/host/tests/task_add_test.ts` (new)
- `devc-bridge/host/tests/capabilities_test.ts`: materialized scripts exclude native commands;
  `task-add` gated by the grant
- `devc-bridge/host/deno.json`: `check` task lists the new files
- `devc-bridge/client/devc-bridge.ts`: usage line
  `task-add [--repo <path>] <text>   add a task to devc web's task list   [task-add]`
- `devc-bridge/README.md`: the new built-in and its grant
- `devc/README.md`: capability list; the task list section notes agents can add tasks

## Validation

- [x] `cd devc-core && deno test -A tests/bridge_test.ts`: `task-add` is a capability;
      `capabilitiesForCommand('task-add')` is `['task-add']`; `grantsProblem(['task-add'])` is
      null; `BRIDGE_NATIVE_COMMANDS` is `['task-add']`
- [x] `cd devc-core && deno test -A tests/tasks_test.ts`:
  - A task with a valid `source` round-trips through `writeTasks` / `readTasks`
  - `source: {kind: 'human'}` is dropped and the task kept
  - `updateTask` keeps `source`
  - `appendAgentTask` on a missing file creates `{version:1, tasks:[…], sent:[]}`
  - On a file holding an unknown top-level key and a task with an unknown field, it keeps both
    unchanged
  - On a non-JSON file it throws and leaves the file unchanged
  - The 21st task from one key throws the cap error while another key still succeeds
  - Two concurrent `appendAgentTask` calls both land
  - A lock file with an mtime 11 s old is taken over
- [x] `cd devc && deno test -A tests/`: all pass with the moved module;
      `parseBridgeAllow('gh')` excludes `task-add`; `parseBridgeAllow('gh,task-add')` ends with
      `task-add`; the page parser keeps `source`
- [x] `cd devc-bridge/host && deno test -A tests/task_add_test.ts` (temp policy dir and tasks path,
      injected container list):
  - Exit 0 prints a UUID, and the task has `localFolder` (the injected folder whose `projectKey`
    is the caller's key), `root` (the line's `repo`) and `source {kind:'agent', key}`
  - No `--repo` with 2 lines → 2
  - `--repo /x/` matches target `/x`
  - A line without `task-add` → 2, naming its target
  - Blank text → 3; text with `\x07` → 3
  - No matching container → 4
  - Shared token → 1
- [x] `cd devc-bridge/host && deno test -A tests/capabilities_test.ts`: materialized scripts equal
      the built-in names minus `task-add`; `task-add` without the grant → exit 1
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` and `bash devc-bridge/tests/gh_push_test.sh`
      still pass
- [x] `deno fmt --check`, `deno lint` and `deno task check` (or `deno check`) pass in `devc`,
      `devc-core`, `devc-bridge/host` and `devc-bridge/client` (2026-10-26: fmt and check pass
      everywhere; lint is clean in `devc-bridge/host`, `devc-bridge/client` and every new source
      file — the only findings in changed files are `no-import-prefix` / `no-unversioned-import`
      on the `jsr:@std/*` imports every test file in `devc` and `devc-core` uses)
- [ ] Manual: restart the bridge, run `devc up --bridge-allow gh,task-add` on a GitHub repo, then
      in the container run `devc-bridge task-add $'Fix the flaky test\n\nDetails…'`. It prints an
      id; the open devc web page shows `🤖 Fix the flaky test` in that repo's tasks within a
      second, unqueued; and Send still works from the page
