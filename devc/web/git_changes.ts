// Each repo's changes to commit for the `devc web` sidebar: how many entries its working tree has
// staged, unstaged, untracked and in conflict, beside the push/pull counts of `git_status.ts`.
//
// `git status` runs the repo's own config (`core.fsmonitor`, `filter.<x>.clean` drivers), and no
// flag turns off every command a config can name, so the host never runs it in a container's repo
// (`git_status.ts`'s header gives the same rule). It runs **in the environment**, through
// `Environment.run…`: a container's own git under `docker exec`, which crosses no boundary, and a
// host project's directly, whose page is a host shell already. The output is display data only.
// See `.plans/devc-web-git-changes.md`.

import { hostToContainerPath } from '@devc-tools/core/mount_paths.ts';
import type { Environment } from './environment.ts';
import { GIT_POLL_MS } from './git_status.ts';

/** A repo's working tree against its index and HEAD. */
export interface GitChanges {
  /** Entries with a staged change (porcelain v2 `1`/`2` lines whose X is not `.`). */
  staged: number;
  /** Entries with an unstaged change (Y not `.`). */
  unstaged: number;
  /** `?` lines. */
  untracked: number;
  /** `u` lines. */
  conflicted: number;
}

/** What a read of one repo gives: its changes, or why there are none. */
export type ChangesReading = GitChanges | { problem: string };

// `core.checkStat=minimal` compares whole-second mtime, size and mode only. Through Docker
// Desktop's file share every index entry's `ino`/`dev`/`ctime` differs from what the index holds,
// so without it git re-hashes every file (through `git-lfs` too) on every read, and
// `--no-optional-locks` keeps it from saving the refresh: 76 s for a 16k-file worktree, 2 s with.
export const CHANGES_ARGV = [
  'git',
  '-c',
  'core.checkStat=minimal',
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=normal',
];

/** The most output {@link readChanges} reads: past it, there are too many to count. */
export const CHANGES_MAX_OUTPUT = 1024 * 1024;
export const CHANGES_TIMEOUT_MS = 10_000;
/**
 * The host's backstop for a container's read: `timeout` there stops git at 10 s (SIGKILL 2 s
 * later), which killing the host's `docker exec` client does not.
 */
export const CHANGES_CONTAINER_TIMEOUT_MS = 13_000;
/** A container's read: {@link CHANGES_ARGV} under coreutils' `timeout`, so git dies with it. */
export const CHANGES_CONTAINER_ARGV = [
  'timeout',
  '-k',
  '2',
  '10',
  ...CHANGES_ARGV,
];
const TIMED_OUT = 'git status: timed out';

/**
 * Parses `git status --porcelain=v2 -z --untracked-files=normal` output. Ignores `#` headers.
 * With `-z` every entry ends in NUL, so a path holding a newline is safe; a rename or copy (`2`)
 * is followed by one more NUL-ended field, its original path, which is skipped.
 */
export function parseChanges(stdout: Uint8Array): GitChanges {
  const changes = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  // Latin-1 keeps one char per byte: only the ASCII field letters are read.
  const fields = new TextDecoder('latin1').decode(stdout).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    switch (f[0]) {
      case '1':
      case '2': {
        // `1 XY …` / `2 XY …`
        if (f[2] !== '.') changes.staged++;
        if (f[3] !== '.') changes.unstaged++;
        if (f[0] === '2') i++;
        break;
      }
      case 'u':
        changes.conflicted++;
        break;
      case '?':
        changes.untracked++;
        break;
        // `#` headers, `!` ignored entries (not asked for), and the empty field after the
        // last NUL.
    }
  }
  return changes;
}

/**
 * Runs it in `env` at `path` (the repo's path in the environment), under
 * {@link CHANGES_MAX_OUTPUT} and a time limit: a host project's for
 * {@link CHANGES_TIMEOUT_MS}, a container's under its own `timeout`
 * ({@link CHANGES_CONTAINER_ARGV}) with {@link CHANGES_CONTAINER_TIMEOUT_MS} as the host's
 * backstop. Never throws.
 */
export async function readChanges(
  env: Pick<Environment, 'runLimited'> & { kind?: Environment['kind'] },
  path: string,
): Promise<GitChanges | { problem: string }> {
  const container = env.kind === 'container';
  try {
    const r = await env.runLimited({
      cmd: container ? CHANGES_CONTAINER_ARGV : CHANGES_ARGV,
      cwd: path,
    }, {
      timeoutMs: container ? CHANGES_CONTAINER_TIMEOUT_MS : CHANGES_TIMEOUT_MS,
      maxOutput: CHANGES_MAX_OUTPUT,
    });
    if (r.kind === 'timeout') return { problem: TIMED_OUT };
    if (r.kind === 'too_large') return { problem: 'too many changes to count' };
    if (container && (r.code === 124 || r.code === 137)) {
      return { problem: TIMED_OUT };
    }
    // No unwrapped run in its place: that would leave git running past a timeout again.
    if (container && r.code === 127 && r.stderr.includes('timeout')) {
      return { problem: 'git status: no timeout command in the environment' };
    }
    if (r.code !== 0) {
      const line = r.stderr.split('\n').map((l) => l.trim()).find((l) => l);
      return { problem: line ? `git status: ${line}` : 'git status failed' };
    }
    return parseChanges(new TextEncoder().encode(r.stdout));
  } catch (e) {
    return {
      problem: `git status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** A running environment and the host folders of its repos. */
export interface ChangesTarget {
  env: Pick<Environment, 'id' | 'mounts' | 'runLimited'> & {
    kind?: Environment['kind'];
  };
  folders: readonly string[];
}

/** A dirty repo is read this long after its last mark, so a burst of edits is one read. */
export const CHANGES_DEBOUNCE_MS = 2_000;
/** The least gap between two reads of one repo. */
export const CHANGES_MIN_INTERVAL_MS = 15_000;
/** A repo's gap is at least this many times its last read's duration. */
export const CHANGES_SLOW_FACTOR = 5;
/** Every repo is marked dirty this often, for file events that were missed. */
export const CHANGES_SWEEP_MS = 300_000;

/** A watched repo folder: its path as given, its real path, and whether it is a linked worktree. */
export interface WatchedFolder {
  folder: string;
  /** `Deno.realPath` of it: FSEvents reports real paths (`/private/…` for `/tmp/…`). */
  real: string;
  /** Its `.git` is a file: a linked worktree, whose index and HEAD live in another repo's `.git`. */
  linked: boolean;
}

const GIT_FILES = new Set(['index', 'HEAD', 'MERGE_HEAD']);
const WORKTREE_GIT_FILE = /^worktrees\/[^/]+\/(index|HEAD)$/;

/**
 * The repos (by `folder`) a file event at `path` (a real path) makes dirty: the one whose folder
 * is its longest prefix, for a working-tree file or its `.git`'s `index`, `HEAD`, `MERGE_HEAD` or
 * `refs/…`; every linked worktree for `.git/worktrees/<name>/index|HEAD`; none for the rest of
 * `.git` or a path in no folder.
 */
export function reposForEvent(
  path: string,
  folders: readonly WatchedFolder[],
): string[] {
  let best: WatchedFolder | undefined;
  for (const f of folders) {
    if (
      (path === f.real || path.startsWith(f.real + '/')) &&
      (!best || f.real.length > best.real.length)
    ) best = f;
  }
  if (!best) return [];
  const rel = path.slice(best.real.length + 1);
  if (rel === '.git') return [];
  if (!rel.startsWith('.git/')) return [best.folder];
  const sub = rel.slice('.git/'.length);
  if (GIT_FILES.has(sub) || sub.startsWith('refs/')) return [best.folder];
  if (WORKTREE_GIT_FILE.test(sub)) {
    return folders.filter((f) => f.linked).map((f) => f.folder);
  }
  return [];
}

/** What {@link GitChangesWatch} watches with: `Deno.watchFs`'s shape. */
export type ChangesWatcher = AsyncIterable<{ paths: string[] }> & {
  close(): void;
};

/** {@link GitChangesWatch}'s clock: real time by default, a fake one in tests. */
export interface ChangesClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}
export type TimerHandle = ReturnType<typeof setTimeout>;

const realClock: ChangesClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/** Resolves a watched folder's real path and whether it is a linked worktree. */
async function watchedFolder(folder: string): Promise<WatchedFolder | null> {
  let real;
  try {
    real = await Deno.realPath(folder);
  } catch {
    return null;
  }
  let linked = false;
  try {
    linked = (await Deno.lstat(`${folder}/.git`)).isFile;
  } catch {
    // No `.git`: not a linked worktree.
  }
  return { folder, real, linked };
}

interface RepoState {
  dirty: boolean;
  /**
   * Read at the next chance, debounce and gaps skipped, once shown: a client's return, or the
   * repo coming into view.
   */
  urgent: boolean;
  /** Read at the next chance, shown or not: devc's own stage, commit or pull (`refreshFolder`). */
  forced: boolean;
  lastMark: number;
  lastReadAt?: number;
  lastDurationMs: number;
  /** `refreshEnvironment` callers waiting for this repo's next read. */
  waiting: (() => void)[];
}

interface EnvState {
  target: ChangesTarget;
  repos: Map<string, RepoState>;
  running: boolean;
  /** The folder set the watcher was built for. */
  watchKey: string;
  watcher?: ChangesWatcher;
  fallback?: TimerHandle;
  /** Bumped on each rebuild and on drop: an older build's watcher is closed, not kept. */
  generation: number;
}

/**
 * Keeps every running environment's repos' {@link ChangesReading}s current, reading a repo only
 * when it may have changed: a file event under its host folder (`Deno.watchFs`), its
 * environment's agent turning idle or done ({@link refreshEnvironment}), devc's own stage, commit
 * or pull ({@link refreshFolder}), or a sweep every {@link CHANGES_SWEEP_MS}. A dirty repo is read
 * {@link CHANGES_DEBOUNCE_MS} after its last mark, and no sooner than
 * max({@link CHANGES_MIN_INTERVAL_MS}, {@link CHANGES_SLOW_FACTOR} × its last read's duration)
 * after its last read. A repo no page shows (`visible`) stays dirty, unread, until one does
 * ({@link reveal}), unless devc's own action asks for it. Nothing is read while no client is
 * connected. At most one exec per
 * environment at a time; environments run side by side. Beside `GitStatusWatch`, not in it: that
 * one reads host data, this one execs in each environment. Calls `onChange` after each reading
 * that changed, and after dropping what is no longer listed. See
 * `.plans/devc-web-git-changes-efficiency.md`.
 */
export class GitChangesWatch {
  #readings = new Map<string, Map<string, ChangesReading>>();
  #envs = new Map<string, EnvState>();
  #timer: TimerHandle | undefined;
  #sweep: TimerHandle | undefined;
  #fallbackLogged = false;
  #clock: ChangesClock;

  constructor(
    private readonly opts: {
      /** The running environments: a stopped one gets no reading. */
      targets: () => Iterable<ChangesTarget>;
      onChange: () => void;
      read?: (
        env: ChangesTarget['env'],
        path: string,
      ) => Promise<ChangesReading>;
      /** Whether any page or desktop client is connected; true when absent. */
      clientsConnected?: () => boolean;
      /** Whether some page shows the repo at host `folder`; true when absent. */
      visible?: (folder: string) => boolean;
      /** Starts watching host folders (real paths); `Deno.watchFs` recursively by default. */
      watch?: (paths: string[]) => ChangesWatcher;
      /** Resolves a folder to watch; {@link watchedFolder} by default. */
      resolveFolder?: (folder: string) => Promise<WatchedFolder | null>;
      clock?: ChangesClock;
      /** How often an environment whose watcher failed has all its repos marked dirty. */
      pollMs?: number;
      log?: (message: string) => void;
    },
  ) {
    this.#clock = opts.clock ?? realClock;
  }

  /** By environment id, each repo's last reading by host folder; one not read yet is absent. */
  get readings(): ReadonlyMap<string, ReadonlyMap<string, ChangesReading>> {
    return this.#readings;
  }

  start() {
    this.sync();
    this.#sweep = this.#clock.setInterval(() => {
      this.sync();
      for (const id of this.#envs.keys()) this.#markAll(id);
    }, CHANGES_SWEEP_MS);
  }

  stop() {
    if (this.#sweep !== undefined) this.#clock.clearInterval(this.#sweep);
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = this.#sweep = undefined;
    for (const id of [...this.#envs.keys()]) {
      this.#closeWatch(this.#envs.get(id)!);
    }
  }

  /**
   * Takes in what `targets` lists now: a new repo is dirty, a repo or environment no longer
   * listed is dropped, and each environment's watcher follows its folder set.
   */
  sync() {
    const targets = this.#targets();
    let dropped = false;
    for (const id of [...this.#readings.keys()]) {
      if (!targets.has(id)) {
        this.#readings.delete(id);
        dropped = true;
      }
    }
    for (const [id, env] of [...this.#envs]) {
      if (!targets.has(id)) this.#dropEnv(id, env);
    }
    const now = this.#clock.now();
    for (const [id, target] of targets) {
      let env = this.#envs.get(id);
      if (!env) {
        env = {
          target,
          repos: new Map(),
          running: false,
          watchKey: '',
          generation: 0,
        };
        this.#envs.set(id, env);
      }
      env.target = target;
      const folders = new Set(target.folders);
      for (const [folder, repo] of [...env.repos]) {
        if (folders.has(folder)) continue;
        env.repos.delete(folder);
        for (const w of repo.waiting) w();
      }
      const readings = this.#readings.get(id);
      for (const folder of readings?.keys() ?? []) {
        if (!folders.has(folder)) {
          readings!.delete(folder);
          dropped = true;
        }
      }
      for (const folder of folders) {
        if (env.repos.has(folder)) continue;
        env.repos.set(folder, {
          dirty: true,
          urgent: false,
          forced: false,
          lastMark: now,
          lastDurationMs: 0,
          waiting: [],
        });
      }
      const key = [...folders].sort().join('\n');
      if (key !== env.watchKey) {
        env.watchKey = key;
        void this.#buildWatch(id, env);
      }
    }
    if (dropped) this.opts.onChange();
    this.#arm();
  }

  /** Marks every running environment's repos dirty; resolves once they are read. */
  async refresh(): Promise<void> {
    this.sync();
    await Promise.all(
      [...this.#envs.keys()].map((id) => this.refreshEnvironment(id)),
    );
  }

  /**
   * Marks environment `id`'s repos dirty (an agent there turned idle or done): they are read
   * under the debounce and gaps. Resolves once the shown ones' reads finish, or at once with no
   * client connected.
   */
  refreshEnvironment(id: string): Promise<void> {
    if (!this.#envs.has(id)) this.sync();
    const env = this.#envs.get(id);
    if (!env) return Promise.resolve();
    const done = this.#connected()
      ? Promise.all(
        [...env.repos].filter(([f]) => this.#visible(f)).map(([, r]) =>
          new Promise<void>((res) => r.waiting.push(res))
        ),
      ).then(() => {})
      : Promise.resolve();
    this.#markAll(id);
    return done;
  }

  /**
   * Reads environment `id`'s repo at host `folder` now, debounce and gaps skipped, shown or not:
   * devc staged, committed or pulled there. During a read of that environment it runs right
   * after it.
   */
  refreshFolder(id: string, folder: string): Promise<void> {
    if (!this.#envs.get(id)?.repos.has(folder)) this.sync();
    const repo = this.#envs.get(id)?.repos.get(folder);
    if (!repo) return Promise.resolve();
    const done = this.#connected()
      ? new Promise<void>((res) => repo.waiting.push(res))
      : Promise.resolve();
    repo.forced = true;
    this.#mark(repo);
    return done;
  }

  /** The repos at host `folders` came into view: each dirty one is read now, once without gaps. */
  reveal(folders: Iterable<string>) {
    const shown = new Set(folders);
    for (const env of this.#envs.values()) {
      for (const [folder, repo] of env.repos) {
        if (repo.dirty && shown.has(folder)) repo.urgent = true;
      }
    }
    this.#arm();
  }

  /** A client connected where none was: every dirty repo is read now, once without gaps. */
  clientConnected() {
    for (const env of this.#envs.values()) {
      for (const repo of env.repos.values()) {
        if (repo.dirty) repo.urgent = true;
      }
    }
    this.#arm();
  }

  #connected(): boolean {
    return this.opts.clientsConnected?.() ?? true;
  }

  #visible(folder: string): boolean {
    return this.opts.visible?.(folder) ?? true;
  }

  #targets(): Map<string, ChangesTarget> {
    return new Map([...this.opts.targets()].map((t) => [t.env.id, t]));
  }

  #mark(repo: RepoState) {
    repo.dirty = true;
    repo.lastMark = this.#clock.now();
    this.#arm();
  }

  #markAll(id: string) {
    const env = this.#envs.get(id);
    if (!env) return;
    const now = this.#clock.now();
    for (const repo of env.repos.values()) {
      repo.dirty = true;
      repo.lastMark = now;
    }
    this.#arm();
  }

  #markFolders(id: string, folders: readonly string[]) {
    const env = this.#envs.get(id);
    if (!env) return;
    for (const folder of folders) {
      const repo = env.repos.get(folder);
      if (repo) this.#mark(repo);
    }
  }

  /** When the repo at `folder` may be read next, or Infinity while it is clean or not shown. */
  #dueAt(folder: string, repo: RepoState): number {
    if (!repo.dirty) return Infinity;
    if (repo.forced) return 0;
    if (!this.#visible(folder)) return Infinity;
    if (repo.urgent) return 0;
    const debounced = repo.lastMark + CHANGES_DEBOUNCE_MS;
    if (repo.lastReadAt === undefined) return debounced;
    const gap = Math.max(
      CHANGES_MIN_INTERVAL_MS,
      CHANGES_SLOW_FACTOR * repo.lastDurationMs,
    );
    return Math.max(debounced, repo.lastReadAt + gap);
  }

  /** Arms the one timer for the earliest due repo of an environment that is not reading. */
  #arm() {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#connected()) return;
    let earliest = Infinity;
    for (const env of this.#envs.values()) {
      if (env.running) continue;
      for (const [folder, repo] of env.repos) {
        earliest = Math.min(earliest, this.#dueAt(folder, repo));
      }
    }
    if (earliest === Infinity) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#tick();
    }, Math.max(0, earliest - this.#clock.now()));
  }

  #tick() {
    const now = this.#clock.now();
    for (const [id, env] of this.#envs) {
      if (env.running) continue;
      if ([...env.repos].some(([f, r]) => this.#dueAt(f, r) <= now)) {
        void this.#run(id, env);
      }
    }
    this.#arm();
  }

  /** Reads `env`'s due repos one after another, the most urgent first, until none is due. */
  async #run(id: string, env: EnvState) {
    env.running = true;
    try {
      while (this.#envs.get(id) === env && this.#connected()) {
        const now = this.#clock.now();
        let next: [string, RepoState] | undefined;
        let nextDue = Infinity;
        for (const entry of env.repos) {
          const due = this.#dueAt(entry[0], entry[1]);
          if (due <= now && due < nextDue) {
            next = entry;
            nextDue = due;
          }
        }
        if (!next) break;
        await this.#readOne(id, env, next[0], next[1]);
      }
    } finally {
      env.running = false;
      this.#arm();
    }
  }

  async #readOne(id: string, env: EnvState, folder: string, repo: RepoState) {
    // Cleared before the read: a mark that comes during it leaves the repo dirty again.
    repo.dirty = false;
    repo.urgent = false;
    repo.forced = false;
    const waiting = repo.waiting;
    repo.waiting = [];
    const start = this.#clock.now();
    try {
      let mounts;
      try {
        mounts = await env.target.env.mounts();
      } catch {
        repo.lastReadAt = this.#clock.now();
        repo.dirty = true;
        return;
      }
      const path = hostToContainerPath(folder, mounts);
      if (path === null) {
        repo.lastReadAt = this.#clock.now();
        return;
      }
      const next = await (this.opts.read ?? readChanges)(env.target.env, path);
      const end = this.#clock.now();
      repo.lastReadAt = end;
      repo.lastDurationMs = 'problem' in next && next.problem === TIMED_OUT
        ? Math.max(end - start, CHANGES_CONTAINER_TIMEOUT_MS)
        : end - start;
      // It stopped while git ran: its readings are gone, and stay gone.
      if (!this.#targets().has(id)) {
        this.sync();
        return;
      }
      if (this.#envs.get(id) !== env || !env.repos.has(folder)) return;
      const readings = this.#readings.get(id) ?? new Map();
      const prev = readings.get(folder);
      if (
        !readings.has(folder) || JSON.stringify(prev) !== JSON.stringify(next)
      ) {
        readings.set(folder, next);
        this.#readings.set(id, readings);
        this.opts.onChange();
      }
    } finally {
      for (const w of waiting) w();
    }
  }

  #dropEnv(id: string, env: EnvState) {
    this.#envs.delete(id);
    this.#closeWatch(env);
    env.generation++;
    for (const repo of env.repos.values()) {
      for (const w of repo.waiting) w();
      repo.waiting = [];
    }
  }

  #closeWatch(env: EnvState) {
    try {
      env.watcher?.close();
    } catch {
      // Already closed.
    }
    env.watcher = undefined;
    if (env.fallback !== undefined) this.#clock.clearInterval(env.fallback);
    env.fallback = undefined;
  }

  /** Watches `env`'s folders; on failure, marks all its repos dirty every `pollMs` instead. */
  async #buildWatch(id: string, env: EnvState) {
    this.#closeWatch(env);
    const generation = ++env.generation;
    const resolve = this.opts.resolveFolder ?? watchedFolder;
    const folders = (await Promise.all(
      [...env.repos.keys()].map((f) => resolve(f)),
    )).filter((f): f is WatchedFolder => f !== null);
    if (env.generation !== generation || this.#envs.get(id) !== env) return;
    const fallback = (e: unknown) => {
      if (env.generation !== generation || this.#envs.get(id) !== env) return;
      this.#closeWatch(env);
      if (!this.#fallbackLogged) {
        this.#fallbackLogged = true;
        (this.opts.log ?? console.error)(
          `devc web: watching repo folders failed (${
            e instanceof Error ? e.message : String(e)
          }): reading changes to commit every ${
            (this.opts.pollMs ?? GIT_POLL_MS) / 1000
          } s instead`,
        );
      }
      env.fallback = this.#clock.setInterval(
        () => this.#markAll(id),
        this.opts.pollMs ?? GIT_POLL_MS,
      );
    };
    if (folders.length === 0) return;
    let watcher: ChangesWatcher;
    try {
      watcher = (this.opts.watch ??
        ((paths) => Deno.watchFs(paths, { recursive: true })))(
          folders.map((f) => f.real),
        );
    } catch (e) {
      fallback(e);
      return;
    }
    env.watcher = watcher;
    try {
      for await (const event of watcher) {
        if (env.generation !== generation) break;
        const marked = new Set<string>();
        for (const p of event.paths) {
          for (const f of reposForEvent(p, folders)) marked.add(f);
        }
        if (marked.size) this.#markFolders(id, [...marked]);
      }
    } catch (e) {
      fallback(e);
    }
  }
}
