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

export const CHANGES_ARGV = [
  'git',
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
 * {@link CHANGES_TIMEOUT_MS} and {@link CHANGES_MAX_OUTPUT}. Never throws.
 */
export async function readChanges(
  env: Pick<Environment, 'runLimited'>,
  path: string,
): Promise<GitChanges | { problem: string }> {
  try {
    const r = await env.runLimited({ cmd: CHANGES_ARGV, cwd: path }, {
      timeoutMs: CHANGES_TIMEOUT_MS,
      maxOutput: CHANGES_MAX_OUTPUT,
    });
    if (r.kind === 'timeout') return { problem: 'git status: timed out' };
    if (r.kind === 'too_large') return { problem: 'too many changes to count' };
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
  env: Pick<Environment, 'id' | 'mounts' | 'runLimited'>;
  folders: readonly string[];
}

/**
 * Keeps every running environment's repos' {@link ChangesReading}s current: all of them every
 * {@link GIT_POLL_MS}, and one environment's on {@link refreshEnvironment} (an agent there turned
 * idle or done). Beside `GitStatusWatch`, not in it: that one reads host data for every folder,
 * this one execs in each environment, at most one exec per environment at a time. Calls
 * `onChange` after each reading that changed, and after dropping what is no longer listed.
 */
export class GitChangesWatch {
  #readings = new Map<string, Map<string, ChangesReading>>();
  #running = new Set<string>();
  #again = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly opts: {
      /** The running environments: a stopped one gets no reading. */
      targets: () => Iterable<ChangesTarget>;
      onChange: () => void;
      read?: (
        env: ChangesTarget['env'],
        path: string,
      ) => Promise<ChangesReading>;
      pollMs?: number;
    },
  ) {}

  /** By environment id, each repo's last reading by host folder; one not read yet is absent. */
  get readings(): ReadonlyMap<string, ReadonlyMap<string, ChangesReading>> {
    return this.#readings;
  }

  start() {
    void this.refresh();
    this.#timer = setInterval(
      () => void this.refresh(),
      this.opts.pollMs ?? GIT_POLL_MS,
    );
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** Reads every running environment's repos now, the environments side by side. */
  async refresh(): Promise<void> {
    const targets = this.#targets();
    let dropped = false;
    for (const id of this.#readings.keys()) {
      if (!targets.has(id)) {
        this.#readings.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.opts.onChange();
    await Promise.all(
      [...targets.keys()].map((id) => this.refreshEnvironment(id)),
    );
  }

  /** Reads environment `id`'s repos now; a call during its pass runs one more pass after it. */
  async refreshEnvironment(id: string): Promise<void> {
    if (this.#running.has(id)) {
      this.#again.add(id);
      return;
    }
    this.#running.add(id);
    try {
      do {
        this.#again.delete(id);
        await this.#pass(id);
      } while (this.#again.has(id));
    } finally {
      this.#running.delete(id);
    }
  }

  #targets(): Map<string, ChangesTarget> {
    return new Map([...this.opts.targets()].map((t) => [t.env.id, t]));
  }

  async #pass(id: string) {
    const target = this.#targets().get(id);
    if (!target) {
      if (this.#readings.delete(id)) this.opts.onChange();
      return;
    }
    const read = this.opts.read ?? readChanges;
    const folders = new Set(target.folders);
    const readings = this.#readings.get(id) ?? new Map();
    let dropped = false;
    for (const folder of readings.keys()) {
      if (!folders.has(folder)) {
        readings.delete(folder);
        dropped = true;
      }
    }
    if (dropped) this.opts.onChange();
    let mounts;
    try {
      mounts = await target.env.mounts();
    } catch {
      return;
    }
    for (const folder of folders) {
      const path = hostToContainerPath(folder, mounts);
      if (path === null) continue;
      const next = await read(target.env, path);
      // It stopped while git ran: its readings are gone, and stay gone.
      if (!this.#targets().has(id)) {
        if (this.#readings.delete(id)) this.opts.onChange();
        return;
      }
      const prev = readings.get(folder);
      if (
        !readings.has(folder) || JSON.stringify(prev) !== JSON.stringify(next)
      ) {
        readings.set(folder, next);
        this.#readings.set(id, readings);
        this.opts.onChange();
      }
    }
  }
}
