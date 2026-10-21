// The `devc web` sidebar's Pull request row: a PR's changed files as a folder tree, with Viewed
// counts, and the markers that make invisible characters in untrusted text visible. Pure (no
// DOM), shared with the Deno tests (`devc/tests/web_pr_tree_test.ts`); `app.js` renders it.

/**
 * A changed file as `pr_files` lists it (without its patch).
 *
 * @typedef {{path: string, previousPath: string | null, status: string, additions: number,
 *   deletions: number, viewed: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'}} PrFile
 */
/**
 * A folder of the tree: `name` is what its row shows (a compacted chain reads `b/c`), `path`
 * its full path ('' for the root). `viewed` and `total` count the files under it.
 *
 * @typedef {{name: string, path: string, dirs: PrDir[], files: PrFileNode[], viewed: number,
 *   total: number}} PrDir
 * @typedef {{name: string, file: PrFile}} PrFileNode
 */

/** @param {string} a @param {string} b */
const byName = (a, b) => a.localeCompare(b, 'en');

/**
 * The files as a tree: folders first, then files, each sorted by name, and every chain of
 * folders that each hold only one folder compacted into one (`src/web/lib`).
 *
 * @param {PrFile[]} files
 * @returns {PrDir}
 */
export function buildPrTree(files) {
  /** @type {PrDir & {byName: Map<string, any>}} */
  const root = newDir('', '');
  for (const file of files) {
    const parts = file.path.split('/');
    const name = /** @type {string} */ (parts.pop());
    let dir = root;
    for (const part of parts) {
      let next = dir.byName.get(part);
      if (!next) {
        next = newDir(part, dir.path === '' ? part : `${dir.path}/${part}`);
        dir.byName.set(part, next);
        dir.dirs.push(next);
      }
      dir = next;
    }
    dir.files.push({ name, file });
  }
  return finish(root);
}

function newDir(name, path) {
  return {
    name,
    path,
    dirs: [],
    files: [],
    viewed: 0,
    total: 0,
    byName: new Map(),
  };
}

/** Sorts, compacts and counts `dir`, depth first. */
function finish(dir) {
  delete dir.byName;
  dir.dirs = dir.dirs.map((d) => {
    let child = d;
    // A folder holding just one folder (and no files) reads as one row.
    while (child.dirs.length === 1 && child.files.length === 0) {
      const only = child.dirs[0];
      only.name = `${child.name}/${only.name}`;
      child = only;
    }
    return finish(child);
  });
  dir.dirs.sort((a, b) => byName(a.name, b.name));
  dir.files.sort((a, b) => byName(a.name, b.name));
  dir.viewed = dir.files.filter((f) => f.file.viewed === 'VIEWED').length;
  dir.total = dir.files.length;
  for (const d of dir.dirs) {
    dir.viewed += d.viewed;
    dir.total += d.total;
  }
  return dir;
}

/**
 * A file's status letter: `A`dded, `D`eleted, `R`enamed, `C`opied, else `M`odified.
 *
 * @param {string} status
 */
export function statusLetter(status) {
  switch (status) {
    case 'added':
      return 'A';
    case 'removed':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    default:
      return 'M';
  }
}

/** Bidi controls and zero-width characters: shown as markers, never as themselves. */
const INVISIBLE = /[‪-‮⁦-⁩​-‏⁠﻿]/g;

/**
 * `text` split around its bidi controls (U+202A–U+202E, U+2066–U+2069) and zero-width characters
 * (U+200B–U+200F, U+2060, U+FEFF): plain parts as strings, each such character as a marker
 * `{marker: '⟨U+202E⟩'}` (the Trojan Source check). Empty parts are left out.
 *
 * @param {string} text
 * @returns {(string | {marker: string})[]}
 */
export function splitMarkers(text) {
  /** @type {(string | {marker: string})[]} */
  const out = [];
  let at = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    const i = /** @type {number} */ (m.index);
    if (i > at) out.push(text.slice(at, i));
    const code = m[0].codePointAt(0)?.toString(16).toUpperCase().padStart(
      4,
      '0',
    );
    out.push({ marker: `⟨U+${code}⟩` });
    at = i + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * Whether a folder row starts open: a fully viewed one starts closed.
 *
 * @param {PrDir} dir
 */
export function folderOpenByDefault(dir) {
  return dir.total === 0 || dir.viewed < dir.total;
}
