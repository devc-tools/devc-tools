# devc-web-since-review

**Repo:** `devc-tools`
**Run on:** any checkout for the code and offline tests. Step 0 and the live Validation rows need
a host with an authenticated `gh` and a throwaway PR you own (devc-bridge's B-row setup in
`devc-bridge/docs/testing.md`).

devc web's **Changes since viewed** (archived plan `devc-web-pr-review-depth`, Part 2) diffs a PR
file from the head it was last marked Viewed at **in devc web**. GitHub keeps no commit for a
Viewed mark, so a file marked on github.com (or before devc web recorded marks) has no starting
point and shows only `PR changes`. GitHub **does** keep a commit for every submitted review
(`PullRequestReview.commit`, `submittedAt`). This plan adds the user's latest review as a second
starting point, offered in every PR file's **Compare**. **The latest point wins**: whichever is
newer, your last devc web Viewed tick on the file or your last review, is where the default
since-diff starts. An approval after a tick means you signed off at that commit, so only later
changes are shown; a tick after the approval is the newer point.

## Checklist

- [x] Step 0: verify the GitHub behaviour this plan relies on (§ Step 0)
- [x] `gh-pr-files` prints `pr.myReview` (§ 1)
- [x] `pr_review.ts` parses and passes `myReview` (§ 2)
- [x] The diff tile's **Compare** option, default choice and messages (§ 3)
- [x] Tests: `gh_pr_review_test.sh`, `web_pr_review_test.ts`, `web_pr_host_test.ts` fixtures (§ 4)
- [x] Docs: `devc/README.md`, `devc-bridge/README.md`, `docs/bridge-github.md`,
      `devc-bridge/docs/testing.md` (§ 5)

## Step 0 — GitHub behaviour to confirm

GitHub does not let you approve your own PR, so use a throwaway PR **opened by a second account**,
reviewed by you (the account `gh` is logged in as on the host), with its branch pinned in a
container:

1. `reviews(last:100,states:[APPROVED,CHANGES_REQUESTED,DISMISSED]){nodes{viewerDidAuthor state
   submittedAt commit{oid}}}` on `pullRequest` returns the review, with `commit.oid` = the PR's head
   when it was submitted.
2. Push a commit; the review's `commit.oid` is unchanged (still the old head).
3. Force-push the branch; `gh api repos/<o>/<n>/contents/<file>?ref=<old oid>` still answers 200
   (GitHub keeps the PR's old commits). If it 404s, the option still works for ordinary pushes and
   shows `That commit no longer has this file on GitHub` after a force-push; note it in the README.
4. As yourself: reply to a review thread (devc web **Reply**, or `devc-bridge gh-pr-reply`). Confirm
   the reply creates a review in state `COMMENTED` by you at the current head. This is why
   `COMMENTED` is excluded (§ 1): a reply is not a review of the code.

Record the results in a `## Step 0 findings` section of this file. If check 1's `states` argument
or field names differ, amend § 1 to match before building.

## 1. `gh-pr-files`: `pr.myReview`

The `pr` object gains a last key, `myReview`: the host user's latest submitted review of the PR in
state `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED`, or `null` when there is none.

```json
"myReview": {"commit": "<40 lowercase hex>", "state": "APPROVED", "submittedAt": "2026-11-09T12:00:00Z"}
```

- Add to the existing files query (the one with `files(first:100,after:$endCursor)`), on
  `pullRequest`: `reviews(last:100,states:[APPROVED,CHANGES_REQUESTED,DISMISSED]){nodes{
  viewerDidAuthor state submittedAt commit{oid}}}`.
- Keep nodes with `viewerDidAuthor == true` and non-null `submittedAt` and `commit.oid`; pick the
  greatest `submittedAt` (ISO 8601 UTC strings compare lexically). None → `null`.
- **`COMMENTED` is excluded**: a thread reply, and devc web's pending-review **Submit** (always
  Comment), each create a `COMMENTED` review, which would move the starting point without any
  review of the code. `DISMISSED` is kept: GitHub only dismisses approvals and change requests, so
  it was a real review.
- **Gotcha — `--paginate`**: the query is paginated on `files`, and `--jq` runs per page, so the
  `H` header line (and `reviews`) comes out on every page. The script already uses only the first
  `H` line; build `myReview` inside that header's `obj` so it rides along. `reviews` is not paged
  (`last:100`); a PR with over 100 approving/changes-requested reviews may miss an older one, which
  does not matter since only the newest is wanted.
- **Gotcha — gojq**: `--jq` runs under gojq, which sorts object keys; build `myReview` with the
  script's `obj` helper (`[["commit", …], ["state", …], ["submittedAt", …]] | obj`) so the key
  order is `commit, state, submittedAt`, and emit `null` (not `{}`) when none.
- Update the header comment's output description.

## 2. `pr_review.ts`

- `PrInfo` gains `myReview: {commit: string; state: 'APPROVED' | 'CHANGES_REQUESTED' |
  'DISMISSED'; submittedAt: string} | null`.
- `parsePr`: a missing `myReview` (an older bridge) is `null`. A present one that is not `null` must
  have `commit` matching `COMMIT_SHA` (`^[0-9a-f]{40}$`), `state` one of the three, and
  `submittedAt` a string `Date.parse` accepts; otherwise `myReview` is `null` (do **not** reject
  the whole listing for it).
- `pr_files` and `pr_diff` already pass `pr` through, so the page gets it with no protocol change.

## 3. The diff tile (`static/tiles.js`, `static/ui.js`)

**Options.** `sinceOptions(view)` returns, besides the Viewed entries it has now, one review entry
when `pr.myReview` is set and its `commit` ≠ `pr.headSha`. Each option carries its kind (`viewed`
| `review`) and its time (`at` for Viewed, `submittedAt` for the review). The list is ordered
newest first by time, compared as `Date.parse` values (not strings: `at` has milliseconds,
`submittedAt` does not). When the review's `commit` equals a Viewed entry's `headSha`, keep only
the newer of the two (same diff; the label names the later event).

**Labels** (`LABELS` in `ui.js`):

| Option       | Label                                      |
| ------------ | ------------------------------------------ |
| Viewed (now) | `Since viewed <age> · <sha 7>` (unchanged) |
| Review       | `Since your review <age> · <sha 7>`        |

`<age>` is `sessionAge(submittedAt, now)`, as Viewed uses for `at`.

**Every PR file gets the review option**, whatever its Viewed state: the **Compare** `<select>`
appears whenever `sinceOptions` is non-empty, as now. So a file you never ticked but reviewed can
be diffed since that review.

**Which option is the default** (for `compare: 'viewed'`, i.e. **Open changes since viewed**, and
the header's **Show changes**): the first option in the list, i.e. the newest by time, Viewed or
review alike. If the list is empty, `PR changes` with the note as now. The
`No record of when you viewed it in devc web` note shows only when the list is empty; otherwise
no note, since the selected option names its kind.

**Reading the old file.** A Viewed option reads its recorded `path`, as now. The review option
reads `file.path` at the review commit; if that answers `missing` and the file has a
`previousPath`, read `previousPath` at that commit instead (a rename since the review). A
`missing` answer on both shows the existing message (`That commit no longer has this file on
GitHub`) with the **PR changes** button. Do not treat it as an added file: a 404 also means a
force-pushed commit GitHub dropped, and the two cannot be told apart.

**No changes.** `hunks: []` shows `No changes since you viewed this file` for a Viewed option and
`No changes since your review` for the review option.

**Unchanged:** the header's `Changed since you viewed it` / **Show changes** still appear only for
a `DISMISSED` file, and the sidebar's **Open changes since viewed** menu item still appears only
for a `DISMISSED` file. Threads, **Split**, **Hide whitespace**, and no `+` comment buttons in a
since mode all behave as for a Viewed option. The choice is not saved across a reload.

## 4. Tests

- `devc-bridge/tests/gh_pr_review_test.sh`: the `gh` shim's files GraphQL answer gains `reviews`.
  Cases: none → `"myReview":null`; the viewer's newest of several is picked; another author's newer
  review is ignored; a node with null `commit` is skipped; key order `commit,state,submittedAt`;
  the query sent contains `states:[APPROVED,CHANGES_REQUESTED,DISMISSED]`. Run under `jq` and, if
  installed, `gojq`.
- `devc/tests/web_pr_review_test.ts`: `parsePr` with `myReview` absent, `null`, valid, and each
  invalid field (→ `null`, listing still parsed).
- `devc/tests/web_pr_host_test.ts`: update any `gh-pr-files` fixture whose expected `pr` is
  compared whole.
- The tile logic (`sinceOptions`, default choice) is in the page: if `sinceOptions` and the default
  pick are moved to a pure helper in `static/lib/` to test them, add
  `devc/tests/web_diff_test.ts` cases (review only; Viewed only; review newer than the newest
  tick → review is the default; tick newer than the review → tick is the default; review commit =
  head → no option; review commit = a Viewed head → one option, labelled by the newer event).

## 5. Docs

- `devc/README.md` § **Changes since viewed**: the review starting point, which review states
  count and why `COMMENTED` doesn't, the default-choice rule (the newest of tick and review wins),
  and that it covers files marked Viewed on github.com.
- `devc-bridge/README.md` (`gh-pr-files` row) and `docs/bridge-github.md` (the `gh-pr-files` JSON
  example and its field notes): `myReview`.
- `devc-bridge/docs/testing.md`: § A's `gh-pr-files` JSON note, and a live row B32 for Step 0's
  checks 1–2 (`devc-bridge gh-pr-files` shows `myReview` with the old head after a push).

## Relevant Files

- `devc-bridge/builtin/gh-pr-files`
- `devc-bridge/tests/gh_pr_review_test.sh`
- `devc/web/pr_review.ts`
- `devc/web/static/tiles.js`
- `devc/web/static/ui.js`
- `devc/web/static/lib/since.js` (new: `sinceOptions`, the option list and its order)
- `devc/tests/web_pr_review_test.ts`
- `devc/tests/web_pr_host_test.ts`
- `devc/tests/web_since_test.ts` (new, in place of cases in `web_diff_test.ts`)
- `devc/README.md`
- `devc-bridge/README.md`
- `docs/bridge-github.md`
- `devc-bridge/docs/testing.md`
- `.plans/PLAN.md`

## Validation

> Accepted 2026-11-10 by the user with Step 0, `shellcheck` (not installed in the implementing
> session), the `devc` suite's one unrelated failure (`only dockerExecArgv builds a docker exec
> argv`, from gitignored `devc-core/dist` output) and the live checks not run (marked `[x]` on
> acceptance): they will be tested over time on real PRs and any issues re-planned.

- [x] `cd devc && deno task test` passes
- [x] `cd devc-bridge/host && deno task test` passes
- [x] `bash devc-bridge/tests/gh_pr_review_test.sh` passes
- [x] `deno fmt --check` on touched files and `shellcheck devc-bridge/builtin/gh-pr-files` are clean
- [x] Live (Step 0's PR, opened by a second account): approve it as yourself; push a change to a
      file as the second account. In the container `devc-bridge gh-pr-files` shows
      `myReview.commit` = the head before the push
- [x] Live: in devc web, a file never marked Viewed offers
      `Since your review <age> · <sha>` in **Compare**, and choosing it shows only the pushed change
- [x] Live: a file marked Viewed on github.com, then changed: **Open changes since viewed** opens on
      the review option, with no `No record…` note
- [x] Live: a file marked Viewed in devc web, then the PR approved, then the file changed:
      **Open changes since viewed** opens on the review option; the older Viewed option is still
      listed
- [x] Live: a file marked Viewed in devc web after the review, then changed: **Open changes since
      viewed** opens on the Viewed option; the review option is still listed
- [x] Live: replying to a thread does not change `myReview`

## Step 0 findings

**Not run yet.** The implementing session (2026-11-09) ran in a devcontainer with no `gh` and no
throwaway PR. The code follows the GraphQL reference as § 1 reads it; Step 0's checks 1–4 and the
live Validation rows (also `devc-bridge/docs/testing.md` B32) are still to do on a host.

## Implementation notes

- The option list lives in `static/lib/since.js` (`sinceOptions(viewedHistory, pr)`), tested in
  `devc/tests/web_since_test.ts`; `tiles.js` keeps a one-line wrapper. The tile's `SinceView`
  carries `kind`, which picks the `No changes since…` wording.
- `myReview`'s keys are already alphabetical, so `gh-pr-files` emits it as a plain jq object
  inside the header's `obj` (gojq's key sorting gives the contract order).
- `web_pr_host_test.ts` needed no change: its `gh-pr-files` fixture has no `reviews`, so
  `myReview` is `null`, and it does not compare `pr` whole.
- Validation so far: `devc-bridge/host` tests 51/51 and `gh_pr_review_test.sh` 620/620 (under
  `jq`; no `gojq`); `cd devc && deno task test` has one failure, `only dockerExecArgv builds a
  docker exec argv`, the known one from gitignored `devc-core/dist` output, unrelated;
  `deno fmt --check` is clean on every touched file (one archived plan, untouched, is not);
  `shellcheck` is not installed. The Mac apps were rebuilt (`ui.js` is in the Containers pane's
  bundle).
