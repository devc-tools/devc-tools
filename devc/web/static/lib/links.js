// Links in a terminal line: URLs, and file paths with an optional `:line[:column]`. Pure (no
// DOM), shared with the Deno tests (`devc/tests/web_links_test.ts`); `renderer.js` finds them
// under the pointer and `app.js` opens them.

/**
 * @typedef {{start: number, end: number} & ({kind: 'url', url: string} |
 *   {kind: 'file', path: string, line?: number, column?: number})} Link
 *   `start`/`end` are string offsets into the line (`end` exclusive).
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

// Anything between delimiters: whitespace, quotes, brackets and the separators around paths in
// compiler output and stack traces.
const TOKEN_RE = /[^\s'"`()<>\[\]{},;|]+/g;

// A path: has a `/` (absolute, `./x`, `src/a.ts`), or is a file name with a letter-led extension
// (`README.md`, not `6.0.0` or `e.g`), then an optional `:line` and `:column`.
const PATH_RE = /^((?:[\w.@+~-]*\/)*[\w.@+-]+)(?::(\d+)(?::(\d+))?)?$/;

/** Trailing characters that end a sentence rather than a URL or path. */
const TRAILING = /[.,:;!?]+$/;

/** A URL without trailing punctuation, or an unmatched `)`/`]` it ran into. */
function trimUrl(url) {
  let u = url.replace(TRAILING, '');
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (
      u.endsWith(close) && u.split(open).length < u.split(close).length
    ) {
      u = u.slice(0, -1).replace(TRAILING, '');
    }
  }
  return u;
}

/** Whether `token` (already without `:line:col`) reads as a file path. */
function looksLikePath(token) {
  if (token.startsWith('~') || token.includes('//')) return false;
  if (token.includes('/')) return /[\w]/.test(token);
  // `e.g` and `i.e` are words: a bare name needs more than one letter on a side.
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,7}$/.test(token) &&
    !/^\w\.\w$/.test(token);
}

/**
 * Every link in `text`, in order and without overlaps: URLs first, then file paths in what is
 * left.
 *
 * @param {string} text
 * @returns {Link[]}
 */
export function findLinks(text) {
  /** @type {Link[]} */
  const links = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    links.push({ kind: 'url', url, start: m.index, end: m.index + url.length });
  }
  const taken = (start, end) =>
    links.some((l) => start < l.end && l.start < end);
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0].replace(/[.,:;!?]+$/, '');
    const start = m.index;
    const end = start + token.length;
    if (token === '' || taken(start, end)) continue;
    const p = PATH_RE.exec(token);
    if (!p || !looksLikePath(p[1])) continue;
    links.push({
      kind: 'file',
      path: p[1],
      ...(p[2] ? { line: Number(p[2]) } : {}),
      ...(p[3] ? { column: Number(p[3]) } : {}),
      start,
      end,
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

/** The link covering string offset `index` of its line, if any. */
export function linkAt(links, index) {
  return links.find((l) => l.start <= index && index < l.end) ?? null;
}

/**
 * `path` as an absolute, normalized container path: relative ones are taken from `cwd` (a
 * container path too). Null when a relative path has no `cwd` to start from.
 *
 * @param {string} cwd @param {string} path
 */
export function resolvePath(cwd, path) {
  if (!path.startsWith('/') && !cwd.startsWith('/')) return null;
  const parts = [];
  for (
    const seg of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')
  ) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}
