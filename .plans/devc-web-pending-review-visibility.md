# devc-web-pending-review-visibility

**Repo:** `devc-tools`
**Run on:** a **host** with an authenticated `gh` and a scratch PR on a repo the host user can
review (any small GitHub repo with an open PR from a branch; pick one at implementation time).
Nothing here can be measured inside a container without the bridge's `gh`.

Comments that devc web adds to a pending review (the `+` on a PR diff tile → Add to review, and
Reply → Add to review) did not appear in GitHub's own pending list when the user went to submit
the review on github.com. Once the review was submitted they appeared in GitHub as normal. Pending
comments the user had added in GitHub's UI did appear in that list. Nobody checked whether the
devc web ones showed inline in GitHub's Files changed view before the submit.

Find out why, and either fix how `gh-pr-pending-review` creates them or record that GitHub
behaves this way.

## Checklist

- [ ] Step 0: reproduce on a host and record which hypothesis holds (§ Step 0)
- [ ] Step 1: act on the outcome Step 0 found (§ Step 1)
- [ ] Record the finding in `devc-bridge/README.md` § gh-pr-pending-review (§ Step 1, every outcome)

## What the code does (read 2026-10-29)

devc web never calls GitHub itself for this. `devc/web/pr_review.ts` (`pr_pending_*` messages)
runs the `devc-bridge/builtin/gh-pr-pending-review` recipe with the host's `gh`
(`devc/web/pr_host.ts`). The recipe:

- **Finds the pending review:** `pullRequest.reviews(states:PENDING,first:5)`, keeping the one
  with `viewerDidAuthor`. GitHub allows one pending review per user per PR, so a pending review
  the user started in GitHub's UI is reused, and the reverse.
- **Starts one when there is none:** `addPullRequestReview(input:{pullRequestId, commitOID})`
  with `commitOID` = the PR's `headRefOid` at that moment. It sends no `event`, so the review
  stays PENDING.
- **Adds a thread:** `addPullRequestReviewThread(input:{pullRequestReviewId, path, line, side
  [, startLine, startSide], body})`. It sends no `subjectType`, so GitHub uses its default, `LINE`.
- **Replies:** `addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId,
  pullRequestReviewId, body})`.

These are the mutations GitHub documents for pending reviews, and the user's report agrees with
them: the comments were in the user's own pending review, because submitting it published them.
So the comments are created and attached correctly. What is open is only how GitHub's page shows
them before the submit.

## Hypotheses (Step 0 decides between them)

- **H1: the GitHub page was stale.** github.com reads the pending review when the PR page or
  Files changed loads, and does not refresh when a comment is added from elsewhere. Comments
  added through devc web after the page loaded are missing from its pending list until a reload.
  Comments the user added on that page are in the page's own state, so they show.
- **H2: the review is on an older commit.** `start_review` sets `commitOID` only when it creates
  the review. A pending review started before a later push (by devc web or in GitHub's UI) stays
  on the old commit, and threads added to it are placed against that commit. GitHub's Files
  changed view on the new head may treat them as outdated and leave them out of its pending
  list. Once the review is submitted, they show in the Conversation tab.
- **H3: a different account.** The host's `gh` is logged in as an account other than the one in
  the browser. Ruled out if `gh api user --jq .login` matches the browser's login, and it is
  very unlikely given the report: the submit that published the comments would then have been
  a different review.

## Step 0: reproduce and measure

On the scratch PR, as the same account in `gh` and the browser
(`gh api user --jq .login`):

1. **H1.** With no pending review, open the PR's Files changed on github.com. In devc web, add
   one comment with `+` → Add to review. Without reloading, open GitHub's review/submit dialog
   and note whether the comment is listed and whether it shows inline. **Reload** the page and
   check again.
2. **H2.** Discard the review. In devc web add one comment (this starts the review at head A).
   Push a new commit B to the PR branch. Reload devc web's tile and add a second comment, on a
   line that B did not change. Reload github.com and check both comments in the submit dialog and
   inline. Read the review's commit and each comment's commits:

   ```sh
   gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){
     pullRequest(number:$p){headRefOid reviews(states:PENDING,first:5){nodes{viewerDidAuthor
     commit{oid} comments(first:20){nodes{body outdated commit{oid} originalCommit{oid}}}}}}}}' \
     -f o=OWNER -f n=REPO -F p=NUMBER
   ```

3. **Control.** Repeat 1 with the comment added in GitHub's UI from a second browser tab, and
   check whether the first tab shows it without a reload. If not, that confirms H1 as GitHub's
   general behavior, not something devc web causes.

Record what each step showed under § Findings in this file before Step 1.

## Step 1: act on the outcome

- **H1 only (a reload shows them):** no code change. Add to `devc-bridge/README.md` § the
  `gh-pr-pending-review` row's notes, and to the Add to review button's tooltip in
  `devc/web/static/ui.js`: "GitHub's page shows comments added here after a reload."
- **H2 (the comments are on the old commit and GitHub leaves them out):** GitHub has no mutation
  that moves a pending review to a new commit. Make `gh-pr-pending-review show` also print the
  review's commit, as `{"review":{"id","comments","commit":"<oid>"}}`, and have devc web's PR
  tile show "Your pending review is on an older commit — GitHub may not list its comments until
  you submit it" when that commit is not the PR's head. Document the field in
  `devc-bridge/README.md` and `devc/README.md`, and extend `devc-bridge/tests/gh_pr_review_test.sh`
  and `devc/tests/web_pr_review_test.ts` for it.
- **Neither (the comments are missing even after a reload, on an up-to-date review):** add a
  § Findings entry with the query output above, and change `addPullRequestReviewThread` calls to
  match what github.com's own request sends (capture it from the browser's network panel:
  compare `subjectType`, `startSide`, and whether it adds the thread by `pullRequestId` rather
  than `pullRequestReviewId`). Re-run Step 0.1 after the change.

## Findings

(Filled in by Step 0.)

## Validation

- [ ] Step 0's three checks recorded under § Findings, with the query output for 2
- [ ] On the scratch PR, after Step 1: a comment added in devc web shows in GitHub's submit
      dialog under the conditions Step 1 says it will (after a reload, or with the older-commit
      notice shown in devc web)
- [ ] `deno test -A devc/tests/web_pr_review_test.ts` passes and
      `bash devc-bridge/tests/gh_pr_review_test.sh` passes, if Step 1 changed code

## Relevant Files

- `devc-bridge/builtin/gh-pr-pending-review` — only for the H2 or "neither" outcomes
- `devc-bridge/README.md` — the `gh-pr-pending-review` notes, every outcome
- `devc-bridge/tests/gh_pr_review_test.sh` — H2
- `devc/web/pr_review.ts` — H2 (passes `commit` through)
- `devc/web/static/ui.js` — the Add to review tooltip (H1)
- `devc/web/static/tiles.js` — the older-commit notice on the PR tile (H2)
- `devc/README.md` — H2
- `devc/tests/web_pr_review_test.ts` — H2
