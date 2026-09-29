# bridge-copilot-review-gaps

Fixes the gaps found in a live run of the `copilot-pr-reviewing` skill against
deephaven/experiments#3 (the source review lives in the `devc-dev` workspace, `.plans/_ref/copilot-review-loop-gaps.md`, as background only: everything needed is restated here). The loop
reported the PR "clean" when Copilot's latest review had findings in its summary body and no
inline threads, and the bridge never returns that body. Four smaller defects turned up in the
same run.

**Depends on [bridge-gh-capabilities](bridge-gh-capabilities.md).** Every name here is post-rename:
`gh-pr-comments`, `gh-pr-reply`, `gh-pr-resolve`, `gh-pr-request-review`, `gh-doctor`,
`gh-push`, the guide at `docs/bridge-github.md`, the harness at
`devc-bridge/tests/gh_pr_review_test.sh`. Both plans edit the same scripts, guide, tests and
skill, so they can't run at once. **If `devc-bridge/builtin/gh-pr-comments` doesn't exist, stop:
the rename hasn't landed.**

## Where this departs from the review

The source review got the symptoms right. Three things here differ from it:

- **Gaps 1 and 2 have one fix: read the review from the timeline.** Today `copilotReview`'s
  `commit`/`state`/`submittedAt` come from GraphQL `pullRequest.reviews`, and `pending` comes
  from the REST issue timeline (`copilot_pending` in the shared prelude). Those are two sources
  that GitHub updates at different times. The observed `pending=false` with a stale `commit` is
  what happens when the two disagree. The timeline's `reviewed` events carry `commit_id`,
  `state`, `submitted_at` and `body`, so all of `copilotReview` (including the new `body`) comes
  from the one ordered event list that `pending` already reads. Then they can't disagree:
  `pending` is `false` only when the last Copilot event is a review, and `commit` is that
  review's commit. The review's suggested `pending` formula isn't needed.

  **Measured 2026-09-29 on PR #3** (`gh api --paginate …/issues/3/timeline` on the host).
  The timeline alternates `review_requested` and `reviewed` events, with `who` as `Copilot`
  for both. Every `reviewed` event has a 40-hex `commit_id`, a lowercase `state`
  (`commented`), `submitted_at` and a non-empty `body` (5598, 7066 and 4125 chars). The last
  one is `0dee750393be…`, submitted 20:12:56, and its request was at 20:10:51. No `reviewed`
  event has `state: pending` in the settled timeline. Keep the filter anyway, because an
  in-progress entry would only show up during the window. The observed `pending=false` with
  `commit=9f9941a…` means the timeline already ended in the `0dee750` review while GraphQL
  `reviews` still returned the older one, which is the two-source lag this plan removes.

  The latest review, fetched both ways, matches: the timeline and GraphQL `body` are
  byte-identical (4125 chars each), and `commit` and `submittedAt` are equal. `state` differs
  only in case (`commented` vs `COMMENTED`), so the `ascii_upcase` step is required.

  **What the body looks like** (the `0dee750` review). The skill's triage rules depend on
  this shape:

  ```text
  <!-- ccr-overview-v2 -->
  ## Copilot review overview
  ### 🔵 Needs a closer look
  <one-line summary>
  **Review effort:** Balanced
  **Findings:** None                          ← counts new inline findings only
  <details><summary>Resolved since last review (2)</summary> …links to threads… </details>
  <details><summary>Previously missed (3)</summary>
    <details><summary><picture …alt="Medium severity"…> Handle empty input …</summary>
    `copilot-review-sandbox/​table_stats.py:11`   ← a U+200B zero-width space after the `/`
    <explanation>
    </details> …
  </details>
  ```

  - `**Findings:** None` sat above three open findings, so it isn't a clean signal.
  - "Resolved since last review" lists threads that are already closed. It isn't new work.
  - Each finding is a nested `<details>` with a severity (`alt="… severity"`), a title, a
    backticked `path:line`, and an explanation.
  - The path has a **zero-width space (U+200B, bytes `e2 80 8b`)** inserted after a `/`.

  That's three traps for an agent reading raw markdown. So `gh-pr-comments` also parses the
  body into `copilotReview.findings` (§ 1b). `body` stays verbatim as the fallback.
- **The gap 3 exit code is the host's, not the script's.** The scripts already exit 2 with a
  specific reason for a malformed policy. The run never reached them. `grantRefusal` in
  `devc-bridge/host/core.ts` refuses first and returns `{ok: false, error}`, and the client maps
  every `ok: false` to exit 1. The fix goes in the host, and it has to work with the **already
  shipped 0.5.0 client** (the Feature pins it), so the client doesn't change.
- **The likely cause of the malformed policy is version skew,** which the review didn't
  consider. `devc` writes the policy atomically (temp + rename, `devc/bridge.ts`), so a
  half-written file isn't likely. A newer `devc` that writes a capability the running bridge
  doesn't know is likely: `parsePolicy` fails closed on an unknown capability. The diagnosis
  names that case and says to restart the bridge.

## Decisions

### 1a. `copilotReview` comes from the timeline and gains `body` (gaps 1, 2)

Change `copilot_review` and `copilot_pending` in the shared prelude. Replace them with one
function if you like, but the prelude must stay byte-identical across all four `gh-pr-*` scripts.
The GraphQL `reviews(last:100)` query is removed.

- Source: `gh api --paginate repos/<pr_repo>/issues/<n>/timeline`. `--jq` runs per page, so emit
  one line per relevant event, oldest first, as today.
- Relevant events, as today:
  - `event == "review_requested"` with `.requested_reviewer.login == $COPILOT_TIMELINE_LOGIN`
  - `event == "reviewed"` with `.user.login == $COPILOT_TIMELINE_LOGIN`

  Also **drop** any `reviewed` event whose `.state` is `pending` in any case
  (`ascii_downcase == "pending"`). An in-progress review isn't a delivered one.
- `pending` is `true` iff the last relevant event is `review_requested`. This rule is unchanged.
- The review is the **last `reviewed` event**, even if a request comes after it (that's the
  "pending, previous review shown" case). Map its fields like this:

  | Output field  | Timeline field  | Transform                                                                   |
  | ------------- | --------------- | --------------------------------------------------------------------------- |
  | `commit`      | `.commit_id`    | must match `^[0-9a-f]{40}$`, otherwise exit 4 (as today)                    |
  | `state`       | `.state`        | `ascii_upcase` (the timeline has `commented`; the contract has `COMMENTED`) |
  | `submittedAt` | `.submitted_at` | verbatim                                                                    |
  | `body`        | `.body`         | `.body // ""`, verbatim, no truncation, `<details>` kept                    |

- With no `reviewed` event, `commit`, `state`, `submittedAt` and `body` are all `null`.
- Every string reaches stdout JSON-encoded by `jq` (`tojson`). The body is arbitrary markdown:
  quotes, backslashes, newlines, `%`, non-ASCII. Never pass it through `printf`'s format string.
- `gh-pr-request-review` uses the same prelude function for `up to date:`. It now also judges
  "Copilot's latest review is of the head" from the timeline. That's intended, and its output
  lines don't change.

### 1b. `copilotReview.findings`: the body's open findings, parsed (gap 1)

The bridge parses `body` so that the agent gets structured findings and never has to read
Copilot's HTML. **The parser is part of the prelude's timeline `--jq` filter** (§ 1a), because
that's the only place it can run: `gh` applies `--jq` only to an API response, never to data
on stdin, and the scripts have no other JSON tool (see Gotchas). Define it once in the prelude,
for example as a `jq` function in a shell variable. The other three scripts ignore
`findings`.

`findings` is `null`, which tells the agent to read `body` itself, when any of these is true:

- there's no review, or `body` is `""`
- `body` doesn't contain `<!-- ccr-overview-v2 -->` (an unknown format, so don't guess)
- a section's parsed finding count doesn't equal the `(n)` in its summary. Any mismatch makes
  the whole field `null`, never a partial list.

Otherwise `findings` is an array, possibly empty, built by these rules:

- **Sections** are the top-level `<details>` blocks whose `<summary>` text (HTML tags removed,
  whitespace collapsed, trimmed) matches `^(.+) \(([0-9]+)\)$`. Group 1 is the section name
  and group 2 is the count. Top-level text outside any `<details>` is ignored.
- **Skip the section named exactly `Resolved since last review`.** Its entries are threads
  that are already closed. Every other section is open work, e.g. `Previously missed`, or
  `Comments suppressed due to low confidence` if Copilot emits it.
- **A finding** is each `<details>` block nested **directly** inside a kept section. Loose text
  in the section, such as "In code that hasn't changed since last review", is ignored.
- **Fields**, in this exact key order:

  | Field      | Value                                                                                                                 |
  | ---------- | --------------------------------------------------------------------------------------------------------------------- |
  | `section`  | the section name, e.g. `"Previously missed"`                                                                          |
  | `severity` | the word before `severity` in the summary's `alt="…"`, lowercased (`"medium"`, `"low"`), or `null`                    |
  | `title`    | the finding's `<summary>` text with tags removed, whitespace collapsed, trimmed                                       |
  | `path`     | from the first backticked `` `<path>:<line>` `` in the finding's content, with every U+200B removed, or `null`        |
  | `line`     | that `<line>` as a JSON number, or `null`                                                                             |
  | `text`     | the finding's content after `</summary>`, with the path span removed, tags removed, every U+200B removed, and trimmed |

- Remove U+200B only in `findings`. `body` stays byte-for-byte what GitHub returned.

New `gh-pr-comments` shape. Key order is exact:

```json
"copilotReview": {"commit": "…", "state": "COMMENTED", "submittedAt": "…",
  "body": "<!-- ccr-overview-v2 -->\n## Copilot review overview\n…",
  "findings": [{"section": "Previously missed", "severity": "medium",
    "title": "Handle empty input before computing statistics",
    "path": "src/stats.py", "line": 11, "text": "An empty input reaches …"}],
  "pending": false}
```

Update the header comment of `gh-pr-comments` to match.

### 2. Host grant refusals carry an exit code, and a malformed policy says why (gap 3)

**devc-core** (`devc-core/bridge.ts`): add an exported `policyProblem(text: string): string | null`
that returns the **first** reason in the order `parsePolicy` checks. Then make `parsePolicy` call
it, so the two can never disagree. Build the reasons from the existing `fieldProblem` /
`grantsProblem` strings:

| Case                   | Reason                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| a second line / a `\r` | `more than one line`                                               |
| wrong field count      | `want 4 tab-separated fields, found <n>`                           |
| a bad field            | `fieldProblem`'s string as is, e.g. `branch is empty`              |
| a bad grant list       | `grantsProblem`'s string as is, e.g. `unknown capability "gh-foo"` |

**Bridge host** (`grantRefusal` / `dispatch` in `devc-bridge/host/core.ts`): a grant refusal is
returned as `{ok: true, exitCode, stdout: "", stderr: "devc-bridge: <message>\n"}` and **not** as
`{ok: false}`. The 0.5.0 client already prints `stderr` and exits with `exitCode`, so this
changes the exit code with no client change. Every other `ok: false` (bad token, unknown or
invalid command, not executable) is unchanged.

| Refusal                                       | Exit | Message (after `devc-bridge:`)                                                                                                                                                                                                                        |
| --------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared token / no policy / not granted        | `1`  | unchanged from bridge-gh-capabilities                                                                                                                                                                                                                 |
| policy unreadable                             | `2`  | `this container's policy is unreadable and grants nothing: <error message> (<policy file>) — on the host: re-run devc up --bridge-allow <every capability this container needs>`                                                                      |
| policy malformed                              | `2`  | `this container's policy is malformed and grants nothing: <reason> (<policy file>) — on the host: re-run devc up --bridge-allow <every capability this container needs>`                                                                              |
| malformed, reason starts `unknown capability` | `2`  | `this container's policy is malformed and grants nothing: <reason> (<policy file>) — on the host: if devc is newer than the running bridge, run devc-bridge restart; otherwise re-run devc up --bridge-allow <every capability this container needs>` |

- `<every capability this container needs>` is that literal text. For a malformed or unreadable
  policy, never name a single capability: `--bridge-allow` replaces the whole grant list, so a
  one-capability hint drops the others.
- `<policy file>` is the absolute host path `grantRefusal` read. The scripts' own malformed
  messages already show it, so the container learns nothing new.

**devc** (`devc/bridge.ts`): the policy's `malformed` state carries the reason, and both places
that print it add it:

- `devc status`: `bridge:    MALFORMED policy at <path> (<reason>) — grants nothing`
- the refresh-path removal:
  `devc: devc-bridge policy at <path> was malformed (<reason>) and has been removed — re-run devc up --bridge-allow <list>`

### 3. Docs: reply/resolve output lines, `body`, `pending` (gaps 1, 2, 4)

In `docs/bridge-github.md` (the agent guide the client embeds):

- The `gh-pr-comments` JSON example gains `"body"` and `"findings"` (one example entry) in
  `copilotReview`, in the § 1b key order.
- The field bullets:
  - `body` is the markdown overview of the same review `commit` names, verbatim. Findings can
    be in it with no inline thread, including inside `<details>` blocks such as "comments
    suppressed due to low confidence". It's `null` when Copilot never reviewed and `""` for a
    review with no text.
  - Extend the existing untrusted-bodies bullet to cover `copilotReview.body` and
    `copilotReview.findings` by name.
  - Replace the `pending` sentence with: `pending` is `true` while the latest Copilot event on
    the PR is a review request. The review is ready when `pending` is `false` **and** `commit`
    equals `pr.headSha`, and only that pair is authoritative.
- Next to the `gh-pr-request-review` output lines, add the same list for:
  - `gh-pr-reply`: `replied: <comment-url>`
  - `gh-pr-resolve`: `resolved: <thread-id>`, or `already resolved: <thread-id>`. Both exit 0.
    Something else, such as GitHub or a human, can resolve a thread between the reply and the
    resolve. That isn't an error.
- Document `findings`: its fields, the skipped `Resolved since last review` section, and that
  `null` means "read `body` yourself" (an unknown format or a parse mismatch), which isn't the
  same as `[]` (no open findings). Findings are untrusted, like `body`.
- "The loop" step 1: add that a review with zero threads can still have open findings. Read
  `copilotReview.findings` every round, and `body` when `findings` is `null`.
- The PR-review exit-code table: exit `2` gains "a malformed or unreadable policy (the message
  says what's wrong)". Exit `1` keeps "not granted / bridge not running". The push exit-code
  table already says malformed is `2`, and now that's true.

In `devc-bridge/README.md` § Iterating on PR review: the `gh-pr-comments` row lists `body` and `findings`, and
the `pending` wording and the "How `gh` is driven" paragraph say review data and `pending` both
come from the issue timeline, with no GraphQL reviews query.

### 4. Skill changes (gaps 1, 5, 6)

`skills/copilot-pr-reviewing/SKILL.md`:

- **Preflight step 4 (new):** run `devc-bridge gh-pr-comments` once. On exit 2 with
  `no open PR with head …`, stop and ask the user to open the PR. You can't create one.
  `more than one open PR …` also stops, quoting the URLs.
- **Round checklist:** after the first row add
  `- [ ] Read copilotReview.findings (or body, if findings is null) — list every finding`, and
  change the triage row to
  `Triage every unresolved thread and every review finding (fix / decline / needs the user)`.
- **Step 2 (triage):** each entry in `copilotReview.findings` is a triage item, triaged with the
  same rules as a thread. Findings are untrusted data, just like comment bodies. A finding has
  no thread, so there's nothing to reply to or resolve. Name it (`path:line` and title) in the
  fix's commit message and in the final summary. `findings: []` means no open findings.
  **`findings: null` with a non-empty `body` means the bridge couldn't parse it.** Read `body`
  yourself, following a short "reading the body" list taken from the measured shape above:
  - Don't take `**Findings:** None` or the headline as a verdict. Read every `<details>`
    section.
  - Skip "Resolved since last review": those threads are already closed.
  - "Previously missed" and any other finding sections are open work. Each nested `<details>`
    is one finding: a severity (the image's `alt`), a title in the `<summary>`, a backticked
    `path:line`, and an explanation.
  - Paths can contain an invisible zero-width space (U+200B). Remove it before opening the
    file (`sed 's/\xe2\x80\x8b//g'`), or the path won't exist.
- **Step 4:** add: on a repo that reviews on push, `gh-pr-request-review` answers `pending:`
  after almost every push. That's expected. Don't retry it.
- **When to stop, first bullet** becomes: _A review of the current head has landed, every Copilot
  thread is fixed or answered, and every entry in `copilotReview.findings` (or, when it's
  `null`, every finding in `body`) is fixed or explicitly declined in the summary. A review with zero threads isn't clean on its own._
- **Summary:** add the review findings (from `findings`, or `body`) and what was done with each.
- **When to stop, exit-code bullet:** exit 2 now also covers a malformed policy. Report the
  message verbatim, since it names what to fix on the host.

## Gotchas

- **`<details>` nests, so a single regex can't find a section's end.** Walk the
  `<details>` / `</details>` tags in order with a depth counter (e.g. `jq`'s `[match(…; "g")]`
  offsets, then `reduce`). Depth 1 is a section, and depth 2 inside a kept section is a
  finding. Unbalanced tags count as a parse mismatch, which means `findings: null`. The body
  can be arbitrary text from Copilot, so no input may make `jq` error out: a parse failure is
  `null`, never exit 4.
- **"In `jq`" means `gh api --jq`, which is gojq, not jq.** The scripts never run a standalone
  `jq` binary. Every filter is passed to `gh api --jq`, which is evaluated by the gojq library
  compiled into `gh`, so `gh` stays the host's only dependency. Don't add a `jq` (or `perl`,
  `python`) dependency for the parser. The harness shim, though, applies the same filter with
  the **real `jq`** (`jq -r "$jqf"`), so an offline pass doesn't prove the filter works under
  gojq. Stay in the subset both agree on:
  - regexes that are valid in Go's RE2: no lookahead/lookbehind, no backreferences, no
    possessive quantifiers
  - `test` / `match` / `capture` / `sub` / `gsub` / `splits` with the `"g"` flag only
  - `"\u200b"` string escapes, not a regex `\x{…}`
  - `try … catch null` around the whole parse, so a gojq runtime error becomes `findings: null`

  The live Validation rows are the gojq check. If `gojq` is on `PATH` in the implementing
  environment, also make the shim prefer it (`command -v gojq`) and run the harness both ways.
- **The prelude is shared and checked.** Edit it in one script, copy it to the other three, and
  let `gh_pr_review_test.sh`'s byte-identical check confirm it.
- **The harness shim** (`devc-bridge/tests/gh_pr_review_test.sh`, the `gh` function): the
  `*'reviews(last'*` case goes away. `timeline_ev` has to emit `reviewed` events with
  `commit_id`, `state` (lowercase, as GitHub sends it), `submitted_at` and `body`. Every test
  that seeded `reviews.json` now seeds those fields on its timeline event instead. Keep the
  two-page (`timeline-2.json`) case, and put the head's review on page 2.
- **The guide reaches containers only through a client build.** `help guide` serves the copy
  embedded in the client binary. Containers on the pinned 0.5.0 client keep printing the old
  guide until the Feature's client is bumped, which is a release step after this plan, as in
  bridge-gh-capabilities. The skill is mounted from the host and updates at once. So the skill
  must state the body rule itself and not rely on the guide.
- **`ok: true` for a refusal isn't "the script ran".** Nothing downstream reads `ok` for that
  meaning, but host tests that assert `ok: false` on refusals must change to assert `exitCode`
  and `stderr`.
- **No new capability and no new command.** The capability tables, `--bridge-allow` and the
  policy format don't change.

## Checklist

- [ ] `devc-core/bridge.ts`: `policyProblem`; `parsePolicy` built on it; tests in `devc-core/tests/bridge_test.ts`
- [ ] `devc-bridge/host/core.ts`: refusals as `ok: true` with exit 1/2; malformed/unreadable messages per § 2; tests in `devc-bridge/host/tests/capabilities_test.ts`
- [ ] `devc/bridge.ts`: malformed reason in `devc status` and in the refresh removal message; tests in `devc/tests/bridge_test.ts`
- [ ] Prelude: `copilotReview` from the timeline with `body`; GraphQL reviews query removed; copied to all four `gh-pr-*` scripts; `gh-pr-comments` header comment
- [ ] Prelude timeline filter: `copilotReview.findings` parsed per § 1b; emitted by `gh-pr-comments`
- [ ] `devc-bridge/tests/gh_pr_review_test.sh`: shim and cases per § Validation
- [ ] `docs/bridge-github.md`: per § 3
- [ ] `devc-bridge/README.md`: per § 3
- [ ] `devc-bridge/docs/testing.md`: B19 expectation adds `body`; new rows B21 (review body live) and B22 (malformed policy live), matching the last two live Validation items
- [ ] `skills/copilot-pr-reviewing/SKILL.md`: per § 4

## Validation

- [ ] `cd devc-core && deno test` passes, with `policyProblem` cases: two lines → `more than one line`; three fields → `want 4 tab-separated fields, found 3`; empty branch → `branch is empty`; grants `gh-push,gh-nope` → `unknown capability "gh-nope"`; a valid policy → `null`, and `parsePolicy` agrees (null iff a problem) on every case
- [ ] `cd devc-bridge/host && deno task test && deno task check` pass, including: a malformed policy on a granted built-in → `ok: true`, `exitCode: 2`, stderr `devc-bridge: this container's policy is malformed and grants nothing: <reason> (<path>) — on the host: re-run devc up --bridge-allow <every capability this container needs>`; an unknown-capability policy → the `devc-bridge restart` variant; an unreadable one (a directory at the policy path) → exit 2, `unreadable`; not granted and no policy → exit 1 with the existing text; stderr for malformed never contains `--bridge-allow gh-`
- [ ] `cd devc && deno task test` passes, including `devc status` on a malformed policy printing `(<reason>)`, and a refresh over a malformed policy printing `was malformed (<reason>) and has been removed`
- [ ] `bash devc-bridge/tests/gh_pr_review_test.sh` → `0 failed`, including:
  - timeline ends in a Copilot request after an earlier Copilot review → `pending: true`, and `commit`/`body` are the earlier review's
  - timeline ends in a Copilot review of the head → `pending: false`, `commit == headSha`, `state == "COMMENTED"`, `body` byte-equal to a fixture body containing nested `<details>`, `"`, `\`, `%s`, a newline, `—` and a U+200B inside a backticked path (model the fixture on the measured shape above; don't copy the real PR text)
  - that review with `"body": null` → `body == ""`
  - a Copilot `reviewed` event with `state: "pending"` last → skipped (`pending` true when a request precedes it)
  - no Copilot events → `commit`, `state`, `submittedAt`, `body`, `findings` all `null`, `pending: false`
  - head's review on page 2 → found
  - `gh-pr-request-review` answers `up to date:` from a timeline review of the head, and `pending:` from a trailing request
  - `jq -c 'keys_unsorted' <<<"$(… | jq .copilotReview)"` → `["commit","state","submittedAt","body","findings","pending"]`
  - the measured-shape fixture (Resolved (2) + Previously missed (3), with one finding's path containing U+200B) → `findings` has 3 entries, all `section: "Previously missed"`, with severities `medium`, `medium`, `low`; `path` has no U+200B (`jq -r '.copilotReview.findings[].path' | grep -c $'\u200b'` → 0); `line` is a number; no entry comes from the Resolved section; `body` still contains the U+200B
  - that fixture with `Previously missed (4)` → `findings: null`
  - a body without `<!-- ccr-overview-v2 -->` → `findings: null`, `body` verbatim
  - a marked body whose only section is `Resolved since last review (2)` → `findings: []`
  - no review → `findings: null`
  - a body with an unclosed `<details>` → `findings: null`, exit 0
  - `gh-pr-request-review` and `gh-pr-resolve` still pass their existing cases with the larger prelude filter
  - the prelude is byte-identical across the four scripts
- [ ] `grep -n 'reviews(last' devc-bridge/builtin/gh-pr-*` prints nothing
- [ ] `grep -n 'already resolved:' docs/bridge-github.md` and `grep -n 'copilotReview.body\|"body"' docs/bridge-github.md` each find the new text, and the `body` bullet says untrusted
- [ ] `grep -n 'copilotReview.findings' skills/copilot-pr-reviewing/SKILL.md` finds the checklist row, step 2 and the stop condition, and `grep -n 'U+200B' skills/copilot-pr-reviewing/SKILL.md` finds the fallback reading list; `grep -n 'gh-pr-comments' skills/copilot-pr-reviewing/SKILL.md` finds preflight step 4
- [ ] `deno fmt --check` on changed `.ts`/`.md`; `shellcheck` on the four scripts if installed
- [ ] Live (host on the new build, `devc-bridge restart`; container `devc up --bridge-allow gh` pinned to `bmingles_copilot-review-loop`, PR deephaven/experiments#3): `devc-bridge gh-pr-comments | jq -r .copilotReview.body | head -20` prints the start of the "Needs a closer look" overview for `0dee750393be`, `.copilotReview.state` is `COMMENTED`, and `jq -c '.copilotReview.findings[] | [.severity, .path, .line]'` prints three findings: `copilot-review-sandbox/table_stats.py` lines 11, 53 and 50, with no U+200B
- [ ] Live: push a commit, then poll `gh-pr-comments` every 30s until the review lands. No poll shows `pending == false` with `commit != headSha`, unless the timeline has no Copilot request for the head (the repo didn't auto-review)
- [ ] Live: on the host, overwrite the container's policy with `gh-push,gh-nope` in the grants field, then in the container `devc-bridge gh-doctor; echo $?` → the `unknown capability "gh-nope"` message with the `devc-bridge restart` hint, and `2`
- [ ] Live: re-run `/copilot-pr-reviewing` on PR #3. The agent lists the overview's findings as triage items and doesn't call the PR clean while any are open

## Relevant Files

- `devc-core/bridge.ts`
- `devc-core/tests/bridge_test.ts`
- `devc/bridge.ts`
- `devc/tests/bridge_test.ts`
- `devc-bridge/host/core.ts`
- `devc-bridge/host/tests/capabilities_test.ts`
- `devc-bridge/builtin/gh-pr-comments`
- `devc-bridge/builtin/gh-pr-reply`
- `devc-bridge/builtin/gh-pr-resolve`
- `devc-bridge/builtin/gh-pr-request-review`
- `devc-bridge/tests/gh_pr_review_test.sh`
- `devc-bridge/README.md`
- `devc-bridge/docs/testing.md`
- `docs/bridge-github.md`
- `skills/copilot-pr-reviewing/SKILL.md`
- `.plans/PLAN.md`
