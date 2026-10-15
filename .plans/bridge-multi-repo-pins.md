# bridge-multi-repo-pins

Let one container's devc-bridge grant cover more than the primary workspace
repo. The user names each extra repo explicitly, by host path, on the same
`devc up`/`devc build` that carries `--bridge-allow`. devc never pins a mounted
repo it was not told to. A multi-repo workspace (e.g. `devc-dev` with its
`devc:source` sibling mounts) can then push and run the PR loop on each named
repo.

**Depends on [bridge-pin-hardening](bridge-pin-hardening.md)** — it must be
complete first. This plan assumes its two behaviours and applies them per pinned
repo: `gh-push` refuses the remote's default branch, and refresh revokes instead
of rewriting a changed pin.

## What already works

- Git protection (`classifyGitRows`, `devc-core/overlay.ts`) already derives
  read-only `.git/config` + `.git/hooks` mounts for every bind-mounted repo row,
  not just the workspace. Extra repos need no new protection work.
- `gitProtectState(row, mounts)` and `resolvePin(source, { configPath })` work
  per row. Today only `derivePin` (`devc/bridge.ts`) restricts them to
  `workspaceMountRow`.

## Decisions

### The flag: `--bridge-repo PATH`

- Accepted by `devc up` and `devc build` only. Repeatable, one path per
  occurrence. Both spellings: `--bridge-repo PATH` and `--bridge-repo=PATH`.
- **Gotcha:** `parseUpArgs`/`parseBuildArgs` take the target as
  `rest.find((a) => !a.startsWith('--'))`. The space form must consume the next
  argument as its value (as `takeBridgeAllow` does), or `PATH` becomes the
  project target.
- `--bridge-repo` without `--bridge-allow` → usage error, exit 2:
  `devc: --bridge-repo requires --bridge-allow`.
- `attach`, `claude`, `copilot`, `pi`, `herdr` and `exec` refuse it exactly as
  they refuse `--bridge-allow` (exit 2,
  `` devc: --bridge-repo is accepted by `devc up` and `devc build` only, not `devc <command>` ``),
  via `refuseBridgeAllow` or a sibling.
- A **flag, not a config key**, for the same reason as `--bridge-allow`: every
  config layer that could set it is agent-writable.
- `PATH` is a **host path** (the user is on the host; it matches what they
  wrote in `devc:source`). Resolution, in order:
  1. A leading `~` or `~/` expands to `$HOME` via `unfoldHome`
     (`devc-core/mounts.ts`). **Gotcha:** the shell does not do this for
     `--bridge-repo=~/x` (bash and zsh only tilde-expand after `=` in real
     variable assignments) or for a quoted `"~/x"`, so devc must. `~user` is
     not expanded.
  2. A relative path resolves against the cwd.
  3. `Deno.realPath`. A path that does not exist is a `BridgeGrantError`:
     `--bridge-repo <PATH>: no such directory`, where `<PATH>` is the argument
     as typed.
- Matching: `realPath(PATH)` must equal `realPath(unfoldHome(row.source))` for a
  row in `classifyGitRows(merged.config, localFolder).protectedRows` with
  `kind === 'repo'`, excluding the workspace row. Otherwise it is a
  `BridgeGrantError`, checked in this order:
  1. It is the primary workspace repo →
     `--bridge-repo <PATH>: this is the workspace repo, which is always pinned`.
  2. It is a linked worktree (`<PATH>/.git` is a file) →
     `--bridge-repo <PATH>: a linked worktree mounted as an extra folder is not git-protected, so it cannot be pinned`.
  3. Otherwise →
     `--bridge-repo <PATH>: not a git-protected repo mount in this workspace — pinnable: <comma-separated host sources of the eligible rows, ~-folded>`
     (or `— no extra repo mounts are git-protected` when there are none).
- The same path given twice (after `realPath`) → usage error, exit 2:
  `devc: --bridge-repo <PATH> given more than once`.
- At most 15 `--bridge-repo` (16 pinned repos with the workspace) → usage error,
  exit 2.

### Which repos are pinned

The workspace repo, always (derived exactly as today, including linked-worktree
handling), then each `--bridge-repo` in command-line order. Each extra repo
passes the same per-repo checks as the workspace repo: `HEAD` names a branch,
exactly one `remote.origin.url`, a GitHub remote, and `gitProtectState(row,
mounts)` is `protected` in the live container. The remote is read from the host
source of the container's read-only `<target>/.git/config` mount. The
container-wide checks (Feature declared, `gitProtect` not off, own key dir at
`/run/devc-bridge`) run once.

Any failure fails the whole grant: no policy is written, any old one is removed,
and `BridgeGrantError` names the repo
(`the container is up, but --bridge-allow was not granted: <PATH>: <reason>`).
That is the same all-or-nothing rule as today.

Two pinned repos whose remotes name the same GitHub `<owner>/<name>` (any of the
three URL shapes, any `github.com-*` alias) fail the grant:
`<PATH-a> and <PATH-b> both push to github.com/<owner>/<name>`. That case only
arises from a repo and its own checkout or worktree, and it would make the
per-remote mirror ambiguous.

### Grants are shared

One `--bridge-allow` list applies to every pinned repo. Per-repo grants are not
part of this plan.

### Policy file v2

`~/.config/devc-bridge/policy/<key>.conf`: 1–16 lines, each terminated by `\n`,
each exactly five non-empty, tab-separated fields with no control characters:

```
<repo>\t<remote>\t<branch>\t<grants>\t<target>\n
```

- `repo`: host path of the working tree (unchanged meaning).
- `remote`, `branch`: unchanged meaning.
- `grants`: unchanged syntax, and **identical on every line**.
- `target`: the repo's path in the container. It is absolute, has no trailing
  `/` (except `/` itself, which is refused), and contains no `//`, `/./` or
  `/../` segment. For the workspace repo this is `workspaceMountRow(...).target`.
  For an extra repo it is the row's normalized target.
- Line 1 is the workspace repo; the rest follow `--bridge-repo` order.
- Distinct `repo` across lines, distinct `target` across lines.
- Anything else is malformed. That includes a v1 four-field line: it fails
  closed, the existing refresh path removes it and says so, and the user re-runs
  `devc up --bridge-allow …`. This is the precedent set when the grants field was
  added.

`policyProblem`/`parsePolicy`/`serializePolicy` (`devc-core/bridge.ts`) are the
TypeScript authority. The bridge host's grant check
(`devc-bridge/host/core.ts`) uses them and reads the shared `grants`. Each bash
script's parser must accept and refuse exactly the same files.

### Refresh

Refresh (`attach`, `exec`, …) re-derives **every** line. It finds each extra
line's row by matching the stored `repo` and `target` against the current
`protectedRows`, then compares with bridge-pin-hardening's rule (repo, origin,
branch must be unchanged). If any line fails or changed, the **whole policy** is
removed, with bridge-pin-hardening's message prefixed by the repo's host path:

```
devc: devc-bridge capabilities revoked — <repo>: the branch is now <new>, but they were granted for <old>. Run `devc up --bridge-allow <grants> --bridge-repo …` to grant it.
```

For a single-line policy, the `<repo>:` prefix and `--bridge-repo …` are
omitted, so the message is bridge-pin-hardening's exactly. The derive-failure
message gets the same `<repo>:` prefix on multi-line policies.

### Selecting a repo in the bridge commands: `--repo <target>`

- `gh-push`, `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve` and
  `gh-pr-request-review` accept an optional leading `--repo <target>`. It is
  recognised **only as `$1`**, so a reply body that happens to be `--repo` is
  still a body. The `--repo=<x>` form is not accepted. After `shift 2`, the
  existing argument rules apply unchanged (e.g.
  `gh-pr-reply --repo /workspaces/tools/x <thread> <body>`).
- `--repo` with no value → exit 2.
- Strip trailing `/` characters from the value, then select the line whose
  `target` equals it exactly. No match → exit 2:
  `no pinned repo at <value> — pinned: <target1>, <target2>, …`.
- No `--repo`: with one line, use it. With more than one → exit 2:
  `this container has <N> pinned repos — pass --repo <path>, one of: <target1>, <target2>, …`.
- `gh-doctor` takes no `--repo`. It reports every line of each policy it covers.
  Per line, it prints `target    <target>` before the existing
  `policy`/`repo`/`branch`/mirror/transport/`default` lines.
- Usage strings: `usage: gh-push [--repo <path>]`,
  `usage: gh-pr-comments [--repo <path>]`,
  `usage: gh-pr-reply [--repo <path>] <thread-id> <body>`,
  `usage: gh-pr-resolve [--repo <path>] <thread-id>`,
  `usage: gh-pr-request-review [--repo <path>]`.
- The selected line's `repo`/`remote`/`branch` feed the existing logic
  unchanged. Every refusal and success message keeps naming the repo, as today.

### Mirrors

`gh-push`'s mirror moves from `~/.local/state/devc-bridge/git/<key>.git` to
`~/.local/state/devc-bridge/git/<key>/<owner>/<name>.git`, where `<owner>` and
`<name>` come from `parse_remote` of the selected line's remote (`valid_name`
already keeps them path-safe). The existing origin-equals-policy-remote check is
unchanged per mirror. `gh-doctor` reads mirrors from the same path. The legacy
`git/<key>.git` is not read, moved or deleted. The README says it is safe to
`rm -rf`.

### Bash parser copies

`load_policy` in the `gh-pr-*` prelude must stay byte-identical across the four
`gh-pr-*` scripts; `gh_pr_review_test.sh` already enforces this. `gh-push` and
`gh-doctor` carry their own copies of the same rules. Parse per line with the
existing technique: read the whole file with the `x` sentinel, split on `\n`,
and count tabs per line (`read` cannot split, because tab is IFS whitespace).
The cross-line checks (identical grants, distinct repo, distinct target, 1–16
lines, no trailing empty line other than the final `\n`) are part of the shared
rules.

### `devc` output

- Grant log, any number of lines:
  ```
  devc: devc-bridge capabilities granted: <grants, ", "-joined>
  devc:   <target>: <branch> → <remote> (<repo>)
  ```
  One indented line per pinned repo, in policy order.
- `devc status`, a present policy:
  ```
  bridge:    <grants, ", "-joined>
    <target>: <branch> → <remote> (<repo>)
  ```
  One indented line per pinned repo. The absent and malformed lines are
  unchanged.

## Checklist

- [ ] `devc-core/bridge.ts`: v2 policy types, `policyProblem`/`parsePolicy`/
      `serializePolicy` with the cross-line rules; v1 files malformed
- [ ] `devc/args.ts`: `--bridge-repo` parsing for `up`/`build` (both spellings,
      repeatable, consumes its value, requires `--bridge-allow`, duplicates and
      the 15 cap as usage errors)
- [ ] `devc/main.ts`: refuse `--bridge-repo` on the other start paths; thread the
      repo list into `{ grant }`
- [ ] `devc/bridge.ts`: per-repo pin derivation for extra rows; all-or-nothing
      grant; same-`<owner>/<name>` refusal; `checkGrantBeforeUp` covers extra
      repos (no mount table yet); per-line refresh; new grant log and
      `devc status` lines
- [ ] `devc/help.ts` and `.plans/design/devc-design.md` (the help source of
      truth): `--bridge-repo PATH` under `up`; `build`'s `As for devc up` line
      covers it
- [ ] `devc-bridge/host/core.ts`: grant check on v2 policies
- [ ] `gh-push`: v2 parse, `--repo`, per-remote mirror path
- [ ] `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve`, `gh-pr-request-review`:
      v2 `load_policy` in the shared prelude, `--repo`, usage strings
- [ ] `gh-doctor`: v2 parse, per-line report with `target`, new mirror path
- [ ] `devc-bridge/client/devc-bridge.ts`: overview lines show `[--repo <path>]`
      for the five commands
- [ ] Tests: `devc-core/tests/bridge_test.ts`, `devc/tests/args_test.ts`,
      `devc/tests/bridge_test.ts`, `devc-bridge/host/tests/capabilities_test.ts`,
      `devc-bridge/tests/gh_push_test.sh` (its `pin` helper and inline policy
      lines move to five fields), `devc-bridge/tests/gh_pr_review_test.sh`
- [ ] Docs: `devc/README.md` (replace "Only the **primary workspace repo** is
      ever pinned…" with the `--bridge-repo` rules; add `--bridge-repo` to the
      start-path table and the precondition list), `devc-bridge/README.md`
      (policy format, `--repo`, mirror path, `gh-doctor`, the legacy mirror is
      safe to delete), `docs/bridge-github.md` (the **One repo** bullet, `--repo`
      on every command, the multi-repo exit-2 message, the tip
      `--repo "$(git rev-parse --show-toplevel)"`),
      `skills/copilot-pr-reviewing/SKILL.md` (pass `--repo` when more than one
      repo is pinned)
- [ ] `deno fmt` on every touched `.ts` and `.md` file

## Validation

- [ ] `cd devc-core && deno task check && deno task test` passes, including:
  - a 1-line and a 3-line v2 policy round-trip through
    `serializePolicy`/`parsePolicy`
  - each of these is malformed, and `policyProblem` names it: a v1 four-field
    line; a six-field line; grants differing between lines; a duplicated
    `repo`; a duplicated `target`; a relative `target`; a `target` with a
    trailing `/`; a `target` containing `/../`; 17 lines; an empty middle line
- [ ] `cd devc && deno task check && deno task test` passes, including:
  - `parseUpArgs(['--bridge-allow', 'gh', '--bridge-repo', '/a', '--bridge-repo=/b', 'proj'])`
    → target `proj`, repos `['/a', '/b']`
  - with `HOME` set to the fixture home, `--bridge-repo=~/extra`,
    `--bridge-repo '~/extra'` (literal tilde) and `--bridge-repo <abs path>`
    all pin the same repo; `--bridge-repo '~nobody/extra'` is not expanded and
    fails with `no such directory`
  - `--bridge-repo /a` without `--bridge-allow` → throws, and the message
    contains `--bridge-repo requires --bridge-allow`
  - `devc attach --bridge-repo /a` → exit 2 with the refusal message
  - a grant with one extra protected repo row (fake mount table freezing both)
    → a two-line policy, line 1 the workspace; the grant log matches the format
    above
  - `--bridge-repo` naming the workspace repo, an unmounted dir, a mounted
    linked worktree, and an unprotected mount → each the exact
    `BridgeGrantError` above, and no policy written
  - an extra repo whose `.git/config` is not read-only in the mount table →
    grant refused naming that repo; any earlier policy removed
  - two pinned repos with `git@github.com:acme/x.git` and
    `https://github.com/acme/x` → refused with the `both push to` message
  - refresh after the extra repo's `HEAD` changes → policy `absent`; log has
    `<repo>: the branch is now`
  - refresh with nothing changed → file content and mtime unchanged
  - `devc status` with a two-line policy prints both indented lines
- [ ] `cd devc-bridge/host && deno task check && deno task test` passes; a v2
      multi-line policy grants by its shared grants; a v1 policy is reported
      malformed (exit 2)
- [ ] `bash devc-bridge/tests/gh_push_test.sh` → `N passed, 0 failed`,
      including:
  - a two-line policy (two repos, two bare remotes `acme/widget`, `acme/gadget`):
    `gh-push` without `--repo` → exit 2, with the `pass --repo` message listing
    both targets
  - `gh-push --repo <target2>` pushes repo 2's branch to `acme/gadget` only;
    `acme/widget` is unchanged
  - `gh-push --repo <target2>/` (trailing slash) is the same repo
  - `gh-push --repo /nope` → exit 2, `no pinned repo at /nope`
  - `gh-push --repo` (no value) → exit 2; `gh-push x` → exit 2 (still no
    positional arguments)
  - mirrors exist at `git/ws-1/acme/widget.git` and `git/ws-1/acme/gadget.git`;
    nothing is created at `git/ws-1.git`
  - a one-line v2 policy pushes without `--repo` (single-repo behaviour
    unchanged)
  - a v1 four-field policy → exit 2, malformed
  - `gh-doctor` on the two-line policy prints a `target` line for each repo
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` → `N passed, 0 failed`,
      including: the prelude byte-identical check; `gh-pr-reply --repo <t> <thread> <body>`
      replies on that repo's PR; `gh-pr-reply <thread> --repo` treats `--repo`
      as the body; multi-line without `--repo` → exit 2 for each of the four
      scripts
- [ ] `cd devc-bridge/client && deno task check` passes
- [ ] `deno fmt --check` passes at the repo root
- [ ] Manual, in this `devc-dev` setup:
      `devc up ~/code/tools/devc-dev --bridge-allow gh --bridge-repo ~/code/tools/devc-tools`
      → grant log lists `/workspaces/devc-dev` and
      `/workspaces/tools/devc-tools`; inside, `devc-bridge gh-doctor` shows both;
      `devc-bridge gh-push --repo /workspaces/tools/devc-tools` from a feature
      branch pushes it

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc/args.ts`
- `devc/main.ts`
- `devc/bridge.ts`
- `devc/help.ts`
- `devc/tests/args_test.ts`
- `devc/tests/bridge_test.ts`
- `devc/README.md`
- `.plans/design/devc-design.md`
- `devc-bridge/host/core.ts`
- `devc-bridge/host/tests/capabilities_test.ts`
- `devc-bridge/builtin/gh-push`
- `devc-bridge/builtin/gh-doctor`
- `devc-bridge/builtin/gh-pr-comments`
- `devc-bridge/builtin/gh-pr-reply`
- `devc-bridge/builtin/gh-pr-resolve`
- `devc-bridge/builtin/gh-pr-request-review`
- `devc-bridge/tests/gh_push_test.sh`
- `devc-bridge/tests/gh_pr_review_test.sh`
- `devc-bridge/client/devc-bridge.ts`
- `devc-bridge/README.md`
- `docs/bridge-github.md`
- `skills/copilot-pr-reviewing/SKILL.md`
- `.plans/PLAN.md`
