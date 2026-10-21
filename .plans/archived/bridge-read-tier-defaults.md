# bridge-read-tier-defaults

Two changes to devc-bridge's grants, so that devc web can show a PR through a container's
bridge without the user typing a review grant on every start:

- **Two new capabilities and two new built-in commands.** `gh-pr-read` enables
  `gh-pr-comments` (also still enabled by `gh-pr-review`) and the new `gh-pr-files`, which lists
  the pinned PR's changed files with their patches and your Viewed state. `gh-pr-viewed` enables
  the new `gh-pr-viewed`, which marks one of those files Viewed or not Viewed.
- **A default grant in `~/.config/devc/config.json`.** `"bridgeDefaultAllow": [...]` is the
  capability list `devc up` and `devc build` grant when `--bridge-allow` is not given. The flag
  still replaces it, and `--bridge-allow none` is the new way to grant nothing.

Read `devc/bridge.ts`'s module header, `devc-core/bridge.ts`'s capability section,
`devc-bridge/host/core.ts`'s `grantRefusal`, and the `pr-prelude` block in
`devc-bridge/builtin/gh-pr-comments` first.

## Decisions

- **The default lives in devc's global config, not in a devc config layer.** Every overlay layer
  that `devc up` merges (`devc.jsonc` at every level, the project's `.devcontainer/`) is either
  agent-writable or merged with one that is, which is why grants were flag-only. `config.json` is
  not part of that merge, no container mounts it (devc mounts only `~/.config/devc/.claude`,
  `shell/` and `git-identity/`), and only the TUI config wizard writes it. The key is **never**
  read from `devc.jsonc` or a repo overlay. devc web must never gain a way to write it: an agent
  can drive devc web's page.
- **Any capability can be a default.** Which risk to accept in every container is the user's
  call. The README says plainly that a write capability in the default is granted on every
  `devc up`.
- **Entries are explicit names.** `gh` and `gh-*` are refused in the config. The flag expands
  them at grant time so that a capability a later release adds is not granted until re-granted.
  In a default re-expanded on every `up`, they would grant new capabilities silently after an
  upgrade.
- **Only `devc up` and `devc build` apply the default**, exactly where today's no-flag `revoke`
  happens. Every other start path (`devc attach`, `devc herdr`, devc web's **Start container**,
  the TUI) still only refreshes an existing policy and never creates one, because `HEAD` is
  agent-writable and only a user's `up` may move a pin.
- **A default grant never fails the command.** An explicit `--bridge-allow` that cannot pin
  anything fails `devc up`, because the user asked for it. A default that cannot pin anything (no
  GitHub origin, detached `HEAD`, git protection off) logs one line, removes any old policy and
  lets the start succeed. A workspace without the devc-bridge Feature gets no line at all.
- **`gh-pr-comments` stays under `gh-pr-review` as well as `gh-pr-read`.** This keeps every
  existing policy valid, so no migration is needed. A built-in command can therefore be enabled by
  more than one capability. The bridge allows it when **any** of them is granted.
- **`gh-pr-viewed` requires `gh-pr-read`.** The paths it takes come from `gh-pr-files`. This
  follows the existing rule that `gh-pr-resolve` requires `gh-pr-review`.
- **The policy file format does not change.** It still holds the explicit capability list, and it
  doesn't record whether that list came from the flag or the default.

## Contracts

### Capabilities (`devc-core/bridge.ts`)

`BRIDGE_CAPABILITIES`, in this canonical order (the old names keep their relative order, so every
existing policy stays in canonical order):

```
gh-push, gh-pr-read, gh-pr-review, gh-pr-viewed, gh-pr-resolve, gh-pr-request-review
```

| Capability             | Commands                        | Requires       |
| ---------------------- | ------------------------------- | -------------- |
| `gh-push`              | `gh-push`, `gh-doctor`          |                |
| `gh-pr-read`           | `gh-pr-comments`, `gh-pr-files` |                |
| `gh-pr-review`         | `gh-pr-comments`, `gh-pr-reply` |                |
| `gh-pr-viewed`         | `gh-pr-viewed`                  | `gh-pr-read`   |
| `gh-pr-resolve`        | `gh-pr-resolve`                 | `gh-pr-review` |
| `gh-pr-request-review` | `gh-pr-request-review`          | `gh-pr-review` |

- **gotcha:** `capabilityForCommand` returns one capability. Replace it with a lookup that
  returns every capability enabling the command, in canonical order (`gh-pr-comments` →
  `[gh-pr-read, gh-pr-review]`). Every caller changes: the host's dispatch and `warnShadowed`.
  `warnShadowed` must log a shadowed `gh-pr-comments` once, not once per capability.
- `--bridge-allow gh` / `gh-*` now expand to all six.

### Host refusals (`devc-bridge/host/core.ts`)

A built-in runs when the policy grants **any** of its capabilities. Messages use the first one
(`<first>`), plus what it requires, as the suggestion:

- No policy: `no capabilities granted to this container — on the host: devc up --bridge-allow <suggestion>`.
  For `gh-pr-comments` that is `gh-pr-read`. For `gh-pr-viewed` it is `gh-pr-read,gh-pr-viewed`.
- Policy without any of them, with one capability:
  `<name> needs capability <cap>, which this container was not granted (it has: <list>) — on the host: devc up --bridge-allow <grants + cap + requirement, canonical>`
  (today's text). With two (only `gh-pr-comments`):
  `gh-pr-comments needs capability gh-pr-read or gh-pr-review, which this container was not granted (it has: <list>) — on the host: devc up --bridge-allow <grants + gh-pr-read, canonical>`.

### The script prelude (all six `gh-pr-*` scripts)

- `require_grant CAP…` passes when the policy grants any CAP listed. Its refusal is
  `this container was not granted <CAP1> or <CAP2>` (a single CAP: today's text).
- `gh-pr-comments` calls `require_grant gh-pr-read gh-pr-review`. Its header says it runs under
  either.
- The prelude stays byte-identical across `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve`,
  `gh-pr-request-review`, `gh-pr-files` and `gh-pr-viewed`. The harness's prelude check covers
  the two new scripts.

### `devc-bridge gh-pr-files [--repo <path>]` (new; `gh-pr-read`)

Steps: `load_policy`, `require_grant gh-pr-read`, `gh_ready`, `resolve_pr`, then:

1. **Header and Viewed state:** GraphQL with `--paginate`, as `gh-pr-comments` pages threads:
   `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){title state isDraft baseRefName headRefName changedFiles author{login} files(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`
   with `-f owner=$pr_owner -f name=$pr_name -F number=$pr_number`.
   - **gotcha:** with `--paginate`, `--jq` runs once per page, so the header fields come out on
     every page. Take them from the first page only.
2. **Files with patches:** REST `gh api --paginate "repos/$pr_repo/pulls/$pr_number/files?per_page=100"`,
   with `--jq` emitting one compact JSON line per file:
   `{path: .filename, previousPath: (.previous_filename // null), status, additions, deletions, patch: (.patch // null)}`.
   GitHub lists at most 3000 files here.
3. **Join:** each file's `viewed` is its path's `viewerViewedState` from step 1. A missing path
   gives `UNVIEWED`.

Output: one JSON object on stdout, then a newline. Strings are JSON-encoded by jq. Strings built
in the shell are values `resolve_pr` already validated.

```json
{
  "pr": {
    "repo": "o/r",
    "number": 12,
    "url": "https://github.com/o/r/pull/12",
    "headSha": "<40 hex>",
    "title": "…",
    "state": "OPEN",
    "isDraft": false,
    "author": "login-or-null",
    "baseRef": "main",
    "headRef": "feature/x",
    "changedFiles": 14
  },
  "files": [
    {
      "path": "src/a.ts",
      "previousPath": null,
      "status": "modified",
      "additions": 3,
      "deletions": 1,
      "patch": "@@ …",
      "viewed": "VIEWED"
    }
  ],
  "truncated": false
}
```

- `author` is `null` for a deleted account. `truncated` is `changedFiles` > the number of
  `files`. `files` keeps REST order.
- Exit codes are the same as `gh-pr-comments`: 0 ok, 2 policy, arguments, remote or no single
  open PR, 4 GitHub, auth or timeout. Any argument after `--repo <path>` → exit 2 with the usage.

### `devc-bridge gh-pr-viewed [--repo <path>] <viewed|unviewed> <file>` (new; `gh-pr-viewed`)

Steps: `load_policy`, `require_grant gh-pr-viewed`, check arguments, `gh_ready`, `resolve_pr`,
then:

1. **Arguments:** exactly two after `--repo`. The first is `viewed` or `unviewed`. The second is
   1–4096 bytes with no control characters. Otherwise exit 2: `usage: gh-pr-viewed [--repo <path>] <viewed|unviewed> <file>`.
2. **The file must be in the PR.** Page `files(first:100,after:$endCursor){… nodes{path}}` as in
   `gh-pr-files` step 1, and look for an exact match. None → exit 2:
   `<file> is not a file in <pr_url>`. The path reaches GitHub only as `-f path=…`.
3. **Mutation:** `mutation($id:ID!,$path:String!){markFileAsViewed(input:{pullRequestId:$id,path:$path}){clientMutationId}}`,
   or `unmarkFileAsViewed` with the same input, with `-f id=$pr_id -f path=<file>`.
   - **gotcha:** `pr_id` is `resolve_pr`'s, never a container value.
4. Output: `{"path":<file, JSON-encoded>,"viewed":"VIEWED"}` (or `"UNVIEWED"`) and a newline.
   Exit codes as above.

### `bridgeDefaultAllow` (`~/.config/devc/config.json`)

```json
{ "bridgeDefaultAllow": ["gh-pr-read", "gh-pr-viewed"] }
```

- Kept in `GlobalConfig.extra` and read through an accessor, as `webSource` is, so a wizard
  save keeps it verbatim. The wizard gets no UI for it.
- **When it is read:** only by `devc up` and `devc build`, and only when `--bridge-allow` is not
  given. When it is read and invalid, the command exits 2 before starting anything, with
  `devc: ~/.config/devc/config.json: bridgeDefaultAllow: <reason>`:

  | Value                               | `<reason>`                                                               |
  | ----------------------------------- | ------------------------------------------------------------------------ |
  | not an array, or a non-string entry | `must be an array of capability names`                                   |
  | `"gh"` or `"gh-*"`                  | `"gh" is not allowed here — list each capability` (the entry as written) |
  | an unknown name                     | `unknown capability <name> — valid: <the six, comma-separated>`          |
  | a requirement missing               | `<cap> requires <needed>` (as `parseBridgeAllow` says it)                |

  Entries are trimmed. Duplicates are dropped, and the list is put in canonical order. Absent,
  `null` or `[]` → no default.

### `devc up` / `devc build` policy mode

| `--bridge-allow` | `bridgeDefaultAllow` | Mode                                                             |
| ---------------- | -------------------- | ---------------------------------------------------------------- |
| `<list>`         | any                  | explicit grant, exactly as today (pre-`up` check, hard failures) |
| `none`           | any                  | revoke, exactly as today's no-flag                               |
| absent           | absent / `[]`        | revoke (unchanged)                                               |
| absent           | non-empty            | **default grant** (below)                                        |

- `none` must be the whole value. Combined with another entry:
  `--bridge-allow none can't be combined with capabilities`. With `--bridge-repo`:
  `--bridge-repo requires --bridge-allow with capabilities`. Today's `--bridge-repo requires --bridge-allow`
  is unchanged for the absent case, so a default grant never pins a `--bridge-repo`.
- **Default grant:** no pre-`up` check. After `up`, pins are derived exactly as for an explicit
  grant with no `--bridge-repo`:
  - **No Feature** (`merged.bridgeKey === null`): behave as revoke, which logs only when it
    removed a policy.
  - **Pins derived:** write the policy (unchanged if identical), then log
    `devc: bridgeDefaultAllow: not pinning <label>: <reason>` for each skip, then
    `devc: devc-bridge capabilities granted (bridgeDefaultAllow): <list>`, then the repo lines
    exactly as today.
  - **Any other failure** (container-wide or nothing pinnable): remove any policy, log
    `devc: bridgeDefaultAllow: not granted: <reason>`, and succeed.
- Refresh (every other start path) is unchanged.

## Checklist

- [x] `devc-core/bridge.ts`: the two capabilities, the command table, the requirement, the
      multi-capability lookup, and comments
- [x] `devc-bridge/host/core.ts`: dispatch on any granted capability, the refusal texts above,
      `warnShadowed` dedupe
- [x] Prelude `require_grant CAP…` in `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve` and
      `gh-pr-request-review` (byte-identical). `gh-pr-comments` takes either grant, and its
      header says so
- [x] `devc-bridge/builtin/gh-pr-files` (new, executable)
- [x] `devc-bridge/builtin/gh-pr-viewed` (new, executable)
- [x] `devc-bridge/host/deno.json` `build` / `build:release`: they already `--include ../builtin`.
      Confirm the new scripts materialize (`config.ts` `materializeBuiltins`) and fix it if it
      lists names
- [x] `devc-bridge/client/devc-bridge.ts`: help lines for `gh-pr-files` `[gh-pr-read]` and
      `gh-pr-viewed` `[gh-pr-viewed]`, and `gh-pr-comments` shown as `[gh-pr-read|gh-pr-review]`
- [x] `devc-core/config.ts`: the `bridgeDefaultAllow` accessor (raw from `extra`)
- [x] `devc/args.ts`: `--bridge-allow none`, its two refusals, and the validation of the
      config value (same capability rules as `parseBridgeAllow`, no `gh`/`gh-*`)
- [x] `devc/bridge.ts`: the default-grant `PolicyMode` and its logging and non-failure rules
- [x] `devc/main.ts`: the mode table for `up` and `build`, and the config error exits 2 before
      anything starts
- [x] `devc/help.ts`: `--bridge-allow` lists the new capabilities and `none`, and mentions
      `bridgeDefaultAllow`
- [x] Tests: `devc-core/tests/bridge_test.ts`, `devc-bridge/host/tests/capabilities_test.ts`,
      `devc-bridge/tests/gh_pr_review_test.sh` (stub-`gh` cases for both new scripts, and the
      prelude check over six), `devc/tests/args_test.ts`, `devc/tests/bridge_test.ts`,
      `devc-core/tests/global_config_test.ts` (round-trip keeps the key)
- [x] Docs: `devc-bridge/README.md` (capability table, the two commands, the multi-capability
      rule), `docs/bridge-github.md` (the capability list, `gh-pr-files` / `gh-pr-viewed` usage and
      output, exit-code row 1's wording), `devc/README.md` (`bridgeDefaultAllow`, `--bridge-allow none`,
      what a write capability in the default means, and that devc web never writes `config.json`),
      `devc-bridge/docs/testing.md` (the new harness cases), `skills/github-pr-reviewing/SKILL.md`
      (step 3: `gh-pr-read` is enough to read threads, `gh-pr-review` to reply),
      `.plans/design/devc-design.md` (the capability list at line ~814)

## Validation

- [x] `(cd devc && deno task check && deno task test)` passes
- [x] `(cd devc-core && deno task check && deno task test)` passes
  - 2026-10-21: check passes; tests pass except `git_dirs_test.ts`'s "cliWorktreeMounts
    matches what the pinned devcontainer CLI computes", which fails identically on a clean
    checkout of the base commit: the embedded devcontainer CLI exits 1 for any
    `read-configuration` in this container. Not caused by this plan.
- [x] `(cd devc-bridge/host && deno task check && deno task test)` passes
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` and `bash devc-bridge/tests/gh_push_test.sh`
      pass
- [x] `deno fmt --check` passes for every touched file, and `shellcheck` passes for both new
      scripts
- [x] `devc-core/tests/bridge_test.ts`:
  - [x] An existing policy with `gh-push,gh-pr-review,gh-pr-resolve` still has no `policyProblem`.
  - [x] `gh-pr-viewed` alone fails with `gh-pr-viewed requires gh-pr-read`.
  - [x] `gh-pr-review,gh-pr-read` (out of order) fails as non-canonical.
  - [x] The lookup gives `[gh-pr-read, gh-pr-review]` for `gh-pr-comments`, `[gh-pr-read]` for
        `gh-pr-files`, and `[]` for `echo`.
- [x] `capabilities_test.ts`:
  - [x] `gh-pr-comments` runs under a policy with only `gh-pr-read`, and under one with only
        `gh-pr-review`.
  - [x] With only `gh-push`, it is refused with exactly the two-capability message.
  - [x] `gh-pr-viewed` without a policy suggests `gh-pr-read,gh-pr-viewed`.
  - [x] A `commands/gh-pr-comments` file is warned about once.
- [x] `gh_pr_review_test.sh` (stub `gh`):
  - [x] `gh-pr-files`' output matches the contract on a two-page files fixture.
  - [x] A path missing from the GraphQL pages gets `UNVIEWED`, and `changedFiles` 3001 against
        3000 listed gives `truncated:true`.
  - [x] `gh-pr-viewed viewed src/a.ts` sends `markFileAsViewed` with the PR's id and that path,
        and prints `{"path":"src/a.ts","viewed":"VIEWED"}`.
  - [x] `gh-pr-viewed` refuses a path not in the PR (exit 2, no mutation in the stub log), a path
        with a newline, a third argument, and `seen` in place of `viewed`.
  - [x] Both scripts refuse with exit 2 when the policy lacks their grant.
  - [x] All six preludes are identical.
- [x] `args_test.ts`:
  - [x] `--bridge-allow none` → revoke.
  - [x] `none,gh-push` and `none` with `--bridge-repo` give the two refusals.
  - [x] The config validator gives each `<reason>` in the table, accepts `[" gh-pr-read "]`, and
        canonicalizes `["gh-pr-viewed","gh-pr-read","gh-pr-read"]`.
- [x] `devc/tests/bridge_test.ts` (temp home, fake mounts):
  - [x] A default grant writes the policy and logs the `(bridgeDefaultAllow)` lines.
  - [x] With no GitHub origin, it logs `devc: bridgeDefaultAllow: not granted: …`, removes an old
        policy and does not throw.
  - [x] With no Feature, it logs nothing.
  - [x] `refresh` with no policy and a default configured still writes nothing.
- [x] `global_config_test.ts`: a load and save of a file with `bridgeDefaultAllow` keeps it unchanged.
- [ ] By hand, on a host with a throwaway PR:
  - 2026-10-21: not done — needs a real host `gh` login, a real devc-bridge and a throwaway
    PR, none of which this container has. `devc-bridge/docs/testing.md` B23 is the same
    check.
  - [ ] With `"bridgeDefaultAllow": ["gh-pr-read","gh-pr-viewed"]`, `devc up` (no flag) prints the
        grant lines.
  - [ ] In the container, `devc-bridge gh-pr-files` prints the PR's files, and
        `devc-bridge gh-pr-viewed viewed <file>` shows as Viewed on github.com.
  - [ ] `devc up --bridge-allow none` revokes it, and `devc-bridge gh-pr-files` is then refused.
  - [ ] An old devc-bridge (not restarted) refuses the new policy with the "run devc-bridge
        restart" hint, and `devc-bridge restart` fixes it.

## Relevant Files

| File                                          | Change                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `devc-core/bridge.ts`                         | capabilities, command table, requirement, multi-capability lookup     |
| `devc-core/config.ts`                         | `bridgeDefaultAllow` accessor                                         |
| `devc-core/tests/bridge_test.ts`              | capability tests                                                      |
| `devc-core/tests/global_config_test.ts`       | round-trip test                                                       |
| `devc-bridge/host/core.ts`                    | any-capability dispatch, refusal texts, `warnShadowed` dedupe         |
| `devc-bridge/host/config.ts`                  | only if `materializeBuiltins` lists names                             |
| `devc-bridge/host/tests/capabilities_test.ts` | dispatch and refusal tests                                            |
| `devc-bridge/builtin/gh-pr-comments`          | prelude `require_grant CAP…`, either grant, header                    |
| `devc-bridge/builtin/gh-pr-reply`             | prelude                                                               |
| `devc-bridge/builtin/gh-pr-resolve`           | prelude                                                               |
| `devc-bridge/builtin/gh-pr-request-review`    | prelude                                                               |
| `devc-bridge/builtin/gh-pr-files` (new)       | the command                                                           |
| `devc-bridge/builtin/gh-pr-viewed` (new)      | the command                                                           |
| `devc-bridge/client/devc-bridge.ts`           | help lines                                                            |
| `devc-bridge/tests/gh_pr_review_test.sh`      | new-script cases, six-way prelude check                               |
| `devc-bridge/docs/testing.md`                 | the new cases                                                         |
| `devc-bridge/README.md`                       | capabilities, commands, any-capability rule                           |
| `devc/args.ts`                                | `--bridge-allow none`, config validation                              |
| `devc/bridge.ts`                              | default-grant mode                                                    |
| `devc/main.ts`                                | mode table for `up` / `build`                                         |
| `devc/container.ts`                           | no pre-`up` check for a default grant (added during implementation)   |
| `devc/help.ts`                                | `--bridge-allow` text                                                 |
| `devc/tests/args_test.ts`                     | flag and config tests                                                 |
| `devc/tests/bridge_test.ts`                   | default-grant tests                                                   |
| `devc/README.md`                              | `bridgeDefaultAllow`, `none`, the risk note, devc web never writes it |
| `docs/bridge-github.md`                       | capability list, new commands, exit-code wording                      |
| `skills/github-pr-reviewing/SKILL.md`         | grant needed to read vs reply                                         |
| `.plans/design/devc-design.md`                | capability list                                                       |
| `.plans/PLAN.md`                              | Pending entry and Development Phases row                              |
