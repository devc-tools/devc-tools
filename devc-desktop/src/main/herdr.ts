// The host terminals' shells: panes of one Herdr session of the app's own (`desktopSessionName`
// in `policy.ts`), reached only from the main process. devc web's Herdr client
// (`devc/web/herdr_bridge.ts`, `controllers.ts`) is Deno code on its `Environment`; this is the
// same protocol in Node, for what the app needs. Every Herdr process is an argv spawn, never a
// shell string (but the server's login-shell wrapper), never a pty. See
// `.plans/archived/host-terminal-herdr.md` (D1–D3, and Step 0's measurements).

import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type Cell,
  paneScroll,
  toTextPoint,
} from '../../../devc/web/selection.ts';

/**
 * The app's Herdr session: `devc-desktop-` and the first 12 hex of the SHA-256 of its
 * `userData` folder, so an installed app and a dev build each have their own. devc web's
 * `hostSessionName` always has `-` as the 9th character from the end; here it is a hex digit,
 * so the two can never be the same name. See `.plans/archived/host-terminal-herdr.md` (D1).
 */
export function desktopSessionName(userData: string): string {
  return `devc-desktop-${
    createHash('sha256').update(userData).digest('hex').slice(0, 12)
  }`;
}

/** What the app spawns Herdr with: tests pass a fake. */
export type Spawn = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string },
) => ChildProcessWithoutNullStreams;

const defaultSpawn: Spawn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });

/** One Herdr session, and how to run `herdr` for it. */
export interface HerdrTarget {
  herdrPath: string;
  session: string;
  env: Record<string, string>;
  spawn?: Spawn;
}

/** A failed Herdr call: Herdr's error code, or `no_session` / `bridge_exited`. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** What `remote-api-bridge --check` prints for the protocol this client speaks. */
export const BRIDGE_VERSION = 'herdr-api-bridge-v1';

/** With {@link START_WAIT_MS}, about 15 s: Herdr's first start can be slow (as devc web's). */
export const START_TRIES = 50;
export const START_WAIT_MS = 300;

/**
 * The login-shell script `herdr server` runs inside, so the server and every pane it spawns get
 * the user's profile: `SHELL` is exported because Herdr gives a pane `$SHELL` (devc web's
 * `SERVER_SCRIPT`). The command rides along as `$0`/`$@`.
 */
export const SERVER_SCRIPT = 'export SHELL; exec "$0" "$@"';

/** The login shells whose `-lc` takes POSIX syntax; anything else (fish) gets `/bin/sh`. */
export function loginShellFor(shell: string): string {
  return ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(basename(shell))
    ? shell
    : '/bin/sh';
}

function run(
  t: HerdrTarget,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCmd(t.spawn ?? defaultSpawn, t.herdrPath, args, t.env);
}

function runCmd(
  spawn: Spawn,
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(cmd, args, { env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    p.stdout.on('data', (d) => stdout += d);
    p.stderr.on('data', (d) => stderr += d);
    p.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.stdin.end();
  });
}

/**
 * `herdr` on the user's login-shell PATH (devc-desktop started from Finder has a bare one), as an
 * absolute path, or null.
 */
export async function findHerdr(
  shell: string,
  env: Record<string, string>,
  spawn: Spawn = defaultSpawn,
): Promise<string | null> {
  const out = await runCmd(
    spawn,
    loginShellFor(shell),
    ['-lc', 'command -v herdr'],
    env,
  );
  const path = out.stdout.trim().split('\n').pop() ?? '';
  return out.code === 0 && path.startsWith('/') ? path : null;
}

/** `remote-api-bridge --check`: true only for exactly {@link BRIDGE_VERSION} and exit 0. */
export async function bridgeSupported(t: HerdrTarget): Promise<boolean> {
  const out = await run(t, [
    '--session',
    t.session,
    'remote-api-bridge',
    '--check',
  ]);
  return out.code === 0 && out.stdout.trim() === BRIDGE_VERSION;
}

/** `herdr --version`'s line (`herdr 0.9.5`), for a refusal; `herdr` when it says nothing. */
export async function herdrVersion(t: HerdrTarget): Promise<string> {
  const out = await run(t, ['--version']);
  const line = out.stdout.trim().split('\n')[0] ?? '';
  return out.code === 0 && line !== '' ? line : 'herdr';
}

/** Whether `herdr session list --json` shows the session running; null when it cannot say. */
export async function sessionRunning(t: HerdrTarget): Promise<boolean | null> {
  const out = await run(t, ['session', 'list', '--json']);
  if (out.code !== 0) return null;
  try {
    const sessions = (JSON.parse(out.stdout) as { sessions?: unknown })
      ?.sessions;
    if (!Array.isArray(sessions)) return null;
    const s = sessions.find((x) =>
      (x as { name?: unknown })?.name === t.session
    ) as { running?: unknown } | undefined;
    return s?.running === true;
  } catch {
    return null;
  }
}

/**
 * Starts the session's server unless it runs: `herdr --session <s> server` in a login shell,
 * detached so it outlives the app (Step 0, 1), in `cwd`; then waits for the listing to show it.
 */
export async function ensureServer(
  t: HerdrTarget,
  shell: string,
  cwd: string,
  opts: {
    detachedSpawn?: (cmd: string, args: string[], cwd: string) => void;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  if (await sessionRunning(t)) return;
  const start = opts.detachedSpawn ?? ((cmd, args, dir) => {
    const p = nodeSpawn(cmd, args, {
      cwd: dir,
      env: { ...t.env, SHELL: shell },
      detached: true,
      stdio: 'ignore',
    });
    p.on('error', () => {});
    p.unref();
  });
  start(
    loginShellFor(shell),
    ['-lc', SERVER_SCRIPT, t.herdrPath, '--session', t.session, 'server'],
    cwd,
  );
  const wait = opts.wait ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < START_TRIES; i++) {
    if (await sessionRunning(t)) return;
    await wait(START_WAIT_MS);
  }
  throw new HerdrError(
    'no_session',
    `herdr --session ${t.session} server did not start`,
  );
}

let nextId = 0;

/**
 * One request on a fresh bridge connection (Herdr resets a connection's second request).
 * Resolves with `result`; rejects with a {@link HerdrError}.
 */
export function bridgeRequest(
  t: HerdrTarget,
  method: string,
  params: unknown,
): Promise<unknown> {
  const spawn = t.spawn ?? defaultSpawn;
  const id = `devc-desktop-${++nextId}`;
  return new Promise((resolve, reject) => {
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(t.herdrPath, ['--session', t.session, 'remote-api-bridge'], {
        env: t.env,
      });
    } catch (e) {
      reject(new HerdrError('bridge_exited', String(e)));
      return;
    }
    let settled = false;
    let stderr = '';
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      f();
      p.stdin.end();
      p.kill();
    };
    p.stderr.on('data', (d) => stderr += d);
    p.on(
      'error',
      (e) => done(() => reject(new HerdrError('bridge_exited', String(e)))),
    );
    createInterface({ input: p.stdout }).on('line', (line) => {
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error as { code?: unknown; message?: unknown };
        done(() =>
          reject(
            new HerdrError(
              String(err.code ?? 'herdr_error'),
              String(err.message ?? 'Herdr returned an error'),
            ),
          )
        );
        return;
      }
      done(() => resolve(msg.result));
    });
    p.on('close', () =>
      done(() => {
        const text = stderr.trim();
        reject(
          text.includes('failed to connect to remote Herdr API socket') ||
            text.includes('kind: NotFound')
            ? new HerdrError('no_session', 'no Herdr server for this session')
            : new HerdrError('bridge_exited', text || 'Herdr bridge exited'),
        );
      }));
    p.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

/**
 * A new pane in its own Herdr tab, in `cwd`, never focused. A session with no workspace (a server
 * just started) has nowhere to put a tab (`workspace_not_found`): then `workspace.create`.
 */
export async function createShell(
  t: HerdrTarget,
  cwd: string,
): Promise<string> {
  const created = await bridgeRequest(t, 'tab.create', { cwd, focus: false })
    .catch((e) => {
      if (!(e instanceof HerdrError && e.code === 'workspace_not_found')) {
        throw e;
      }
      return bridgeRequest(t, 'workspace.create', { cwd, focus: false });
    }) as { root_pane?: { pane_id?: unknown } } | undefined;
  const pane = created?.root_pane?.pane_id;
  if (typeof pane !== 'string') {
    throw new HerdrError('herdr_error', 'Herdr made no pane');
  }
  return pane;
}

/** A pane as `pane.list` gives it, as far as the app uses it. */
export interface PaneInfo {
  pane_id: string;
  cwd: string;
  foreground_cwd: string;
  title: string;
  /** The agent Herdr detected in it (`claude`, say), or `''`. */
  agent: string;
  /** That agent's status (`idle`, `working`, …), or `''`. */
  agent_status: string;
}

/** The session's panes, in Herdr's order. */
export async function listPanes(t: HerdrTarget): Promise<PaneInfo[]> {
  const result = await bridgeRequest(t, 'pane.list', {}) as
    | { panes?: unknown }
    | undefined;
  const panes = Array.isArray(result?.panes) ? result.panes : [];
  const out: PaneInfo[] = [];
  for (const p of panes) {
    const o = p as Record<string, unknown>;
    if (typeof o?.pane_id !== 'string') continue;
    const str = (v: unknown) => typeof v === 'string' ? v : '';
    out.push({
      pane_id: o.pane_id,
      cwd: str(o.cwd),
      foreground_cwd: str(o.foreground_cwd) || str(o.cwd),
      title: str(o.terminal_title_stripped) || str(o.terminal_title),
      agent: str(o.agent),
      agent_status: str(o.agent_status),
    });
  }
  return out;
}

/** Ends a pane (its process too). */
export async function closePane(t: HerdrTarget, paneId: string): Promise<void> {
  await bridgeRequest(t, 'pane.close', { pane_id: paneId });
}

/**
 * Whether the pane's shell is at its prompt: `null` when it is, else the foreground program's
 * name (Step 0, 3: another process group than the shell's is in the foreground).
 */
export function busyFrom(result: unknown): string | null {
  const info = (result as { process_info?: unknown } | null)?.process_info as
    | Record<string, unknown>
    | undefined;
  if (typeof info !== 'object' || info === null) return null;
  const shell = info.shell_pid;
  const group = info.foreground_process_group_id;
  if (typeof shell !== 'number' || typeof group !== 'number') return null;
  if (group === shell) return null;
  const procs = Array.isArray(info.foreground_processes)
    ? info.foreground_processes
    : [];
  const name = (procs[0] as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name !== '' ? name : 'a program';
}

/** The pane's foreground program, as {@link busyFrom}; `null` too when Herdr cannot say. */
export async function busyWith(
  t: HerdrTarget,
  paneId: string,
): Promise<string | null> {
  try {
    return busyFrom(
      await bridgeRequest(t, 'pane.process_info', { pane_id: paneId }),
    );
  } catch {
    return null;
  }
}

/** The text between two viewport cells, read from Herdr (as devc web's `read_selection`). */
export async function readSelection(
  t: HerdrTarget,
  paneId: string,
  anchor: Cell,
  cursor: Cell,
): Promise<string> {
  const scroll = paneScroll(
    await bridgeRequest(t, 'pane.get', { pane_id: paneId }),
  );
  if (scroll === null) {
    throw new HerdrError('bad_reply', 'pane.get returned no scroll position');
  }
  const result = await bridgeRequest(t, 'pane.selection.read', {
    pane_id: paneId,
    anchor: toTextPoint(scroll, anchor),
    cursor: toTextPoint(scroll, cursor),
  }) as { text?: unknown } | null;
  return typeof result?.text === 'string' ? result.text : '';
}

/** A command for a pane's controller, written to its stdin (devc web's `TerminalCommand`). */
export type TerminalCommand =
  | { type: 'terminal.input'; bytes: string }
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.scroll'; direction: 'up' | 'down'; lines: number }
  | {
    type: 'terminal.mouse';
    action: 'down' | 'up' | 'drag' | 'move';
    button?: 'left' | 'right' | 'middle';
    column: number;
    row: number;
  };

/** A frame, as the page's `renderer.js` takes it: `bytes` base64 (Step 0). */
export interface Frame {
  seq: unknown;
  full: boolean;
  cols: number;
  rows: number;
  bytes: string;
}

/** A pane's controller: one `terminal session control --takeover` process. */
export interface PaneControl {
  send(cmd: TerminalCommand): void;
  /** Lets go of the pane (`terminal.release`); it keeps running. */
  release(): void;
}

/** How long a released controller gets to exit before it is killed. */
const RELEASE_GRACE_MS = 2000;

/**
 * Takes over a pane's terminal: frames go to `onFrame`; `onClosed` hears why it ended (Herdr's
 * `terminal.closed` reason, or the process's stderr), unless the app released it itself.
 */
export function controlPane(
  t: HerdrTarget,
  paneId: string,
  cols: number,
  rows: number,
  on: { frame(f: Frame): void; closed(reason: string): void },
): PaneControl {
  const spawn = t.spawn ?? defaultSpawn;
  const p = spawn(t.herdrPath, [
    '--session',
    t.session,
    'terminal',
    'session',
    'control',
    paneId,
    '--takeover',
    '--cols',
    String(cols),
    '--rows',
    String(rows),
  ], { env: t.env });
  let released = false;
  let closed: string | null = null;
  let stderr = '';
  p.stderr.on('data', (d) => stderr += d);
  p.on('error', (e) => {
    closed ??= String(e);
  });
  createInterface({ input: p.stdout }).on('line', (line) => {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    if (rec.type === 'terminal.frame') {
      on.frame({
        seq: rec.seq,
        full: rec.full === true,
        cols: Number(rec.width),
        rows: Number(rec.height),
        bytes: String(rec.bytes ?? ''),
      });
    } else if (rec.type === 'terminal.closed') {
      closed = String(rec.reason ?? 'closed');
    }
  });
  p.on('close', () => {
    if (released) return;
    on.closed(closed ?? (stderr.trim() || 'terminal controller exited'));
  });
  const write = (o: unknown) => {
    if (p.stdin.writable) p.stdin.write(JSON.stringify(o) + '\n');
  };
  return {
    send: (cmd) => {
      if (!released) write(cmd);
    },
    release: () => {
      if (released) return;
      released = true;
      write({ type: 'terminal.release' });
      p.stdin.end();
      setTimeout(() => p.kill(), RELEASE_GRACE_MS).unref?.();
    },
  };
}
