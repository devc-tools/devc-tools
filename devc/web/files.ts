// Host directory listings for `devc web`: a project's files (`list_dir`), confined to the project
// folder, and the "Add project…" folder picker (`list_host_dir`), which opens on the configured
// `codeRoots` but may walk anywhere. See `.plans/devc-web-files.md`.
//
// Agents in containers can write project folders, symlinks included, so a project listing never
// follows a link out of its folder. The picker lists directory names only, never files.

import { dirname, join } from 'jsr:@std/path';

export interface DirEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink';
  /** A file's size in bytes. */
  size?: number;
  /** What a symlink points at, when it resolves to a directory or a file. */
  to?: 'dir' | 'file';
}

/** A picker entry: a directory, or a symlink to one. */
export interface HostDirEntry extends DirEntry {
  /** It holds a dev container config, or is already a known project. */
  project: boolean;
}

/** The most entries one listing returns. */
export const MAX_ENTRIES = 2000;

/** Why a listing failed, as the `result` error code it is answered with. */
export class FilesError extends Error {
  constructor(
    readonly code: 'bad_request' | 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

/** A directory-like entry: a directory, or a symlink to one. */
function isDirLike(e: DirEntry): boolean {
  return e.kind === 'dir' || e.to === 'dir';
}

/** Dirs (and symlinks to them) first, then files, each case-insensitively by name. */
export function sortEntries<T extends DirEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) =>
    Number(isDirLike(b)) - Number(isDirLike(a)) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name)
  );
}

/** Whether `path` is `root` or under it. Both absolute and normalized. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
}

/**
 * Resolves `rel` (a '/'-separated path relative to `root`; '' is the root itself) to an absolute
 * host path, or null when it is absolute, contains a `..` segment, or — after `Deno.realPath` —
 * lands outside `realPath(root)` (a symlink pointing out). The path returned is the lexical one
 * (`root` joined with `rel`), which is how the container's bind mount names it too. Throws
 * `Deno.errors.NotFound` when it does not exist.
 */
export async function confine(
  root: string,
  rel: string,
): Promise<string | null> {
  if (rel.startsWith('/')) return null;
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return null;
  const path = segments.length ? join(root, ...segments) : root;
  const [realRoot, real] = await Promise.all([
    Deno.realPath(root),
    Deno.realPath(path),
  ]);
  return within(realRoot, real) ? path : null;
}

/** `e` as a `FilesError` when it is a filesystem error worth naming, else `e` itself. */
function filesError(e: unknown, path: string): unknown {
  if (e instanceof Deno.errors.NotFound) {
    return new FilesError('not_found', `${path} does not exist`);
  }
  if (e instanceof Deno.errors.NotADirectory) {
    return new FilesError('not_found', `${path} is not a directory`);
  }
  if (e instanceof Deno.errors.PermissionDenied) {
    return new FilesError('forbidden', `${path} is not readable`);
  }
  return e;
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}

/** The entries of directory `dir`, without sizes or symlink targets yet. */
async function readEntries(dir: string): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const e of Deno.readDir(dir)) {
    const kind = e.isSymlink ? 'symlink' : e.isDirectory ? 'dir' : 'file';
    entries.push({ name: e.name, kind });
  }
  return entries;
}

/** Fills in a symlink's `to` and a file's `size`, by following each. */
async function describe(dir: string, e: DirEntry): Promise<DirEntry> {
  if (e.kind === 'dir') return e;
  const info = await statOrNull(join(dir, e.name));
  if (e.kind === 'file') {
    return info ? { ...e, size: info.size } : e;
  }
  return info?.isDirectory
    ? { ...e, to: 'dir' }
    : info?.isFile
    ? { ...e, to: 'file' }
    : e;
}

/**
 * One directory of a project: `rel` under `root`, confined to it (see {@link confine}), and its
 * lexical host path. Sorted, capped at {@link MAX_ENTRIES}. Throws {@link FilesError}.
 */
export async function listProjectDir(
  root: string,
  rel: string,
): Promise<{ path: string; entries: DirEntry[]; truncated: boolean }> {
  let confined: string | null;
  try {
    confined = await confine(root, rel);
  } catch (e) {
    throw filesError(e, rel || root);
  }
  if (confined === null) {
    throw new FilesError('forbidden', `${rel} is outside the project`);
  }
  const dir = confined;
  let entries: DirEntry[];
  try {
    entries = await readEntries(dir);
  } catch (e) {
    throw filesError(e, rel || root);
  }
  // Symlinks are sorted once their targets are known, so a link to a directory sorts with them.
  const described = await Promise.all(entries.map((e) => describe(dir, e)));
  const sorted = sortEntries(described);
  return {
    path: dir,
    entries: sorted.slice(0, MAX_ENTRIES),
    truncated: sorted.length > MAX_ENTRIES,
  };
}

/** The folders the picker opens on: the `codeRoots` that are directories, else `home`. */
export async function pickerRoots(
  codeRoots: readonly string[],
  home: string,
): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of codeRoots) {
    if ((await statOrNull(root))?.isDirectory && !dirs.includes(root)) {
      dirs.push(root);
    }
  }
  return dirs.length ? dirs : [home];
}

/** Whether `dir` holds a dev container config. */
async function hasDevcontainer(dir: string): Promise<boolean> {
  const [folder, file] = await Promise.all([
    statOrNull(join(dir, '.devcontainer')),
    statOrNull(join(dir, '.devcontainer.json')),
  ]);
  return folder?.isDirectory === true || file?.isFile === true;
}

/**
 * One host directory for the picker: `path` (absolute, no `..`), resolved with `realPath`. Its
 * subdirectories and symlinks to directories only, each marked `project` when it holds a dev
 * container config or is in `known` (project folders). `parent` is `null` at `/`. Not confined:
 * see the module comment. Throws {@link FilesError}.
 */
export async function listHostDir(
  path: string,
  known: ReadonlySet<string>,
): Promise<{
  path: string;
  parent: string | null;
  entries: HostDirEntry[];
  truncated: boolean;
}> {
  if (!path.startsWith('/')) {
    throw new FilesError('bad_request', `${path} is not an absolute path`);
  }
  if (path.split('/').includes('..')) {
    throw new FilesError('bad_request', `${path} contains '..'`);
  }
  let real: string;
  let entries: DirEntry[];
  try {
    real = await Deno.realPath(path);
    entries = await readEntries(real);
  } catch (e) {
    throw filesError(e, path);
  }
  const dirs = sortEntries(
    (await Promise.all(entries.map((e) => describe(real, e))))
      .filter(isDirLike),
  );
  const shown = dirs.slice(0, MAX_ENTRIES);
  return {
    path: real,
    parent: real === '/' ? null : dirname(real),
    entries: await Promise.all(shown.map(async (e) => {
      const full = join(real, e.name);
      return {
        ...e,
        project: known.has(full) || known.has(join(path, e.name)) ||
          await hasDevcontainer(full),
      };
    })),
    truncated: dirs.length > MAX_ENTRIES,
  };
}

/**
 * The shell line that opens `containerPath` in the container's editor: `$EDITOR`, else `vi`.
 * `exec`, so quitting the editor ends the pane. The path is single-quoted, so nothing in a file
 * name reaches the shell as syntax.
 */
export function editorCommand(containerPath: string): string {
  return `exec "\${EDITOR:-vi}" -- '${
    containerPath.replaceAll("'", `'\\''`)
  }'\n`;
}
