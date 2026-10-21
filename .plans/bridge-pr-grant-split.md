# bridge-pr-grant-split

The PR capabilities split cleanly into one read grant and separate write grants. Copilot-only
becomes its own narrower write grant, and resolved / unresolved becomes a filter on the read,
not a permission:

| Kind  | Capability                         | Commands                                               | Requires     |
| ----- | ---------------------------------- | ------------------------------------------------------ | ------------ |
| write | `gh-push`                          | `gh-push`, `gh-doctor`                                 | —            |
| read  | `gh-pr-read`                       | `gh-pr-comments`, `gh-pr-files`                        | —            |
| write | `gh-pr-reply` (was `gh-pr-review`) | `gh-pr-reply`                                          | `gh-pr-read` |
| write | `gh-pr-viewed`                     | `gh-pr-viewed`                                         | `gh-pr-read` |
| write | `gh-pr-resolve`                    | `gh-pr-resolve`, **any** thread                        | `gh-pr-read` |
| write | `gh-pr-resolve-copilot` (new)      | `gh-pr-resolve`, Copilot's threads only (today's rule) | `gh-pr-read` |
| write | `gh-pr-request-review`             | `gh-pr-request-review`                                 | `gh-pr-read` |

`gh-pr-comments` lists **all** review threads by default, takes
`--state unresolved|resolved|all`, and reports `isResolved` on each thread.

Builds on `bridge-read-tier-defaults` (`aecc225`). Read `devc-core/bridge.ts`'s capability
section, `devc-bridge/host/core.ts`'s `grantRefusal`, and `devc-bridge/builtin/gh-pr-resolve`
and `gh-pr-comments` first.

## Decisions

- **Old policies fail closed; they never widen.** A policy written today with `gh-pr-resolve`
  means Copilot-only. Under this plan the same name means any thread. Every PR write grant now
  requires `gh-pr-read`, and `gh-pr-review` no longer exists. Every policy written before this
  change that holds a PR grant is therefore rejected by `policyProblem`: the bridge refuses every
  built-in for it, and devc's refresh removes it with the regrant hint. No old policy can resolve
  a human reviewer's thread without a new `devc up`. A policy with only `gh-push` is unaffected.
  The same holds for a `bridgeDefaultAllow` written for the old names: it fails validation and
  `devc up` exits 2, so a default can't widen either.
- **`gh-pr-review` is renamed, not kept as an alias.** An alias would keep the read+write
  bundle the split removes. The old name gets a specific message wherever it is refused (below)
  instead of the generic `unknown capability`.
- **Both resolve grants enable the one `gh-pr-resolve` command**, through the any-capability rule
  `aecc225` added. The script decides the scope: with `gh-pr-resolve` granted, any thread on the
  PR; with only `gh-pr-resolve-copilot`, Copilot's threads, and others exit 3 as today. Holding
  both is valid (it is what `--bridge-allow gh` expands to) and means any thread.
- **`--state` is a filter, not a grant.** Everything `gh-pr-read` can see is the pinned PR's
  threads. Which subset is shown is the caller's choice.
- **The default is `all`.** That changes `gh-pr-comments`' default output, so the review-loop
  skill, which treats "no threads listed" as clean, must pass `--state unresolved`.

## Contracts

### Capabilities (`devc-core/bridge.ts`)

- `BRIDGE_CAPABILITIES`, canonical order:
  `gh-push, gh-pr-read, gh-pr-reply, gh-pr-viewed, gh-pr-resolve, gh-pr-resolve-copilot, gh-pr-request-review`.
- The commands and requirements are exactly the table above. `gh-pr-comments` is `gh-pr-read`'s
  only. Update the doc comment that explains why it was under two.
- **The renamed name:** wherever a capability name is checked and `gh-pr-review` is found, the
  reason is `gh-pr-review was split — grant gh-pr-read,gh-pr-reply instead` in place of
  `unknown capability …`. That covers:
  - `policyProblem` / `grantsProblem`, as `line <n>: gh-pr-review was split — …`;
  - `parseBridgeAllow` (`--bridge-allow gh-pr-review`);
  - `parseBridgeDefaultAllow` (`bridgeDefaultAllow` containing it).
- **The host's malformed-policy hint** (`grantRefusal`): when the problem is that rename, the fix
  text is `re-run devc up --bridge-allow <every capability this container needs> (gh-pr-review is now gh-pr-read,gh-pr-reply; gh-pr-resolve now resolves any thread, gh-pr-resolve-copilot only Copilot's)`,
  not the "devc is newer than the running bridge" hint.
- **A policy without the rename but missing `gh-pr-read`** (for example `gh-push,gh-pr-resolve`
  from the old era) fails as `gh-pr-resolve requires gh-pr-read`. The host's fix text for any
  `requires gh-pr-read` problem is the same long text as for the rename.

### `devc-bridge gh-pr-comments [--repo <path>] [--state unresolved|resolved|all]`

- Grant: `require_grant gh-pr-read`. The script's `grant_hint` is `gh-pr-read`.
- Arguments: after the prelude's `--repo`, nothing, or exactly `--state <value>` with `<value>`
  one of `unresolved`, `resolved`, `all`. Anything else (including `--state=x`) → exit 2 with
  `usage: gh-pr-comments [--repo <path>] [--state unresolved|resolved|all]`.
- Default `all`. The thread query is unchanged. The jq filter keeps threads by `isResolved`
  per `--state` instead of always `select(.isResolved | not)`.
- Each thread object gains `isResolved` (boolean), after `line`:
  `{"id","path","line","isResolved","isOutdated","copilot","comments":[…]}`. Everything else in
  the output is unchanged, including `copilotReview` and `pending`.

### `devc-bridge gh-pr-resolve [--repo <path>] <thread-id>`

- Grant: `require_grant gh-pr-resolve gh-pr-resolve-copilot`. `grant_hint` is
  `gh-pr-read,gh-pr-resolve`.
- After `load_thread`: when the policy's grants include `gh-pr-resolve`, any thread on the PR is
  resolved. Otherwise (only `gh-pr-resolve-copilot`) a thread Copilot didn't start exits 3:
  `refused: thread <id> was not started by Copilot — this container has gh-pr-resolve-copilot, which resolves only Copilot's threads; reply instead`.
- An already-resolved thread: exit 0, unchanged.
- Header comment: the two scopes, and why Copilot-only exists (an agent loop that must not hide
  human review).

### Other scripts

- `gh-pr-reply`: `require_grant gh-pr-reply`. `grant_hint` is `gh-pr-read,gh-pr-reply`.
- `gh-pr-request-review`: its requirement moves to `gh-pr-read`. `grant_hint` is
  `gh-pr-read,gh-pr-request-review`.
- `gh-pr-files` and `gh-pr-viewed`: unchanged.
- The six preludes stay byte-identical. Only per-script lines change.

## Checklist

- [ ] `devc-core/bridge.ts`: the capability list, commands, requirements, the rename reason in
      `grantsProblem`/`policyProblem`, and comments
- [ ] `devc-bridge/host/core.ts`: the fix texts for the rename and for `requires gh-pr-read`
- [ ] `devc/args.ts`: the rename reason in `parseBridgeAllow` and `parseBridgeDefaultAllow`
- [ ] `devc/bridge.ts`: check the refresh's malformed-policy message reads well with the new
      reason. Change it only if needed
- [ ] `devc-bridge/builtin/gh-pr-comments`: `--state`, `isResolved`, the grant, usage, header
- [ ] `devc-bridge/builtin/gh-pr-resolve`: the two scopes, the grant, the exit-3 text, header
- [ ] `devc-bridge/builtin/gh-pr-reply`, `gh-pr-request-review`: grant and `grant_hint`
- [ ] `devc-bridge/client/devc-bridge.ts`: help lines with the new grants and `--state`
- [ ] `devc/help.ts`: the capability list
- [ ] `skills/github-pr-reviewing/SKILL.md`:
  - [ ] the grants are `gh-push,gh-pr-read,gh-pr-reply,gh-pr-resolve-copilot,gh-pr-request-review`;
  - [ ] every `gh-pr-comments` call passes `--state unresolved`;
  - [ ] resolving stays Copilot-only by the skill's own rule, even when the container holds
        `gh-pr-resolve`;
  - [ ] the keywords line is updated
- [ ] Tests: `devc-core/tests/bridge_test.ts`, `devc-bridge/host/tests/capabilities_test.ts`,
      `devc-bridge/tests/gh_pr_review_test.sh`, `devc/tests/args_test.ts`,
      `devc/tests/bridge_test.ts`
- [ ] Docs:
  - [ ] `devc-bridge/README.md`: the capability table, the any-capability note, and a
        **Migrating** note: re-grant, with the old → new mapping;
  - [ ] `docs/bridge-github.md`: grants, `--state`, `isResolved`, the resolve scopes, and the
        exit-code rows;
  - [ ] `devc/README.md`: the `--bridge-allow` list and `bridgeDefaultAllow` examples;
  - [ ] `devc-bridge/docs/testing.md`: the new cases, and B23's grant list;
  - [ ] `.plans/design/devc-design.md`: the capability list

## Validation

- [ ] `(cd devc && deno task check && deno task test)` passes
- [ ] `(cd devc-core && deno task check && deno task test)` passes, apart from the known
      `cliWorktreeMounts` failure (the embedded devcontainer CLI exits 1 in this container; it
      fails the same way on `aecc225`)
- [ ] `(cd devc-bridge/host && deno task check && deno task test)` passes
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` and `bash devc-bridge/tests/gh_push_test.sh`
      pass
- [ ] `deno fmt --check` on every touched file, and `shellcheck` on every touched script
- [ ] `devc-core/tests/bridge_test.ts`:
  - [ ] `gh-pr-read,gh-pr-reply,gh-pr-resolve,gh-pr-resolve-copilot` is valid.
  - [ ] `gh-pr-reply` alone fails `requires gh-pr-read`, and so does `gh-push,gh-pr-resolve`.
  - [ ] A policy line with `gh-pr-review` fails with the rename reason.
  - [ ] `gh-pr-comments` → `[gh-pr-read]`, and `gh-pr-resolve` →
        `[gh-pr-resolve, gh-pr-resolve-copilot]`.
- [ ] `capabilities_test.ts`:
  - [ ] An old-era policy (`gh-push,gh-pr-review,gh-pr-resolve`) refuses `gh-pr-comments` with
        exit 2 and the migration fix text.
  - [ ] `gh-pr-read,gh-pr-resolve-copilot` runs `gh-pr-resolve`.
  - [ ] `gh-pr-read` alone refuses `gh-pr-reply`, suggesting `gh-pr-read,gh-pr-reply`.
- [ ] `gh_pr_review_test.sh` (stub `gh`):
  - [ ] `gh-pr-comments` with no flag lists a resolved and an unresolved fixture thread, each
        with the right `isResolved`.
  - [ ] `--state unresolved` and `--state resolved` each keep one.
  - [ ] `--state bogus`, `--state` with no value, and `--state=all` exit 2 with the usage.
  - [ ] `gh-pr-resolve` on a human's thread: with `gh-pr-resolve-copilot` only → exit 3, the
        exact text, and no mutation in the stub log. With `gh-pr-resolve` → the mutation is sent.
        With both → sent.
  - [ ] The six preludes are identical.
- [ ] `args_test.ts`: `--bridge-allow gh-pr-review` and `bridgeDefaultAllow: ["gh-pr-review"]`
      give the rename reason. `--bridge-allow gh` gives all seven.
- [ ] `devc/tests/bridge_test.ts`: refresh of an old-era policy removes it, and the log names the
      rename.
- [ ] By hand, on a host with a throwaway PR that has a human reviewer's thread (as
      `testing.md` B23), with
      `devc up --bridge-allow gh-pr-read,gh-pr-reply,gh-pr-resolve-copilot`:
  - [ ] `gh-pr-comments --state unresolved` lists it.
  - [ ] `gh-pr-resolve` on it exits 3.
  - [ ] After `devc up --bridge-allow gh-pr-read,gh-pr-resolve` it resolves, and
        `gh-pr-comments --state resolved` lists it.

## Relevant Files

| File                                          | Change                                              |
| --------------------------------------------- | --------------------------------------------------- |
| `devc-core/bridge.ts`                         | capabilities, commands, requirements, rename reason |
| `devc-core/tests/bridge_test.ts`              | capability tests                                    |
| `devc-bridge/host/core.ts`                    | migration fix texts                                 |
| `devc-bridge/host/tests/capabilities_test.ts` | refusal tests                                       |
| `devc-bridge/builtin/gh-pr-comments`          | `--state`, `isResolved`, grant                      |
| `devc-bridge/builtin/gh-pr-resolve`           | two scopes, grant, exit-3 text                      |
| `devc-bridge/builtin/gh-pr-reply`             | grant, hint                                         |
| `devc-bridge/builtin/gh-pr-request-review`    | grant, hint                                         |
| `devc-bridge/client/devc-bridge.ts`           | help lines                                          |
| `devc-bridge/tests/gh_pr_review_test.sh`      | new cases                                           |
| `devc-bridge/docs/testing.md`                 | new cases, B23 grants                               |
| `devc-bridge/README.md`                       | capability table, migration note                    |
| `devc/args.ts`                                | rename reason                                       |
| `devc/bridge.ts`                              | refresh message, only if needed                     |
| `devc/help.ts`                                | capability list                                     |
| `devc/tests/args_test.ts`                     | rename and expansion tests                          |
| `devc/tests/bridge_test.ts`                   | old-era refresh test                                |
| `devc/README.md`                              | grant lists                                         |
| `docs/bridge-github.md`                       | grants, `--state`, resolve scopes, exit codes       |
| `skills/github-pr-reviewing/SKILL.md`         | grants, `--state unresolved`, keywords              |
| `.plans/design/devc-design.md`                | capability list                                     |
| `.plans/PLAN.md`                              | Pending entry and Development Phases row            |
