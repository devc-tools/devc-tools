// File watching for `devc web`'s language servers. Only `tsserver`-based servers notice changes on
// disk by themselves; TS 7, `deno lsp`, pyright, basedpyright and ty wait for the client's
// `workspace/didChangeWatchedFiles`, and agents edit files outside the editor all the time. So the
// host watches each session's root on the host side of its bind mount (the same files the
// container sees) and sends the changes the server's registrations ask for, batched. See
// `.plans/devc-web-lsp-core.md` § File watching.
//
// Matching and batching are pure (tested in `tests/web_lsp_watch_test.ts`); {@link RootWatcher}
// adds `Deno.watchFs`.

import { globToRegExp } from 'jsr:@std/path';
import {
  type Clock,
  fileUri,
  type FileWatcher,
  realClock,
} from './lsp_session.ts';

/** `FileChangeType`: what happened to a file. */
export const CREATED = 1;
export const CHANGED = 2;
export const DELETED = 3;
export type FileChangeType = typeof CREATED | typeof CHANGED | typeof DELETED;

/** `WatchKind`'s bits, which a watcher's `kind` (default all three) is made of. */
const KIND_BIT: Record<FileChangeType, number> = { 1: 1, 2: 2, 3: 4 };

/** How long after a batch's first event it is sent. */
export const BATCH_MS = 200;
/** The most changes one `workspace/didChangeWatchedFiles` carries. */
export const MAX_BATCH = 1000;

export type FileEvent = { uri: string; type: FileChangeType };

const GLOB_OPTS = { globstar: true, extended: true } as const;
const regexps = new Map<string, RegExp>();

function globRegExp(glob: string): RegExp {
  let re = regexps.get(glob);
  if (!re) {
    re = globToRegExp(glob, GLOB_OPTS);
    regexps.set(glob, re);
  }
  return re;
}

/** A `file:` URI's path; null for any other URI. */
function uriPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

/**
 * Whether container path `path` matches `glob`: a string pattern is tried against the absolute
 * path and against the path relative to `root` (`{src,lib}/**`); a `RelativePattern` resolves
 * against its `baseUri` (a URI, or a workspace folder's `{uri}`).
 */
export function globMatches(
  glob: unknown,
  path: string,
  root: string,
): boolean {
  if (typeof glob === 'string') {
    const re = globRegExp(glob);
    if (re.test(path)) return true;
    const rel = relativeTo(path, root);
    return rel !== null && re.test(rel);
  }
  if (typeof glob !== 'object' || glob === null) return false;
  const { baseUri, pattern } = glob as { baseUri?: unknown; pattern?: unknown };
  if (typeof pattern !== 'string') return false;
  const base = typeof baseUri === 'string'
    ? baseUri
    : typeof baseUri === 'object' && baseUri !== null &&
        typeof (baseUri as { uri?: unknown }).uri === 'string'
    ? (baseUri as { uri: string }).uri
    : null;
  const basePath = base === null ? null : uriPath(base);
  if (basePath === null) return false;
  const rel = relativeTo(path, basePath);
  return rel !== null && globRegExp(pattern).test(rel);
}

/** `path` relative to folder `dir` (no leading `/`); null when it is not under it. */
function relativeTo(path: string, dir: string): string | null {
  const d = dir.replace(/\/+$/, '');
  if (d === '') return path.replace(/^\/+/, '');
  if (!path.startsWith(`${d}/`)) return null;
  return path.slice(d.length + 1);
}

/** Whether some watcher asks for a change of `type` to container path `path`. */
export function watched(
  watchers: readonly FileWatcher[],
  path: string,
  type: FileChangeType,
  root: string,
): boolean {
  return watchers.some((w) =>
    ((w.kind ?? 7) & KIND_BIT[type]) !== 0 &&
    globMatches(w.globPattern, path, root)
  );
}

/**
 * A `Deno.watchFs` event as changes, by path: `create` → created, `modify` → changed, `remove`
 * → deleted, and `rename` → its first path deleted and its second created. Other kinds (`access`,
 * `any`, `other`) give none.
 */
export function eventChanges(
  ev: { kind: string; paths: string[] },
): { path: string; type: FileChangeType }[] {
  switch (ev.kind) {
    case 'create':
      return ev.paths.map((path) => ({ path, type: CREATED }));
    case 'modify':
      return ev.paths.map((path) => ({ path, type: CHANGED }));
    case 'remove':
      return ev.paths.map((path) => ({ path, type: DELETED }));
    case 'rename': {
      const [from, to] = ev.paths;
      return [
        ...(from !== undefined
          ? [{ path: from, type: DELETED as FileChangeType }]
          : []),
        ...(to !== undefined
          ? [{ path: to, type: CREATED as FileChangeType }]
          : []),
      ];
    }
    default:
      return [];
  }
}

/**
 * Collects changes into batches: the first change starts a {@link BATCH_MS} timer, and when it
 * fires every change since goes out, de-duplicated by URI (the last type wins, except that a
 * create then a delete drops the file), at most {@link MAX_BATCH} per `send`.
 */
export class ChangeBatcher {
  #pending = new Map<string, FileChangeType>();
  /** URIs created in this batch: a delete of one drops it. */
  #created = new Set<string>();
  #timer: unknown = null;
  #clock: Clock;
  #send: (changes: FileEvent[]) => void;

  constructor(send: (changes: FileEvent[]) => void, clock: Clock = realClock) {
    this.#send = send;
    this.#clock = clock;
  }

  add(uri: string, type: FileChangeType): void {
    if (type === DELETED && this.#created.has(uri)) {
      this.#pending.delete(uri);
      this.#created.delete(uri);
    } else {
      // Re-inserted, so the order is each URI's last change.
      this.#pending.delete(uri);
      this.#pending.set(uri, type);
      if (type === CREATED) this.#created.add(uri);
      else if (type === DELETED) this.#created.delete(uri);
    }
    this.#timer ??= this.#clock.setTimeout(() => this.flush(), BATCH_MS);
  }

  /** Sends what is pending now. */
  flush(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    const changes = [...this.#pending].map(([uri, type]) => ({ uri, type }));
    this.#pending.clear();
    this.#created.clear();
    for (let i = 0; i < changes.length; i += MAX_BATCH) {
      this.#send(changes.slice(i, i + MAX_BATCH));
    }
  }

  /** Drops what is pending; nothing more is sent until the next {@link add}. */
  stop(): void {
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending.clear();
    this.#created.clear();
  }
}

/** What the watcher prints, and the `lsp_status` detail, when changes can't be watched. */
export const UNWATCHED_NOTICE = 'file changes outside the editor are not seen';

/**
 * One session's watch: `Deno.watchFs(hostRoot, {recursive: true})`, started on the server's
 * first file-watcher registration, its events mapped to the container `root` and filtered by
 * the registrations, batched into `notify`. `onFailure` is told once when the watch can't be
 * made (Linux `ENOSPC`: the inotify limit) or ends with an error; the session keeps running.
 */
export class RootWatcher {
  #hostRoot: string;
  #root: string;
  #watchers: FileWatcher[] = [];
  #fs: Deno.FsWatcher | null = null;
  #stopped = false;
  #failed = false;
  #batcher: ChangeBatcher;
  #onFailure: (e: unknown) => void;
  #watchFs: typeof Deno.watchFs;

  constructor(opts: {
    hostRoot: string;
    root: string;
    notify: (changes: FileEvent[]) => void;
    onFailure: (e: unknown) => void;
    clock?: Clock;
    /** For tests: `Deno.watchFs` by default. */
    watchFs?: typeof Deno.watchFs;
  }) {
    this.#hostRoot = opts.hostRoot.replace(/\/+$/, '') || '/';
    this.#root = opts.root.replace(/\/+$/, '') || '/';
    this.#batcher = new ChangeBatcher(opts.notify, opts.clock);
    this.#onFailure = opts.onFailure;
    this.#watchFs = opts.watchFs ?? Deno.watchFs;
  }

  /** The server's registrations now: all of their watchers. */
  setWatchers(watchers: FileWatcher[]): void {
    this.#watchers = watchers;
    if (watchers.length > 0) this.#start();
  }

  /** A host path's container path; null outside the root. */
  containerPath(hostPath: string): string | null {
    if (hostPath === this.#hostRoot) return this.#root;
    const rel = relativeTo(hostPath, this.#hostRoot);
    if (rel === null) return null;
    return this.#root === '/' ? `/${rel}` : `${this.#root}/${rel}`;
  }

  /** One watch event: the changes some watcher asks for go into the batch. */
  event(ev: { kind: string; paths: string[] }): void {
    if (this.#stopped) return;
    for (const { path, type } of eventChanges(ev)) {
      const at = this.containerPath(path);
      if (at === null || !watched(this.#watchers, at, type, this.#root)) {
        continue;
      }
      this.#batcher.add(fileUri(at), type);
    }
  }

  #start() {
    if (this.#fs || this.#stopped || this.#failed) return;
    try {
      this.#fs = this.#watchFs(this.#hostRoot, { recursive: true });
    } catch (e) {
      this.#fail(e);
      return;
    }
    const fs = this.#fs;
    (async () => {
      try {
        for await (const ev of fs) this.event(ev);
      } catch (e) {
        if (!this.#stopped) this.#fail(e);
      }
    })();
  }

  #fail(e: unknown) {
    if (this.#failed) return;
    this.#failed = true;
    this.#fs = null;
    this.#onFailure(e);
  }

  stop(): void {
    this.#stopped = true;
    this.#batcher.stop();
    try {
      this.#fs?.close();
    } catch { /* already closed */ }
    this.#fs = null;
  }
}
