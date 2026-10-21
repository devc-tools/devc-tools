# bridge-skip-unpinnable-repos

A `--bridge-allow` grant considers n candidate repos: the workspace repo, then
each `--bridge-repo` in command-line order. Each candidate is checked on its
own. Ones that pass are pinned; ones that fail a per-repo precondition are
skipped with a notice; the grant fails only when **none** pass. Today the
workspace repo is mandatory and any failing repo fails the whole grant, so e.g.
a workspace repo with no `origin` blocks pinning a GitHub `--bridge-repo`
sibling (`devc: --bridge-allow: the repo has no remote.origin.url`).

With no `--bridge-repo`, n = 1 and behaviour (including every message) is
unchanged.

Refresh is **not** changed in spirit: it still never writes the policy and
still revokes the whole policy when any stored line fails or drifted. It only
learns that the workspace line may be absent.

## Decisions

### Three kinds of failure

1. **Container-wide** — fail the grant regardless of n, checked once, before
   any repo, with today's reason texts:
   - `no devc-bridge Feature is declared` (`merged.bridgeKey === null`)
   - `gitProtect is off, so the repo config the pin is read from is not frozen`
   - live table only (not `'skip'`): `no container to verify git protection
     against` (mounts `null`), and the `/run/devc-bridge` token-mount check
     (both of its current messages).

   These move out of `derivePin` into one check that the grant path, the
   pre-`up` path and refresh all run first. Note the order change: today the
   token-mount check runs after the workspace's per-repo checks; now it runs
   before them.
2. **Eligibility of a `--bridge-repo` argument** — what `matchBridgeRepo`
   throws today stays a thrown `BridgeGrantError` that fails the grant, even if
   other repos pass: `no such directory`, `given more than once`, `not a
   git-protected repo mount in this workspace — …`, the workspace repo itself,
   and every `matchWorktree` refusal. These mean the argument does not name a
   pinnable thing; a typo must not be silently dropped. The boundary is the
   function: everything `matchBridgeRepo` throws is an error, everything a
   `derive*Pin` returns as `{ ok: false }` is a skip.
   - The workspace-repo refusal's text changes to
     `--bridge-repo <PATH>: this is the workspace repo, which devc always tries to pin`.
3. **Per-repo preconditions** — every `{ ok: false, reason }` from the
   workspace's per-repo derivation (`no bind-mounted workspace repo …`, a bad
   mount target, `resolvePin` reasons such as `the repo has no
   remote.origin.url` or a detached `HEAD`, `origin … is not a github.com
   remote`, the linked-worktree common-dir message, `git protection is not in
   force …`, the frozen-config re-read) and from `deriveExtraPin` /
   `deriveWorktreePin`. These **skip** the candidate.

### Which pins are written

- Pins are the passing candidates in candidate order: the workspace first when
  it passes, then each passing `--bridge-repo` in order.
- Zero passing → the grant fails; no policy is written and any old one is
  removed (as today).
- `sameRepoProblem` runs over the **passing** pins only and stays a hard error
  (same message as today).
- The `--bridge-repo` cap (15) and `MAX_PINNED_REPOS` (16) are unchanged.

### Messages

Labels: the workspace candidate is `the workspace repo`; a `--bridge-repo`
candidate is its argument as typed.

- **Skip notice** — after `up` only (the `applyPolicy` grant path), one line
  per skipped candidate, via `deps.log`, in candidate order, before the
  `capabilities granted` lines:
  ```
  devc: --bridge-allow: not pinning <label>: <reason>
  ```
  e.g. `devc: --bridge-allow: not pinning the workspace repo: the repo has no remote.origin.url`.
  The grant log that follows is unchanged in format and lists only the pinned
  repos.
- **Pre-`up` check** (`checkGrantBeforeUp`) logs no skip notices: it only fails
  when zero pass (or on a container-wide / eligibility error). The post-`up`
  grant logs the skips once.
- **Zero passing, n = 1** — exactly today's errors:
  `--bridge-allow: <reason>` (pre-`up`) and
  `the container is up, but --bridge-allow was not granted: <reason>`
  (post-`up`).
- **Zero passing, n > 1** — `<reason>` above becomes
  ```
  no repo can be pinned — <label>: <reason>; <label>: <reason>; …
  ```
  every candidate in candidate order, e.g.
  `devc: --bridge-allow: no repo can be pinned — the workspace repo: the repo has no remote.origin.url; ~/x: origin /srv/x.git is not a github.com remote`.

### Refresh

- Run the container-wide check first; a failure revokes with today's revoke
  wording (`devc: devc-bridge capabilities revoked — <reason>. Re-run … once
  that is fixed.`, no repo prefix).
- A stored line is the **workspace line** when `workspaceMountRow(...)` is
  non-null and the line's `target` equals that row's normalized target (no
  extra can share it: `eligibleRows` excludes the workspace target, and a
  worktree inside the workspace mount has a deeper target). It is re-derived
  with the workspace's per-repo derivation. Every other line — including line 1
  when it is not the workspace — goes through the existing extra-line path
  (`eligibleRows` match, else `refreshWorktreeLine`).
- **Gotcha:** today `rows` is computed only when `stored.repos.length > 1`
  (`multi`). It must be computed whenever any stored line is not the workspace
  line — a one-line policy pinning only an extra repo is now possible.
- The regrant hint carries `--bridge-repo …` when the stored policy has any
  non-workspace line (today: when `multi`). The `<repo>:` message prefix stays
  keyed on more than one line.
- Any failing or drifted line still revokes the whole policy. Refresh never adds
  a workspace line that has since become pinnable.

## Checklist

- [x] `devc/bridge.ts`: container-wide check split out of `derivePin` and run
      first by `derivePins`, `checkGrantBeforeUp` (via `derivePins`) and
      `refreshPolicy`
- [x] `devc/bridge.ts`: `derivePins` returns passing pins plus skipped
      `{ label, reason }`; zero-passing errors as specified; `sameRepoProblem`
      over passing pins only
- [x] `devc/bridge.ts`: `applyPolicy` grant path logs the skip notices before
      the grant log; `checkGrantBeforeUp` logs none
- [x] `devc/bridge.ts`: `matchBridgeRepo` workspace-repo refusal text updated
- [x] `devc/bridge.ts`: `refreshPolicy` identifies the workspace line by
      target, computes `rows` when any non-workspace line exists, regrant hint
      rule as specified
- [x] `devc/bridge.ts`: module header and doc comments (`derivePin`,
      `deriveExtraPin`, `derivePins`, `applyPolicy`, `refreshPolicy`) no longer
      say the workspace is always line 1 / all-or-nothing
- [x] `devc-core/bridge.ts`: `MAX_PINNED_REPOS` and `PolicyRecord` comments —
      the workspace repo first _when pinned_; no code change
- [x] `devc/tests/bridge_test.ts`: update existing all-or-nothing tests for
      extra repos to the skip behaviour; add the cases in Validation
- [x] `devc/README.md`: line ~120 summary; "Extra repos are pinned by name"
      section (workspace no longer "always pinned"; the new refusal text);
      replace the **All or nothing** bullet with the skip rule and the three
      failure kinds; the policy-format paragraph ("the workspace repo first" →
      when pinned); the numbered precondition list (3–5 are per pinned repo,
      a failing repo is skipped); refresh paragraph (a policy may lack the
      workspace line)
- [x] `devc-bridge/README.md`: lines ~568, ~589, ~682 — workspace repo pinned
      when it passes the checks, first when present
- [x] `docs/bridge-github.md`: **The pinned repos** bullet — the workspace repo
      when it could be pinned
- [x] `deno fmt` on every touched `.ts` and `.md` file

## Validation

- [x] `cd devc && deno task check && deno task test` passes, including:
  - workspace repo with no `origin`, `--bridge-repo ~/extra` (GitHub, frozen)
    → `checkGrantBeforeUp` resolves; `applyPolicy` writes a one-line policy
    whose only line is `~/extra`'s; logs contain
    `devc: --bridge-allow: not pinning the workspace repo: the repo has no remote.origin.url`
    before `devc: devc-bridge capabilities granted:`
  - workspace repo with a detached `HEAD`, same extra → same shape, notice
    carries the detached-`HEAD` reason
  - workspace passes, `--bridge-repo ~/extra` whose `.git/config` is not
    read-only in the mount table → one-line policy (workspace only); notice
    `devc: --bridge-allow: not pinning ~/extra: git protection is not in force …`
  - workspace passes, two extras, the first with a non-GitHub origin → two-line
    policy: workspace, then the second extra
  - workspace with no `origin` and no `--bridge-repo` → throws with exactly
    `--bridge-allow: the repo has no remote.origin.url` (unchanged); no policy
  - workspace with no `origin`, `--bridge-repo ~/extra` with a non-GitHub
    origin → throws `--bridge-allow: no repo can be pinned — the workspace repo: the repo has no remote.origin.url; ~/extra: origin <url> is not a github.com remote`;
    an earlier policy is removed
  - `--bridge-repo /nope` alongside a passing workspace → still throws
    `--bridge-repo /nope: no such directory`; no policy
  - `--bridge-repo` naming the workspace repo → throws
    `… this is the workspace repo, which devc always tries to pin`
  - no devc-bridge Feature with a passing extra → throws
    `no devc-bridge Feature is declared`
  - wrong `/run/devc-bridge` mount with a workspace lacking `origin` → the
    token-mount message, not the origin one
  - two passing extras on the same GitHub repo and branch, workspace skipped →
    the `both push branch` error
  - refresh of the extra-only one-line policy with nothing changed → file
    content and mtime unchanged, nothing logged
  - refresh of that policy after the extra's `HEAD` changes → policy absent;
    log hint contains `--bridge-repo …`; no `<repo>:` prefix (one line)
  - refresh of the extra-only policy after the workspace gains an `origin` →
    unchanged (refresh does not add the workspace)
- [ ] `cd devc-core && deno task check && deno task test` passes
  - Note (2026-10-19): `deno task check` passes and 435 tests pass; the one failure,
    `cliWorktreeMounts matches what the pinned devcontainer CLI computes`, runs the real
    devcontainer CLI, which exits 1 in this container, and it fails the same way with this
    change stashed.
- [x] `deno fmt --check` passes at the repo root
- [ ] Manual: a workspace repo with no `origin` and a GitHub `devc:source`
      sibling; `devc up --bridge-allow gh --bridge-repo <sibling>` succeeds,
      prints the skip notice, and `devc status` shows one pinned line for the
      sibling; in the container `devc-bridge gh-doctor` lists that one target
      and `gh-push` works without `--repo`

## Relevant Files

- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc-core/bridge.ts` (comments only)
- `devc/README.md`
- `devc-bridge/README.md`
- `docs/bridge-github.md`
