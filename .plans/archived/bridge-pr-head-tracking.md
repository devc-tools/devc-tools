# Bridge PR lookup follows the branch's tracking config

## Problem

The `gh-pr-*` recipes find "the PR" as the one open PR whose head is
`<origin repo>:<local branch name>`. The pin comes from `remote.origin.url` and
the branch `HEAD` names (`resolvePin`, `devc-core/bridge.ts`). That pin is wrong
in two common cases:

1. **A PR from someone else's fork.** Checking out vbabich's PR
   (`gh pr checkout 2821` in a bmingles fork of deephaven/web-client-ui) gives
   local branch `vlad-DH-24324-queue`, tracking
   `https://github.com/vbabich/web-client-ui.git`. The recipes look for head
   `bmingles/web-client-ui:vlad-DH-24324-queue`, and fail with
   `no open PR with head bmingles/web-client-ui:vlad-DH-24324-queue`. The real
   head is `vbabich/web-client-ui:vlad-DH-24324-queue`.
2. **A local branch named differently from the remote one.** Local `foo`
   tracking `origin/feature-foo`: the recipes search for head `<origin>:foo`.

## Decision

The pin gains an optional **PR head**, `<owner>/<name>:<branch>`, read from the
branch's tracking config in the same frozen repo config `remote.origin.url` comes
from. The `gh-pr-*` recipes try the PR head first, then today's
`<origin repo>:<local branch>`.

**Where `gh-push` and devc web's Push go does not change.** They still push the
local branch to origin under its own name. The PR head only changes which PR the
read/review recipes act on. Pushing to another fork's PR branch is a separate,
later decision. (A branch started with `git checkout -b feat upstream/main`
tracks `upstream/main`; if pushes followed tracking, the pin would point at
upstream's default branch.)

The PR head is skipped when it is the default branch of its repo, so a branch
that merely tracks `upstream/main` falls back to origin as today.

## Contract

### Deriving the PR head (`resolvePin`, devc-core)

Read from the same config text `parseOriginUrl` reads (the frozen `config`,
`opts.configPath` when given), with the same parsing rules and refusals: no
`[include]`/`[includeIf]`, no continued values, section names and keys
case-insensitive, subsections case-sensitive. Only the `[branch "<name>"]` header
form counts. The legacy `[branch.<name>]` form is ignored, like any other
section.

With `<b>` the branch `HEAD` names:

1. `R` = the last `branch.<b>.remote` value; `M` = the last `branch.<b>.merge`
   value (git's last-one-wins for single-valued keys).
2. No PR head when `R` is unset or `.`, or `M` is unset or does not start with
   `refs/heads/` (for example `refs/pull/2821/head`, which `gh pr checkout`
   writes when maintainers cannot push to the PR).
3. The URL: when the config has a `[remote "R"]` section, its `url`. Zero URLs
   there means no PR head; more than one fails the pin with
   `remote.<R>.url is set <n> times`, mirroring origin. With no such section,
   `R` itself when it contains `:` or starts with `/` (`gh pr checkout` writes
   the URL directly); otherwise no PR head.
4. No PR head when `gitHubRepoOf(url)` is null (not a GitHub remote). That is not
   a pin failure.
5. PR head = `` `${gitHubRepoOf(url)}:${M without refs/heads/}` ``.
6. Omitted (no PR head) when it equals `<gitHubRepoOf(origin)>:<b>`, comparing
   the repo case-insensitively and the branch exactly. A plain branch pushed to
   origin under its own name writes no sixth field.

The PR head never makes a pin fail, except for case 3's repeated URL.

### Policy line

```text
<repo>\t<remote>\t<branch>\t<grants>\t<target>[\t<pr-head>]\n
```

- 5 or 6 fields per line; any other count is malformed:
  `line <n>: want 5 or 6 tab-separated fields, found <k>`.
- `<pr-head>` is `<owner>/<name>:<branch>`, owner and name each what bash
  `valid_name` accepts (`[A-Za-z0-9._-]`, not `.` or `..`; TS `validRemoteName`).
  The branch part must pass `fieldProblem` (TS) and
  `git check-ref-format "refs/heads/<branch>"` (bash). Otherwise:
  `line <n>: bad pr-head field`.
- `serializePolicy` writes the sixth field only when the pin has a PR head.
- The `PinnedRepo`/`Pin` type gains `prHead?: string`. `parsePolicy` sets it only
  for 6-field lines.

Version skew: a bridge whose recipes predate this reads a 6-field line as
malformed and grants nothing. devc and devc-bridge ship from this repo, and
recipes materialize on `devc-bridge start`, so the README says to restart the
bridge after upgrading.

### Drift and descriptions (`devc/bridge.ts`)

- `pinDrift` compares `prHead` after `branch`, as
  `{ what: 'PR head', now: derived.prHead ?? 'none', was: stored.prHead ?? 'none' }`.
  Drift revokes as today.
- `describeRepo` appends `(PR head <owner>/<name>:<branch>)` when set:
  `/workspaces/x: vlad-DH-24324-queue → git@github.com:bmingles/web-client-ui.git (/Users/…/x) (PR head vbabich/web-client-ui:vlad-DH-24324-queue)`.
- `sameRepoProblem` is unchanged: it is about push mirrors, keyed on `remote` +
  `branch`.

### Bash `parse_policy` (all ten copies)

The eight `pr-prelude` copies (byte-identical, checked by the harness), plus
`gh-push` and `gh-doctor`, accept 5 or 6 fields with the rules above. A new array
`pol_prhead` holds `''` for a 5-field line. `select_repo` sets `prhead` alongside
`branch`. `gh-push` and `gh-doctor` parse and ignore it.

### `resolve_pr` (pr-prelude)

Candidate heads, in order: `$prhead` when non-empty, then
`<owner>/<name from $remote>:$branch`. For each candidate `<repo>:<hb>`:

1. `gh api repos/<repo> --jq '[.full_name, (.parent.full_name // ""), .default_branch] | @tsv'`,
   validated as today; `default_branch` must pass `git check-ref-format`.
2. Only for the PR-head candidate: skip it when `<hb>` equals `default_branch`.
3. List open PRs with `headRefName: <hb>` in the repo and its parent (the
   existing GraphQL query, with `branch` set to `<hb>`). Keep those whose
   `headRepository.nameWithOwner` equals the full name, case-insensitively.
4. Exactly one PR: use it and stop. More than one: exit 2 with today's
   `more than one open PR with head <full>:<hb>: <urls>`. None: next candidate.

When no candidate matches: exit 2 with
`no open PR with head <full1>:<hb1> or <full2>:<hb2>`. With one candidate (no
PR head, or a skipped one) the message reads as today:
`no open PR with head <full>:<hb>`. A gh failure on any step is exit 4, as
today.

The rest of each recipe acts on the PR found, as today.

## Checklist

- [x] devc-core: `Pin.prHead?`; a config reader for `branch.<b>.remote`/`.merge`
      and `remote.<R>.url`, sharing `parseOriginUrl`'s line and section handling
      (generalize it rather than duplicate it); `resolvePin` derives `prHead` per
      the rules above
- [x] devc-core: `policyProblem` / `parsePolicy` / `serializePolicy` take the
      optional sixth field; doc comments updated
- [x] devc: `pinDrift` and `describeRepo` per the contract; check every
      `PinnedRepo` construction site (`devc/bridge.ts` derive paths,
      `devc/git_push.ts` `pushPin`, which writes none) still type-checks
- [x] devc-bridge: `parse_policy` in the eight `pr-prelude` recipes,
      `gh-push` and `gh-doctor`; `select_repo` sets `prhead`
- [x] devc-bridge: `resolve_pr` candidate loop and messages, in the
      `pr-prelude` (all eight copies identical)
- [x] Tests: devc-core `tests/bridge_test.ts`, devc `tests/bridge_test.ts`,
      `devc-bridge/tests/gh_pr_review_test.sh`, `devc-bridge/tests/gh_push_test.sh`
      (cases under Validation)
- [x] Docs: `devc/README.md` (policy format at "Per-container identity", the pin
      rules near "exactly one `remote.origin.url`", the PR review section's
      "the PR is always that pinned branch's"), `devc-bridge/README.md` (how
      `gh-pr-*` find the PR; restart the bridge after upgrading),
      `.plans/design/devc-design.md` (policy line format)
- [x] `deno fmt` on touched files

## Validation

- [x] devc-core test: a `gh pr checkout`-style config
      (`[branch "vlad-x"] remote = https://github.com/vbabich/r.git`,
      `merge = refs/heads/vlad-x`, origin `git@github.com:bmingles/r.git`)
      → `prHead === 'vbabich/r:vlad-x'`, `remote` still origin's URL
- [x] devc-core test: named remote (`remote = vlad`, `[remote "vlad"] url = …`)
      → PR head from that URL
- [x] devc-core test: local `foo` tracking `origin`, merge `refs/heads/feature-foo`
      → `prHead === 'bmingles/r:feature-foo'`
- [x] devc-core test: no PR head for tracking `origin` under the same name,
      `remote = .`, merge `refs/pull/7/head`, a non-GitHub tracking URL, a
      named remote with no URL, no tracking config
- [x] devc-core test: `[remote "vlad"]` with two URLs fails the pin with
      `remote.vlad.url is set 2 times`
- [x] devc-core test: a policy round-trips with and without the sixth field;
      7 fields, an empty sixth field and `bad:x:` style values are refused with
      the messages above
- [x] devc test: a stored pin whose `prHead` differs from the derived one
      revokes with a `PR head` drift message; `describeRepo` output includes the
      PR head
- [x] gh_pr_review_test: 6-field policy, PR on the PR-head fork with the parent
      as base → found (`gh-pr-files` prints that PR)
- [x] gh_pr_review_test: PR head on its repo's default branch → skipped, origin
      candidate used
- [x] gh_pr_review_test: neither candidate has a PR → exit 2,
      `no open PR with head <a>:<x> or <b>:<y>`; with a 5-field policy the
      message is unchanged (existing check at the `no open PR with head me/r:`
      line still passes)
- [x] gh_pr_review_test: the pr-prelude byte-identical check passes; malformed
      sixth field → exit 2
- [x] gh_push_test: a 6-field policy pushes exactly as the 5-field one did
- [x] `cd devc-core && deno task check && deno task test`
- [x] `cd devc && deno task check && deno task test`
- [x] `cd devc-bridge/host && deno task check && deno task test` (it imports
      `parsePolicy`)
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` (also with `SHIM_JQ=jq`)
      and `bash devc-bridge/tests/gh_push_test.sh`
- [x] `deno fmt --check` and `deno lint` on touched TS files add nothing
- [ ] **Not run** (needs a host with gh and the real PR). Live, on the host: with deephaven/web-client-ui#2821 checked out via
      `gh pr checkout` in a fork, `devc up --bridge-allow gh-pr-read` then
      `devc-bridge gh-pr-files` in the container lists #2821's files, and devc
      web's PR view shows them

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc/git_push.ts` (type-check only; `pushPin` writes no PR head)
- `devc-bridge/host/task_add.ts` (type-check only)
- `devc-bridge/builtin/gh-pr-comments`
- `devc-bridge/builtin/gh-pr-files`
- `devc-bridge/builtin/gh-pr-file-at`
- `devc-bridge/builtin/gh-pr-viewed`
- `devc-bridge/builtin/gh-pr-reply`
- `devc-bridge/builtin/gh-pr-resolve`
- `devc-bridge/builtin/gh-pr-request-review`
- `devc-bridge/builtin/gh-pr-pending-review`
- `devc-bridge/builtin/gh-push`
- `devc-bridge/builtin/gh-doctor`
- `devc-bridge/tests/gh_pr_review_test.sh`
- `devc-bridge/tests/gh_push_test.sh`
- `devc/README.md`
- `devc-bridge/README.md`
- `.plans/design/devc-design.md`
- `.plans/PLAN.md`

## Outcome

Implemented as specified. devc-core bridge tests (incl. new parsePrHead/round-trip cases),
devc bridge tests (81), devc-bridge host tests (51), gh_pr_review_test (638, gojq and jq) and
gh_push_test (332) pass; checks pass. Unrelated failures seen in full runs: devc-core
`default_config_test` and `git_dirs_test` (environment: pinned devcontainer CLI / config
baseline), devc `docker_exec_single_path_test` (a stray `devc-core/dist/` build file). The live
check against deephaven/web-client-ui#2821 was not run. An existing grant on a branch whose
tracking config now yields a PR head is revoked on its next refresh (drift `none` → the head);
`devc up --bridge-allow …` re-grants it.
