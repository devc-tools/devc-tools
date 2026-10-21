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
 *   newCount: number, section: string, rows: DiffRow[]}} Hunk
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
