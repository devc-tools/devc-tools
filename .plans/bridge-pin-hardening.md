# bridge-pin-hardening

Two fixes that make the devc-bridge pin (`policy/<key>.conf`: repo, remote,
branch, grants) change only when the user explicitly grants it, and never cover
the remote's default branch.

**The gap.** Git protection freezes `.git/config` and `.git/hooks`, but not
`HEAD`. Every start path without `--bridge-allow` (`attach`, `claude`,
`copilot`, `pi`, `herdr`, `exec`) runs `applyPolicy('refresh', …)`, which
rewrites the pin from the current `HEAD`. So an agent can write
`ref: refs/heads/main` into `HEAD` (for a linked worktree,
`<primary>/.git/worktrees/<name>/HEAD`). At the user's next `devc attach`, the
pin moves to `main` with only a `devc-bridge pin refreshed:` log line. `gh-push`
then pushes to the default branch, because nothing refuses it.

The convenience this removes is small. The pin was only re-read at the next
start, never mid-session, and `devc up --bridge-allow …` reuses the running
container. So moving the pin with `devc up --bridge-allow` was already the
normal workflow.

Prerequisite for multi-repo pinning (extra repos added by explicit path), which
is a separate, later plan.

## Decisions

### Fix 1 — `gh-push` refuses the remote's default branch

- In `devc-bridge/builtin/gh-push`, right after `base` is computed from
  `ls-remote --symref` (before the `fetching $base` network step, before any
  fetch from the agent's repo, before the mirror is touched further):

  ```bash
  [ "$branch" != "$base" ] ||
    die 3 "refused: $branch is the default branch of $remote — gh-push publishes only a non-default branch; on the host, check out another branch and run devc up --bridge-allow $grants"
  ```

  Exact, case-sensitive string comparison: git ref names are case-sensitive,
  and `base` comes from the remote's own `HEAD` symref. The default branch is
  read on every push, never assumed to be `main`. A pin named `main` on a remote
  whose default branch is `master` still pushes.
- Exit code `3`: it is a policy refusal, and `docs/bridge-github.md` already
  tells agents not to loop on exit 3.
- devc does **not** check this at grant time. devc never runs git and has no
  network step, and the repo's `refs/remotes/origin/HEAD` is agent-writable.
  `gh-push` is the enforcement point.
- Consequence to document: a fork workflow that commits on the fork's own
  default branch can no longer be published; use a feature branch.
- `gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve` and `gh-pr-request-review`
  are unchanged.

### Fix 1b — `gh-doctor` reports it

- Change the transport probe in `devc-bridge/builtin/gh-doctor` from
  `ls-remote --heads -- "$url" "refs/heads/$branch"` to
  `ls-remote --symref -- "$url" HEAD "refs/heads/$branch"`, stdout captured to
  a temp file instead of `/dev/null`. Read the default branch with the same awk
  `gh-push` uses:

  ```bash
  awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2; exit }'
  ```

- After the `transport ok` line, when the branch equals the default branch:
  `finding "default   $branch is the default branch of $remote — gh-push refuses it"`.
  This counts as a finding, so the exit code is 1.

### Fix 2 — refresh validates the pin and never changes it

In `devc/bridge.ts` `applyPolicy`, `refresh` mode:

- Unchanged: absent → no-op; malformed → remove and log; `derivePin` fails →
  remove and log the existing `capabilities revoked — <reason>. Re-run …` line.
- New: when `derivePin` succeeds but its pin differs from the stored one,
  **remove the policy** and log, checking fields in the order repo, remote,
  branch and reporting the first that differs:

  ```
  devc: devc-bridge capabilities revoked — the <what> is now <new>, but they were granted for <old>. Run `devc up --bridge-allow <grants>` to grant it.
  ```

  `<what>` is `workspace repo`, `origin`, or `branch`. `<grants>` is the stored
  list comma-joined, e.g. `gh-push,gh-pr-review`.
- When the pin is identical: write nothing, log nothing. Refresh never writes
  the policy file. The `devc-bridge pin refreshed:` log line is removed.
- `{ grant }` and `revoke` modes are unchanged. `devc up`/`devc build` with
  `--bridge-allow` remain the only way to create or change a pin.
- `--bridge-allow` stays refused on `attach` and the other start paths
  (unchanged).

## Checklist

- [ ] `gh-push`: default-branch refusal (exit 3, exact message above); update
      the header comment's exit-code list to include it
- [ ] `gh-doctor`: `--symref` probe and the `default` finding
- [ ] `devc-bridge/tests/gh_push_test.sh`: new `default branch is refused`
      cases (see Validation)
- [ ] `devc/bridge.ts`: refresh revokes on a changed repo, remote or branch;
      drop the `pin refreshed` path; update the module header and the
      `applyPolicy` doc comment (refresh validates, never rewrites)
- [ ] `devc/tests/bridge_test.ts`: replace `refresh rewrites the pin after a
      branch switch` with the revoke case; add the origin-changed case and the
      unchanged-pin case
- [ ] `devc/README.md`: the start-path table's `attach, …` row ("Without it"
      column → `re-check an existing policy; revoke it if its repo, origin or
      branch changed`), and rewrite the **Refresh** paragraph to match
- [ ] `devc-bridge/README.md`: the "Every other start path keeps the set and
      only refreshes the pin's branch" sentence; a new `gh-push` step after
      step 4 (refuse the default branch, exit 3); the exit-code table's `3`
      row; the `gh-doctor [key]` section (the `default` finding)
- [ ] `docs/bridge-github.md`: the **One branch** bullet (switching branches
      never moves the pin; the host's next `attach` revokes the grant; only
      `devc up --bridge-allow …` grants a new branch; the default branch is
      never publishable); the `gh-push` exit `3` row
- [ ] `deno fmt` on every touched `.ts` and `.md` file

## Validation

- [ ] `cd devc && deno task test` — all pass, including:
  - after a grant on `feat/x`, `setHead('ref: refs/heads/feat/next\n')` then
    `refresh` → policy `absent`; log contains
    ``devc: devc-bridge capabilities revoked — the branch is now feat/next, but they were granted for feat/x. Run `devc up --bridge-allow gh-push,gh-pr-review` to grant it.``
  - after a grant, `setOrigin(f, 'git@github.com:acme/other.git')` then
    `refresh` → policy `absent`; log contains
    `the origin is now git@github.com:acme/other.git, but they were granted for git@github.com:acme/proj.git`
  - after a grant, `refresh` with nothing changed → policy file content and
    mtime unchanged, and no log line from the refresh
  - no log line anywhere contains `pin refreshed`
- [ ] `cd devc && deno task check` passes
- [ ] `bash devc-bridge/tests/gh_push_test.sh` → `N passed, 0 failed`,
      including:
  - `fresh`; `pin "$REPO" "$GH_PIN" main` → exit 3; output has
    `is the default branch of $GH_PIN`; `remote_ref refs/heads/main` unchanged;
    no `push` in `$W/git.log`
  - `fresh master`; `pin "$REPO" "$GH_PIN" master` → exit 3
  - `fresh master`; a local `main` branch with a new commit;
    `pin "$REPO" "$GH_PIN" main` → exit 0 (the default branch is read, not
    assumed)
  - `gh-doctor` on the `fresh`/`main` pin → exit 1; output has
    `default   main is the default branch of $GH_PIN`
  - existing `gh-doctor` "a healthy policy" case still exits 0
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` → `N passed, 0 failed`
      (unchanged scripts, regression only)
- [ ] `grep -rn "pin refreshed\|refreshes the pin's branch\|rewrites the pin" devc devc-bridge docs`
      returns nothing
- [ ] `deno fmt --check` on every touched file passes

## Relevant Files

- `devc-bridge/builtin/gh-push`
- `devc-bridge/builtin/gh-doctor`
- `devc-bridge/tests/gh_push_test.sh`
- `devc-bridge/README.md`
- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc/README.md`
- `docs/bridge-github.md`
- `.plans/PLAN.md`
