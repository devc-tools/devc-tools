# bridge-per-repo-grants

Per-repo default grants, and the policy format change they need:

- **`"bridgeRepoAllow"`** in `~/.config/devc/config.json` maps a repo, by any host path of one of
  its checkouts, to a grant list. It applies to the repo's primary checkout and every linked
  worktree of it. `[]` means "no default for this repo".
- **Without `--bridge-allow`**, `devc up` / `devc build` grant defaults:
  - the workspace repo and each `--bridge-repo` get their repo's `bridgeRepoAllow` entry, else
    `bridgeDefaultAllow`;
  - every other git-protected repo mounted in the workspace whose repo has a non-empty entry is
    pinned too, with that entry;
  - a bare `--bridge-repo` (no `--bridge-allow`) is now accepted.
- **With `--bridge-allow` (a list or `none`)**, only the flags count: exactly today's
  behavior. Neither default key is read.
- **Grants become per policy line.** The rule that every line holds the same grants goes away.
  The bridge lets a built-in through when any line grants it, and the script then enforces the
  grants of the line `--repo` selected.

Builds on `bridge-read-tier-defaults` (`aecc225`) and `bridge-pr-grant-split` (`2c5f28e`). Read
`devc/bridge.ts` (`applyPolicy`, `derivePins`, `eligibleRows`, `matchBridgeRepo`,
`matchWorktree`, `refreshPolicy`, `bridgeStatusLines`), `devc-core/bridge.ts` (`PolicyRecord`,
`policyProblem`, `parsePolicy`, `serializePolicy`), `devc-core/repo.ts` (`resolveRepo`), the
`pr-prelude` in `devc-bridge/builtin/gh-pr-comments`, `parse_policy` in `gh-push` and
`gh-doctor`, `grantRefusal` in `devc-bridge/host/core.ts`, and `devc/web/pr_review.ts`'s policy
lookup first.

## Decisions

- **Flags given: exactly what you typed. No flags: the defaults.** Mixing them (flags for some
  pins, the map for others) was rejected: it adds a rule to remember and no safety. A flagged
  `up` therefore drops the map repos' grants until the next unflagged `up`, because every `up`
  rewrites the whole policy.
- **An entry ties to the repo, not a worktree.** A grant is a statement about trusting a GitHub
  repo, so a key resolves to its git common dir (`resolveRepo(...).commonDir`, the identity the
  repo overlay uses), and a pin uses its repo's entry when its common dir is the same. Pins stay
  per worktree: each line still pins one checkout's path, branch and container path. There is no
  per-worktree entry. The command line covers that.
- **A pin's common dir comes from what its derivation already trusts.** The workspace and
  extra-repo derivations read git metadata from frozen files, and the worktree derivation checks
  the common dir against frozen data. Use that common dir. Never re-read a container-writable
  `.git` file or `commondir` to pick an entry: an agent could repoint a worktree's `.git` at a
  repo whose entry grants more. A pin kind whose derivation has no trusted common dir uses
  `bridgeDefaultAllow`, never an entry.
- **Auto-pinning covers whole-repo mounts only.** The map adds pins only for `eligibleRows`
  (git-protected `repo` rows), not for every linked worktree in a `<repo>.worktrees` mirror. A
  worktree gets its repo's entry when it is the workspace or named by `--bridge-repo`.
- **The scripts are the binding per-repo check.** They are host-side built-ins the container
  can't change. The host's pre-check stays a coarse first layer: any line granting any of the
  command's capabilities.
- **Old bridges fail closed.** An un-restarted bridge rejects a policy whose lines differ
  (`grants differ from line 1's`) and refuses everything. Its own message already hints at a
  re-grant. The README says to restart the bridge after upgrading.
- **Defaults never fail a start for a repo precondition.** Typos in a `--bridge-repo` still fail,
  exactly as today.

## Contracts

### `bridgeRepoAllow` (`~/.config/devc/config.json`)

```json
{
  "bridgeDefaultAllow": ["gh-pr-read"],
  "bridgeRepoAllow": {
    "~/code/shared-lib": ["gh-pr-read", "gh-pr-reply"],
    "~/code/secrets": []
  }
}
```

- Kept in `GlobalConfig.extra` with an accessor, as `bridgeDefaultAllow` is. The wizard keeps
  it verbatim and gets no UI for it.
- **When it is read:** by `devc up` / `devc build` only, and only without `--bridge-allow`, the
  same condition as `bridgeDefaultAllow`.
- **When it is invalid:** the command exits 2 before starting anything, with
  `devc: ~/.config/devc/config.json: bridgeRepoAllow: <reason>`.

  | Value                                                                   | `<reason>`                                                                                                                |
  | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
  | not a JSON object                                                       | `must be an object mapping repo paths to capability lists`                                                                |
  | a key that isn't absolute after expansion (`~`/`$VAR` via `expandPath`) | `<key>: not an absolute path`                                                                                             |
  | an unset `$VAR`                                                         | `<key>: $<VAR> is not set`                                                                                                |
  | a value that isn't an array of strings                                  | `<key>: must be an array of capability names`                                                                             |
  | a bad capability                                                        | `<key>: <reason>`, with `parseBridgeDefaultAllow`'s reasons (unknown, `gh`/`gh-*`, the `gh-pr-review` rename, `requires`) |
  | two keys resolving to the same common dir                               | `<key1> and <key2> name the same repo`                                                                                    |

  Values are canonicalized as `bridgeDefaultAllow` is. `[]` is valid.
- **When a key can't be resolved** (no such folder, or not in a git repo): one notice per run,
  `devc: bridgeRepoAllow: ignoring <key>: <reason>`, and the entry is ignored. The list is
  global, and a repo may have been moved or deleted.

### Who gets what (`devc up` / `devc build`)

| Flags                                        | Pins and their grants                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--bridge-allow <list>` [+ `--bridge-repo`…] | Today's explicit grant, unchanged. Every pin gets `<list>`. Neither default key is read.                                                                                                                                                                     |
| `--bridge-allow none`                        | Revoke, unchanged.                                                                                                                                                                                                                                           |
| no `--bridge-allow` [+ `--bridge-repo`…]     | **Defaults.** Candidates are the workspace repo, then each `--bridge-repo` in order, then each other `eligibleRows` repo whose entry is non-empty, in `eligibleRows` order. A candidate's grants are its repo's entry, else `bridgeDefaultAllow`, else none. |

In the defaults row:

- **A candidate with no grants** (an `[]` entry, or no entry and no `bridgeDefaultAllow`) is not
  pinned. For the workspace this is silent. For a `--bridge-repo`, it logs
  `devc: not pinning <arg>: no default grants for it — pass --bridge-allow`.
- **A bare `--bridge-repo` with neither key configured** is refused before anything starts:
  `--bridge-repo requires --bridge-allow, "bridgeDefaultAllow" or "bridgeRepoAllow"`. This
  replaces today's `--bridge-repo requires --bridge-allow` for that case. The
  `--bridge-allow none` + `--bridge-repo` refusal is unchanged.
- **`--bridge-repo` eligibility** works as for an explicit grant. A typo, the workspace repo
  itself, or anything `matchBridgeRepo` throws fails the command, and the check before `up` runs
  whenever a `--bridge-repo` is given.
- **Per-repo preconditions** (no GitHub origin, detached `HEAD`, protection not in force) skip
  the candidate with `devc: defaults: not pinning <label>: <reason>`.
- **The cap:** candidates past 16 pins are skipped with
  `devc: defaults: not pinning <label>: a policy pins at most 16 repos`.
- **`sameRepoProblem`** runs over the passing pins. With a `--bridge-repo` given, it fails the
  command, as today. Without, it logs `devc: defaults: not granted: <reason>` and succeeds.
- **Container-wide failures** (no Feature: silent, as today; gitProtect off; the token mount):
  as `bridge-read-tier-defaults`, logged with the `devc: defaults: not granted: …` prefix.
- **No pins at all:** any old policy is removed, and nothing else is logged unless something
  above was.
- **The grant log**, after skip notices:
  ```
  devc: devc-bridge capabilities granted (defaults):
  devc:   <target>: <branch> → <remote> (<repo>): <grants>
  ```
  One indented line per pin. `<grants>` is comma-separated. This replaces
  `bridge-read-tier-defaults`' `(bridgeDefaultAllow)` header, and its `bridgeDefaultAllow:` notice
  prefixes become `defaults:`. The explicit-grant log is unchanged.

### Policy format

- Lines keep the five tab-separated fields. Each line's grants are validated on their own:
  non-empty, canonical order, known names (with the rename reason), and requirements met.
- The cross-line `grants differ from line 1's` rule is removed from `policyProblem`, the six
  `pr-prelude` copies, and `gh-push`'s and `gh-doctor`'s `parse_policy`. `repo` and `target`
  must still each be distinct.
- `PolicyRecord` carries grants per pinned repo, for example `repos: (PinnedRepo & {grants})[]`.
  The exact shape is internal. `serializePolicy` writes each line's own grants. An explicit grant
  writes the same list on every line, which is byte-identical to today's files.

### Enforcement

- **Host (`grantRefusal`):**
  - A built-in runs when any line grants any of its capabilities.
  - The refusal's `(it has: …)` lists the union of all lines' grants in canonical order.
  - The suggestion is built from that union, as today.
- **Scripts:**
  - `parse_policy` keeps each line's grants (for example a `pol_grants` array).
  - Selecting a repo (`select_repo` in the prelude, and the selection in `gh-push` / `gh-doctor`)
    sets `grants` from the selected line.
  - `require_grant` checks the selected line. Its refusal adds `for <target>` when the policy has
    more than one line: `this container was not granted <CAP1> or <CAP2> for <target>`. A
    one-line policy keeps today's text exactly.
  - `gh-doctor`'s per-target report shows each target's grants.
  - `gh-pr-resolve`'s any/Copilot scope is read from the selected line's grants.
- **devc web (`pr_review.ts`):** the lookup uses the matched line's grants. So do `gh-pr-read` as
  the gate, `canReply`, `resolveScope` and `canViewed`, and the write checks.

### `devc status` and refresh

- **`devc status`:** the bridge section prints each pinned repo as
  `<target>: <branch> → <remote> (<repo>): <grants>` and drops the single grants line. When every
  line has the same grants, it keeps today's grants line and today's repo lines.
- **Refresh:** unchanged in behavior. Its regrant hint is today's
  `devc up --bridge-allow <grants> [--bridge-repo …]` when every line has the same grants, and
  plain `devc up` (which re-applies the defaults) when they differ.

## Checklist

- [x] `devc-core/bridge.ts`: per-line grants in `PolicyRecord`, `policyProblem`, `parsePolicy`,
      `serializePolicy`, and comments
- [x] `devc-core/config.ts`: the `bridgeRepoAllow` accessor (raw from `extra`)
- [x] `devc/args.ts`: validate `bridgeRepoAllow`; accept a bare `--bridge-repo` and give the new
      refusal; reuse `parseBridgeDefaultAllow`'s per-capability reasons
- [x] `devc/bridge.ts`: key resolution to common dirs (with the ignore notice), the
      trusted-common-dir lookup per pin kind, candidates and grants for defaults, auto-pinning
      map repos, skip and cap notices, the new grant log, per-line `refreshPolicy` and its hint,
      and `bridgeStatusLines`
- [x] `devc/container.ts` / `devc/main.ts`: the defaults mode now carries `--bridge-repo`s and the
      map. The pre-`up` check runs when a `--bridge-repo` is given
- [x] `devc-bridge/host/core.ts`: union-of-lines check and refusal text
- [x] The six `pr-prelude` copies (byte-identical): per-line grants, the selected line's
      `require_grant`, and `for <target>` on multi-line refusals
- [x] `devc-bridge/builtin/gh-push`, `gh-doctor`: their `parse_policy` and selection, and
      `gh-doctor`'s per-target grants
- [x] `devc-bridge/builtin/gh-pr-resolve`: the scope from the selected line
- [x] `devc/web/pr_review.ts`: the matched line's grants
- [x] `devc/help.ts`: `--bridge-repo` without `--bridge-allow`, and `bridgeRepoAllow`
- [x] Tests: `devc-core/tests/bridge_test.ts`, `devc-core/tests/global_config_test.ts`,
      `devc/tests/args_test.ts`, `devc/tests/bridge_test.ts`,
      `devc-bridge/host/tests/capabilities_test.ts`, `devc-bridge/tests/gh_pr_review_test.sh`,
      `devc-bridge/tests/gh_push_test.sh`, `devc/tests/web_pr_review_test.ts`
- [x] Docs:
  - [x] `devc/README.md`: `bridgeRepoAllow`, the flags-vs-defaults rule, bare `--bridge-repo`,
        and the per-repo `devc status` lines. Note that nothing checks who wrote a
        `--bridge-repo`'s `.git/config`: a repo the agent created and got mounted carries a remote
        it chose;
  - [x] `devc-bridge/README.md`: per-line grants, the two-layer check, and restart after upgrade;
  - [x] `docs/bridge-github.md`: per-repo grants and `gh-doctor`'s output;
  - [x] `devc-bridge/docs/testing.md`: the new cases and a manual row;
  - [x] `.plans/design/devc-design.md`: the policy format

## Validation

- [x] `(cd devc && deno task check && deno task test)` passes
- [x] `(cd devc-core && deno task check && deno task test)` passes, apart from the known
      `cliWorktreeMounts` failure
- [x] `(cd devc-bridge/host && deno task check && deno task test)` passes
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` and `bash devc-bridge/tests/gh_push_test.sh`
      pass
- [x] `deno fmt --check` on every touched file, and `shellcheck` on every touched script
- [x] `devc-core/tests/bridge_test.ts`:
  - [x] A two-line policy with different valid grants parses, and `serializePolicy` round-trips
        it.
  - [x] A line with `gh-pr-reply` alone fails `line 2: gh-pr-reply requires gh-pr-read`.
  - [x] An explicit-grant record serializes byte-identical to `aecc225`'s format.
- [x] `global_config_test.ts`: `bridgeRepoAllow` survives a load and save unchanged.
- [x] `args_test.ts`:
  - [x] Each `<reason>` in the table.
  - [x] `[]` accepted, and a value canonicalized.
  - [x] A bare `--bridge-repo` is accepted with either key set, and refused with the new text
        with neither.
  - [x] `--bridge-allow none --bridge-repo x` is still refused.
- [x] `devc/tests/bridge_test.ts` (temp home with real repos, linked worktrees and fake mounts):
  - [x] Workspace with an entry → the entry's grants. Without one → `bridgeDefaultAllow`.
  - [x] A `--bridge-repo` worktree of a mapped repo → the entry's grants. A `[]` entry → the
        `no default grants` notice and no line.
  - [x] An unnamed mounted repo with a non-empty entry → auto-pinned. With `[]`, or with no entry
        → not pinned.
  - [x] A worktree whose `.git` file is rewritten to point at a mapped repo, without the frozen
        data agreeing, → not given that entry.
  - [x] Two keys naming one repo → the config error. A key for a deleted folder → the ignore
        notice.
  - [x] `--bridge-allow gh-push` with a map → every pin `gh-push`, and no map repo pinned.
  - [x] 17 candidates → the cap notice for the 17th.
  - [x] Refresh of a mixed policy re-derives every line, and its hint is `devc up`.
  - [x] `bridgeStatusLines` per-repo lines for mixed grants, and today's lines for uniform ones.
  - [x] The grant log matches the contract.
- [x] `capabilities_test.ts`:
  - [x] A policy whose line 1 grants `gh-push` and line 2 `gh-pr-read` runs `gh-pr-comments`.
  - [x] With no line granting it, `gh-pr-comments` is refused, and `(it has: …)` is the union.
- [x] `gh_pr_review_test.sh`, `gh_push_test.sh` (stub `gh`):
  - [x] With line 1 `gh-push` and line 2 `gh-pr-read,gh-pr-reply`:
    - [x] `gh-pr-reply --repo <line 1 target>` exits 2 with `… not granted gh-pr-reply for <target>`;
    - [x] `--repo <line 2 target>` replies;
    - [x] `gh-push` from line 2's target is refused, and from line 1's it pushes.
  - [x] `gh-pr-resolve`'s scope follows the selected line.
  - [x] `gh-doctor` shows each target's grants.
  - [x] One-line policies keep every existing message byte for byte (the existing cases pass
        unchanged).
  - [x] The six preludes are identical.
- [x] `web_pr_review_test.ts`: with line 1 `gh-pr-read,gh-pr-reply` and line 2 `gh-pr-read`,
      `canReply` is true for line 1's repo, false for line 2's, and `pr_reply` on line 2's repo
      is refused.
- [ ] By hand, on a host (add as a `testing.md` row): _2026-10-21: not run — needs a macOS host
      with Docker and a GitHub PR; added as `devc-bridge/docs/testing.md` row B26._
  - [ ] With `"bridgeDefaultAllow": ["gh-pr-read"]` and
        `"bridgeRepoAllow": {"<sibling>": ["gh-pr-read","gh-pr-reply"]}` in a workspace mounting
        that sibling, `devc up` prints both pins with their grants.
  - [ ] In the container, `devc-bridge gh-pr-reply --repo <workspace target> …` is refused and
        `--repo <sibling target>` works.
  - [ ] `devc status` shows both lines.
  - [ ] `devc up --bridge-allow gh-pr-read` leaves only the workspace pin.

## Notes

Implementation decisions where the plan left room (2026-10-21):

- **The trusted common dir, per pin kind.** Every kind already reads its remote from the host
  source of the live container's read-only `config` mount (Docker's mount table, fixed at create
  time; the container cannot change it), so the pin's repo is `realpath(dirname(<that source>))`
  for all three: the workspace repo (`<root>/.git/config`, or for a worktree workspace the CLI's
  common-dir mount), an extra repo row (`<target>/.git/config`), and a linked worktree
  (`<gitDir>/config` of the protected row `matchWorktree` matched). No `.git` file or `commondir`
  is re-read for it. When that source no longer resolves, the pin takes `bridgeDefaultAllow`
  (an auto-pinned map repo is then not pinned). Before `up` no grant is computed at all.
- **Whether to try a candidate** is decided first from its host git dir (the workspace mount's
  `resolveRepo`, an eligible row's `<source>/.git`), so a repo with nothing to grant costs no
  skip notice; the grants themselves only ever come from the frozen identity above. An auto-pin
  candidate whose frozen identity has no non-empty entry is silently not pinned.
- **Mixed `devc status`:** a bare `bridge:` header line, then each repo line ending
  `: <grants>`. `<grants>` in the defaults log and status is joined with `,`, as the existing
  grants lines are.
- **A same-repo clash in the defaults with a `--bridge-repo`** throws
  `the container is up, but the defaults were not granted: <reason>` (the plan gives no text).
- **"Either key set"** for a bare `--bridge-repo`: `bridgeDefaultAllow` non-empty, or a
  `bridgeRepoAllow` with at least one key (even if every value is `[]`). With neither, a flagless
  `up` without `--bridge-repo` revokes as before. `"bridgeRepoAllow": null` counts as absent, as
  `null` does for `bridgeDefaultAllow`.
- **Ignore reasons** for an unresolvable key: `no such folder`, `not in a git repo`, or
  `resolveRepo`'s metadata error.
- **The defaults' pre-`up` check** only checks `--bridge-repo` eligibility, and is skipped when a
  container-wide problem stands (no Feature, `gitProtect` off) — that is logged after `up`.
- **`gh-doctor`** takes no `--repo`, so through the bridge it refuses only when no line grants
  `gh-push`, and reports each target with its own line's grants. **`gh-push`** now checks the
  grant after `select_repo`; one-line policies keep every message.
- **Shellcheck:** the two harnesses had eight pre-existing findings (SC2016 on intentional
  single-quoted `bash -c`, SC2034, SC2086); fixed so `shellcheck` on every touched script is clean.

## Relevant Files

| File                                          | Change                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `devc-core/bridge.ts`                         | per-line grants in the policy model, parser, serializer                |
| `devc-core/config.ts`                         | `bridgeRepoAllow` accessor                                             |
| `devc-core/tests/bridge_test.ts`              | policy tests                                                           |
| `devc-core/tests/global_config_test.ts`       | round-trip test                                                        |
| `devc/args.ts`                                | `bridgeRepoAllow` validation, bare `--bridge-repo`                     |
| `devc/bridge.ts`                              | defaults candidates and grants, map, logs, refresh, status             |
| `devc/container.ts`                           | defaults mode with repos, pre-`up` check                               |
| `devc/main.ts`                                | mode resolution for `up` / `build`                                     |
| `devc/help.ts`                                | `--bridge-repo`, `bridgeRepoAllow`                                     |
| `devc/tests/args_test.ts`                     | config and flag tests                                                  |
| `devc/tests/bridge_test.ts`                   | defaults, map, worktree trust, cap, refresh, status tests              |
| `devc/web/pr_review.ts`                       | matched line's grants                                                  |
| `devc/tests/web_pr_review_test.ts`            | per-repo offers                                                        |
| `devc-bridge/host/core.ts`                    | union-of-lines check, refusal text                                     |
| `devc-bridge/host/tests/capabilities_test.ts` | per-line tests                                                         |
| `devc-bridge/builtin/gh-pr-comments`          | prelude                                                                |
| `devc-bridge/builtin/gh-pr-files`             | prelude                                                                |
| `devc-bridge/builtin/gh-pr-viewed`            | prelude                                                                |
| `devc-bridge/builtin/gh-pr-reply`             | prelude                                                                |
| `devc-bridge/builtin/gh-pr-resolve`           | prelude, scope from the selected line                                  |
| `devc-bridge/builtin/gh-pr-request-review`    | prelude                                                                |
| `devc-bridge/builtin/gh-push`                 | `parse_policy`, selection                                              |
| `devc-bridge/builtin/gh-doctor`               | `parse_policy`, per-target grants                                      |
| `devc-bridge/tests/gh_pr_review_test.sh`      | per-line cases                                                         |
| `devc-bridge/tests/gh_push_test.sh`           | per-line cases                                                         |
| `devc-bridge/docs/testing.md`                 | new cases, manual row                                                  |
| `devc-bridge/README.md`                       | per-line grants, two-layer check, restart note                         |
| `devc/README.md`                              | `bridgeRepoAllow`, flags-vs-defaults, status lines, `.git/config` note |
| `docs/bridge-github.md`                       | per-repo grants, `gh-doctor` output                                    |
| `.plans/design/devc-design.md`                | policy format                                                          |
| `.plans/PLAN.md`                              | Pending entry and Development Phases row                               |
