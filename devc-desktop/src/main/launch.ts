// devc-desktop's child: finding the installed `devc`, the `devc web` arguments and environment,
// and the running process, whose ready line carries the page URL. No Electron here, so this
// module type-checks and tests under plain Node; `main.ts` wires it to the window. See
// `.plans/devc-desktop-electron.md`.
//
// The app never runs devc's code itself. It runs the separately installed `devc` (or the
// checkout's, for `devc2`), as the `deno desktop` app before it did.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

/**
 * The line `devc web` prints once its page is served (`devc/main.ts`, and the supervisor's
 * `announce` under `--live-yolo`). Loopback and a 64-hex token only.
 */
const READY_LINE =
  /^devc web: (http:\/\/127\.0\.0\.1:\d{1,5}\/#token=[0-9a-f]{64})$/;

/** The page URL in `line`, if it is `devc web`'s ready line, else `null`. */
export function readyUrl(line: string): string | null {
  return READY_LINE.exec(line.trimEnd())?.[1] ?? null;
}

/**
 * Which `devc` the app runs, from `"desktopDevc"`: the installed one (absent, or
 * `"installed"`), the checkout's from source (`"devc2"`: `$DEVC_BIN`), or the binary at an
 * absolute path.
 */
export type DevcChoice =
  | { kind: 'installed' }
  | { kind: 'devc2' }
  | { kind: 'path'; path: string };

/** The app's keys in `~/.config/devc/config.json`, with their defaults filled in. */
export interface DesktopConfig {
  /** `"desktopWebArgs"`: the `devc web` arguments when the app is launched with none. */
  webArgs: string[];
  /** `"desktopDevc"`: see {@link DevcChoice}. */
  devc: DevcChoice;
}

/**
 * The app's keys from the text of `~/.config/devc/config.json` (`null`: no file, so the
 * defaults). devc keeps keys it does not know, so they live beside devc's own. Throws on
 * malformed JSON or a malformed value, with a message naming the key.
 */
export function desktopConfig(text: string | null): DesktopConfig {
  const cfg = text === null ? {} : JSON.parse(text);
  return {
    webArgs: webArgsFrom(cfg?.desktopWebArgs),
    devc: devcChoiceFrom(cfg?.desktopDevc),
  };
}

function webArgsFrom(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string')) {
    throw new Error('"desktopWebArgs" must be an array of strings');
  }
  return raw;
}

function devcChoiceFrom(raw: unknown): DevcChoice {
  if (raw === undefined || raw === null || raw === 'installed') {
    return { kind: 'installed' };
  }
  if (raw === 'devc2') return { kind: 'devc2' };
  if (typeof raw === 'string' && raw.startsWith('/')) {
    return { kind: 'path', path: raw };
  }
  throw new Error(
    '"desktopDevc" must be "installed", "devc2" or an absolute path to a devc binary',
  );
}

/**
 * The arguments `devc` is run with: `web --no-open`, then the app's own arguments if it was
 * given any, else the config's. Never `--port`: devc picks it, and the ready line says which.
 */
export function devcArgs(appArgs: string[], configArgs: string[]): string[] {
  return ['web', '--no-open', ...(appArgs.length > 0 ? appArgs : configArgs)];
}

/**
 * The environment a child of the app gets (`devc web`, and the host terminal's shell): the
 * app's, with `PATH` replaced when the login shell supplied one, and never an `ELECTRON_*`
 * variable (`ELECTRON_RUN_AS_NODE` would turn any Electron app the shell starts into Node) nor
 * `DENO_SERVE_ADDRESS` (it moves a `Deno.serve`'s first server, should anything set it).
 */
export function childEnv(
  env: Record<string, string | undefined>,
  path: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith('ELECTRON_')) continue;
    if (k === 'DENO_SERVE_ADDRESS') continue;
    out[k] = v;
  }
  if (path !== undefined) out.PATH = path;
  return out;
}

/**
 * How to run `devc`: the command (`[path]` for a binary, or `$DEVC_BIN`'s words, e.g.
 * `deno run … devc/main.ts`), and the `PATH` to run it with when not the app's own.
 */
export interface Found {
  cmd: string[];
  path?: string;
}

/** What the login shell says: its `PATH`, and its `$DEVC_BIN` if set. */
export interface LoginEnv {
  path: string;
  devcBin?: string;
}

/** The lookups {@link findDevc} makes, injected for tests. */
export interface FindDeps {
  /** The app's environment variable `k`. */
  env(k: string): string | undefined;
  /** The first executable `name` in the colon-separated `path`, or `null`. */
  onPath(name: string, path: string): Promise<string | null>;
  /** The login shell's {@link LoginEnv}, or `null` when it cannot be read. */
  loginEnv(): Promise<LoginEnv | null>;
}

/** Where {@link findDevc} looks for `choice`, in order, for the not-found message. */
export function looked(choice: DevcChoice): string[] {
  switch (choice.kind) {
    case 'path':
      return ['$DEVC_DESKTOP_DEVC', choice.path];
    case 'devc2':
      return [
        '$DEVC_DESKTOP_DEVC',
        "$DEVC_BIN in the app's environment",
        '$DEVC_BIN in your login shell (source scripts/bash_aliases.sh there)',
      ];
    case 'installed':
      return [
        '$DEVC_DESKTOP_DEVC',
        "devc on the app's PATH",
        "devc on your login shell's PATH",
      ];
  }
}

/** `$DEVC_BIN`'s words: it is a multi-word command, split on whitespace like a shell would. */
function words(s: string): string[] {
  return s.trim().split(/\s+/).filter((w) => w !== '');
}

/**
 * Finds the `devc` that `choice` asks for. `$DEVC_DESKTOP_DEVC` (an absolute path to a binary)
 * overrides it, for a terminal launch. Then:
 *
 * - `installed`: `devc` on the app's `PATH`, else on the login shell's.
 * - `devc2`: `$DEVC_BIN`, the from-source invocation that sourcing `scripts/bash_aliases.sh`
 *   exports (the shell function `devc2` as a command a process can run), from the app's
 *   environment, else the login shell's, its first word resolved on the login `PATH`.
 * - `path`: that binary, as is.
 *
 * An app opened from the Dock or Finder gets launchd's minimal `PATH`, which lacks
 * `~/.local/bin`, `docker` and `deno`, and none of the shell's variables. So the login shell is
 * asked, and its `PATH` goes to the child too. `null` when nothing is found.
 */
export async function findDevc(
  deps: FindDeps,
  choice: DevcChoice,
): Promise<Found | null> {
  const given = deps.env('DEVC_DESKTOP_DEVC');
  if (given) return { cmd: [given] };
  if (choice.kind === 'path') return { cmd: [choice.path] };
  if (choice.kind === 'devc2') {
    const bin = words(deps.env('DEVC_BIN') ?? '');
    if (bin.length > 0) return { cmd: bin };
  } else {
    const own = await deps.onPath('devc', deps.env('PATH') ?? '');
    if (own !== null) return { cmd: [own] };
  }
  const login = await deps.loginEnv();
  if (login === null) return null;
  if (choice.kind === 'installed') {
    const devc = await deps.onPath('devc', login.path);
    return devc === null ? null : { cmd: [devc], path: login.path };
  }
  const loginBin = words(login.devcBin ?? '');
  if (loginBin.length === 0) return null;
  // Spawning resolves a bare name against the app's own PATH, not the child's.
  const first = loginBin[0].includes('/')
    ? loginBin[0]
    : await deps.onPath(loginBin[0], login.path);
  return first === null
    ? null
    : { cmd: [first, ...loginBin.slice(1)], path: login.path };
}

/** The first executable `name` in the colon-separated `path`, or `null`. */
export async function onPath(
  name: string,
  path: string,
): Promise<string | null> {
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const file = `${dir}/${name}`;
    try {
      const st = await stat(file);
      if (st.isFile() && (st.mode & 0o111) !== 0) return file;
    } catch { /* not here */ }
  }
  return null;
}

/** Brackets the values in the login shell's output, which rc files may add lines to. */
const MARK = '__devc_desktop__';

/** How long the login shell gets to answer. */
const LOGIN_SHELL_MS = 5000;

/**
 * `PATH` and `$DEVC_BIN` as the user's login shell sets them (`$SHELL`, else `/bin/zsh`),
 * interactive as well so rc files (`.zshrc`, `.bashrc`, where `bash_aliases.sh` is sourced)
 * count. `null` on failure or after 5 s.
 */
export function loginEnv(
  shell = process.env.SHELL || '/bin/zsh',
): Promise<LoginEnv | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, [
        '-ilc',
        `printf '${MARK}%s${MARK}%s${MARK}' "$PATH" "\${DEVC_BIN:-}"`,
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: LOGIN_SHELL_MS,
      });
    } catch {
      return resolve(null);
    }
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => text += d);
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const m = new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`, 's').exec(text);
      if (!m?.[1]) return resolve(null);
      resolve(m[2] ? { path: m[1], devcBin: m[2] } : { path: m[1] });
    });
  });
}

/** How many of the child's last stderr lines are kept, for the status view. */
export const STDERR_LINES = 40;

/** How long a stopping child gets after SIGTERM before SIGKILL. */
const STOP_GRACE_MS = 5000;

/** A running `devc web`, as the app sees it. */
export interface DevcWeb {
  /** The page URL from the ready line; never resolves if the child exits first. */
  ready: Promise<string>;
  /** The exit code (or signal name) once the child has exited. */
  exited: Promise<string>;
  /** The child's last {@link STDERR_LINES} lines of stderr, oldest first. */
  stderr(): string[];
  /** SIGTERM, then SIGKILL after 5 s; resolves once the child has exited. */
  stop(): Promise<void>;
}

/**
 * Starts `cmd` (a {@link Found}'s) with `args` after it, and `env`. stdout and stderr are read
 * for the child's whole life, so a full pipe never blocks it; stdout is only scanned for the
 * ready line, never kept or printed, since it carries the token. Throws if it cannot be spawned.
 */
export function startDevcWeb(
  cmd: string[],
  args: string[],
  env: Record<string, string>,
): DevcWeb {
  const child = spawn(cmd[0], [...cmd.slice(1), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let resolveReady!: (url: string) => void;
  const ready = new Promise<string>((r) => resolveReady = r);
  const tail: string[] = [];
  const keep = (line: string) => {
    tail.push(line);
    if (tail.length > STDERR_LINES) tail.shift();
  };
  eachLine(child.stdout, (line) => {
    const url = readyUrl(line);
    if (url !== null) resolveReady(url);
  });
  eachLine(child.stderr, keep);
  const exited = new Promise<string>((resolve) => {
    child.on('error', (e) => {
      keep(String(e.message));
      resolve('spawn failed');
    });
    child.on('close', (code, signal) => resolve(signal ?? String(code)));
  });
  return {
    ready,
    exited,
    stderr: () => [...tail],
    async stop() {
      const signal = (sig: NodeJS.Signals) => {
        try {
          child.kill(sig);
        } catch { /* already exited */ }
      };
      signal('SIGTERM');
      const timer = setTimeout(() => signal('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Calls `fn` with each line of `stream` (without its newline) until the stream ends. */
function eachLine(
  stream: NodeJS.ReadableStream,
  fn: (line: string) => void,
): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      fn(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  stream.on('end', () => {
    if (buf !== '') fn(buf);
    buf = '';
  });
}
