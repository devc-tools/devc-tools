# bridge-pr-request-review

A new built-in, `devc-bridge pr-request-review`, asks Copilot to review the
container's PR at its current head. Without it an unattended fix → push → poll
loop stalls after the first push on any repo whose Copilot setup does not
re-review automatically on push (a personal repo without the plan feature, or an
org repo whose ruleset lacks `review_on_push`); a human has to click
"Re-request review".

## Step 0 — verify the GitHub behaviour (done on the personal repo)

The REST shape below is believed correct but has not been run. On an org repo
with an open PR `<n>` that Copilot has already reviewed, after pushing a new
commit:

```sh
gh api -X POST repos/<org>/<repo>/pulls/<n>/requested_reviewers \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]' \
  --jq '[.requested_reviewers[]?.login]'
```

Record here: (a) the response includes `copilot-pull-request-reviewer[bot]`,
(b) a new Copilot review of the new head arrives, (c) the same call on
`bmingles/private-repo-spike` (personal, no auto-review) — works or its exact
error, (d) the same call while a review is already pending — duplicate, no-op,
or error.

**If (b) fails, stop and revise this plan** — do not fall back to
`gh pr edit --add-reviewer @copilot`: the `pr-*` prelude runs `gh` only as
`gh api`/`gh auth` and the harness asserts it.

### Results (2026-09-29, `bmingles/private-repo-spike` PR #1, personal repo)

- **(a) No.** Before: `GET …/requested_reviewers` → `[]`. Every POST (five in
  all) answered `[.requested_reviewers[]?.login]` → `[]`, including ones that
  started a review. The response is **not** a success signal; a 2xx is.
- **(b) Yes.** Requests started Copilot reviews of `f79cc0c` (15:20:46Z) and
  `422fd21` (16:02:15Z).
- **(c) Works on the personal repo.** The plan-tier gate is on
  auto-review-on-push, not on requesting.
- **(d) A request while pending is a no-op.** For `422fd21`, two POSTs seconds
  apart inside the 16:00:29–16:02:15 review window produced one
  `review_requested` event and one review; the same held for `f79cc0c`. A POST
  after the head was already reviewed also started nothing.
- **Pending is visible only in the issue timeline.** A 5 s poll of
  `pr-comments` across the whole 16:00:29–16:02:15 window never saw
  `pending=true`: REST `requested_reviewers` never lists Copilot, so
  `pr-comments`' `copilotReview.pending` is **always `false` today** (an
  existing bug this plan fixes). The timeline
  (`repos/<repo>/issues/<n>/timeline`) shows, per request:
  `review_requested` (`requested_reviewer.login == "Copilot"`) →
  `copilot_work_started` → `reviewed` (`user.login == "Copilot"`). GraphQL
  `reviewRequests` was not captured and is not used.
- **Gotcha — three names for one bot:** `copilot-pull-request-reviewer[bot]`
  in the REST request, `copilot-pull-request-reviewer` as a GraphQL review
  author, `Copilot` in timeline events.

Still to confirm, as a live Validation item rather than a blocker: the same
behaviour on an org repo (including one with review-on-push, where the push
itself starts the review).

## Decisions

1. **Its own capability, `pr-request-review`, requiring `pr-review`.** Each
   request spends a Copilot review (org quota / premium requests), which a user
   granting `pr-review` (read and reply) today did not consent to. Same shape as
   `pr-resolve`: `BRIDGE_CAPABILITIES` order becomes `git-push, pr-review,
   pr-resolve, pr-request-review`; `BRIDGE_CAPABILITY_COMMANDS['pr-request-review']
   = ['pr-request-review']`; `BRIDGE_CAPABILITY_REQUIRES['pr-request-review'] =
   'pr-review'`. `parseBridgeAllow`, `parsePolicy` and `suggestGrants` already
   handle a requires-edge generically.
2. **Host hint generalized.** `grantRefusal`'s hint special-cases
   `capability === 'pr-resolve'`; make it
   `BRIDGE_CAPABILITY_REQUIRES[capability] !== undefined`, so the no-policy
   message for `pr-request-review` suggests
   `devc up --bridge-allow pr-review,pr-request-review`.
3. **The recipe** `devc-bridge/builtin/pr-request-review` carries the shared
   `pr-prelude` byte-identically (update the prelude's "Shared by …" comment
   in all four copies and the harness's recipe list). No arguments (any → exit
   2, `usage: pr-request-review`). `require_grant pr-request-review`, then
   `gh_ready` and `resolve_pr`, then reads Copilot's latest non-`PENDING` review
   commit with the **same query as `pr-comments`** and pending with
   `copilot_pending` (decision 6). Then, in order:
   - Pending → stdout
     `pending: Copilot is already reviewing <pr-url>`, exit 0, nothing posted.
   - Latest Copilot review commit equals `headSha` → stdout
     `up to date: Copilot already reviewed <sha12> on <pr-url>`, exit 0,
     nothing posted.
   - Otherwise `gh api -X POST repos/<repo>/pulls/<n>/requested_reviewers -f
     'reviewers[]=copilot-pull-request-reviewer[bot]'`
     under the prelude's `gh_run` (timeout, stderr relayed, failure exit 4).
     A 2xx is success (Step 0 (a): the response never lists Copilot): stdout
     `requested: Copilot review of <sha12> on <pr-url>`, exit 0. No `--jq`
     check of the response.
     The idempotency checks are what bound spend: an agent calling it after every
     push requests at most one review per head.
4. **Agent guide loop** (`docs/bridge-git-push.md` "The loop"): after step 3
   (`git-push`), a new step `devc-bridge pr-request-review` — "harmless on a
   repo that reviews on push: it answers `pending:` or `up to date:`". The loop's
   step 1 wording ("`copilotReview.pending` is `true`") becomes accurate with
   decision 6. The "stop and
   tell the user if `copilotReview.commit` never catches up" note stays, now
   meaning the request itself did not take.
5. **Client help** overview gains, after `pr-resolve`:
   `pr-request-review            ask Copilot to review the current head    [pr-request-review]`
   (column-aligned with its neighbours; widen the command column if needed).
6. **`copilot_pending`, in the shared `pr-prelude`,** used by `pr-comments`
   (replacing its REST `requested_reviewers` read, which never sees Copilot)
   and `pr-request-review`. Pending ⇔ the **last** Copilot event in the PR's
   timeline is a request:

   ```sh
   gh_run "reading the timeline of $pr_url" api --paginate \
     "repos/$pr_repo/issues/$pr_number/timeline" \
     --jq '.[] | select((.event == "review_requested" and .requested_reviewer.login == "Copilot")
       or (.event == "reviewed" and .user.login == "Copilot")) | .event'
   # pending iff the final line is `review_requested`
   ```

   Gotcha: with `--paginate`, `--jq` runs **per page** (and `--slurp` cannot be
   combined with `--jq`), so emit one line per matching event and take the last
   line in shell — never compute "latest" inside the filter. Events arrive
   oldest first. An unexpected line (neither value) is exit 4.

## Checklist

- [x] Step 0 run and results recorded above (personal repo; org repo is a Validation item)
- [x] `copilot_pending` in the `pr-prelude` (all four copies); `pr-comments` uses it for `copilotReview.pending`, dropping the REST `requested_reviewers` read
- [x] `devc-core/bridge.ts`: capability, commands, requires
- [x] `devc-bridge/host/core.ts`: generalized hint
- [x] `devc-bridge/builtin/pr-request-review` (new, executable) + prelude comment in `pr-comments`, `pr-reply`, `pr-resolve`
- [x] `devc-bridge/client/devc-bridge.ts`: overview line
- [x] `devc/help.ts` and `devc/args.ts` doc comments listing capabilities
- [x] Tests: `devc-bridge/tests/pr_review_test.sh` (extend the `gh` shim to accept `-X POST` and log it, and to answer `repos/*/*/issues/*/timeline` from a `timeline.json` fixture — a JSON array of events, emitted through the shim's `--jq`; drop the `requested.json` fixture), `devc-bridge/host/tests/capabilities_test.ts` (built-ins list; hint), `devc-core/tests/bridge_test.ts` (canonical order; `pr-request-review` without `pr-review` refused)
- [x] Docs: `docs/bridge-git-push.md` (commands, loop, exit codes), `devc-bridge/README.md` (command table, Capabilities table, Iterating on PR review), `devc/README.md` (capability table and `--bridge-allow` list)

## Validation

- [x] `bash devc-bridge/tests/pr_review_test.sh` → `0 failed`, including:
  - timeline ending in a Copilot `review_requested` → `pr-request-review` exit 0 `pending: Copilot is already reviewing`, no POST logged; `pr-comments` reports `"pending":true`
  - timeline ending in a Copilot `reviewed` (or with no Copilot events) → `pr-comments` reports `"pending":false`
  - a non-Copilot `review_requested` after Copilot's `reviewed` → not pending
  - latest Copilot review commit = head → exit 0 `up to date: Copilot already reviewed`, no POST logged
  - neither → exit 0 `requested: Copilot review of <sha12>`, exactly one POST logged to `repos/<repo>/pulls/<n>/requested_reviewers` with `reviewers[]=copilot-pull-request-reviewer[bot]`
  - POST failing (`SHIM_FAIL=requested_reviewers`) → exit 4
  - an argument → exit 2; policy with `pr-review` only → exit 2 `not granted pr-request-review`
  - `pr-request-review`'s prelude byte-identical to `pr-comments'`
- [x] `bash devc-bridge/tests/git_push_test.sh` → `0 failed`
- [x] `cd devc-bridge/host && deno task test` and `deno task check` pass
- [x] `cd devc-core && deno test` passes (except the pre-existing, unrelated `cliWorktreeMounts … pinned devcontainer CLI` failure, which reproduces on the untouched tree); `cd devc && deno task test` passes
- [x] `devc up --bridge-allow pr-request-review` → refused `pr-request-review requires pr-review`
- [ ] Live on an org repo, after the host runs the new build: push a commit, `devc-bridge pr-request-review` → `requested:`; call again → `pending:`; after the review lands → `up to date:` — **not run**: needs the host running the new build and a live org-repo PR (it mutates a real PR); the steps are `devc-bridge/docs/testing.md` B19
- [x] `deno fmt --check` on changed `.ts`/`.md`

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc-bridge/host/core.ts`
- `devc-bridge/host/tests/capabilities_test.ts`
- `devc-bridge/builtin/pr-request-review` (new)
- `devc-bridge/builtin/pr-comments`
- `devc-bridge/builtin/pr-reply`
- `devc-bridge/builtin/pr-resolve`
- `devc-bridge/tests/pr_review_test.sh`
- `devc-bridge/client/devc-bridge.ts`
- `devc/help.ts`
- `devc/args.ts`
- `devc/bridge.ts` (header comment's capability list)
- `devc/tests/args_test.ts`
- `devc-bridge/docs/testing.md`
- `docs/bridge-git-push.md`
- `devc-bridge/README.md`
- `devc/README.md`
- `.plans/PLAN.md`
