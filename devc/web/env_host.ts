// Projects on this machine, the `host` kind of environment (`environment.ts`): a project folder
// with its own Herdr session (`hostSessionName`), every command run directly, with no Docker.
//
// The PATH every command gets is a login shell's (see {@link HostShell}): devc-desktop started
// from Finder has a bare environment, and a terminal's PATH is where `herdr`, `gh` and the agents
// are. A project's files are read and written with Deno's FS calls rather than shell argv, since
// `find -printf` and `mv -T` are GNU-only. {@link HostSource} finds the sessions by polling
// `herdr session list --json`. See `.plans/devc-web-host-environments.md` § D3, D4.

import { spawn as nodeSpawn } from 'node:child_process';
import { basename, join } from 'jsr:@std/path';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import {
  type ByteProc,
  type LineProc,
  runCapped,
  spawnBytes,
  spawnLines,
} from './proc.ts';
import {
  type BridgeRun,
  type DiscoveryHooks,
  type EnvExec,
  type EnvFiles,
  type Environment,
  type EnvironmentSource,
  type ExecOutput,
  hostEnvironmentId,
  hostSessionName,
  type PrBackend,
  type RunLimits,
  type RunningSession,
} from './environment.ts';
import {
  contentHash,
  type DirEntry,
  FilesError,
  fileText,
  MAX_ENTRIES,
  MAX_READ_BYTES,
  readUpTo,
  sortEntries,
} from './files.ts';
import { parseRunningOutput, RUNNING_PROBE } from './sessions.ts';
import { START_SESSION_TRIES, START_SESSION_WAIT_MS } from './herdr_bridge.ts';
import { hostBuiltins, hostPrBackend } from './pr_host.ts';

/** How often {@link HostSource} lists the Herdr sessions. */
export const HOST_POLL_MS = 5000;

/** How long one one-shot command may take before it is killed. */
const EXEC_TIMEOUT_MS = 15_000;

/** The login shells whose `-lc` takes POSIX syntax; anything else (fish) gets `/bin/sh`. */
const POSIX_SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];

/** The shell to probe and run login scripts with: `$SHELL` when POSIX, else `/bin/sh`. */
export function loginShellFor(shell: string | undefined): string {
  return shell !== undefined && shell.startsWith('/') &&
      POSIX_SHELLS.includes(basename(shell))
    ? shell
    : '/bin/sh';
}

/** The probe: prints the login shell's PATH, then where `herdr` is (if anywhere). */
export const PROBE_SCRIPT = 'printf "%s\\n" "$PATH"; command -v herdr || true';

/** What the login-shell probe found. */
export interface ShellProbe {
  shell: string;
  path: string;
  /** Absolute, or `''` when there is none. */
  herdrPath: string;
}

/** {@link PROBE_SCRIPT}'s output: line 1 the PATH, the last line `herdr` when absolute. */
export function parseProbe(
  stdout: string,
  fallbackPath: string,
): { path: string; herdrPath: string } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l);
  const path = lines[0] ?? '';
  const last = lines.length > 1 ? lines[lines.length - 1] : '';
  return {
    path: path.includes('/') ? path : fallbackPath,
    herdrPath: last.startsWith('/') ? last : '',
  };
}

/**
 * This machine's login shell, probed once and again on each {@link refresh}: the PATH every host
 * command runs with, and the `herdr` on it. Shared by {@link HostSource} and its environments.
 */
export class HostShell {
  readonly shell: string;
  #probe: Promise<ShellProbe> | null = null;
  #last: ShellProbe | null = null;

  constructor(shell = Deno.env.get('SHELL')) {
    this.shell = loginShellFor(shell);
  }

  /** The last probe, or a first one. */
  current(): Promise<ShellProbe> {
    return this.#probe ?? this.refresh();
  }

  /** The last finished probe, for the long-lived spawns; null before one. */
  now(): ShellProbe | null {
    return this.#last;
  }

  refresh(): Promise<ShellProbe> {
    const fallback = Deno.env.get('PATH') ?? '/usr/bin:/bin';
    const probe = (async () => {
      let stdout = '';
      try {
        const out = await new Deno.Command(this.shell, {
          args: ['-lc', PROBE_SCRIPT],
          stdin: 'null',
          stdout: 'piped',
          stderr: 'null',
          signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
        }).output();
        stdout = new TextDecoder().decode(out.stdout);
      } catch { /* no shell, or a slow profile: devc web's own PATH */ }
      const found = { shell: this.shell, ...parseProbe(stdout, fallback) };
      this.#last = found;
      return found;
    })();
    this.#probe = probe;
    return probe;
  }

  /** `[shell, '-lc', script, ...args]`. */
  argv(script: string, ...args: string[]): string[] {
    return [this.shell, '-lc', script, ...args];
  }
}

/** The environment a host command gets: devc web's own, the probed PATH, then `x.env`. */
function execEnv(path: string | undefined, x: EnvExec): Record<string, string> {
  return { ...(path ? { PATH: path } : {}), ...x.env };
}

/** Runs `x` directly, to completion (killed after 15 s); a missing command exits 127. */
export async function hostRun(
  x: EnvExec,
  cwd: string,
  path: string | undefined,
  input?: Uint8Array,
): Promise<ExecOutput> {
  try {
    const child = new Deno.Command(x.cmd[0], {
      args: x.cmd.slice(1),
      cwd: x.cwd ?? cwd,
      env: execEnv(path, x),
      stdin: input === undefined ? 'null' : 'piped',
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    }).spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(input);
        await writer.close();
      } catch { /* the child exited first: its status says why */ }
    }
    const out = await child.output();
    return {
      code: out.code,
      stdout: out.stdout,
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (e) {
    return {
      code: 127,
      stdout: new Uint8Array(),
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** A Deno FS error as a {@link FilesError}, else itself. */
function fsError(
  e: unknown,
  path: string,
  what: string,
  create = false,
): unknown {
  if (e instanceof FilesError) return e;
  if (e instanceof Deno.errors.NotFound) {
    return new FilesError(
      'not_found',
      create ? `${path}'s folder does not exist` : `${path} does not exist`,
    );
  }
  if (e instanceof Deno.errors.PermissionDenied) {
    return new FilesError('forbidden', `${path} can't be ${what} here`);
  }
  if (e instanceof Deno.errors.AlreadyExists) {
    return new FilesError('exists', `${path} already exists`);
  }
  if (e instanceof Deno.errors.NotADirectory) {
    return new FilesError(
      'not_found',
      create ? `${path}'s folder does not exist` : `${path} is not a directory`,
    );
  }
  return e;
}

/** A host project's {@link EnvFiles}: Deno FS calls, the same contract as the exec-backed ones. */
export function hostFiles(): EnvFiles {
  const readBytes = async (path: string, max: number) => {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (e) {
      throw fsError(e, path, 'read');
    }
    // Checked before opening: opening a FIFO for reading would wait for a writer.
    if (!info.isFile) {
      throw new FilesError('bad_request', `${path} is not a file`);
    }
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, { read: true });
    } catch (e) {
      if (e instanceof Deno.errors.PermissionDenied) {
        throw new FilesError('forbidden', `${path} is not readable`);
      }
      throw fsError(e, path, 'read');
    }
    try {
      return await readUpTo(file, max + 1);
    } finally {
      file.close();
    }
  };
  const write = async (path: string, bytes: Uint8Array) => {
    let file: Deno.FsFile;
    try {
      // In place: truncated, so its inode and mode are kept.
      file = await Deno.open(path, { write: true, truncate: true });
    } catch (e) {
      throw fsError(e, path, 'saved');
    }
    try {
      let n = 0;
      while (n < bytes.length) n += await file.write(bytes.subarray(n));
    } finally {
      file.close();
    }
  };
  return {
    async list(path) {
      const entries: DirEntry[] = [];
      try {
        for await (const e of Deno.readDir(path)) {
          const full = join(path, e.name);
          const own = await Deno.lstat(full).catch(() => null);
          if (own?.isSymlink) {
            const to = await Deno.stat(full).catch(() => null);
            entries.push({
              name: e.name,
              kind: 'symlink',
              ...(to?.isDirectory
                ? { to: 'dir' }
                : to?.isFile
                ? { to: 'file' }
                : {}),
            });
          } else if (own?.isDirectory) {
            entries.push({ name: e.name, kind: 'dir' });
          } else if (own?.isFile) {
            entries.push({ name: e.name, kind: 'file', size: own.size });
          } // Sockets, FIFOs and devices are listed as files that don't open.
          else entries.push({ name: e.name, kind: 'file' });
        }
      } catch (e) {
        if (e instanceof Deno.errors.PermissionDenied) {
          throw new FilesError('forbidden', `${path} is not readable`);
        }
        throw fsError(e, path, 'listed');
      }
      const sorted = sortEntries(entries);
      return {
        entries: sorted.slice(0, MAX_ENTRIES),
        truncated: sorted.length > MAX_ENTRIES,
      };
    },
    async read(path) {
      const bytes = await readBytes(path, MAX_READ_BYTES);
      return { ...fileText(bytes, path), hash: await contentHash(bytes) };
    },
    readBytes,
    async create(path, kind) {
      try {
        if (kind === 'file') {
          (await Deno.open(path, { createNew: true, write: true })).close();
        } else await Deno.mkdir(path);
      } catch (e) {
        throw fsError(e, path, 'created', true);
      }
      return { path };
    },
    async rename(from, to) {
      if (await Deno.lstat(to).then(() => true, () => false)) {
        throw new FilesError('exists', `${to} already exists`);
      }
      try {
        await Deno.rename(from, to);
      } catch (e) {
        throw fsError(e, from, 'renamed');
      }
      return { path: to };
    },
    async delete(path) {
      try {
        // A link is removed itself, never what it points to.
        await Deno.remove(path, { recursive: true });
      } catch (e) {
        throw fsError(e, path, 'deleted');
      }
      return {};
    },
    async write(dir, file, text) {
      try {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(file, text);
      } catch (e) {
        throw fsError(e, file, 'written');
      }
    },
    async writeText(path, text, base) {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_READ_BYTES) {
        throw new FilesError(
          'too_large',
          `${path} would be ${bytes.length} bytes; files up to ${MAX_READ_BYTES} bytes can be saved`,
        );
      }
      if (base !== undefined) {
        let current: string | null;
        try {
          current = await contentHash(await readBytes(path, MAX_READ_BYTES));
        } catch (e) {
          if (!(e instanceof FilesError && e.code === 'not_found')) throw e;
          current = null;
        }
        if (current !== base) {
          throw new FilesError(
            'conflict',
            `${path} changed since it was opened`,
          );
        }
      }
      await write(path, bytes);
      return { hash: await contentHash(bytes), size: bytes.length };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------------------------

/**
 * The linked worktrees of the repo at `folder`, from `git worktree list --porcelain`: every
 * `worktree <path>` after the first (the main one) that is an existing directory. `[]` when it
 * is no repo or git is missing.
 */
export function parseWorktreeList(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length)).slice(1);
}

/** A project folder on this machine: see the module header. */
export class HostEnvironment implements Environment {
  readonly kind = 'host' as const;
  readonly id: string;
  readonly herdrSession: string;
  readonly caps = { stop: true, down: false, containerPaths: false };
  readonly files = hostFiles();
  readonly pr: PrBackend;

  constructor(
    readonly localFolder: string,
    base: string,
    private shell: HostShell,
    opts: { home?: string; builtins?: () => Promise<string> } = {},
  ) {
    this.id = hostEnvironmentId(localFolder);
    this.herdrSession = hostSessionName(base, localFolder);
    const home = opts.home ?? Deno.env.get('HOME') ?? '.';
    this.pr = hostPrBackend({
      env: this,
      home,
      builtins: opts.builtins ?? hostBuiltins(home),
    });
  }

  async prepare(): Promise<void> {
    await this.shell.refresh();
  }

  #path(): string | undefined {
    return this.shell.now()?.path;
  }

  #opts(x: EnvExec) {
    return { cwd: x.cwd ?? this.localFolder, env: execEnv(this.#path(), x) };
  }

  spawn(x: EnvExec): LineProc {
    return spawnLines(x.cmd[0], x.cmd.slice(1), this.#opts(x));
  }

  spawnBytes(x: EnvExec): ByteProc {
    return spawnBytes(x.cmd[0], x.cmd.slice(1), this.#opts(x));
  }

  async run(x: EnvExec, input?: Uint8Array): Promise<ExecOutput> {
    await this.shell.current();
    return hostRun(x, this.localFolder, this.#path(), input);
  }

  /** Spawned on its own (detached, stdio ignored, not waited for): it outlives devc web. */
  async runDetached(x: EnvExec): Promise<ExecOutput> {
    await this.shell.current();
    const { cwd, env } = this.#opts(x);
    return await new Promise<ExecOutput>((resolve) => {
      const child = nodeSpawn(x.cmd[0], x.cmd.slice(1), {
        cwd,
        env: { ...Deno.env.toObject(), ...env },
        detached: true,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        child.unref();
        resolve({ code: 0, stdout: new Uint8Array(), stderr: '' });
      });
      child.once(
        'error',
        (e) =>
          resolve({ code: 127, stdout: new Uint8Array(), stderr: String(e) }),
      );
    });
  }

  async runLimited(x: EnvExec, limits: RunLimits): Promise<BridgeRun> {
    await this.shell.current();
    return runCapped(x.cmd[0], x.cmd.slice(1), limits, this.#opts(x));
  }

  loginShell(script: string, ...args: string[]): string[] {
    return this.shell.argv(script, ...args);
  }

  async herdrPath(): Promise<string> {
    return (await this.shell.current()).herdrPath;
  }

  home(): Promise<string | null> {
    const home = Deno.env.get('HOME');
    return Promise.resolve(home?.startsWith('/') ? home : null);
  }

  /** The identity bind: a host path is its own path. */
  mounts(): Promise<ContainerMount[]> {
    return Promise.resolve([
      { type: 'bind', source: '/', destination: '/', rw: true },
    ]);
  }

  async repoSources(): Promise<string[]> {
    const out = await this.run({
      cmd: ['git', '-C', this.localFolder, 'worktree', 'list', '--porcelain'],
    });
    if (out.code !== 0) return [];
    const dirs: string[] = [];
    for (
      const path of parseWorktreeList(new TextDecoder().decode(out.stdout))
    ) {
      if ((await Deno.stat(path).catch(() => null))?.isDirectory) {
        dirs.push(path);
      }
    }
    return dirs;
  }

  async runningAgents(): Promise<RunningSession[]> {
    const out = await this.run({ cwd: '/', cmd: ['sh', '-c', RUNNING_PROBE] });
    if (out.code !== 0) return [];
    return parseRunningOutput(new TextDecoder().decode(out.stdout));
  }

  running(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

// ---------------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------------

/** One `herdr session list --json` session. */
export interface HerdrSessionInfo {
  name: string;
  running: boolean;
  sessionDir: string;
}

/** `herdr session list --json`'s sessions by name; null for a malformed answer. */
export function parseSessionList(
  text: string,
): Map<string, HerdrSessionInfo> | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const sessions = (data as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return null;
  const out = new Map<string, HerdrSessionInfo>();
  for (const s of sessions) {
    if (typeof s !== 'object' || s === null) continue;
    const { name, running, session_dir } = s as Record<string, unknown>;
    if (typeof name !== 'string' || typeof running !== 'boolean') continue;
    out.set(name, {
      name,
      running,
      sessionDir: typeof session_dir === 'string' ? session_dir : '',
    });
  }
  return out;
}

/**
 * The projects on this machine as an {@link EnvironmentSource}. `candidates` are the folders
 * whose effective environment is `host`; each whose Herdr session runs is an environment, one
 * listed but not running is stopped. Polled every {@link HOST_POLL_MS}, and on {@link refresh}.
 */
export class HostSource implements EnvironmentSource {
  readonly kind = 'host' as const;
  readonly shell: HostShell;
  #hooks: DiscoveryHooks | null = null;
  #known = new Map<string, HostEnvironment>();
  #stopped = new Map<string, { id: string; localFolder: string }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #lastError = '';
  readonly #opts: {
    session: string;
    candidates: () => string[];
    pollMs: number;
    home?: string;
  };

  constructor(opts: {
    /** The `--session` base: see `hostSessionName`. */
    session: string;
    candidates: () => string[];
    shell?: HostShell;
    pollMs?: number;
    home?: string;
  }) {
    this.shell = opts.shell ?? new HostShell();
    this.#opts = { pollMs: HOST_POLL_MS, ...opts };
  }

  start(hooks: DiscoveryHooks): void {
    this.#hooks = hooks;
    const tick = () =>
      this.refresh().catch((e) =>
        hooks.onError(e instanceof Error ? e.message : String(e))
      );
    void tick();
    this.#timer = setInterval(tick, this.#opts.pollMs);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#hooks = null;
  }

  stopped(): ReadonlyMap<string, { id: string; localFolder: string }> {
    return this.#stopped;
  }

  environment(record: { localFolder: string }): HostEnvironment {
    return new HostEnvironment(
      record.localFolder,
      this.#opts.session,
      this.shell,
      this.#opts.home !== undefined ? { home: this.#opts.home } : {},
    );
  }

  /** The Herdr sessions, or null (no `herdr`, or a failed or malformed answer). */
  async #list(): Promise<Map<string, HerdrSessionInfo> | null> {
    const probe = await this.shell.current();
    if (probe.herdrPath === '') return null;
    const out = await hostRun(
      { cmd: [probe.herdrPath, 'session', 'list', '--json'] },
      '/',
      probe.path,
    );
    if (out.code !== 0) {
      const message = `herdr session list: ${
        out.stderr.trim() || `exit ${out.code}`
      }`;
      if (message !== this.#lastError) this.#hooks?.onError(message);
      this.#lastError = message;
      return null;
    }
    this.#lastError = '';
    return parseSessionList(new TextDecoder().decode(out.stdout));
  }

  /** Lists the sessions again, one listing at a time. */
  refresh(): Promise<void> {
    const next = this.#queue.then(() => this.#refreshOnce());
    this.#queue = next.catch(() => {});
    return next;
  }

  async #refreshOnce(): Promise<void> {
    const listing = await this.#list();
    const hooks = this.#hooks;
    if (hooks === null) return;
    const running = new Map<string, string>();
    const stopped = new Map<string, { id: string; localFolder: string }>();
    for (const folder of new Set(this.#opts.candidates())) {
      const s = listing?.get(hostSessionName(this.#opts.session, folder));
      const id = hostEnvironmentId(folder);
      if (s?.running) running.set(id, folder);
      else if (s) stopped.set(id, { id, localFolder: folder });
    }
    for (const id of [...this.#known.keys()]) {
      if (running.has(id)) continue;
      this.#known.delete(id);
      hooks.onRemove(id);
    }
    const stoppedKey = (m: Map<string, unknown>) => [...m.keys()].sort().join();
    if (stoppedKey(stopped) !== stoppedKey(this.#stopped)) {
      this.#stopped = stopped;
      hooks.onStoppedChange();
    }
    for (const [id, folder] of running) {
      if (this.#known.has(id)) {
        // A server that came back between two listings: a `no-session` card reconnects.
        hooks.onLaunch(id);
        continue;
      }
      const env = new HostEnvironment(
        folder,
        this.#opts.session,
        this.shell,
        this.#opts.home !== undefined ? { home: this.#opts.home } : {},
      );
      this.#known.set(id, env);
      hooks.onAdd(env);
    }
  }

  /**
   * `herdr --session <name> server`, detached, in the folder, then waits for the listing to show
   * it running. Throws when there is no `herdr`, or with the server log's tail when it doesn't
   * come up.
   */
  async startProject(
    localFolder: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    const probe = await this.shell.refresh();
    if (probe.herdrPath === '') {
      throw new Error(
        "herdr is not installed on this machine (not on your login shell's PATH)",
      );
    }
    const name = hostSessionName(this.#opts.session, localFolder);
    const env = new HostEnvironment(
      localFolder,
      this.#opts.session,
      this.shell,
    );
    onLine(`herdr --session ${name} server`);
    const out = await env.runDetached({
      cmd: [probe.herdrPath, '--session', name, 'server'],
      cwd: localFolder,
    });
    if (out.code !== 0) {
      throw new Error(out.stderr.trim() || 'starting the Herdr server failed');
    }
    let last: HerdrSessionInfo | undefined;
    for (let i = 0; i < START_SESSION_TRIES; i++) {
      last = (await this.#list())?.get(name);
      if (last?.running) {
        await this.refresh();
        return;
      }
      await new Promise((r) => setTimeout(r, START_SESSION_WAIT_MS));
    }
    const seconds = Math.round(
      START_SESSION_TRIES * START_SESSION_WAIT_MS / 1000,
    );
    const log = last?.sessionDir
      ? await Deno.readTextFile(join(last.sessionDir, 'herdr-server.log'))
        .then((t) => t.trimEnd().split('\n').slice(-10).join('\n'), () => '')
      : '';
    await this.refresh();
    throw new Error(`Herdr didn't come up in ${seconds}s.\n${log}`.trimEnd());
  }

  /** `herdr session stop <name>`; `false` when it was not running. */
  async stopProject(localFolder: string): Promise<boolean> {
    const name = hostSessionName(this.#opts.session, localFolder);
    const probe = await this.shell.current();
    if (!(await this.#list())?.get(name)?.running) return false;
    const out = await hostRun(
      { cmd: [probe.herdrPath, 'session', 'stop', name] },
      '/',
      probe.path,
    );
    await this.refresh();
    if (out.code !== 0) {
      throw new Error(out.stderr.trim() || `stopping ${name} failed`);
    }
    return true;
  }
}
