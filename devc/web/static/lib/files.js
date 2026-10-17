// The lazily loaded directory tree behind the `devc web` sidebar's Files node and the "Add
// project…" folder picker, and its path helpers. Pure (no DOM), shared with the Deno tests
// (`devc/tests/web_files_page_test.ts`); `app.js` renders it.

/**
 * @typedef {{name: string, kind: 'dir' | 'file' | 'symlink', size?: number,
 *   to?: 'dir' | 'file', project?: boolean}} DirEntry
 * @typedef {{entries: DirEntry[], truncated: boolean} & Record<string, unknown>} Listing
 * @typedef {{state: 'loading'} | ({state: 'ok'} & Listing) |
 *   {state: 'error', message: string}} ListingState
 * @typedef {{type: 'entry', path: string, entry: DirEntry, depth: number, open: boolean,
 *   dir: string} | {type: 'loading' | 'truncated', depth: number} |
 *   {type: 'error', depth: number, message: string}} TreeItem
 */

/**
 * `name` inside `dir`. Paths are '/'-separated: relative to a project (`''` is its root) in the
 * Files tree, absolute in the picker.
 */
export function childPath(dir, name) {
  if (dir === '') return name;
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Whether `path` is `dir` or under it, in the same space as {@link childPath}. */
export function isWithin(dir, path) {
  if (dir === '' || path === dir) return true;
  return path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** The folder above absolute `path`; `null` at `/`. */
export function parentDir(path) {
  if (path === '/' || path === '') return null;
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

/** A file size for a tooltip: bytes, then KB, MB, GB with one decimal under 10. */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** A dotfile or dot-directory, listed dimmed. */
export function isHiddenName(name) {
  return name.startsWith('.');
}

/** An entry that expands: a directory, or a symlink to one. */
export function opensAsDir(entry) {
  return entry.kind === 'dir' || entry.to === 'dir';
}

/** An entry that opens in the editor: a file, or a symlink to one. */
export function opensAsFile(entry) {
  return entry.kind === 'file' || entry.to === 'file';
}

/** `paths` without duplicates, parents before children (by depth, then as given). */
export function byDepth(paths) {
  const depth = (p) => p === '' ? 0 : p.split('/').filter(Boolean).length;
  return [...new Set(paths)].sort((a, b) => depth(a) - depth(b));
}

/**
 * A lazily loaded tree: `list(path)` fetches one directory when it is first expanded, and the
 * listing is kept until that directory is collapsed or refreshed. `onChange` runs whenever what
 * {@link walk} would return changes. A reply that arrives after its directory was collapsed or
 * refreshed again is dropped.
 *
 * @param {{list: (path: string) => Promise<Listing>, onChange: () => void}} opts
 */
export function createDirTree({ list, onChange }) {
  /** @type {Map<string, ListingState>} */
  const listings = new Map();
  /** @type {Map<string, object>} the request each listing waits on */
  const pending = new Map();
  /** @type {Set<string>} */
  const open = new Set();

  const load = (path) => {
    const token = {};
    pending.set(path, token);
    listings.set(path, { state: 'loading' });
    list(path).then(
      (result) => {
        if (pending.get(path) !== token) return;
        pending.delete(path);
        listings.set(path, { state: 'ok', ...result });
        onChange();
      },
      (e) => {
        if (pending.get(path) !== token) return;
        pending.delete(path);
        listings.set(path, {
          state: 'error',
          message: String(e?.message ?? e),
        });
        onChange();
      },
    );
  };

  /** Drops the listings at and under `path`. */
  const forget = (path) => {
    for (const p of [...listings.keys()]) {
      if (isWithin(path, p)) {
        listings.delete(p);
        pending.delete(p);
      }
    }
  };

  const tree = {
    isOpen: (path) => open.has(path),
    /** @returns {ListingState | undefined} */
    listing: (path) => listings.get(path),
    expand(path) {
      open.add(path);
      if (!listings.has(path)) load(path);
      onChange();
    },
    /** Collapses `path` and everything open under it, forgetting their listings. */
    collapse(path) {
      for (const p of [...open]) if (isWithin(path, p)) open.delete(p);
      forget(path);
      onChange();
    },
    toggle(path) {
      if (open.has(path)) tree.collapse(path);
      else tree.expand(path);
    },
    /** Lists `path` and every open directory under it again. */
    refresh(path) {
      forget(path);
      for (const p of open) if (isWithin(path, p)) load(p);
      onChange();
    },
    /** Collapses everything. */
    clear() {
      open.clear();
      listings.clear();
      pending.clear();
      onChange();
    },
    /** The open directories whose listing has not failed: what a reload should open again. */
    openPaths: () =>
      [...open].filter((p) => listings.get(p)?.state !== 'error'),
    /**
     * The rows under `path` (which should be open), depth-first, starting at `depth`: each
     * entry, and under each open directory its own rows; a placeholder while a listing loads or
     * after it failed, and a final `truncated` row when the server capped it.
     *
     * @returns {TreeItem[]}
     */
    walk(path, depth) {
      const l = listings.get(path);
      if (!l || l.state === 'loading') return [{ type: 'loading', depth }];
      if (l.state === 'error') {
        return [{ type: 'error', depth, message: l.message }];
      }
      /** @type {TreeItem[]} */
      const items = [];
      for (const entry of l.entries) {
        const p = childPath(path, entry.name);
        const isOpen = opensAsDir(entry) && open.has(p);
        items.push({
          type: 'entry',
          path: p,
          entry,
          depth,
          open: isOpen,
          dir: path,
        });
        if (isOpen) items.push(...tree.walk(p, depth + 1));
      }
      if (l.truncated) items.push({ type: 'truncated', depth });
      return items;
    },
  };
  return tree;
}
