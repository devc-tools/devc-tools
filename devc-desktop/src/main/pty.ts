// The host terminal's shell: one `node-pty` process on the host, owned by the main process and
// reached only through the host view's IPC. Not Herdr, and nothing devc web can address.

import { userInfo } from 'node:os';
import type { IPty } from 'node-pty';
import { MAX_SHELLS } from './policy.ts';

/** How long output is gathered before it goes to the page, in ms: one IPC message per frame. */
const FLUSH_MS = 16;

/** How long the shell gets after SIGHUP before SIGKILL, when the app quits. */
const STOP_GRACE_MS = 5000;

/**
 * The shell the host terminal runs: `$SHELL`, else the account's login shell, else `/bin/zsh`
 * on macOS and `/bin/bash` elsewhere.
 */
export function hostShell(
  env: Record<string, string | undefined>,
  platform: string,
  accountShell: string | null,
): string {
  return env.SHELL || accountShell ||
    (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/** The account's shell from the password database, or `null`. */
export function accountShell(): string | null {
  try {
    return userInfo().shell || null;
  } catch {
    return null;
  }
}

/** The host terminal's environment: the app's (already stripped by `childEnv`), plus a terminal. */
export function ptyEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export interface HostPtyOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  /** Output, batched to at most one call per {@link FLUSH_MS}. */
  onOutput(data: string): void;
  onExit(code: number): void;
}

/**
 * One shell behind the drawer. {@link start} spawns it if none is running, so reopening the
 * drawer finds the same shell, and opening it after the shell exited starts a fresh one.
 */
export class HostPty {
  #pty: IPty | null = null;
  #buf = '';
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #opts: HostPtyOptions;
  readonly #spawn: typeof import('node-pty').spawn;

  constructor(opts: HostPtyOptions, spawn: typeof import('node-pty').spawn) {
    this.#opts = opts;
    this.#spawn = spawn;
  }

  get running(): boolean {
    return this.#pty !== null;
  }

  /** The shell it runs. */
  get shell(): string {
    return this.#opts.shell;
  }

  /** The foreground process's name (node-pty's `process`), or `null` while no shell runs. */
  get foreground(): string | null {
    try {
      return this.#pty?.process ?? null;
    } catch {
      return null;
    }
  }

  start(cols: number, rows: number): void {
    if (this.#pty !== null) {
      this.resize(cols, rows);
      return;
    }
    const pty = this.#spawn(this.#opts.shell, ['-l'], {
      name: 'xterm-256color',
      cols: size(cols, 80),
      rows: size(rows, 24),
      cwd: this.#opts.cwd,
      env: this.#opts.env,
    });
    this.#pty = pty;
    pty.onData((d) => {
      this.#buf += d;
      this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      if (this.#pty !== pty) return;
      this.#flush();
      this.#pty = null;
      this.#opts.onExit(exitCode);
    });
  }

  write(data: string): void {
    this.#pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.#pty?.resize(size(cols, 80), size(rows, 24));
    } catch { /* exited meanwhile */ }
  }

  /** SIGHUP to the shell's process group, SIGKILL after 5 s; resolves once it has exited. */
  async stop(): Promise<void> {
    const pty = this.#pty;
    if (pty === null) return;
    const exited = new Promise<void>((r) => pty.onExit(() => r()));
    const signal = (sig: NodeJS.Signals) => {
      try {
        // node-pty starts the shell in a session of its own, so its pid leads the group.
        process.kill(-pty.pid, sig);
      } catch {
        try {
          pty.kill(sig);
        } catch { /* gone */ }
      }
    };
    signal('SIGHUP');
    const timer = setTimeout(() => signal('SIGKILL'), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  #flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#buf === '') return;
    const out = this.#buf;
    this.#buf = '';
    this.#opts.onOutput(out);
  }
}

/** {@link HostPtyOptions}, for every shell of {@link HostPtys}: output and exits name their shell. */
export interface HostPtysOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  onOutput(id: string, data: string): void;
  onExit(id: string, code: number): void;
}

/**
 * The host shells: the drawer's, one per terminal tile, by the id its page gave it, and the host
 * tiles', by the id the app gave each. A tile's shell lives
 * until the tile closes ({@link close}) or the app quits ({@link stop}); at most
 * {@link MAX_SHELLS} at once, and a {@link start} past that is ignored.
 */
export class HostPtys {
  readonly #ptys = new Map<string, HostPty>();
  readonly #opts: HostPtysOptions;
  readonly #spawn: typeof import('node-pty').spawn;

  constructor(opts: HostPtysOptions, spawn: typeof import('node-pty').spawn) {
    this.#opts = opts;
    this.#spawn = spawn;
  }

  /** How many shells there are, running or not. */
  get size(): number {
    return this.#ptys.size;
  }

  /** The shell with this id, or `undefined`. */
  get(id: string): HostPty | undefined {
    return this.#ptys.get(id);
  }

  start(id: string, cols: number, rows: number): void {
    let pty = this.#ptys.get(id);
    if (pty === undefined) {
      if (this.#ptys.size >= MAX_SHELLS) return;
      pty = new HostPty({
        shell: this.#opts.shell,
        cwd: this.#opts.cwd,
        env: this.#opts.env,
        onOutput: (data) => this.#opts.onOutput(id, data),
        onExit: (code) => {
          // A closed tile's shell has no one left to tell.
          if (this.#ptys.has(id)) this.#opts.onExit(id, code);
        },
      }, this.#spawn);
      this.#ptys.set(id, pty);
    }
    pty.start(cols, rows);
  }

  /** Forgets a closed tile's shell and stops it. */
  async close(id: string): Promise<void> {
    const pty = this.#ptys.get(id);
    this.#ptys.delete(id);
    await pty?.stop();
  }

  /** Stops every shell: see {@link HostPty.stop}. */
  async stop(): Promise<void> {
    await Promise.all([...this.#ptys.values()].map((p) => p.stop()));
  }
}

/** A terminal dimension from the page: a whole number from 1 to 1000, else `fallback`. */
function size(n: number, fallback: number): number {
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}
