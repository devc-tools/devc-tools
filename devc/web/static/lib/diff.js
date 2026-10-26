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
 *   text: string, filled?: boolean}} DiffRow
 *   `filled`: an unchanged line {@link fillPatch} added from the file, not in the patch
 * @typedef {{header: string, oldStart: number, oldCount: number, newStart: number,
 *   newCount: number, section: string, rows: DiffRow[], whitespaceOnly?: boolean}} Hunk
 *   `whitespaceOnly`: {@link ignoreWhitespace} left it no added or deleted row
 * @typedef {{hunks: Hunk[], rest: string | null}} ParsedPatch
 */

import { splitMarkers } from './pr_tree.js';

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
 * A thread's place as {@link placeThreads} and {@link threadRows} read it: `line` on `diffSide`
 * (`LEFT` counts the old file's numbers, anything else the new file's), a block from `startLine`
 * on `startDiffSide` (`diffSide` when unset), and `subjectType: 'FILE'` for the whole file.
 *
 * @typedef {{line: number | null, startLine?: number | null, diffSide?: string,
 *   startDiffSide?: string | null, subjectType?: string}} ThreadPlace
 */

/** The row field a side's line numbers are in. @param {string | null | undefined} side */
function sideField(side) {
  return side === 'LEFT' ? 'old' : 'new';
}

/**
 * Where each thread goes: after the last row whose number on its side is its `line` — a `LEFT`
 * thread's by the **old-file** number (a deleted or context row), any other's by the **new-file**
 * number (an added or context row) — keyed `<hunk index>:<row index>`; in `file` (the File
 * threads block) when it is a file comment, its `line` is `null`, or it matches no row.
 *
 * @template {ThreadPlace} T
 * @param {ParsedPatch | null} parsed
 * @param {T[]} threads
 * @returns {{rows: Map<string, T[]>, file: T[]}}
 */
export function placeThreads(parsed, threads) {
  /** @type {{old: Map<number, string>, new: Map<number, string>}} */
  const by = { old: new Map(), new: new Map() };
  parsed?.hunks.forEach((h, hi) =>
    h.rows.forEach((r, ri) => {
      if (r.old !== null) by.old.set(r.old, `${hi}:${ri}`);
      if (r.new !== null) by.new.set(r.new, `${hi}:${ri}`);
    })
  );
  /** @type {Map<string, T[]>} */
  const rows = new Map();
  /** @type {T[]} */
  const file = [];
  for (const t of threads) {
    const key = t.line === null || t.subjectType === 'FILE'
      ? undefined
      : by[sideField(t.diffSide)].get(t.line);
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

/**
 * The rows a thread is on, as {@link placeThreads} keys: from the first row whose number on the
 * start side (`startDiffSide`, else `diffSide`) is at least its `startLine` (its `line` when it
 * has none) to the last row whose number on its side is at most its `line`, notes left out. On
 * one side that is the rows numbered `startLine`–`line` there and the other side's rows between
 * them. None for a file comment, a thread with no `line`, or one whose lines the patch doesn't
 * show.
 *
 * @param {ParsedPatch | null} parsed
 * @param {ThreadPlace} thread
 * @returns {string[]}
 */
export function threadRows(parsed, thread) {
  const last = thread.line;
  if (parsed === null || last === null || thread.subjectType === 'FILE') {
    return [];
  }
  const end = sideField(thread.diffSide);
  const start = thread.startLine == null
    ? end
    : sideField(thread.startDiffSide ?? thread.diffSide);
  const first = thread.startLine ?? last;
  /** @type {{key: string, row: DiffRow}[]} */
  const all = parsed.hunks.flatMap((h, hi) =>
    h.rows.map((row, ri) => ({ key: `${hi}:${ri}`, row }))
  );
  const from = all.findIndex(({ row }) =>
    row[start] !== null && row[start] >= first
  );
  const to = all.findLastIndex(({ row }) =>
    row[end] !== null && row[end] <= last
  );
  if (from < 0 || to < from) return [];
  return all.slice(from, to + 1).filter(({ row }) => row.kind !== 'note')
    .map(({ key }) => key);
}

/** Past this many lines on either side, {@link diffTexts} does not compare. */
export const MAX_DIFF_LINES = 20_000;

/**
 * A text's lines as {@link diffTexts} compares them: split on `\n`, each line's trailing `\r`
 * dropped, and the empty line after a final newline not a line.
 *
 * @param {string} text
 */
function textLines(text) {
  const lines = text.split('\n').map((l) =>
    l.endsWith('\r') ? l.slice(0, -1) : l
  );
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * `parsed` with every unchanged line between, before and after its hunks filled in from
 * `headText` (the file at the PR's head), each filled row marked `filled: true`. `null` when
 * the patch does not match the text. Hunks stay one for one: a gap's rows go at the start of the
 * hunk after it, the lines after the last hunk at that hunk's end.
 *
 * @param {ParsedPatch} parsed @param {string} headText
 * @returns {ParsedPatch | null}
 */
export function fillPatch(parsed, headText) {
  if (parsed.rest !== null || parsed.hunks.length === 0) return null;
  const head = textLines(headText);
  const noCr = (/** @type {string} */ t) =>
    t.endsWith('\r') ? t.slice(0, -1) : t;
  /** @param {number} oldFrom @param {number} newFrom @param {number} n */
  const fill = (oldFrom, newFrom, n) =>
    Array.from({ length: n }, (_, k) => ({
      kind: /** @type {const} */ ('context'),
      old: oldFrom + k,
      new: newFrom + k,
      text: head[newFrom + k - 1],
      filled: true,
    }));
  let oldNext = 1;
  let newNext = 1;
  /** @type {Hunk[]} */
  const hunks = [];
  for (const hunk of parsed.hunks) {
    // A side with no lines starts after its start number, as diff writes it.
    const oldFirst = hunk.oldCount > 0 ? hunk.oldStart : hunk.oldStart + 1;
    const newFirst = hunk.newCount > 0 ? hunk.newStart : hunk.newStart + 1;
    const gap = newFirst - newNext;
    if (gap < 0 || oldFirst - oldNext !== gap) return null;
    if (newFirst + hunk.newCount - 1 > head.length) return null;
    for (const row of hunk.rows) {
      if (
        (row.kind === 'context' || row.kind === 'add') &&
        (row.new === null || noCr(row.text) !== head[row.new - 1])
      ) return null;
    }
    hunks.push({
      ...hunk,
      rows: [...fill(oldNext, newNext, gap), ...hunk.rows],
    });
    oldNext = oldFirst + hunk.oldCount;
    newNext = newFirst + hunk.newCount;
  }
  const last = hunks[hunks.length - 1];
  last.rows.push(...fill(oldNext, newNext, head.length - newNext + 1));
  return { hunks, rest: null };
}

/**
 * A unified diff of two whole texts, as {@link parsePatch} would read `diff -U<context>`'s: hunks
 * of changed lines with `context` unchanged lines around them, merged when they touch, each
 * headed `-a,b +c,d` between `@@`s. Lines are compared whole by Myers' O(ND) algorithm; a run of changes lists
 * its deleted rows before its added ones. Identical texts give no hunks; `null` past
 * {@link MAX_DIFF_LINES} lines on either side.
 *
 * @param {string} oldText @param {string} newText @param {number} [context]
 * @returns {ParsedPatch | null}
 */
export function diffTexts(oldText, newText, context = 3) {
  const a = textLines(oldText);
  const b = textLines(newText);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // Lines as numbers, so the comparisons are cheap.
  /** @type {Map<string, number>} */
  const ids = new Map();
  const id = (/** @type {string} */ l) => {
    let n = ids.get(l);
    if (n === undefined) ids.set(l, n = ids.size);
    return n;
  };
  const ai = Int32Array.from(a, id);
  const bi = Int32Array.from(b, id);
  /** @type {DiffRow[]} */
  const rows = [];
  let i = 0;
  let j = 0;
  const changes = (/** @type {number} */ toA, /** @type {number} */ toB) => {
    while (i < toA) {
      rows.push({ kind: 'del', old: i + 1, new: null, text: a[i++] });
    }
    while (j < toB) {
      rows.push({ kind: 'add', old: null, new: j + 1, text: b[j++] });
    }
  };
  // Two texts with no line in common (the worst case for Myers) need no search.
  const inA = new Set(ai);
  const shared = bi.some((n) => inA.has(n));
  for (const [x, y] of shared ? commonLines(ai, bi) : []) {
    changes(x, y);
    rows.push({ kind: 'context', old: i + 1, new: j + 1, text: b[j] });
    i++;
    j++;
  }
  changes(a.length, b.length);
  /** @type {Hunk[]} */
  const hunks = [];
  /** Where the last hunk's rows end, in `rows`. */
  let end = 0;
  let k = 0;
  while (k < rows.length) {
    if (rows[k].kind === 'context') {
      k++;
      continue;
    }
    let from = Math.max(0, k - context);
    // Extend over changes whose context touches or overlaps this one's.
    let last = k;
    for (let m = k + 1; m < rows.length && m - last <= 2 * context + 1; m++) {
      if (rows[m].kind !== 'context') last = m;
    }
    const to = Math.min(rows.length, last + context + 1);
    if (from < end) from = end;
    const hunkRows = rows.slice(from, to);
    // A side with no rows here starts after the line before the hunk, as diff writes it.
    const before = rows.slice(0, from);
    const oldRows = hunkRows.filter((r) => r.old !== null);
    const newRows = hunkRows.filter((r) => r.new !== null);
    const oldStart = oldRows.length
      ? /** @type {number} */ (oldRows[0].old)
      : before.filter((r) => r.old !== null).length;
    const newStart = newRows.length
      ? /** @type {number} */ (newRows[0].new)
      : before.filter((r) => r.new !== null).length;
    hunks.push({
      header:
        `@@ -${oldStart},${oldRows.length} +${newStart},${newRows.length} @@`,
      oldStart,
      oldCount: oldRows.length,
      newStart,
      newCount: newRows.length,
      section: '',
      rows: hunkRows,
    });
    end = to;
    k = to;
  }
  return { hunks, rest: null };
}

/**
 * The index pairs `[x, y]` (both increasing) of a longest common subsequence of `a` and `b`, by
 * Myers' linear-space O(ND) algorithm: each step finds the middle snake of the remaining box and
 * recurses on the two halves around it.
 *
 * @param {Int32Array} a @param {Int32Array} b
 * @returns {[number, number][]}
 */
function commonLines(a, b) {
  /** @type {[number, number][]} */
  const out = [];
  const size = a.length + b.length + 2;
  const vf = new Int32Array(2 * size + 1);
  const vb = new Int32Array(2 * size + 1);
  /** @param {number} aLo @param {number} aHi @param {number} bLo @param {number} bHi */
  const walk = (aLo, aHi, bLo, bHi) => {
    // Common head and tail first: most of a file is unchanged.
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      out.push([aLo++, bLo++]);
    }
    /** @type {[number, number][]} */
    const tail = [];
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      tail.push([--aHi, --bHi]);
    }
    if (aLo < aHi && bLo < bHi) {
      const [x, y, u, v] = middleSnake(a, aLo, aHi, b, bLo, bHi, vf, vb, size);
      walk(aLo, x, bLo, y);
      for (let s = 0; s < u - x; s++) out.push([x + s, y + s]);
      walk(u, aHi, v, bHi);
    }
    for (let t = tail.length - 1; t >= 0; t--) out.push(tail[t]);
  };
  walk(0, a.length, 0, b.length);
  return out;
}

/**
 * The middle snake of the box `a[aLo..aHi)` × `b[bLo..bHi)` (both non-empty, ends differing):
 * `[x, y, u, v]`, the snake from `(x, y)` to `(u, v)` in absolute indexes on an optimal path.
 * `vf` and `vb` are scratch arrays indexed by diagonal + `off`.
 *
 * @param {Int32Array} a @param {number} aLo @param {number} aHi
 * @param {Int32Array} b @param {number} bLo @param {number} bHi
 * @param {Int32Array} vf @param {Int32Array} vb @param {number} off
 * @returns {[number, number, number, number]}
 */
function middleSnake(a, aLo, aHi, b, bLo, bHi, vf, vb, off) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const max = Math.ceil((n + m) / 2);
  vf[off + 1] = 0;
  vb[off + 1] = 0;
  for (let d = 0; d <= max; d++) {
    // Forward: x on diagonal k = x - y, from (0, 0).
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])
        ? vf[off + k + 1]
        : vf[off + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      vf[off + k] = x;
      // Backward diagonal c = delta - k, its x counted from the end.
      if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
        if (x + vb[off + delta - k] >= n) {
          return [aLo + x0, bLo + y0, aLo + x, bLo + y];
        }
      }
    }
    // Backward: x counted from (n, m) on diagonal c, the forward diagonal being delta - c.
    for (let c = -d; c <= d; c += 2) {
      let x = c === -d || (c !== d && vb[off + c - 1] < vb[off + c + 1])
        ? vb[off + c + 1]
        : vb[off + c - 1] + 1;
      let y = x - c;
      const x0 = x;
      const y0 = y;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      vb[off + c] = x;
      const k = delta - c;
      if (!odd && k >= -d && k <= d) {
        if (x + vf[off + k] >= n) {
          return [aHi - x, bHi - y, aHi - x0, bHi - y0];
        }
      }
    }
  }
  throw new Error('middleSnake: no overlap');
}

/**
 * The UTF-16 offset in `text` of displayed offset `shown` in `markedText(text)` (`ui.js`), which
 * draws each invisible character as a longer `⟨U+XXXX⟩` marker: what a diff tile's hover turns
 * the mouse's place in a row into, as an LSP `character`. An offset inside a marker is its
 * character's start; one past the end is `text.length`.
 *
 * @param {string} text @param {number} shown
 */
export function newColumn(text, shown) {
  let at = 0; // in `text`
  let left = shown; // in what is displayed
  for (const part of splitMarkers(text)) {
    if (typeof part === 'string') {
      if (left <= part.length) return at + left;
      at += part.length;
      left -= part.length;
      continue;
    }
    const width = /** @type {number} */ (text.codePointAt(at)) > 0xffff ? 2 : 1;
    if (left < part.marker.length) return at;
    at += width;
    left -= part.marker.length;
  }
  return text.length;
}

/**
 * Maps `fromText`'s lines onto `toText`'s: `map(line)` is the 0-based line of `toText` that line
 * `line` of `fromText` is unchanged as, or null when it was changed or deleted (or either text is
 * past {@link MAX_DIFF_LINES}). What a diff tile's hover uses when an open tile holds the file
 * with other text than the PR head's.
 *
 * @param {string} fromText @param {string} toText
 * @returns {(line: number) => number | null}
 */
export function lineMap(fromText, toText) {
  if (fromText === toText) return (line) => line;
  // Context as long as the texts: every unchanged line is a context row, with both numbers.
  const parsed = diffTexts(fromText, toText, MAX_DIFF_LINES);
  if (!parsed) return () => null;
  /** @type {Map<number, number>} */
  const map = new Map();
  for (const hunk of parsed.hunks) {
    for (const row of hunk.rows) {
      if (row.kind === 'context' && row.old !== null && row.new !== null) {
        map.set(row.old - 1, row.new - 1);
      }
    }
  }
  return (line) => map.get(line) ?? null;
}
