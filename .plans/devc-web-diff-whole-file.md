# devc-web-diff-whole-file

## Checklist

- [x] Pure helper in `devc/web/static/lib/diff.js` that fills a parsed patch out to the whole
      file, per [Filling the patch](#filling-the-patch)
- [x] **Whole file** toggle in the diff tile's tools, remembered per browser, per
      [Toggle](#toggle)
- [x] Head text read once and shared with hover (`view.head`), per [Head text](#head-text)
- [x] Drawing: no hunk bars, highlighting across the file, no `+` on filled rows, per
      [Drawing](#drawing)
- [x] Since viewed in whole-file mode, per [Since viewed](#since-viewed)
- [x] Fallbacks: loading, too large, read failure, mismatch, per [Fallbacks](#fallbacks)
- [x] Tests in `devc/tests/web_diff_test.ts`, per [Tests](#tests)
- [x] `devc/README.md` **Pull requests** section, per [Docs](#docs)
- [x] Run every [Validation](#validation) item an agent can run; hand the **(human)** items to
      the user
- [x] `deno fmt` every touched file

A PR diff tile today shows GitHub's per-file `patch`: changed lines with 3 unchanged lines
around them, and a muted `@@ … @@` bar where unchanged lines are left out. **Whole file**
shows every line of the file instead, like VS Code's diff with **Hide Unchanged Regions** off.
The changed rows and their numbers stay the same, so threads, comments, hover and **Hide
whitespace** keep working.

**Who runs what.** Items marked **(human)** need devc web on a host with Docker, a browser, and
a repo with an open pull request whose checkout is pinned in devc web. Everything else runs in
the devcontainer.

## Scope

- In: **PR changes** (GitHub's patch) and **Since viewed** comparisons, in unified and split
  layouts, with and without **Hide whitespace**.
- Out: expanding one gap at a time (click a bar to show its lines), new host messages, and any
  change to `pr_review.ts` or the bridge.
- Added and removed files (`oneSided`) already show the whole file: there is no toggle for them.
  A file with no `patch` (binary, or too large for GitHub) has no toggle either.

## Filling the patch

The PR's patch is filled in from **the file at the PR's head** only. No base commit is needed:
every line outside the patch's hunks is unchanged, so its text is the head's line and its old
number follows from the hunks before it.

Add to `lib/diff.js` (exported, so tests can reach it):

```js
/**
 * `parsed` with every unchanged line between, before and after its hunks filled in from
 * `headText` (the file at the PR's head), each filled row marked `filled: true`. `null` when
 * the patch does not match the text.
 *
 * @param {ParsedPatch} parsed @param {string} headText
 * @returns {ParsedPatch | null}
 */
export function fillPatch(parsed, headText)
```

- **Head lines:** `textLines(headText)` (already in `diff.js`: split on `\n`, trailing `\r`
  dropped, no empty last line after a final newline).
- **Hunks are kept, one for one, in order.** Filled rows go **at the start** of the hunk that
  follows the gap. The lines after the last hunk go at the end of the last hunk. Hunk indices
  never change, so `NewComment.hunk`, `anchor.hunk` and the one-hunk rule for multi-line
  comments still hold. A range between two of a hunk's patch rows never contains filled rows,
  because filled rows only come before the first patch row or after the last.
- **Where a hunk starts:** a side whose count is 0 starts _after_ its start number, as diff
  writes it (`-5,0` is "after line 5"). So a side's first line is `start` when `count > 0`,
  else `start + 1`.
- **Counters:** `oldNext = newNext = 1` to begin. For each hunk, `gap = newFirst - newNext`
  (`newFirst` is the hunk's first new line, as above). The old side's gap
  (`oldFirst - oldNext`) must be the same, else return `null`. Filled rows are
  `{kind: 'context', old: oldNext + k, new: newNext + k, text: headLines[newNext + k - 1],
  filled: true}` for `k` in `0 … gap - 1`. After the hunk, `oldNext = oldFirst + oldCount` and
  `newNext = newFirst + newCount`. After the last hunk, fill `newNext … headLines.length` the
  same way, appended to the last hunk.
- **Check against the text.** Return `null` if:
  - a hunk's new side runs past `headLines.length`;
  - any `context` or `add` row's text, without a trailing `\r`, differs from
    `headLines[row.new - 1]`;
  - any gap is negative;
  - `parsed.rest !== null` (a patch that didn't parse to the end is not filled).
- **Header and counts:** a hunk's `header`, `oldStart`, `oldCount`, `newStart`, `newCount` and
  `section` are left as they were. They are not drawn in whole-file mode.
- A patch with no hunks returns `null`.
- Add `filled?: boolean` to the `DiffRow` typedef.

`ignoreWhitespace` runs **after** filling. Filled rows are `context`, so it passes them through.

## Toggle

- A checkbox labelled **Whole file** in `.diff-tools`, between the **Unified | Split** group and
  **Hide whitespace**, built with the existing `checkbox` helper.
- Remembered per browser like the other toggles: `localStorage` key
  `devc-web-pr-whole-file-v1`, `'1'` on, default off, using `loadFlag` / `saveFlag`.
- Global, like **Split**: toggling it redraws every open diff tile.
- Shown only when the tile is **not** `oneSided(view)` and either `view.since` is set or
  `view.data.file.patch` is a string.
- Toggling clears every view's `openFolds` (row keys change with the rows, as with **Hide
  whitespace**). An open new comment stays open: it is keyed by side, line and hunk, which
  filling does not change.

## Head text

The hover code already reads the PR head's text into `view.head`
(`{sha, got: Promise<{text, message}>}`, keyed by `data.pr.headSha`, via `pr_file_at`). Move
that read into one helper that both hover and **Whole file** call, so a tile reads the head at
most once per head sha. A refresh that changes `headSha` reads it again (as today).

When **Whole file** is on and the tile is showing **PR changes**, the tile starts the head read
as soon as `pr_diff` answers (not lazily, as hover does), and redraws when it arrives.

The filled patch is cached on the view for its `(parsed, head text)` pair. `shownPatch`'s cache
also keys on whether whole file is on, alongside `source` and `whitespace`.

## Drawing

In whole-file mode, in `renderDiff`:

- **No hunk bars.** The `.diff-hunk` rows, and their `· whitespace only` note, are not drawn.
  The rows of every hunk follow each other with no break.
- **Highlighting runs across the whole file.** `shownPatch` highlights each side as one text over
  all hunks (the old side's `context` and `del` rows of every hunk, in order; the new side's
  `context` and `add` rows), not one text per hunk. `changedRanges` stays per hunk.
- **No `+` on filled rows.** GitHub accepts review comments only on lines in the patch, so
  `numCell` gets no `diff-add-comment` button for a row with `filled: true`, in both layouts.
- **Threads** are placed by `placeThreads` on the filled patch, unchanged. A thread whose line
  is now on a filled row sits there rather than under **File threads**.
- **Hover** works on filled rows unchanged: they are context rows with a `new` number.
- Filled rows look like any other context row. There is no extra styling.

## Since viewed

When **Whole file** is on, a Since viewed comparison is
`diffTexts(beforeText, nowText, MAX_DIFF_LINES)`. Both texts are already capped at
`MAX_DIFF_LINES`, so this gives one hunk holding every line. Keep both texts on the
`SinceView`, so toggling recomputes `parsed` without reading the files again. Identical texts
still give no hunks and show `LABELS.noChangesSinceViewed`, as today. Comments are already off
in Since viewed, so no `+` rule applies there.

## Fallbacks

Whole file never blocks the diff. Whenever it can't be shown, the tile draws the condensed patch
as today, under a one-line `.diff-message` note above the table:

| Situation                                               | Note (`LABELS` entry, in `ui.js`)                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| head text still loading                                 | `Loading the whole file…`                                             |
| `pr_file_at` failed (`available !== true`, or it threw) | `Whole file unavailable: <message>`                                   |
| head text over `MAX_DIFF_LINES` lines                   | `Too large to show whole (over 20000 lines)`                          |
| `fillPatch` returned `null`                             | `Whole file unavailable: the file at the head doesn't match the diff` |

The `20000` comes from `MAX_DIFF_LINES`, not a literal. `pr_file_at`'s own refusals (binary,
over 1 MB, gone) come through as `<message>`.

## Tests

In `devc/tests/web_diff_test.ts`, for `fillPatch`:

- Two hunks with a gap between them and lines before the first and after the last: every line
  of the head appears once, in order. Filled rows have `filled: true` and `kind: 'context'`,
  and the numbers are right on both sides when a hunk adds more lines than it deletes (old
  numbers after it lag new by the difference).
- Hunk count and order are unchanged. Each hunk's patch rows are still there, in order, and
  filled rows only come before the first patch row or (last hunk only) after the last.
- A hunk at line 1 (no leading fill), and a hunk ending on the last line (no trailing fill).
- A pure insertion `-5,0 +6,2` and a pure deletion `-6,2 +5,0`: start-after-line rule.
- `\ No newline at end of file` note rows are kept where they were.
- CRLF head text matches a patch whose rows end in `\r`.
- `null` for: a context row whose text differs from the head; a hunk past the head's end; a
  patch with `rest`; a patch with no hunks.
- `ignoreWhitespace(fillPatch(...))` keeps every filled row.

And for Since viewed: `diffTexts(a, b, MAX_DIFF_LINES)` on texts with two changes far apart
gives one hunk holding every line of both texts.

## Docs

`devc/README.md`, **Pull requests**: after the **Hide whitespace** sentence, add a sentence on
**Whole file**: every line of the file instead of only the changed ones and their nearby lines,
filled in from the file at the PR's head (comments still only on the patch's lines). Change
"All four toggles are remembered per browser" to "All five toggles…".

## Validation

- [x] `cd devc && deno test --allow-run --allow-read --allow-write --allow-env tests/web_diff_test.ts`
      passes, including the new `fillPatch` and whole-file Since viewed tests
- [x] `cd devc && deno task test` passes
- [x] `cd devc && deno lint && deno fmt --check` pass
      (lint: no findings in the touched code; the tree's existing `no-import-prefix` /
      `no-unversioned-import` findings on test files' `jsr:` imports were already there)
- [ ] **(human)** A modified file with two or more hunks, **Whole file** on, Split: no `@@` bars;
      line numbers run unbroken 1…N on the right and 1…M on the left; rows between hunks are
      unshaded context. Unified: the same.
- [ ] **(human)** Toggle off and on: the condensed view comes back with its bars, and the setting
      survives a page reload.
- [ ] **(human)** With **Whole file** on: a `+` on a changed row and on a context row from the
      patch opens a comment; filled rows have no `+`. An existing thread still sits on its row.
- [ ] **(human)** Syntax colours are right on a line just after a former hunk boundary that falls
      inside a block comment or template literal (e.g. the `` `${ `` case in a TS file).
- [ ] **(human)** **Hide whitespace** together with **Whole file**: whitespace-only changes turn to
      context, filled rows stay.
- [ ] **(human)** **Compare → Since viewed** with **Whole file** on shows the whole file; toggling
      it does not re-read (no `Loading…`).
- [ ] **(human)** Hover (with a language server) works on a filled row.
- [ ] **(human)** An added file and a removed file show no **Whole file** checkbox.

## Relevant Files

- `devc/web/static/lib/diff.js` — `fillPatch`, `filled` on `DiffRow`
- `devc/web/static/tiles.js` — toggle, flag, head read shared with hover, `shownPatch` cache and
  whole-file highlighting, `renderDiff` drawing and fallbacks, `loadSince` keeping both texts
- `devc/web/static/ui.js` — `LABELS` for the toggle and the four notes
- `devc/web/static/style.css` — only if the note above the table needs spacing beyond
  `.diff-message`
- `devc/tests/web_diff_test.ts` — tests
- `devc/README.md` — **Pull requests** section
