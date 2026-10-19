// Live mode's static side, for the child `devc web` a supervisor runs from a checkout (see
// `supervisor.ts`): the **generation** of `static/` (a content hash, not the devc version), the
// watch that broadcasts `static_changed`, and the **last-good snapshot** served at `/safe/`.
// See `.plans/devc-web-live.md`.

import { join, relative, SEPARATOR } from 'jsr:@std/path';

/** The generation every embedded-mode server reports: its files never change. */
export const EMBEDDED_GENERATION = 'embedded';

/** Where the last-good snapshot lives: a copy of `static/` plus a `GENERATION` file. */
export function lastGoodDir(): string {
  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE') ?? '.';
  return `${home}/.cache/devc/web/last-good`;
}

const GENERATION_FILE = 'GENERATION';

/** A tree's files (path relative to its root, `/`-separated) → SHA-256 of their bytes, hex. */
export type FileHashes = Map<string, string>;

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string'
    ? new TextEncoder().encode(bytes)
    : bytes;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) await walk(root, path, out);
    else if (entry.isFile) {
      out.push(relative(root, path).split(SEPARATOR).join('/'));
    }
  }
}

/**
 * The generation of the tree at `dir`: 16 hex chars of SHA-256 over every file's path and bytes,
 * in path order, plus the per-file hashes it was computed from (for {@link changedPaths}).
 */
export async function computeGeneration(
  dir: string,
): Promise<{ generation: string; files: FileHashes }> {
  const paths: string[] = [];
  await walk(dir, dir, paths);
  paths.sort();
  const files: FileHashes = new Map();
  let manifest = '';
  for (const path of paths) {
    const hash = await sha256(await Deno.readFile(join(dir, path)));
    files.set(path, hash);
    manifest += `${path}\0${hash}\n`;
  }
  return { generation: (await sha256(manifest)).slice(0, 16), files };
}

/** The paths added, removed or changed between two trees, sorted. */
export function changedPaths(before: FileHashes, after: FileHashes): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

/** The generation recorded in the snapshot at `snapshotDir`, or `null` when there is none. */
export async function snapshotGeneration(
  snapshotDir: string,
): Promise<string | null> {
  try {
    const text = (await Deno.readTextFile(join(snapshotDir, GENERATION_FILE)))
      .trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory) await copyTree(src, dest);
    else if (entry.isFile) await Deno.copyFile(src, dest);
  }
}

/**
 * Copies `staticDir` to `snapshotDir` as the snapshot of `generation`. The copy is built in a
 * sibling temp dir and renamed into place, so a half-written snapshot never exists, and it is
 * dropped (returning `false`) when the files changed under it and no longer hash to
 * `generation`.
 */
export async function writeSnapshot(
  staticDir: string,
  snapshotDir: string,
  generation: string,
): Promise<boolean> {
  const suffix = crypto.randomUUID();
  const tmp = `${snapshotDir}.tmp-${suffix}`;
  const old = `${snapshotDir}.old-${suffix}`;
  try {
    await copyTree(staticDir, tmp);
    if ((await computeGeneration(tmp)).generation !== generation) return false;
    await Deno.writeTextFile(join(tmp, GENERATION_FILE), `${generation}\n`);
    // rename() cannot replace a non-empty directory, so the old snapshot steps aside first.
    let hadOld = true;
    try {
      await Deno.rename(snapshotDir, old);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      hadOld = false;
    }
    await Deno.rename(tmp, snapshotDir);
    if (hadOld) await Deno.remove(old, { recursive: true });
    return true;
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

export interface LiveStaticOptions {
  /** The `static/` directory being served. */
  staticDir: string;
  snapshotDir: string;
  /** A new generation, and the paths that changed since the previous one. */
  onChange(generation: string, paths: string[]): void;
  onError(message: string): void;
}

const STATIC_DEBOUNCE_MS = 150;

/** The current generation of a watched `static/`, and its last-good snapshot. */
export class LiveStatic {
  #opts: LiveStaticOptions;
  #files: FileHashes = new Map();
  #generation = '';
  /** Generations already snapshotted (or tried), so each is copied at most once. */
  #snapshotted = new Set<string>();
  #watcher: Deno.FsWatcher | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #recomputing: Promise<void> = Promise.resolve();

  constructor(opts: LiveStaticOptions) {
    this.#opts = opts;
  }

  get generation(): string {
    return this.#generation;
  }

  /** Computes the first generation. Call {@link watch} to follow changes. */
  async init(): Promise<void> {
    const { generation, files } = await computeGeneration(this.#opts.staticDir);
    this.#generation = generation;
    this.#files = files;
    const snap = await snapshotGeneration(this.#opts.snapshotDir);
    if (snap !== null) this.#snapshotted.add(snap);
  }

  watch(): void {
    const watcher = Deno.watchFs(this.#opts.staticDir, { recursive: true });
    this.#watcher = watcher;
    (async () => {
      for await (const _ of watcher) {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          this.#recomputing = this.#recomputing.then(() => this.recompute());
        }, STATIC_DEBOUNCE_MS);
      }
    })().catch((e) => this.#opts.onError(`static watch stopped: ${e}`));
  }

  /** Re-hashes `static/` and reports a change. Public for tests; the watch calls it. */
  async recompute(): Promise<void> {
    let next;
    try {
      next = await computeGeneration(this.#opts.staticDir);
    } catch (e) {
      // Mid-save (a file renamed away, say): the next event recomputes.
      this.#opts.onError(`cannot hash static files: ${e}`);
      return;
    }
    if (next.generation === this.#generation) return;
    const paths = changedPaths(this.#files, next.files);
    this.#generation = next.generation;
    this.#files = next.files;
    this.#opts.onChange(next.generation, paths);
  }

  /**
   * A browser rendered `generation`: snapshot it when it is the current one and not yet
   * snapshotted. Resolves `true` when a snapshot was written.
   */
  async clientReady(generation: string): Promise<boolean> {
    if (
      generation !== this.#generation || this.#snapshotted.has(generation)
    ) return false;
    this.#snapshotted.add(generation);
    try {
      return await writeSnapshot(
        this.#opts.staticDir,
        this.#opts.snapshotDir,
        generation,
      );
    } catch (e) {
      this.#opts.onError(`cannot write the last-good snapshot: ${e}`);
      return false;
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    try {
      this.#watcher?.close();
    } catch { /* already closed */ }
    this.#watcher = null;
  }
}
