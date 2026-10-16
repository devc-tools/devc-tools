# bridge-worktree-extra-repos

Let `--bridge-repo` name a **linked worktree**, including one of the same repo
as the workspace. Motivating setup: the workspace is one worktree of
`deephaven-core` (`~/code/deephaven-core.worktrees/A`), and the user wants a
second worktree of it (`~/code/deephaven-core.worktrees/B`) pinned in the same
container. Today that fails twice:

1. `matchBridgeRepo` (`devc/bridge.ts`) refuses any path whose `.git` is a file:
   `a linked worktree mounted as an extra folder is not git-protected, so it cannot be pinned`.
2. `derivePins` refuses two pins on one GitHub `<owner>/<name>`
   (`… both push to github.com/<owner>/<name>`), which a second worktree of the
   workspace's own repo always hits.

Neither restriction is needed for safety. A linked worktree has no config or
hooks of its own: git reads the primary's `.git/config` and `.git/hooks`, which
git protection already freezes for the primary's repo row (see
`gitProtectMounts`' doc comment in `devc-core/mounts.ts`), or, for a worktree
workspace, for the CLI's common-dir mount. The same-repo refusal existed only
because the two pins would share `gh-push`'s per-remote mirror, and two branches
in one mirror do not conflict. What a shared mirror does need is a lock, because
two sessions can push at once. A lock needs the `run_t` EXIT-trap race fixed
first: that race already deletes `$tmp` intermittently (the known
`gh_push_test.sh` flake), and it would delete a lock the same way.

Builds on [bridge-multi-repo-pins](archived/bridge-multi-repo-pins.md) and
[bridge-pin-hardening](archived/bridge-pin-hardening.md). Policy format v2 is
unchanged.

## Decisions

### Eligible worktrees

`--bridge-repo PATH` keeps its resolution (`~` expansion, cwd-relative,
`realPath`) and its existing match against protected `repo` rows. When `PATH`
matches no such row and `PATH/.git` is a **file**, it is eligible as a linked
worktree when all of these hold, checked in this order. The first that fails is
a `BridgeGrantError` of the form `--bridge-repo <PATH as typed>: <reason>`:

1. **Inside a bind mount.** Among `merged.config.mounts` entries with
   `type=bind` and a resolvable source (`parseMountSpec`, then
   `realPath(unfoldHome(source))`), pick the one with the **longest** source
   that equals `PATH` or is a path prefix of it at a `/` boundary. The
   worktree's container path is
   `normalizeTarget(target) + PATH.slice(source.length)`. This covers a
   `<repo>.worktrees` row (the usual `devc:source` layout) and a row mounting
   the worktree itself. None →
   `a linked worktree that is not inside any bind mount of this workspace`.
2. **A relative pointer.** The first line of `PATH/.git` is `gitdir: <rel>`
   (the same parse as `parseGitdirPointer`). An absolute `<rel>` →
   `its .git uses an absolute gitdir: path, which does not resolve inside the container — run git worktree repair --relative-paths`.
3. **An honest pointer into a protected git dir.** Resolve `G = realPath(PATH/<rel>)`.
   `G` must be `<C>/worktrees/<name>`, with `G/gitdir` pointing back at
   `PATH/.git` and `G/commondir` resolving to `C`. These are the same three
   checks as `gh-push`'s `pointer_problem`. `C` must be the host git dir of one
   of:
   - a `repo` row in `merged.protectedRows` (`C = realPath(source)/.git`); its
     container git dir is `normalizeTarget(target)/.git`;
   - a `gitdir` row in `merged.protectedRows`, including the workspace's CLI
     common-dir row (`C = realPath(source)`); its container git dir is
     `normalizeTarget(target)`.

   Otherwise →
   `its .git points at <G>, which is not the worktrees/ dir of a git-protected repo here`.
4. **The pointer resolves to the same place inside the container.**
   `resolvePosix(<container path>, <rel>)` must equal
   `<container git dir of C>/worktrees/<name>`. Otherwise →
   `its gitdir: pointer resolves to <that> inside the container, not <expected>`.
   This guarantees the container's git uses the frozen config, not some other
   path.
5. **No per-worktree config.** See § `extensions.worktreeConfig`.

The pin for an eligible worktree:

- `repo` is `PATH` (realpath); `target` is its container path.
- `branch` comes from `G/HEAD`, via `resolvePin(PATH, { configPath })`. With
  `mounts === 'skip'` (before `up`), `configPath` is `C/config`. Otherwise it is
  the host source of the live mount at `<container git dir of C>/config`.
- `remote` comes from that frozen config.
- With a live mount table: `gitProtectState` must be `protected` for `C`'s row,
  with the existing message naming the worktree's container path.

`eligibleRows`/the `pinnable:` list stay as they are, so worktrees are not
enumerated in that error. A path that matches no repo row and whose `.git` is
not a file keeps today's `not a git-protected repo mount …` message.

The `this is the workspace repo` check keeps running **before** the worktree
checks, so naming the workspace worktree itself is still refused.

### `extensions.worktreeConfig`

With it enabled, git also reads `<git dir>/config.worktree`, which is not frozen.
The frozen config can't be changed from inside, so it can't be turned on from
inside either, but a user may already have it on. Refuse every pin (the
workspace's line 1 too, at grant **and** refresh) whose frozen config enables
it:

- Parse the frozen config text for section `[extensions]` (case-insensitive),
  key `worktreeConfig` (case-insensitive). It counts as enabled unless the value
  is one of `false`, `no`, `off`, `0` (case-insensitive). A bare key with no
  `=` is `true`, as in git. Use the same value parsing as `parseOriginUrl`, so
  quotes, escapes and trailing comments are handled.
- Reason, for any pin:
  `its repo config enables extensions.worktreeConfig, so a per-worktree config.worktree could override the frozen config — unset it on the host to pin this repo`.
- Implement it in `devc-core/bridge.ts`, next to `parseOriginUrl`, and call it
  where the frozen config is read.

### Same GitHub repo, different branches

Replace `derivePins`' pairwise refusal with this rule. For two pins whose
`gitHubRepoOf(remote)` matches case-insensitively:

- Same `branch` → refuse:
  `<a> and <b> both push branch <branch> to github.com/<owner>/<name>`.
- Different `remote` strings (e.g. one SSH and one HTTPS, or a different
  `github.com-*` alias) → refuse:
  `<a> and <b> reach github.com/<owner>/<name> through different URLs (<remote a>, <remote b>)`.
  They would share a mirror whose `origin` must equal each line's remote.
- Otherwise allowed.

`<a>`/`<b>` are labelled as today: the workspace by its host path, extras as typed.
Refresh re-applies the same rule after re-deriving every line. A violation there
revokes the policy with the same reason (no `<repo>:` prefix) and the usual
`Re-run … once that is fixed.` suffix.

### `gh-push`: per-mirror lock

- After `mirror` is known and before the mirror is created or touched, take a
  lock: `mkdir -- "$mirror.lock"` (create the parent with `mkdir -p` first).
  The lock is held until the script exits and released in the EXIT trap
  (`rmdir`). Only the script that took the lock may remove it, so track that in
  a variable.
- If the lock is held, retry every second for up to `$timeout_s` seconds. Before
  each retry, remove a stale lock: one whose mtime is older than
  `4 * timeout_s + 60` seconds. Check with
  `find "$mirror.lock" -maxdepth 0 -mmin +<minutes>`, where `<minutes>` is
  `(4 * timeout_s + 60 + 59) / 60`, and remove with `rmdir`. Both work on macOS
  and Linux. _Changed during implementation:_ the plan first said
  `timeout_s + 60`, but a healthy run holds the lock across four separately
  timed git steps (`ls-remote`, two fetches, `push`), so that limit could break
  into a live push.
- Still held at the end →
  `die 4 "another gh-push is using the mirror for $head_owner/$head_name — try again (if none is running, remove $lock)"`.
  _Changed during implementation:_ the message names the lock path, so a lock
  left by a killed run can be cleared without waiting out the stale limit.
- `gh-doctor` takes no lock: it only reads the mirror.

### The EXIT-trap race (all six built-ins)

`run_t`'s watcher subshell, killed right after it forks, sometimes runs the
parent's EXIT trap and deletes `$tmp`. This was reproduced in a loop with
`run_t true`. Fix it in `gh-push`, `gh-doctor` and the four `gh-pr-*` scripts,
keeping the `gh-pr-*` prelude byte-identical: the EXIT trap acts only in the
main shell. bash 3.2 (macOS) has no `BASHPID`, so compare against a pid saved at
startup:

```bash
main_pid=$$
trap '[ "$(exec sh -c "echo \$PPID")" = "$main_pid" ] && rm -rf "$tmp"' EXIT
```

In `gh-push`, the same guard also covers the lock release. The implementing
agent may restructure the trap into a function, as long as the guard stays the
first thing it checks.

## Checklist

- [x] `devc-core/bridge.ts`: `extensions.worktreeConfig` detection beside
      `parseOriginUrl`
- [x] `devc/bridge.ts`: worktree eligibility (checks 1–5, exact messages);
      worktree pin derivation; `worktreeConfig` refusal for every pin at grant
      and refresh; refresh re-derives worktree lines through the same path;
      the same-repo rule replaced
- [x] `devc-bridge/builtin/gh-push`: mirror lock; EXIT-trap guard
- [x] `devc-bridge/builtin/gh-doctor`: EXIT-trap guard
- [x] `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve`, `gh-pr-request-review`:
      EXIT-trap guard, prelude still byte-identical
- [x] Tests: `devc-core/tests/bridge_test.ts`, `devc/tests/bridge_test.ts`,
      `devc-bridge/tests/gh_push_test.sh`, `devc-bridge/tests/gh_pr_review_test.sh`
- [x] Docs: `devc/README.md` (the `--bridge-repo` rules: linked worktrees
      allowed, their conditions and messages; same-repo pins on different
      branches; `extensions.worktreeConfig`), `devc-bridge/README.md` (mirror
      lock and its exit-4 message; a shared mirror for same-repo pins),
      `docs/bridge-github.md` (exit 4 `another gh-push is using the mirror` →
      retry after the other push finishes)
- [x] `deno fmt` on every touched `.ts` and `.md` file

## Validation

- [x] `cd devc-core && deno task check && deno task test` passes, except the
      known Docker-dependent `cliWorktreeMounts matches what the pinned
      devcontainer CLI computes`. Includes: `worktreeConfig` detected for
      `worktreeConfig = true`, `worktreeconfig` (bare), `"yes"`, `1`; not for
      `false`, `off`, `0`, absent, or a `worktreeConfig` key under a section
      other than `[extensions]`.
- [x] `cd devc && deno task check && deno task test` passes, including, with a
      fake mount table that freezes the primary's git dir:
  - **the motivating case:** workspace = worktree `A` of a primary `P`, with
    `--bridge-repo <worktree B of P>`, where B sits inside a mounted
    `P.worktrees` row and both use relative pointers → a two-line policy. Line 2
    has `repo` B, `target` `<P.worktrees target>/B`, B's branch, and P's remote.
  - an extra worktree of a separate primary that is mounted as a protected
    repo row → pinned, with the remote from that primary's frozen config.
  - each refusal, with its exact message: B not inside any bind mount; an
    absolute `gitdir:`; a pointer into a git dir that is not protected; a
    pointer whose back-reference is wrong; a pointer that resolves differently
    in the container (a mount target that breaks the sibling layout); the
    primary config enables `extensions.worktreeConfig`.
  - `extensions.worktreeConfig` on the **workspace** repo's frozen config →
    grant refused; and a refresh after it is enabled revokes the policy.
  - same GitHub repo, same branch → refused (`both push branch`); same repo,
    different URL strings → refused (`through different URLs`).
  - refresh after B's `HEAD` changes → policy `absent`, and the log has
    `<B>: the branch is now`.
  - refresh with nothing changed → file content and mtime unchanged.
- [x] `bash devc-bridge/tests/gh_push_test.sh` → `N passed, 0 failed` on **five
      consecutive runs**, including:
  - a two-line policy on the same remote with branches `feat` and `feat2`
    (two linked worktrees of one repo): `gh-push --repo <t1>` and
    `gh-push --repo <t2>` each push their own branch; one mirror
    `git/ws-1/acme/widget.git` is used.
  - two `gh-push` runs started together in the background, one per line →
    both exit 0, both branches are on the remote, and no `.lock` dir remains.
  - a pre-made `$mirror.lock` with an mtime older than the stale limit
    (`touch -t`) → removed, and the push succeeds.
  - a fresh `$mirror.lock` held throughout, with `DEVC_BRIDGE_GIT_TIMEOUT=2` →
    exit 4 with `another gh-push is using the mirror for acme/widget`, and the
    lock is not removed.
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` → `N passed, 0 failed` on
      three consecutive runs; the prelude byte-identical check passes.
- [x] The trap race no longer reproduces: a scratch script copying
      `gh-push`'s `tmp`/trap/`run_t` setup and calling `run_t true` 2000 times
      never loses `$tmp`. Run it on bash 5 here; record in this plan that
      bash 3.2 was not exercised locally.
      _Result:_ on GNU bash 5.2.21 (aarch64 Linux), the unguarded trap lost
      `$tmp` within 7–30 iterations; both the inline guard (the four `gh-pr-*`
      scripts and `gh-doctor`) and `gh-push`'s `on_exit` function form held for
      2000. bash 3.2 (macOS) was not exercised locally.
- [x] `cd devc-bridge/host && deno task check && deno task test` passes
- [x] `deno fmt --check` passes at the repo root
- [ ] Manual, on the host, in the motivating setup: from the existing worktree
      container,
      `devc up --bridge-allow gh --bridge-repo ~/code/deephaven-core.worktrees/<B>`
      → grant log lists both worktrees. Inside, `devc-bridge gh-push --repo <B's target>`
      pushes B's branch, and existing sessions in A keep working.

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc/README.md`
- `devc-bridge/builtin/gh-push`
- `devc-bridge/builtin/gh-doctor`
- `devc-bridge/builtin/gh-pr-comments`
- `devc-bridge/builtin/gh-pr-reply`
- `devc-bridge/builtin/gh-pr-resolve`
- `devc-bridge/builtin/gh-pr-request-review`
- `devc-bridge/tests/gh_push_test.sh`
- `devc-bridge/tests/gh_pr_review_test.sh`
- `devc-bridge/README.md`
- `docs/bridge-github.md`
- `.plans/PLAN.md`
