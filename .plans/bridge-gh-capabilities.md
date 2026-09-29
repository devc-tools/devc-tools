# bridge-gh-capabilities

Every devc-bridge capability and built-in command moves to one `gh-` naming
convention, `--bridge-allow` gains `gh` / `gh-*` for "all of them", and push
becomes GitHub-only so that every `gh-` name really does depend on the host's
`gh` login.

There are no existing users, so there is **no compatibility layer**: old names
are simply unknown.

## Decisions

### Names

| Old capability      | New capability         | Commands it enables (old → new)                              |
| ------------------- | ---------------------- | ------------------------------------------------------------ |
| `git-push`          | `gh-push`              | `git-push` → `gh-push`, `git-doctor` → `gh-doctor`           |
| `pr-review`         | `gh-pr-review`         | `pr-comments` → `gh-pr-comments`, `pr-reply` → `gh-pr-reply` |
| `pr-resolve`        | `gh-pr-resolve`        | `pr-resolve` → `gh-pr-resolve`                               |
| `pr-request-review` | `gh-pr-request-review` | `pr-request-review` → `gh-pr-request-review`                 |

- Canonical order: `gh-push`, `gh-pr-review`, `gh-pr-resolve`, `gh-pr-request-review`.
- Requirements are unchanged, only renamed: `gh-pr-resolve` and
  `gh-pr-request-review` each need `gh-pr-review`.
- The capability-to-commands map is the single source of truth
  (`BRIDGE_CAPABILITY_COMMANDS` in `devc-core/bridge.ts`). The built-in script
  file names in `devc-bridge/builtin/` must match the new command names
  exactly, because the bridge dispatches by file name.
- `ping`, `help` and `version` are unchanged. They aren't capabilities.
- These names stay as they are, because they describe git or the host rather
  than the capability: the `DEVC_BRIDGE_GIT_TIMEOUT` and `DEVC_BRIDGE_GH_TIMEOUT`
  env vars, the mirror path `~/.local/state/devc-bridge/git/<key>.git`, and the
  policy file format (four tab-separated fields, grants comma-joined in
  canonical order).

### `gh` / `gh-*` wildcard

- In a `--bridge-allow` list, the exact entries `gh` and `gh-*` (after trimming)
  each expand to **every capability whose name starts with `gh-`**. Today that's
  all four.
- They can be mixed with explicit names and with each other. The result is
  deduplicated into canonical order, as today.
- No other pattern is accepted. `*`, `gh-pr-*`, `GH` and so on get the
  unknown-capability error. This is two reserved tokens, not a glob engine.
- **The wildcard is expanded by `devc` when it parses the flag.** The policy
  file always stores the explicit list, and neither the bridge nor the scripts
  ever see `gh` or `gh-*`. So a capability added in a later release is **not**
  granted to an existing container just because the bridge was upgraded. That
  matters because `gh-pr-request-review` spends Copilot quota, and a future one
  might too. A pin refresh keeps the stored grants, so the new capability
  arrives only on the next `devc up --bridge-allow gh`.
- **Shell gotcha, which the docs must show:** zsh (the macOS default) aborts an
  unquoted `gh-*` with `zsh: no matches found: gh-*` before devc ever runs. Bash
  passes it through when nothing in the current directory matches. So docs and
  help show `gh` as the everyday form and `'gh-*'` quoted.

### Push is GitHub-only

- Today `git-push` pushes a non-GitHub remote (a local path, SSH to another
  host) with the user's normal git credentials. That path is removed.
- A remote is a GitHub remote when it has exactly one of the shapes that
  `parse_remote` in the `pr-*` scripts accepts today:
  - `git@<host>:<owner>/<name>[.git]`
  - `ssh://git@<host>/<owner>/<name>[.git]`
  - `https://<host>/<owner>/<name>[.git]`

  In each, `<host>` is `github.com` or `github.com-<alias>`, with host
  characters `[A-Za-z0-9.-]` only. `<owner>` and `<name>` are non-empty, made of
  `[A-Za-z0-9._-]`, and are not `.` or `..`. There is no other form and no
  other host.
- **The check happens at grant time too.** `devc` adds the rule to pin
  derivation in `devc/bridge.ts`, using a new `devc-core` predicate that mirrors
  `parse_remote` shape for shape. So:
  - `devc up --bridge-allow …` on a non-GitHub remote is refused before `up`.
  - A pin refresh on a repo whose origin stopped being GitHub revokes the
    grant.

  Both of those already exist; this only adds a new reason string.
- **`gh-push` and `gh-doctor` still check for themselves**, as a second layer,
  because policy files are host files that can be edited by hand.
- Remove the SSH transport from both scripts: `GIT_SSH_COMMAND` / BatchMode,
  the `is_ssh` branch in the doctor, and the `SSH_AUTH_SOCK` notes. Set
  `GIT_ALLOW_PROTOCOL=file:https`. `file` must stay, because step 5 fetches from
  the container's repo by local path.

### Old names

- Old names are a hard error with no hint. `--bridge-allow git-push` gets the
  normal unknown-capability error.
- A policy file holding old names doesn't parse. The existing refresh path
  removes it with its existing "malformed" message, and the bridge refuses it
  with its existing message. No new code is needed for either.
- The client sends old command names to the host unchanged, and the host treats
  them as unknown commands. No special-casing.
- The already-removed `--bridge-git-push` flag keeps its refusal, with the text
  updated to point at `gh-push`.

### The agent guide

`docs/bridge-git-push.md` is renamed to `docs/bridge-github.md`. The client
embeds it (the `--include` in both `deno.json` build tasks and in
`build-client.sh`) and reads it through `GUIDE_FILE` in
`devc-bridge/client/devc-bridge.ts`. All of those must change together, or
`help guide` breaks in a compiled client while still working from source.

## Contract

These strings are exact. Everything else about the output is unchanged apart
from the names.

| Where                                  | Output                                                                                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devc up`/`build`, unknown entry       | `unknown capability <n> — valid: gh-push, gh-pr-review, gh-pr-resolve, gh-pr-request-review (or gh / gh-* for all of them)` (exit 2)                                                                                                                           |
| `devc up`/`build`, empty list          | `--bridge-allow needs at least one of: gh-push, gh-pr-review, gh-pr-resolve, gh-pr-request-review (or gh / gh-* for all of them)` (exit 2)                                                                                                                     |
| `devc up`/`build`, missing requirement | `gh-pr-resolve requires gh-pr-review` / `gh-pr-request-review requires gh-pr-review` (exit 2)                                                                                                                                                                  |
| any devc command, `--bridge-git-push`  | `devc: --bridge-git-push was replaced by --bridge-allow gh-push` (exit 2)                                                                                                                                                                                      |
| grant on a non-GitHub origin           | `--bridge-allow: origin <url> is not a github.com remote` (before `up`), or `the container is up, but --bridge-allow was not granted: origin <url> is not a github.com remote` (after)                                                                         |
| refresh on a non-GitHub origin         | `devc: devc-bridge capabilities revoked — origin <url> is not a github.com remote. Re-run \`devc up --bridge-allow <grants>\` once that is fixed.` (existing template, new reason)                                                                             |
| `gh-push`, non-GitHub pin              | stderr `gh-push: unsupported remote <remote> — only github.com`, exit 2                                                                                                                                                                                        |
| `gh-doctor`, non-GitHub pin            | a `transport FAILED: unsupported remote <remote> — only github.com` line; doctor exits 1                                                                                                                                                                       |
| `gh-push` success                      | `pushed: …` / `up to date: …` lines unchanged; the stderr prefix becomes `gh-push:`                                                                                                                                                                            |
| `devc --help` for `up`                 | `--bridge-allow <list>   Let this container use devc-bridge capabilities (gh-push, gh-pr-review, gh-pr-resolve, gh-pr-request-review; gh or 'gh-*' for all), comma-separated; without it, any earlier grant is removed` (wrapped in the existing column style) |

`devc-bridge help` lists the six renamed commands, each with its capability in
brackets, in canonical order: `gh-push`, `gh-doctor`, `gh-pr-comments`,
`gh-pr-reply`, `gh-pr-resolve`, `gh-pr-request-review`. The closing hint
becomes `Start with: devc-bridge gh-doctor`.

## Gotchas

- **The `pr-*` scripts share a prelude** that has to stay byte-identical across
  all four copies, and `pr_review_test.sh` checks this. Rename inside it once
  and copy it to all four. `git-push` and `git-doctor` carry their own copy of
  `parse_remote`. Every copy must accept exactly the shapes in the devc-core
  predicate. Add one shape table to `devc-core/tests/bridge_test.ts`, and assert
  the same table against the shell `parse_remote` in `gh_push_test.sh`.
- **Most of the push tests use a local bare repo as the remote**, which is
  exactly the path being removed. Switch them to a GitHub pin
  (`git@github.com:acme/widget.git`) and use the harness's existing `git` shim
  (the `GH_URL` → `$REMOTE` rewrite, currently around line 411), plus the `gh`
  shim for `auth status` and `auth git-credential`. Drop the SSH / BatchMode /
  `SSH_AUTH_SOCK` cases. Add a local-path pin → exit 2 case and an
  `ssh://git@gitlab.com/…` pin → exit 2 case.
- **Scripts check their own capability** (`require_grant` and its push
  equivalent) using string literals. Rename those too, or every call passes the
  bridge's check and then fails the script's (exit 2 "not granted").
- **`builtin/` is replaced wholesale on every bridge start**, so the old script
  names disappear after a restart and nothing needs cleaning up. A user's
  `commands/` file with a new built-in's name is shadowed. That behaviour
  already exists and isn't new here.
- **Versions have to move together.** An old bridge rejects a new policy as
  malformed, and a new bridge rejects an old one. `install.sh` now stops the
  bridge on upgrade, which covers this. The Feature's pinned client
  (`features/devc-bridge`) is bumped as a release step after this ships. It is
  not part of this plan.
- **Leave history alone.** `.plans/archived/`, the existing entries in
  `.plans/PLAN.md` and `docs/manual-verification.md` describe past behaviour
  and keep the old names.

## Checklist

- [ ] `devc-core/bridge.ts`: rename the capabilities, the command map and the requirements; add the GitHub-remote predicate
- [ ] `devc/args.ts`: `gh` / `gh-*` expansion; unknown and empty messages; `--bridge-git-push` text
- [ ] `devc/main.ts`: `--bridge-git-push` refusal text; doc comment
- [ ] `devc/bridge.ts`: non-GitHub origin reason in pin derivation; header comment
- [ ] `devc/help.ts`: `up` help text
- [ ] `devc-bridge/builtin/`: rename all six scripts (`git mv`); rename grant literals, `$me` messages and prelude comments; push and doctor become GitHub-only with no SSH transport
- [ ] `devc-bridge/host/core.ts` and `devc-bridge/host/config.ts`: comments and anything that names commands
- [ ] `devc-bridge/client/devc-bridge.ts`: overview text; `GUIDE_FILE`
- [ ] `docs/bridge-git-push.md` → `docs/bridge-github.md` (`git mv`), updated throughout; `deno.json` (both tasks) and `build-client.sh` includes
- [ ] Tests: `git mv` `devc-bridge/tests/git_push_test.sh` → `gh_push_test.sh` and `pr_review_test.sh` → `gh_pr_review_test.sh`, then update them; `.github/workflows/release.yml` test steps
- [ ] Tests: `devc-core/tests/bridge_test.ts`, `devc/tests/args_test.ts`, `devc/tests/bridge_test.ts`, `devc-bridge/host/tests/capabilities_test.ts`
- [ ] Docs: `devc-bridge/README.md`, `devc/README.md`, `devc-bridge/docs/testing.md`
- [ ] Skill: `skills/copilot-pr-reviewing/SKILL.md` — new command names; the `devc up` line uses `--bridge-allow gh`

## Validation

- [ ] `cd devc-core && deno test` passes, including:
  - the GitHub-remote shape table: accepts `git@github.com:o/n.git`, `ssh://git@github.com/o/n`, `https://github.com/o/n.git`, `git@github.com-work:o/n.git`; refuses `/srv/repo.git`, `file:///x`, `git@gitlab.com:o/n.git`, `https://github.com/o`, `https://github.com/../n`, `git@github.com:o/n/extra`
  - parsing a policy with `git-push` → `null`
- [ ] `cd devc && deno task test` passes, including:
  - `--bridge-allow gh` → `[gh-push, gh-pr-review, gh-pr-resolve, gh-pr-request-review]`
  - `--bridge-allow 'gh-*'` → the same list
  - `--bridge-allow gh-push,gh` → the same list
  - `--bridge-allow gh-pr-resolve` → `gh-pr-resolve requires gh-pr-review`
  - `--bridge-allow git-push` → `unknown capability git-push — valid: …` (the exact contract string)
  - `--bridge-allow '*'` and `--bridge-allow 'gh-pr-*'` → unknown capability
  - a grant against a fixture repo whose `remote.origin.url` is a local path → `BridgeGrantError` `--bridge-allow: origin <path> is not a github.com remote`
  - a refresh against the same fixture → revoke with that reason
- [ ] `cd devc-bridge/host && deno task test && deno task check` pass. The built-ins list is exactly the six `gh-*` names, and an ungranted `gh-pr-resolve` gets the hint `devc up --bridge-allow gh-pr-review,gh-pr-resolve`
- [ ] `bash devc-bridge/tests/gh_push_test.sh` → `0 failed`, including local-path pin → exit 2 `gh-push: unsupported remote … — only github.com`, and `gh-doctor` on that pin → `transport FAILED: unsupported remote`, exit 1
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` → `0 failed`, including the prelude being byte-identical across the four `gh-pr-*` scripts
- [ ] `grep -rnE '\b(git-push|git-doctor|pr-comments|pr-reply|pr-resolve|pr-request-review|pr-review)\b' --exclude-dir=.git --exclude-dir=archived . | grep -vE 'gh-(push|doctor|pr-)|docs/manual-verification.md|\.plans/PLAN.md'` prints nothing
- [ ] A compiled client (`bash devc-bridge/client/build-client.sh`) prints the new guide for `./devc-bridge help guide | head -1`, and `./devc-bridge help` lists the six `gh-*` commands
- [ ] `deno fmt --check` on changed `.ts`/`.md`
- [ ] Live on the host, after installing the new build and running `devc-bridge start`: `devc up --bridge-allow gh` → `devc: devc-bridge capabilities granted: gh-push, gh-pr-review, gh-pr-resolve, gh-pr-request-review for <branch> → <remote> (<repo>)`; inside the container `devc-bridge gh-doctor` shows the pin and `transport ok`, and `devc-bridge gh-pr-comments` prints JSON

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc/args.ts`
- `devc/main.ts`
- `devc/bridge.ts`
- `devc/help.ts`
- `devc/README.md`
- `devc/tests/args_test.ts`
- `devc/tests/bridge_test.ts`
- `devc-bridge/builtin/git-push` → `devc-bridge/builtin/gh-push`
- `devc-bridge/builtin/git-doctor` → `devc-bridge/builtin/gh-doctor`
- `devc-bridge/builtin/pr-comments` → `devc-bridge/builtin/gh-pr-comments`
- `devc-bridge/builtin/pr-reply` → `devc-bridge/builtin/gh-pr-reply`
- `devc-bridge/builtin/pr-resolve` → `devc-bridge/builtin/gh-pr-resolve`
- `devc-bridge/builtin/pr-request-review` → `devc-bridge/builtin/gh-pr-request-review`
- `devc-bridge/host/core.ts`
- `devc-bridge/host/config.ts`
- `devc-bridge/host/tests/capabilities_test.ts`
- `devc-bridge/client/devc-bridge.ts`
- `devc-bridge/client/deno.json`
- `devc-bridge/client/build-client.sh`
- `devc-bridge/tests/git_push_test.sh` → `devc-bridge/tests/gh_push_test.sh`
- `devc-bridge/tests/pr_review_test.sh` → `devc-bridge/tests/gh_pr_review_test.sh`
- `devc-bridge/README.md`
- `devc-bridge/docs/testing.md`
- `docs/bridge-git-push.md` → `docs/bridge-github.md`
- `.github/workflows/release.yml`
- `skills/copilot-pr-reviewing/SKILL.md`
- `.plans/PLAN.md`
