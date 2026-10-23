// The `devc web` diff tile's patch parser and review thread placement. Pure (no DOM), shared
// with the Deno tests (`devc/tests/web_diff_test.ts`); `app.js` renders it.
//
// The patch is GitHub's per-file unified diff (`gh-pr-files`' `patch`), which is untrusted: a
// line the parser doesn't expect ends the parse, and the rest is shown as raw text.

/**
 * One diff row: a context (`' '`), added (`'+'`) or deleted (`'-'`) line with its old and new
 * line numbers (`null` where the side has none), or a `\ No newline at end of file` note with
 * neither.
 *
 * @typedef {{kind: 'context' | 'add' | 'del' | 'note', old: number | null, new: number | null,
 *   text: string}} DiffRow
 * @typedef {{header: string, oldStart: number, oldCount: number, newStart: number,
 *   newCount: number, section: string, rows: DiffRow[], whitespaceOnly?: boolean}} Hunk
 *   `whitespaceOnly`: {@link ignoreWhitespace} left it no added or deleted row
 * @typedef {{hunks: Hunk[], rest: string | null}} ParsedPatch
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses a unified diff's hunks. The first line that is neither a hunk header nor starts with a
 * space, `+`, `-` or `\` ends the parse: it and everything after it are `rest`, shown as text.
 *
 * @param {string} patch
 * @returns {ParsedPatch}
 */
export function parsePatch(patch) {
  const lines = patch.split('\n');
  // A patch's final newline is no line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk | null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = HUNK.exec(line);
    if (m) {
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5].trim(),
        rows: [],
      };
      hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    const c = line[0];
    if (hunk === null || (c !== ' ' && c !== '+' && c !== '-' && c !== '\\')) {
      return { hunks, rest: lines.slice(i).join('\n') };
    }
    const text = line.slice(1);
    if (c === ' ') {
      hunk.rows.push({ kind: 'context', old: oldLine++, new: newLine++, text });
    } else if (c === '+') {
      hunk.rows.push({ kind: 'add', old: null, new: newLine++, text });
    } else if (c === '-') {
      hunk.rows.push({ kind: 'del', old: oldLine++, new: null, text });
    } else hunk.rows.push({ kind: 'note', old: null, new: null, text: line });
  }
  return { hunks, rest: null };
}

/**
 * Where each thread goes: after the row with its `line` as the **new-file** number (an added or
 * context row), keyed `<hunk index>:<row index>`; in `file` (the File threads block) when its
 * `line` is `null` or matches no row. `gh-pr-comments` gives no diff side, so a thread on a
 * deleted line can land on the wrong row.
 *
 * @template {{line: number | null}} T
 * @param {ParsedPatch | null} parsed
 * @param {T[]} threads
 * @returns {{rows: Map<string, T[]>, file: T[]}}
 */
export function placeThreads(parsed, threads) {
  /** @type {Map<number, string>} */
  const byNew = new Map();
  parsed?.hunks.forEach((h, hi) =>
    h.rows.forEach((r, ri) => {
      if (r.new !== null && !byNew.has(r.new)) byNew.set(r.new, `${hi}:${ri}`);
    })
  );
  /** @type {Map<string, T[]>} */
  const rows = new Map();
  /** @type {T[]} */
  const file = [];
  for (const t of threads) {
    const key = t.line === null ? undefined : byNew.get(t.line);
    if (key === undefined) file.push(t);
    else rows.set(key, [...(rows.get(key) ?? []), t]);
  }
  return { rows, file };
}

/** A row's text with every whitespace character dropped: what **Hide whitespace** compares. */
function squeezed(text) {
  return text.replace(/\s+/g, '');
}

/**
 * Past this many cells (deleted rows × added rows) a change block is aligned from its ends only,
 * not by a full longest-common-subsequence table.
 */
const LCS_LIMIT = 4_000_000;

/**
 * The patch as `git diff -w` would show it: in each run of added and deleted rows, a deleted row
 * and an added row that differ only in whitespace become one context row (the new text, both
 * numbers). Rows keep their order otherwise; a hunk left with no added or deleted row is marked
 * `whitespaceOnly`. Returns a new patch; `parsed` is not changed.
 *
 * @param {ParsedPatch} parsed
 * @returns {ParsedPatch}
 */
export function ignoreWhitespace(parsed) {
  const hunks = parsed.hunks.map((hunk) => {
    /** @type {DiffRow[]} */
    const rows = [];
    let i = 0;
    while (i < hunk.rows.length) {
      const kind = hunk.rows[i].kind;
      if (kind !== 'add' && kind !== 'del') {
        rows.push(hunk.rows[i++]);
        continue;
      }
      let end = i;
      while (
        end < hunk.rows.length &&
        (hunk.rows[end].kind === 'add' || hunk.rows[end].kind === 'del')
      ) end++;
      rows.push(...realign(hunk.rows.slice(i, end)));
      i = end;
    }
    const changed = rows.some((r) => r.kind === 'add' || r.kind === 'del');
    return { ...hunk, rows, ...(changed ? {} : { whitespaceOnly: true }) };
  });
  return { hunks, rest: parsed.rest };
}

/** One change block, its whitespace-only pairs made context. @param {DiffRow[]} block */
function realign(block) {
  const dels = block.filter((r) => r.kind === 'del');
  const adds = block.filter((r) => r.kind === 'add');
  const a = dels.map((r) => squeezed(r.text));
  const b = adds.map((r) => squeezed(r.text));
  const pairs = matchLines(a, b);
  if (pairs.length === 0) return block;
  /** @type {DiffRow[]} */
  const out = [];
  let di = 0;
  let ai = 0;
  for (const [d, n] of pairs) {
    while (di < d) out.push(dels[di++]);
    while (ai < n) out.push(adds[ai++]);
    out.push({
      kind: 'context',
      old: dels[d].old,
      new: adds[n].new,
      text: adds[n].text,
    });
    di++;
    ai++;
  }
  while (di < dels.length) out.push(dels[di++]);
  while (ai < adds.length) out.push(adds[ai++]);
  return out;
}

/**
 * The index pairs `[i, j]` (both increasing) of a longest common subsequence of `a` and `b`, or,
 * past `limit` cells, of their common prefix and suffix only.
 *
 * @param {string[]} a @param {string[]} b @param {number} [limit]
 * @returns {[number, number][]}
 */
function matchLines(a, b, limit = LCS_LIMIT) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > limit) {
    /** @type {[number, number][]} */
    const head = [];
    while (head.length < Math.min(n, m) && a[head.length] === b[head.length]) {
      head.push([head.length, head.length]);
    }
    /** @type {[number, number][]} */
    const tail = [];
    while (
      head.length + tail.length < Math.min(n, m) &&
      a[n - 1 - tail.length] === b[m - 1 - tail.length]
    ) tail.unshift([n - 1 - tail.length, m - 1 - tail.length]);
    return [...head, ...tail];
  }
  // len[i * (m + 1) + j]: the LCS length of a[i..] and b[j..].
  const len = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * (m + 1) + j] = a[i] === b[j]
        ? len[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(len[(i + 1) * (m + 1) + j], len[i * (m + 1) + j + 1]);
    }
  }
  /** @type {[number, number][]} */
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i++, j++]);
    } else if (len[(i + 1) * (m + 1) + j] >= len[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * One line of the side-by-side view: the old file's row on the left, the new file's on the
 * right (`null` for a blank side), with each row's index in its hunk's `rows` (for
 * {@link placeThreads}' keys). A context row is on both sides; in a run of changed rows the
 * n-th deleted row faces the n-th added one. A `\ No newline` note sits on the side of the row
 * before it (both sides after a context row).
 *
 * @typedef {{left: DiffRow | null, right: DiffRow | null, leftIndex: number | null,
 *   rightIndex: number | null}} SplitRow
 */

/**
 * A hunk's rows, paired for the side-by-side view.
 *
 * @param {Hunk} hunk
 * @returns {SplitRow[]}
 */
export function splitRows(hunk) {
  /** @type {SplitRow[]} */
  const out = [];
  /** @type {number[]} */
  let dels = [];
  /** @type {number[]} */
  let adds = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const l = k < dels.length ? dels[k] : null;
      const r = k < adds.length ? adds[k] : null;
      out.push({
        left: l === null ? null : hunk.rows[l],
        right: r === null ? null : hunk.rows[r],
        leftIndex: l,
        rightIndex: r,
      });
    }
    dels = [];
    adds = [];
  };
  hunk.rows.forEach((row, i) => {
    if (row.kind === 'del') dels.push(i);
    else if (row.kind === 'add') adds.push(i);
    else if (row.kind === 'note') {
      const before = i > 0 ? hunk.rows[i - 1].kind : 'context';
      flush();
      out.push({
        left: before === 'add' ? null : row,
        right: before === 'del' ? null : row,
        leftIndex: before === 'add' ? null : i,
        rightIndex: before === 'del' ? null : i,
      });
    } else {
      flush();
      out.push({ left: row, right: row, leftIndex: i, rightIndex: i });
    }
  });
  flush();
  return out;
}

/** A line's words, runs of whitespace, and single other characters: what lines are diffed by. */
const TOKEN = /\w+|\s+|[^\w\s]/g;

/** Past this many cells (tokens × tokens) a pair of lines is diffed from its ends only. */
const WORD_LCS_LIMIT = 40_000;

/**
 * For each deleted or added row that faces one on the other side (as {@link splitRows} pairs
 * them), the `[from, to)` ranges of its text that its partner lacks, by a word diff (a longest
 * common subsequence of {@link TOKEN}s); adjacent changed tokens make one range. Rows with no
 * partner, and pairs with no token in common, have none: the whole line is the change.
 *
 * @param {Hunk} hunk
 * @returns {Map<number, [number, number][]>} by row index in `hunk.rows`
 */
export function changedRanges(hunk) {
  /** @type {Map<number, [number, number][]>} */
  const out = new Map();
  for (const { leftIndex, rightIndex, left, right } of splitRows(hunk)) {
    if (
      left?.kind !== 'del' || right?.kind !== 'add' || leftIndex === null ||
      rightIndex === null
    ) continue;
    const a = left.text.match(TOKEN) ?? [];
    const b = right.text.match(TOKEN) ?? [];
    const pairs = matchLines(a, b, WORD_LCS_LIMIT);
    if (pairs.length === 0) continue;
    out.set(leftIndex, unmatched(a, new Set(pairs.map(([i]) => i))));
    out.set(rightIndex, unmatched(b, new Set(pairs.map(([, j]) => j))));
  }
  return out;
}

/**
 * The character ranges of the tokens not in `kept`, adjacent ones merged.
 *
 * @param {string[]} tokens @param {Set<number>} kept
 * @returns {[number, number][]}
 */
function unmatched(tokens, kept) {
  /** @type {[number, number][]} */
  const ranges = [];
  let at = 0;
  tokens.forEach((t, i) => {
    if (!kept.has(i)) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === at) last[1] = at + t.length;
      else ranges.push([at, at + t.length]);
    }
    at += t.length;
  });
  return ranges;
}

/**
 * Highlighted text: runs of a line, each with the class names its syntax gave it (`''` for
 * none), and `changed` when it is in one of the line's {@link changedRanges}.
 *
 * @typedef {{text: string, cls: string, changed?: boolean}} Span
 */

/**
 * `spans` (one line, in order) with each of `ranges` (`[from, to)`, in order, not overlapping)
 * marked `changed`.
 *
 * @param {Span[]} spans @param {[number, number][]} ranges
 * @returns {Span[]}
 */
export function markRanges(spans, ranges) {
  return ranges.reduce((out, [from, to]) => markRange(out, from, to), spans);
}

/**
 * `spans` with `[from, to)` marked `changed`, split where the range starts and ends.
 *
 * @param {Span[]} spans @param {number} from @param {number} to
 * @returns {Span[]}
 */
function markRange(spans, from, to) {
  /** @type {Span[]} */
  const out = [];
  let at = 0;
  for (const s of spans) {
    const end = at + s.text.length;
    const cuts = [
      at,
      Math.min(Math.max(from, at), end),
      Math.min(Math.max(to, at), end),
      end,
    ];
    for (let k = 0; k < 3; k++) {
      if (cuts[k + 1] > cuts[k]) {
        out.push({
          text: s.text.slice(cuts[k] - at, cuts[k + 1] - at),
          cls: s.cls,
          ...(k === 1 || s.changed ? { changed: true } : {}),
        });
      }
    }
    at = end;
  }
  return out;
}
