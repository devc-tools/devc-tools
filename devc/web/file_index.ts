// Every file of a repo, for the page's file palette (`find_files`): a walk of the repo folder on
// the host, as `list_dir` reads it, leaving out what the repo's `.gitignore` files and
// `.git/info/exclude` ignore. See `.plans/devc-web-file-palette.md`.
//
// The host never runs git in a repo (see `git_status.ts`), so this is a Deno FS walk with a
// matcher for the part of gitignore(5) repos use, not `git ls-files`. A folder holding a `.git`
// below the root (a worktree, submodule or nested repo) is another repo's and is not entered;
// symlinks are never followed into directories.

import { join } from 'jsr:@std/path';
import { filesError } from './files.ts';

/** The most files one `find_files` lists. */
export const MAX_FIND_FILES = 50_000;

/** The most directory entries one `find_files` reads. */
export const MAX_FIND_VISITED = 500_000;

/** One parsed ignore line. */
export interface IgnoreRule {
  /** The directory of the file it is from, relative to the root ('' for the root). */
  base: string;
  /** A `!` rule: re-includes what earlier rules ignored. */
  negate: boolean;
  /** A trailing `/`: matches directories only. */
  dirOnly: boolean;
  /** Matched against the path relative to `base`; else against the basename. */
  anchored: boolean;
  re: RegExp;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/;

/** `c` as a regex source matching itself. */
function lit(c: string): string {
  return REGEX_SPECIAL.test(c) ? `\\${c}` : c;
}

/**
 * The regex source for glob `p` (no leading or trailing `/`), or null for an unparseable one (an
 * unclosed `[`, a trailing `\`).
 */
function globSource(p: string): string | null {
  let out = '';
  let i = 0;
  if (p.startsWith('**/')) {
    out += '(?:.*/)?';
    i = 3;
  }
  while (i < p.length) {
    const c = p[i];
    if (c === '\\') {
      if (i + 1 >= p.length) return null;
      out += lit(p[i + 1]);
      i += 2;
    } else if (c === '/' && p.startsWith('/**/', i)) {
      out += '/(?:.*/)?';
      i += 4;
    } else if (c === '/' && i + 3 === p.length && p.endsWith('/**')) {
      out += '/.+';
      i += 3;
    } else if (c === '*') {
      // `**` anywhere else acts as `*`.
      while (p[i] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      let j = i + 1;
      let negate = false;
      if (p[j] === '!' || p[j] === '^') {
        negate = true;
        j++;
      }
      let body = '';
      let first = true;
      let closed = false;
      while (j < p.length) {
        const d = p[j];
        if (d === ']' && !first) {
          closed = true;
          break;
        }
        first = false;
        if (d === '\\' && j + 1 < p.length) {
          body += `\\${p[j + 1]}`;
          j += 2;
        } else {
          body += d === ']' || d === '[' || d === '^' || d === '\\'
            ? `\\${d}`
            : d;
          j++;
        }
      }
      if (!closed) return null;
      out += negate ? `[^/${body}]` : `[${body}]`;
      i = j + 1;
    } else {
      out += lit(c);
      i++;
    }
  }
  return out;
}

/** One line of an ignore file, or null when it holds no rule. `base` as in {@link IgnoreRule}. */
export function parseIgnoreLine(line: string, base: string): IgnoreRule | null {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (line === '' || line.startsWith('#')) return null;
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
  let p = line.slice(0, end);
  const negate = p.startsWith('!');
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith('/') && !p.endsWith('\\/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p === '') return null;
  const source = globSource(p);
  if (source === null) return null;
  let re: RegExp;
  try {
    re = new RegExp(`^${source}$`);
  } catch {
    return null;
  }
  return { base, negate, dirOnly, anchored, re };
}

/** The rules of an ignore file's `text`, in order. `base` as in {@link IgnoreRule}. */
export function parseIgnore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split('\n')) {
    const rule = parseIgnoreLine(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Whether `path` (relative to the root, `/`-separated) is ignored by `rules`, lowest precedence
 * first: the last rule that matches decides. `dir`: the path is a directory.
 */
export function isIgnored(
  rules: readonly IgnoreRule[],
  path: string,
  dir: boolean,
): boolean {
  const slash = path.lastIndexOf('/');
  const name = slash < 0 ? path : path.slice(slash + 1);
  for (let k = rules.length - 1; k >= 0; k--) {
    const r = rules[k];
    if (r.dirOnly && !dir) continue;
    let rel = path;
    if (r.base !== '') {
      if (!path.startsWith(`${r.base}/`)) continue;
      rel = path.slice(r.base.length + 1);
    }
    if (r.re.test(r.anchored ? rel : name)) return !r.negate;
  }
  return false;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch {
    return null;
  }
}

/**
 * Every file under `root` that its ignore rules keep, as paths relative to it, sorted by code
 * unit. Stops at `maxFiles` files listed or {@link MAX_FIND_VISITED} entries read, with
 * `truncated`. Throws `FilesError` when `root` itself cannot be read.
 */
export async function listRepoFiles(
  root: string,
  { maxFiles = MAX_FIND_FILES, maxVisited = MAX_FIND_VISITED }: {
    maxFiles?: number;
    maxVisited?: number;
  } = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;

  /** `dir`'s entries sorted by name, or null when it cannot be read. */
  const entriesOf = async (dir: string) => {
    const entries: Deno.DirEntry[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e);
    return entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  };

  /** Walks `dir` (`rel` under the root) with the rules of the folders above it. */
  const walk = async (
    dir: string,
    rel: string,
    entries: Deno.DirEntry[],
    inherited: IgnoreRule[],
  ): Promise<void> => {
    const own = entries.some((e) => e.name === '.gitignore')
      ? await readTextOrNull(join(dir, '.gitignore'))
      : null;
    const rules = own === null
      ? inherited
      : [...inherited, ...parseIgnore(own, rel)];
    for (const e of entries) {
      if (truncated) return;
      if (++visited > maxVisited) {
        truncated = true;
        return;
      }
      if (e.name === '.git') continue;
      const path = join(dir, e.name);
      const relPath = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isSymlink) {
        let isFile = false;
        try {
          isFile = (await Deno.stat(path)).isFile;
        } catch { /* broken or a loop: left out */ }
        if (!isFile || isIgnored(rules, relPath, false)) continue;
      } else if (e.isDirectory) {
        if (isIgnored(rules, relPath, true)) continue;
        // Another repo's folder (a worktree, submodule or nested repo).
        if (await lstatOrNull(join(path, '.git'))) continue;
        let children: Deno.DirEntry[];
        try {
          children = await entriesOf(path);
        } catch {
          continue;
        }
        await walk(path, relPath, children, rules);
        continue;
      } else if (!e.isFile || isIgnored(rules, relPath, false)) {
        continue;
      }
      files.push(relPath);
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  let entries: Deno.DirEntry[];
  try {
    entries = await entriesOf(root);
  } catch (e) {
    throw filesError(e, root);
  }
  const gitDir = await lstatOrNull(join(root, '.git'));
  const exclude = gitDir?.isDirectory
    ? await readTextOrNull(join(root, '.git', 'info', 'exclude'))
    : null;
  await walk(
    root,
    '',
    entries,
    exclude === null ? [] : parseIgnore(exclude, ''),
  );
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, truncated };
}
