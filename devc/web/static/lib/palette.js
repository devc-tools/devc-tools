// Pure helpers for the `devc web` file palette (`palette.js`): its shortcut, fuzzy matching and
// ranking of a repo's files, the list an empty query shows, and the recently opened files kept
// in `localStorage`. Tested from `devc/tests/web_palette_test.ts`. No DOM access here.

/** The `localStorage` key of the recently opened files, `{[root]: paths newest first}`. */
export const RECENTS_KEY = 'devc-web-palette-recent-v1';

/** The most recent files kept per repo root. */
export const MAX_RECENTS = 20;

/** The most repo roots recent files are kept for. */
export const MAX_RECENT_ROOTS = 50;

/**
 * Whether a keydown is the palette's shortcut: Cmd+P on a Mac, Ctrl+Alt+P elsewhere (Ctrl+P is
 * the terminals' previous-history). Matched on `code`, since a Mac's Option changes `key`.
 *
 * @param {{code: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean}} e
 * @param {boolean} isMac
 */
export function isPaletteShortcut(e, isMac) {
  if (e.code !== 'KeyP' || e.shiftKey) return false;
  return isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && e.altKey && !e.metaKey;
}

/** Each file list's lower-cased paths, made once per list. @type {WeakMap<readonly string[], string[]>} */
const lowered = new WeakMap();

/** @param {readonly string[]} files */
function lowerCased(files) {
  let lower = lowered.get(files);
  if (!lower) {
    lower = files.map((f) => f.toLowerCase());
    lowered.set(files, lower);
  }
  return lower;
}

/** Whether `q` is a subsequence of `s` from index `from`. Allocates nothing. */
function isSubsequence(q, s, from) {
  let qi = 0;
  for (let i = from; i < s.length && qi < q.length; i++) {
    if (s.charCodeAt(i) === q.charCodeAt(qi)) qi++;
  }
  return qi === q.length;
}

/** The greedy leftmost indices of subsequence `q` in `s`, from index `from`. */
function greedy(q, s, from) {
  const positions = [];
  let qi = 0;
  for (let i = from; i < s.length && qi < q.length; i++) {
    if (s.charCodeAt(i) === q.charCodeAt(qi)) {
      positions.push(i);
      qi++;
    }
  }
  return positions;
}

/** `n` indices from `start`. */
function run(start, n) {
  return Array.from({ length: n }, (_, i) => start + i);
}

/**
 * The files matching `query`, best first, at most `limit`: those `query` (lower-cased, all
 * whitespace removed) is a subsequence of, case-insensitively. Ranked by tier — the basename
 * equals it, starts with it, contains it, holds it as a subsequence; then the path contains it,
 * holds it as a subsequence — then shorter paths, then by code unit. `positions` are the indices
 * in `path` of the matched characters. An empty query matches nothing.
 *
 * @param {string} query
 * @param {readonly string[]} files
 * @param {number} limit
 * @returns {{path: string, positions: number[]}[]}
 */
export function rankFiles(query, files, limit) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return [];
  const lower = lowerCased(files);
  /** @type {{path: string, positions: number[], tier: number}[]} */
  const matches = [];
  for (let k = 0; k < files.length; k++) {
    const s = lower[k];
    if (!isSubsequence(q, s, 0)) continue;
    const bs = s.lastIndexOf('/') + 1;
    const base = s.slice(bs);
    let tier;
    let positions;
    if (base === q) {
      tier = 1;
      positions = run(bs, q.length);
    } else if (base.startsWith(q)) {
      tier = 2;
      positions = run(bs, q.length);
    } else if (base.includes(q)) {
      tier = 3;
      positions = run(bs + base.indexOf(q), q.length);
    } else if (isSubsequence(q, s, bs)) {
      tier = 4;
      positions = greedy(q, s, bs);
    } else if (s.includes(q)) {
      tier = 5;
      positions = run(s.indexOf(q), q.length);
    } else {
      tier = 6;
      positions = greedy(q, s, 0);
    }
    matches.push({ path: files[k], positions, tier });
  }
  matches.sort((a, b) =>
    a.tier - b.tier || a.path.length - b.path.length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
  return matches.slice(0, limit).map(({ path, positions }) => ({
    path,
    positions,
  }));
}

/**
 * What an empty query lists, de-duplicated, at most `limit`: the files of repo `root` open in file
 * tiles, most recently focused first, then its `recent` files that are in `listed` (all of them
 * while `listed` is null: no listing yet).
 *
 * @param {readonly {kind: string, focusSeq: number,
 *   file: {root: string, path: string, container?: boolean} | null}[]} tiles
 * @param {string} root
 * @param {readonly string[]} recent
 * @param {ReadonlySet<string> | null} listed
 * @param {number} limit
 * @returns {string[]}
 */
export function emptyQueryFiles(tiles, root, recent, listed, limit) {
  const open = tiles
    .filter((t) =>
      t.kind === 'file' && t.file && !t.file.container && t.file.root === root
    )
    .sort((a, b) => b.focusSeq - a.focusSeq)
    .map((t) => /** @type {{path: string}} */ (t.file).path);
  const seen = new Set();
  const out = [];
  for (
    const path of [
      ...open,
      ...recent.filter((p) => !listed || listed.has(p)),
    ]
  ) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The recently opened files saved as `text`: `{[root]: paths newest first}`, in the order the
 * roots were last updated. Anything malformed is dropped; never throws.
 *
 * @param {string | null} text
 * @returns {Record<string, string[]>}
 */
export function parseRecents(text) {
  /** @type {Record<string, string[]>} */
  const out = {};
  let data;
  try {
    data = JSON.parse(text ?? 'null');
  } catch {
    return out;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [root, paths] of Object.entries(data)) {
    if (!Array.isArray(paths)) continue;
    const kept = paths.filter((p) => typeof p === 'string' && p !== '')
      .slice(0, MAX_RECENTS);
    if (kept.length) out[root] = kept;
  }
  return out;
}

/**
 * `recents` with `path` opened in `root`: first in its list (at most {@link MAX_RECENTS}), the
 * root moved last; past {@link MAX_RECENT_ROOTS} roots, the least recently updated are dropped.
 *
 * @param {Record<string, string[]>} recents
 * @param {string} root
 * @param {string} path
 * @returns {Record<string, string[]>}
 */
export function recordRecent(recents, root, path) {
  const list = [path, ...(recents[root] ?? []).filter((p) => p !== path)]
    .slice(0, MAX_RECENTS);
  /** @type {Record<string, string[]>} */
  const out = {};
  const roots = Object.keys(recents).filter((r) => r !== root);
  for (
    const r of roots.slice(Math.max(0, roots.length - MAX_RECENT_ROOTS + 1))
  ) {
    out[r] = recents[r];
  }
  out[root] = list;
  return out;
}
