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
 * its full path ('' for the root). `viewed` and `total` count the files under it, `viewedLines`
 * and `totalLines` their changed lines (additions plus deletions).
 *
 * @typedef {{name: string, path: string, dirs: PrDir[], files: PrFileNode[], viewed: number,
 *   total: number, viewedLines: number, totalLines: number}} PrDir
 * @typedef {{name: string, file: PrFile, dir?: string}} PrFileNode  `dir`, in a flat list, is
 *   the folder the file is in ('' at the top)
 */

/**
 * GitHub's page for one file of a PR: `<pr url>/files#diff-<sha256 hex of the path>`, as the
 * server's `fileUrl` (`pr_review.ts`) builds it. Without `crypto.subtle` (a page served over
 * plain http from another host), the PR's Files page.
 *
 * @param {string} prUrl @param {string} path
 * @returns {Promise<string>}
 */
export async function prFileUrl(prUrl, path) {
  if (!globalThis.crypto?.subtle) return `${prUrl}/files`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(path),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prUrl}/files#diff-${hex}`;
}

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
    viewedLines: 0,
    totalLines: 0,
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
  count(dir);
  return dir;
}

/** Fills in `dir`'s counts from its files and its (already counted) folders. */
function count(dir) {
  dir.viewed = 0;
  dir.total = dir.files.length;
  dir.viewedLines = 0;
  dir.totalLines = 0;
  for (const { file } of dir.files) {
    const n = changedLines(file);
    dir.totalLines += n;
    if (file.viewed === 'VIEWED') {
      dir.viewed++;
      dir.viewedLines += n;
    }
  }
  for (const d of dir.dirs) {
    dir.viewed += d.viewed;
    dir.total += d.total;
    dir.viewedLines += d.viewedLines;
    dir.totalLines += d.totalLines;
  }
}

/** @param {PrFile} file */
function changedLines(file) {
  return (Number(file.additions) || 0) + (Number(file.deletions) || 0);
}

/**
 * The files as one flat list (the PR row's Flat, by size): a root with no folders, its files
 * sorted by changed lines (additions plus deletions), most first or, with `order` 'fewest',
 * fewest first; then by path either way. Each node's `name` is the file's name and `dir` its
 * folder.
 *
 * @param {PrFile[]} files @param {'most' | 'fewest'} [order]
 * @returns {PrDir}
 */
export function buildPrFlat(files, order = 'most') {
  const sign = order === 'fewest' ? -1 : 1;
  /** @type {PrDir & {byName?: Map<string, any>}} */
  const root = newDir('', '');
  delete root.byName;
  root.files = files.map((file) => {
    const cut = file.path.lastIndexOf('/');
    return {
      name: file.path.slice(cut + 1),
      dir: cut < 0 ? '' : file.path.slice(0, cut),
      file,
    };
  });
  root.files.sort((a, b) =>
    sign * (changedLines(b.file) - changedLines(a.file)) ||
    byName(a.file.path, b.file.path)
  );
  count(root);
  return root;
}

/**
 * How much of `dir`'s change is marked Viewed, as a whole percent: its Viewed files' changed
 * lines over all its changed lines, rounded down (100 only once every changed line is viewed).
 * With no changed lines at all (renames, binary files), Viewed files over files instead; with
 * no files, 0.
 *
 * @param {PrDir} dir
 */
export function viewedPercent(dir) {
  if (dir.totalLines > 0) {
    return Math.floor((dir.viewedLines * 100) / dir.totalLines);
  }
  return dir.total > 0 ? Math.floor((dir.viewed * 100) / dir.total) : 0;
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

/**
 * `dir` without its Viewed files, or the folders left holding none (the PR row's Hide viewed):
 * a file changed since it was viewed (`DISMISSED`) stays. Folders keep their names and counts,
 * so a row reads as it does with everything shown; nothing is compacted again.
 *
 * @param {PrDir} dir
 * @returns {PrDir}
 */
export function withoutViewed(dir) {
  return {
    ...dir,
    dirs: dir.dirs.filter((d) => d.viewed < d.total).map(withoutViewed),
    files: dir.files.filter((f) => f.file.viewed !== 'VIEWED'),
  };
}
