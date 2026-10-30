// A container start from `devc web` that outlives `devc web`: run in a pane of the host's own
// Herdr session `devcd` ({@link DEVCD_SESSION}) instead of as a child of the server, so a restart
// of `devc web` (devc-desktop's Restart, say) no longer kills a start halfway through.
//
// The pane runs devc itself with the hidden `__web-start` subcommand ({@link
// WEB_START_SUBCOMMAND}), which is `project_control.ts`'s `startProject` — the same start as
// before — writing into a run folder per project ({@link startRunDir}):
//
//   folder        the project's folder, written by devc web before the start begins
//   output.log    every output line, appended as it comes
//   heartbeat     rewritten every few seconds while the start runs
//   result.json   `{ "ok": true }` or `{ "ok": false, "error": "…" }`, written once, last
//
// `devc web` follows the folder rather than the pane ({@link followStart}): the log's new lines
// are its progress, the result its outcome, and a heartbeat gone stale with no result means the
// start died. A `devc web` started again while one runs follows that one instead of starting a
// second, and one launched while starts run shows them as starting ({@link runningStarts}). No
// `herdr` on this machine, or a `devcd` that won't come up, and the start runs in
// `devc web` as before.

import { createHash } from 'node:crypto';
import { basename, fromFileUrl, join } from 'jsr:@std/path';
import { shellQuote } from '@devc-tools/core/mount_check.ts';
import {
  currentRuntime,
  type SelfExecRuntime,
} from '../devcontainer_selfexec.ts';
import {
  HostEnvironment,
  hostRun,
  type HostShell,
  parseSessionList,
} from './env_host.ts';
import {
  bridgeRequest,
  createShell,
  type HerdrTarget,
  START_SESSION_TRIES,
  START_SESSION_WAIT_MS,
} from './herdr_bridge.ts';
import { startProject } from './project_control.ts';

/** The host Herdr session that runs `devc web`'s host processes. */
export const DEVCD_SESSION = 'devcd';

/**
 * Hidden subcommand that turns a devc process into one start of a project's container, its
 * output and outcome in a run folder: `devc __web-start <localFolder> <runDir>`. Dispatched in
 * `main.ts` with the other self-execs, and absent from `COMMANDS`.
 */
export const WEB_START_SUBCOMMAND = '__web-start';

/** The run folder's files. */
export const FOLDER_FILE = 'folder';
export const OUTPUT_FILE = 'output.log';
export const HEARTBEAT_FILE = 'heartbeat';
export const RESULT_FILE = 'result.json';
const SCRIPT_FILE = 'run.sh';

/** How often a running start rewrites its heartbeat. */
export const HEARTBEAT_MS = 2000;
/** A heartbeat this old, with no result, is a start that died. */
export const HEARTBEAT_STALE_MS = 15_000;
/** How long the pane's shell gets to begin the start (its login profile runs first). */
export const BEGIN_TIMEOUT_MS = 30_000;
/** How often {@link followStart} looks at the run folder. */
export const FOLLOW_POLL_MS = 300;

/**
 * The permissions the from-source child runs with: `startContainer`'s, the same set as the
 * devcontainer CLI's self-exec (`SOURCE_CHILD_PERMISSIONS` in `devcontainer_selfexec.ts`).
 */
const SOURCE_CHILD_PERMISSIONS = [
  '--allow-read',
  '--allow-write',
  '--allow-env',
  '--allow-sys',
  '--allow-net',
  '--allow-run',
];

/** `<home>/.cache/devc/starts`: every project's run folder. */
function startsDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/.cache/devc/starts`;
}

/** `<home>/.cache/devc/starts/<16 hex chars of the folder's SHA-256>`. */
export function startRunDir(home: string, localFolder: string): string {
  const hex = createHash('sha256').update(localFolder, 'utf8').digest('hex');
  return `${startsDir(home)}/${hex.slice(0, 16)}`;
}

/** Full argv (after the executable) for the self-exec, as `devcontainerArgv`. */
export function webStartArgv(
  localFolder: string,
  runDir: string,
  runtime: SelfExecRuntime,
): string[] {
  const self = runtime.standalone
    ? []
    : ['run', ...SOURCE_CHILD_PERMISSIONS, fromFileUrl(runtime.mainModule)];
  return [...self, WEB_START_SUBCOMMAND, localFolder, runDir];
}

/**
 * The script the pane runs. A file, so the line typed into the pane's shell — whatever shell the
 * user's is, fish included — is only `exec /bin/sh '<script>'`, with no argv of ours to quote.
 */
export function startScript(
  localFolder: string,
  runDir: string,
  runtime: SelfExecRuntime,
): string {
  const argv = [
    runtime.execPath,
    ...webStartArgv(localFolder, runDir, runtime),
  ];
  return `#!/bin/sh\nexec ${argv.map(shellQuote).join(' ')}\n`;
}

/** The line typed into the pane. */
export function paneCommand(runDir: string): string {
  return `exec /bin/sh ${shellQuote(join(runDir, SCRIPT_FILE))}\n`;
}

/** What `result.json` holds; null while there is none (or it is malformed). */
export type StartResult = { ok: true } | { ok: false; error: string };

export function parseResult(text: string): StartResult | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const r = data as { ok?: unknown; error?: unknown } | null;
  if (r?.ok === true) return { ok: true };
  if (r?.ok === false) {
    return { ok: false, error: typeof r.error === 'string' ? r.error : '' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The child: `devc __web-start`
// ---------------------------------------------------------------------------------------------

/** Writes all of `bytes`, which one `writeSync` need not. */
function writeAllSync(file: Deno.FsFile, bytes: Uint8Array): void {
  let n = 0;
  while (n < bytes.length) n += file.writeSync(bytes.subarray(n));
}

/**
 * The child half: one start, its lines to the pane and `output.log`, its heartbeat kept fresh,
 * its outcome to `result.json` (written whole, through a rename). Never returns.
 */
export async function runWebStartBody(args: string[]): Promise<never> {
  const [localFolder, runDir] = args;
  if (!localFolder || !runDir) {
    console.error(`devc ${WEB_START_SUBCOMMAND} <localFolder> <runDir>`);
    Deno.exit(2);
  }
  const log = await Deno.open(join(runDir, OUTPUT_FILE), {
    append: true,
    create: true,
  });
  const encoder = new TextEncoder();
  const beat = () =>
    Deno.writeTextFile(join(runDir, HEARTBEAT_FILE), String(Date.now()))
      .catch(() => {});
  await beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  let result: StartResult;
  try {
    await startProject(localFolder, (line) => {
      console.log(line);
      writeAllSync(log, encoder.encode(`${line}\n`));
    });
    result = { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(error);
    result = { ok: false, error };
  }
  clearInterval(timer);
  log.close();
  const tmp = join(runDir, `${RESULT_FILE}.tmp`);
  await Deno.writeTextFile(tmp, JSON.stringify(result));
  await Deno.rename(tmp, join(runDir, RESULT_FILE));
  Deno.exit(result.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------
// devc web's half
// ---------------------------------------------------------------------------------------------

/** The run folder's state: whether a start is running there now. */
export async function runningStart(
  runDir: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    await Deno.stat(join(runDir, RESULT_FILE));
    return false;
  } catch { /* none yet */ }
  try {
    const { mtime } = await Deno.stat(join(runDir, HEARTBEAT_FILE));
    return mtime !== null && now - mtime.getTime() < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** The folders whose start is running now, from their run folders' `folder` files. */
export async function runningStarts(home: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(startsDir(home))) {
      if (!e.isDirectory) continue;
      const runDir = join(startsDir(home), e.name);
      const folder = await Deno.readTextFile(join(runDir, FOLDER_FILE))
        .catch(() => '');
      // Only a folder that is its own run folder's: never a stray or edited file's.
      if (
        folder !== '' && startRunDir(home, folder) === runDir &&
        await runningStart(runDir)
      ) out.push(folder);
    }
  } catch { /* no starts yet */ }
  return out;
}

/**
 * Follows `localFolder`'s start to its end when one is running (see {@link followStart}); false,
 * having followed nothing, when none is.
 */
export async function resumeStart(
  home: string,
  localFolder: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  const runDir = startRunDir(home, localFolder);
  if (!(await runningStart(runDir))) return false;
  await followStart(runDir, onLine);
  return true;
}

/**
 * Follows the start in `runDir` to its end: each new line of `output.log` to `onLine`, from
 * `offset` bytes in. Resolves on `{ ok: true }`; rejects with the start's error, when the
 * heartbeat goes stale with no result, or when there is still none after `beginTimeoutMs`.
 */
export async function followStart(
  runDir: string,
  onLine: (line: string) => void,
  opts: { beginTimeoutMs?: number; pollMs?: number; staleMs?: number } = {},
): Promise<void> {
  const beginTimeoutMs = opts.beginTimeoutMs ?? BEGIN_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FOLLOW_POLL_MS;
  const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;
  const since = Date.now();
  const decoder = new TextDecoder();
  let offset = 0;
  let partial = '';
  const drain = async (final: boolean) => {
    let file: Deno.FsFile;
    try {
      file = await Deno.open(join(runDir, OUTPUT_FILE));
    } catch {
      return;
    }
    try {
      await file.seek(offset, Deno.SeekMode.Start);
      const buf = new Uint8Array(64 * 1024);
      for (;;) {
        const n = await file.read(buf);
        if (n === null || n === 0) break;
        offset += n;
        partial += decoder.decode(buf.subarray(0, n), { stream: true });
      }
    } finally {
      file.close();
    }
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) onLine(line);
    if (final && partial !== '') {
      onLine(partial);
      partial = '';
    }
  };
  for (;;) {
    const result = await Deno.readTextFile(join(runDir, RESULT_FILE))
      .then(parseResult, () => null);
    await drain(result !== null);
    if (result !== null) {
      if (result.ok) return;
      throw new Error(result.error || 'the start failed');
    }
    const beat = await Deno.stat(join(runDir, HEARTBEAT_FILE))
      .then((s) => s.mtime?.getTime() ?? null, () => null);
    const now = Date.now();
    if (beat === null && now - since > beginTimeoutMs) {
      throw new Error(
        `the start never began in Herdr session ${DEVCD_SESSION} (${
          Math.round(beginTimeoutMs / 1000)
        }s)`,
      );
    }
    if (beat !== null && now - beat > staleMs) {
      throw new Error(
        `the start stopped without an outcome (its Herdr session ${DEVCD_SESSION} pane went away?)`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Starts session `devcd` unless it runs; false when it doesn't come up. */
async function ensureDevcd(
  env: HostEnvironment,
  herdrPath: string,
  path: string,
): Promise<boolean> {
  const running = async () => {
    const out = await hostRun(
      { cmd: [herdrPath, 'session', 'list', '--json'] },
      '/',
      path,
    );
    if (out.code !== 0) return false;
    return parseSessionList(new TextDecoder().decode(out.stdout))
      ?.get(DEVCD_SESSION)?.running ?? false;
  };
  if (await running()) return true;
  const out = await env.runDetached({
    cmd: [herdrPath, '--session', DEVCD_SESSION, 'server'],
    cwd: '/',
  });
  if (out.code !== 0) return false;
  for (let i = 0; i < START_SESSION_TRIES; i++) {
    if (await running()) return true;
    await new Promise((r) => setTimeout(r, START_SESSION_WAIT_MS));
  }
  return false;
}

/**
 * Starts `localFolder`'s container in a pane of Herdr session `devcd`, or follows the start
 * already running there, to its end (see {@link followStart}). False, having run nothing, when
 * there is no `herdr` on this machine or `devcd` couldn't be had: the caller starts it itself.
 */
export async function startInDevcd(opts: {
  shell: HostShell;
  home: string;
  localFolder: string;
  onLine: (line: string) => void;
  runtime?: SelfExecRuntime;
}): Promise<boolean> {
  const { shell, home, localFolder, onLine } = opts;
  const runDir = startRunDir(home, localFolder);
  if (await runningStart(runDir)) {
    onLine(`already starting in Herdr session ${DEVCD_SESSION}: following it`);
    await followStart(runDir, onLine);
    return true;
  }
  const probe = await shell.current();
  if (probe.herdrPath === '') return false;
  const env = new HostEnvironment(home, DEVCD_SESSION, shell);
  if (!(await ensureDevcd(env, probe.herdrPath, probe.path))) {
    onLine(
      `Herdr session ${DEVCD_SESSION} didn't come up: starting it from devc web`,
    );
    return false;
  }
  await Deno.remove(runDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(runDir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(join(runDir, FOLDER_FILE), localFolder);
  await Deno.writeTextFile(
    join(runDir, SCRIPT_FILE),
    startScript(localFolder, runDir, opts.runtime ?? currentRuntime()),
  );
  const target: HerdrTarget = {
    env,
    herdrPath: probe.herdrPath,
    session: DEVCD_SESSION,
  };
  try {
    const pane = await createShell(target, { cwd: localFolder });
    await bridgeRequest(target, 'pane.send_text', {
      pane_id: pane.pane_id,
      text: paneCommand(runDir),
    });
    // Named for what it runs, in a Herdr TUI attached to `devcd`; a failed rename is harmless.
    await bridgeRequest(target, 'pane.rename', {
      pane_id: pane.pane_id,
      label: `start ${basename(localFolder)}`,
    }).catch(() => {});
  } catch (e) {
    onLine(
      `Herdr session ${DEVCD_SESSION} has no pane for it (${
        e instanceof Error ? e.message : String(e)
      }): starting it from devc web`,
    );
    return false;
  }
  onLine(`starting in Herdr session ${DEVCD_SESSION}`);
  await followStart(runDir, onLine);
  return true;
}
