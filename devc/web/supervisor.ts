// `devc web --source DIR` (live mode): the process the user started supervises a child
// `deno run DIR/main.ts web` that serves the checkout, and swaps in a new child when the
// checkout's server code changes and passes `deno check`. A child that dies on its own is
// replaced by the embedded server, in-process, until the next good change, so a crash in
// checkout code never takes the UI (and the agent pane that can fix it) away. See
// `.plans/devc-web-live.md`.
//
// The supervisor owns the token, the printed URL and the `.ts` watch; it binds the port itself
// only as that fallback. The child's own `static/` watch and `/safe/` snapshot live in
// `live.ts`.

import { spawn } from 'node:child_process';
import { join, resolve, SEPARATOR } from 'jsr:@std/path';
import {
  requireDocker,
  startWeb,
  STOP_CAP_MS,
  stopCapped,
  type WebHandle,
  type WebOptions,
  WebStartError,
} from './server.ts';

/** The permissions the child runs with: the same as `deno.json`'s `run` task. */
const CHILD_PERMISSIONS = [
  '--allow-run',
  '--allow-read',
  '--allow-write',
  '--allow-env',
  '--allow-sys',
  '--allow-net',
];

const SERVER_DEBOUNCE_MS = 300;
const LISTEN_POLL_MS = 100;

/**
 * Whether a change to `path` (absolute) is server code: a `.ts` file under one of `roots`
 * that is not in a `tests/`, `node_modules/` or `.git/` directory, nor under `web/static/`.
 */
export function isServerCodePath(path: string, roots: string[]): boolean {
  if (!path.endsWith('.ts')) return false;
  for (const root of roots) {
    const prefix = root.endsWith(SEPARATOR) ? root : root + SEPARATOR;
    if (!path.startsWith(prefix)) continue;
    const segments = path.slice(prefix.length).split(SEPARATOR);
    const dirs = segments.slice(0, -1);
    if (
      dirs.some((d) => d === 'tests' || d === 'node_modules' || d === '.git')
    ) {
      return false;
    }
    return !(dirs[0] === 'web' && dirs[1] === 'static');
  }
  return false;
}

/** Throws {@link WebStartError} unless `dir` holds `main.ts` and `deno` is on PATH. */
export async function checkSource(dir: string): Promise<void> {
  try {
    if (!(await Deno.stat(join(dir, 'main.ts'))).isFile) throw new Error();
  } catch {
    throw new WebStartError(
      `--source ${dir}: no main.ts there (expected the devc/ directory of a devc-tools checkout)`,
    );
  }
  try {
    await new Deno.Command('deno', {
      args: ['--version'],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new WebStartError('live mode needs deno on PATH');
    }
    throw e;
  }
}

/** Throws {@link WebStartError} when `port` cannot be bound on 127.0.0.1 right now. */
function requirePortFree(port: number): void {
  try {
    Deno.listen({ hostname: '127.0.0.1', port }).close();
  } catch (e) {
    if (e instanceof Deno.errors.AddrInUse) {
      throw new WebStartError(`port ${port} is already in use`);
    }
    throw new WebStartError(
      `cannot listen on 127.0.0.1:${port}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
}

interface Child {
  pid: number;
  /** Resolves with the exit code (or signal name) once the child has exited. */
  exited: Promise<string>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/**
 * Runs live mode until SIGINT/SIGTERM and resolves with the exit code. Prints the URL once,
 * when the first server (child or fallback) is listening. Throws {@link WebStartError} for a
 * startup failure.
 */
export async function superviseWeb(
  opts: WebOptions & { token: string; source: string },
): Promise<number> {
  const dir = resolve(opts.source);
  await checkSource(dir);
  await requireDocker();
  requirePortFree(opts.port);

  let child: Child | null = null;
  let fallback: WebHandle | null = null;
  let stopping = false;
  /** Set while the supervisor itself is stopping `child`, so its exit is not a crash. */
  let stoppingChild: Child | null = null;
  let announced = false;

  const announce = () => {
    if (announced) return;
    announced = true;
    console.log(
      `devc web: http://127.0.0.1:${opts.port}/#token=${opts.token}`,
    );
  };

  const spawnChild = (): Child => {
    const proc = spawn(
      'deno',
      [
        'run',
        ...CHILD_PERMISSIONS,
        'main.ts',
        'web',
        '--port',
        String(opts.port),
        '--session',
        opts.session,
      ],
      {
        cwd: dir,
        // The token goes in the environment, never argv, which `ps` shows.
        env: {
          ...Deno.env.toObject(),
          DEVC_WEB_CHILD: '1',
          DEVC_WEB_TOKEN: opts.token,
        },
        stdio: ['ignore', 'inherit', 'inherit'],
        // Its own process group, so a terminal Ctrl-C reaches only the supervisor, which then
        // stops the child the orderly way (see proc.ts for the same reason).
        detached: true,
      },
    );
    const exited = new Promise<string>((resolve) => {
      proc.on('error', (err) => resolve(String(err)));
      proc.on('exit', (code, signal) => resolve(String(code ?? signal)));
    });
    const c: Child = {
      pid: proc.pid ?? -1,
      exited,
      kill(signal) {
        try {
          proc.kill(signal);
        } catch { /* already exited */ }
      },
    };
    void exited.then((code) => {
      if (child === c) child = null;
      if (stopping || stoppingChild === c) return;
      console.error(
        `devc web: server exited (${code}); serving the built-in copy until the next change`,
      );
      void startFallback();
    });
    return c;
  };

  /** Resolves `true` once the child accepts connections, `false` if it exits first. */
  const waitListening = async (c: Child): Promise<boolean> => {
    let gone = false;
    void c.exited.then(() => gone = true);
    while (!gone) {
      try {
        const conn = await Deno.connect({
          hostname: '127.0.0.1',
          port: opts.port,
        });
        conn.close();
        return !gone;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, LISTEN_POLL_MS));
    }
    return false;
  };

  const startChild = async () => {
    const c = spawnChild();
    child = c;
    if (await waitListening(c)) announce();
  };

  const startFallback = async () => {
    if (stopping || fallback) return;
    try {
      fallback = await startWeb({ ...opts, live: false });
      announce();
    } catch (e) {
      console.error(
        `devc web: cannot start the built-in copy: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  };

  const stopChild = async () => {
    const c = child;
    if (!c) return;
    stoppingChild = c;
    c.kill('SIGTERM');
    // The child caps its own shutdown at STOP_CAP_MS; past that (plus a margin) it is hung.
    const timer = setTimeout(() => c.kill('SIGKILL'), STOP_CAP_MS + 2000);
    await c.exited;
    clearTimeout(timer);
    if (child === c) child = null;
  };

  const stopFallback = async () => {
    const f = fallback;
    if (!f) return;
    fallback = null;
    await stopCapped(f);
  };

  // `deno check` gates every swap, and runs while the old server keeps serving.
  const check = async (): Promise<boolean> => {
    const out = await new Deno.Command('deno', {
      args: ['check', 'main.ts'],
      cwd: dir,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    if (out.success) return true;
    const dec = new TextDecoder();
    console.error('devc web: not restarting: deno check failed');
    const text = (dec.decode(out.stdout) + dec.decode(out.stderr)).trimEnd();
    if (text) console.error(text);
    return false;
  };

  let busy = false;
  let again = false;
  const onServerChange = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      let ok: boolean;
      do {
        again = false;
        ok = await check();
        // A change during the check: the latest change wins, so check again.
      } while (again && !stopping);
      if (!ok || stopping) return;
      await stopChild();
      await stopFallback();
      if (!stopping) await startChild();
    } finally {
      busy = false;
      // A change that arrived during the swap itself.
      if (again && !stopping) void onServerChange();
    }
  };

  const roots = [dir, resolve(dir, '..', 'devc-core')];
  const watchRoots: string[] = [];
  for (const r of roots) {
    try {
      if ((await Deno.stat(r)).isDirectory) watchRoots.push(r);
    } catch { /* no devc-core next to it: watch devc/ alone */ }
  }
  const watcher = Deno.watchFs(watchRoots, { recursive: true });
  let debounce: ReturnType<typeof setTimeout> | undefined;
  void (async () => {
    for await (const ev of watcher) {
      if (!ev.paths.some((p) => isServerCodePath(p, watchRoots))) continue;
      clearTimeout(debounce);
      debounce = setTimeout(() => void onServerChange(), SERVER_DEBOUNCE_MS);
    }
  })().catch((e) => console.error(`devc web: watch stopped: ${e}`));

  const done = Promise.withResolvers<number>();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(debounce);
    try {
      watcher.close();
    } catch { /* already closed */ }
    await stopChild();
    await stopFallback();
    done.resolve(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(sig, () => void shutdown());
    } catch { /* signal unsupported on this platform */ }
  }

  await startChild();
  return done.promise;
}
