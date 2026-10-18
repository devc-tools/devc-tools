// devc-desktop's child: finding the installed `devc`, the `devc web` arguments and environment,
// and the running process, whose ready line carries the page URL. No window code here, so this
// module type-checks and tests under plain `deno`; `main.ts` wires it to the window. See
// `.plans/devc-desktop.md`.
//
// The app never runs devc's code itself, and never re-executes its own binary: a `deno desktop`
// binary started again with arguments is another GUI instance, not a CLI, so devc's self-exec of
// its embedded devcontainer CLI could not work in here. It runs the separately installed `devc`.

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
 * `desktopWebArgs` from the text of `~/.config/devc/config.json`: the `devc web` arguments the
 * app adds when launched with none. Absent (or no file, `text` null) means `[]`. Throws on
 * malformed JSON or a value that is not an array of strings, with a message naming the key.
 */
export function desktopWebArgsFromConfig(text: string | null): string[] {
  if (text === null) return [];
  const cfg = JSON.parse(text);
  const raw = cfg?.desktopWebArgs;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string')) {
    throw new Error('"desktopWebArgs" must be an array of strings');
  }
  return raw;
}

/**
 * The arguments `devc` is run with: `web --no-open`, then the app's own arguments if it was
 * given any, else the config's. Never `--port`: devc picks it, and the ready line says which.
 */
export function devcArgs(appArgs: string[], configArgs: string[]): string[] {
  return ['web', '--no-open', ...(appArgs.length > 0 ? appArgs : configArgs)];
}

/**
 * The child's environment: the app's, with `PATH` replaced when the login shell supplied one,
 * and never `DENO_SERVE_ADDRESS`. The desktop runtime sets that for the app's own server, and a
 * `Deno.serve` in any process that inherits it binds there instead of its own port.
 */
export function childEnv(
  env: Record<string, string>,
  path: string | undefined,
): Record<string, string> {
  const out = { ...env };
  delete out.DENO_SERVE_ADDRESS;
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

/** The places {@link findDevc} looks, in order, for the not-found message. */
export const LOOKED = [
  '$DEVC_DESKTOP_DEVC',
  '$DEVC_BIN',
  "devc on the app's PATH",
  '$DEVC_BIN or devc in your login shell',
];

/** `$DEVC_BIN`'s words: it is a multi-word command, split on whitespace like a shell would. */
function words(s: string): string[] {
  return s.trim().split(/\s+/).filter((w) => w !== '');
}

/**
 * Finds `devc`: `$DEVC_DESKTOP_DEVC` (an absolute path to a binary), else `$DEVC_BIN`, else `devc`
 * on the app's `PATH`, else the same two in the login shell. `$DEVC_BIN` is what sourcing
 * `scripts/bash_aliases.sh` exports, the from-source `devc2` as a command a process can run; it
 * comes before a `PATH` `devc` because it only exists when asked for (as in the Features'
 * `run-features-test.sh`). An app opened from the Dock or Finder gets launchd's minimal `PATH`,
 * which lacks `~/.local/bin`, `docker` and `deno`; the login shell's `PATH` then goes to the
 * child too, and resolves `$DEVC_BIN`'s first word. `null` when none has it.
 */
export async function findDevc(deps: FindDeps): Promise<Found | null> {
  const given = deps.env('DEVC_DESKTOP_DEVC');
  if (given) return { cmd: [given] };
  const bin = words(deps.env('DEVC_BIN') ?? '');
  if (bin.length > 0) return { cmd: bin };
  const own = await deps.onPath('devc', deps.env('PATH') ?? '');
  if (own !== null) return { cmd: [own] };
  const login = await deps.loginEnv();
  if (login === null) return null;
  const loginBin = words(login.devcBin ?? '');
  if (loginBin.length > 0) {
    // Spawning resolves a bare name against the app's own PATH, not the child's.
    const first = loginBin[0].includes('/')
      ? loginBin[0]
      : await deps.onPath(loginBin[0], login.path);
    if (first !== null) {
      return { cmd: [first, ...loginBin.slice(1)], path: login.path };
    }
  }
  const devc = await deps.onPath('devc', login.path);
  return devc === null ? null : { cmd: [devc], path: login.path };
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
      const st = await Deno.stat(file);
      if (st.isFile && ((st.mode ?? 0o111) & 0o111) !== 0) return file;
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
export async function loginEnv(
  shell = Deno.env.get('SHELL') || '/bin/zsh',
): Promise<LoginEnv | null> {
  try {
    const out = await new Deno.Command(shell, {
      args: [
        '-ilc',
        `printf '${MARK}%s${MARK}%s${MARK}' "$PATH" "\${DEVC_BIN:-}"`,
      ],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      signal: AbortSignal.timeout(LOGIN_SHELL_MS),
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const m = new RegExp(`${MARK}(.*?)${MARK}(.*?)${MARK}`, 's').exec(text);
    if (!m?.[1]) return null;
    return m[2] ? { path: m[1], devcBin: m[2] } : { path: m[1] };
  } catch {
    return null;
  }
}

/** How many of the child's last stderr lines are kept, for the status page. */
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
 * Starts `cmd` (a {@link Found}'s) with `args` after it, and `env`. stdout and stderr are read for the child's whole life, so
 * a full pipe never blocks it; stdout is only scanned for the ready line, never kept or printed,
 * since it carries the token.
 */
export function startDevcWeb(
  cmd: string[],
  args: string[],
  env: Record<string, string>,
): DevcWeb {
  const child = new Deno.Command(cmd[0], {
    args: [...cmd.slice(1), ...args],
    env,
    clearEnv: true,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let resolveReady!: (url: string) => void;
  const ready = new Promise<string>((r) => resolveReady = r);
  const tail: string[] = [];
  const keep = (line: string) => {
    tail.push(line);
    if (tail.length > STDERR_LINES) tail.shift();
  };
  const outDone = eachLine(child.stdout, (line) => {
    const url = readyUrl(line);
    if (url !== null) resolveReady(url);
  });
  const errDone = eachLine(child.stderr, keep);
  const exited = child.status.then(async (s) => {
    await Promise.allSettled([outDone, errDone]);
    return s.signal ?? String(s.code);
  });
  return {
    ready,
    exited,
    stderr: () => [...tail],
    async stop() {
      const signal = (sig: Deno.Signal) => {
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
async function eachLine(
  stream: ReadableStream<Uint8Array>,
  fn: (line: string) => void,
): Promise<void> {
  let buf = '';
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      fn(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf !== '') fn(buf);
}
