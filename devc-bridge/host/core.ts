// Headless core for the host command bridge: a loopback TCP server that dispatches
// requests to allowlisted host scripts and watches a state directory for active
// markers. No tray / no `deno desktop` dependency here, so this module is runnable
// under a plain `deno run` and testable entirely inside a devcontainer.
//
// Transport note: we use TCP (not a unix socket) because a bind-mounted AF_UNIX
// socket does not cross the Docker Desktop VM boundary — the container sees the
// socket inode but connect() is refused (no listener in the guest kernel). The
// container reaches the host-loopback server via `host.docker.internal`. A shared
// token (delivered through a bind-mounted directory as a regular file) authorizes
// requests, since a loopback TCP port is otherwise reachable by any local process: the
// shared legacy token in run/, or a per-workspace one in keys/<key>/ that also identifies
// which container is calling.
//
// The desktop entrypoint (server.ts) imports startServer() and adds the tray by
// subscribing to `onActiveChange`.

import { dirname, resolve } from '@std/path';
import { Keepawake, type KeepawakeStatus } from './keepawake.ts';
import { TokenRegistry } from './token.ts';

export interface ServerOptions {
  /** Address to bind. Default host is 127.0.0.1 (reachable via host.docker.internal). */
  hostname: string;
  port: number;
  /** The shared legacy token (`run/token`), for containers that mount `run/` whole. */
  token: string;
  /**
   * `keys/`: one subdirectory per devc workspace. The server mints a token into every one on
   * start and into any created while it runs, and accepts each as identifying that key.
   */
  keysDir: string;
  /** Directory of executable command scripts. The filenames are the allowlist. */
  commandsDir: string;
  /** Directory where scripts drop "active" marker files; watched for the tray. */
  stateDir: string;
  /** Called on startup and whenever the set of active markers changes. */
  onActiveChange?: (active: string[]) => void;
  /** Optional logger; defaults to console.error. */
  log?: (msg: string) => void;
  /**
   * When present, the reserved `ping` command is intercepted (after auth, before
   * script dispatch) and drives a `Keepawake` that starts/stops `command` based on
   * ping activity. Absent → `ping` falls through to normal script dispatch.
   */
  keepawake?: { command: string; idleMs: number };
}

export interface Request {
  token: string;
  command: string;
  args?: string[];
}

export type Response =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string };

export interface RunningServer {
  address: string;
  /** Current set of active markers (sorted). */
  active(): string[];
  /** Workspace keys currently holding a token minted by this server, sorted. */
  keys(): string[];
  /** Resolves once every change to `keys/` seen so far has been minted. For tests. */
  settled(): Promise<void>;
  /** Keepalive status, or null when the server wasn't configured with keepawake opts. */
  keepawake(): KeepawakeStatus | null;
  /** Stops accepting connections and — if the keepalive is armed — awaits its stop. */
  close(): Promise<void>;
}

// A command name must be a bare filename — no path separators, no traversal.
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Yield newline-delimited chunks from a connection until EOF. */
async function* readLines(conn: Deno.Conn): AsyncGenerator<string> {
  let buf = '';
  const chunk = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(chunk);
    if (n === null) break;
    buf += decoder.decode(chunk.subarray(0, n), { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, idx);
      buf = buf.slice(idx + 1);
    }
  }
  if (buf.trim().length > 0) yield buf;
}

/** Resolve a request to an allowlisted script and run it with args as argv. */
async function dispatch(
  req: Request,
  commandsDir: string,
  stateDir: string,
): Promise<Response> {
  const name = req.command;
  if (
    typeof name !== 'string' || !NAME_RE.test(name) || name === '.' ||
    name === '..'
  ) {
    return {
      ok: false,
      error: `invalid command name: ${JSON.stringify(name)}`,
    };
  }

  const commandsRoot = resolve(commandsDir);
  const scriptPath = resolve(commandsRoot, name);
  // Defense in depth: the resolved path must sit directly inside commandsDir.
  if (dirname(scriptPath) !== commandsRoot) {
    return {
      ok: false,
      error: `invalid command name: ${JSON.stringify(name)}`,
    };
  }

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(scriptPath);
  } catch {
    return { ok: false, error: `unknown command: ${name}` };
  }
  if (!info.isFile) {
    return { ok: false, error: `unknown command: ${name}` };
  }
  // Require an executable bit so only intentional scripts run.
  if (info.mode !== null && (info.mode & 0o111) === 0) {
    return { ok: false, error: `command not executable: ${name}` };
  }

  const args = Array.isArray(req.args) ? req.args.map(String) : [];
  try {
    // args are passed as argv — never interpolated into a shell — so nothing the
    // client sends can be interpreted as a shell metacharacter.
    const cmd = new Deno.Command(scriptPath, {
      args,
      env: { ...Deno.env.toObject(), DEVC_BRIDGE_STATE: stateDir },
      stdout: 'piped',
      stderr: 'piped',
    });
    const out = await cmd.output();
    return {
      ok: true,
      exitCode: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  } catch (e) {
    return {
      ok: false,
      error: `failed to run ${name}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

async function scanActive(stateDir: string): Promise<string[]> {
  const active: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile) active.push(entry.name);
    }
  } catch {
    // stateDir may not exist yet; treat as empty.
  }
  return active.sort();
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const commandsDir = resolve(opts.commandsDir);
  const stateDir = resolve(opts.stateDir);

  await Deno.mkdir(stateDir, { recursive: true });
  const keysDir = resolve(opts.keysDir);
  await Deno.mkdir(keysDir, { recursive: true });

  // Mint every key directory before accepting a connection, so no container that already
  // exists sees a window where its token is stale.
  const tokens = new TokenRegistry(opts.token, keysDir);
  const minted = await tokens.sync();
  if (minted.length > 0) log(`minted tokens for ${minted.length} key(s)`);

  const listener = Deno.listen({ hostname: opts.hostname, port: opts.port });
  const address = `${opts.hostname}:${opts.port}`;

  const keepawake = opts.keepawake
    ? new Keepawake({
      command: opts.keepawake.command,
      idleMs: opts.keepawake.idleMs,
      run: (command, args) =>
        dispatch({ token: opts.token, command, args }, commandsDir, stateDir),
      log,
    })
    : null;

  let currentActive = await scanActive(stateDir);
  opts.onActiveChange?.(currentActive);

  const watcher = Deno.watchFs(stateDir);
  // Not recursive: only a key directory appearing or going matters, and the token files this
  // server writes inside them would otherwise wake it for every mint.
  const keysWatcher = Deno.watchFs(keysDir, { recursive: false });
  let closed = false;
  let keysSettled: Promise<unknown> = Promise.resolve();

  (async () => {
    for await (const _ev of keysWatcher) {
      keysSettled = tokens.sync().then((keys) => {
        if (keys.length > 0) log(`minted tokens for: ${keys.join(', ')}`);
      }, (e) => log(`key sync error: ${e}`));
    }
  })().catch((e) => {
    if (!closed) log(`keys watch error: ${e}`);
  });

  // State-watch loop → recompute active set → notify subscriber (the tray).
  (async () => {
    for await (const _ev of watcher) {
      const next = await scanActive(stateDir);
      if (next.join('\0') !== currentActive.join('\0')) {
        currentActive = next;
        opts.onActiveChange?.(currentActive);
      }
    }
  })().catch((e) => {
    if (!closed) log(`watch error: ${e}`);
  });

  // Accept loop.
  (async () => {
    for await (const conn of listener) {
      (async () => {
        try {
          for await (const line of readLines(conn)) {
            if (line.trim().length === 0) continue;
            let resp: Response;
            try {
              const req = JSON.parse(line) as Request;
              // Identified, not merely authenticated: the caller's key is what a publishing verb
              // resolves its policy from. Nothing dispatched today consults it.
              if (tokens.identify(req.token) === null) {
                resp = { ok: false, error: 'unauthorized' };
              } else if (keepawake && req.command === 'ping') {
                const args = Array.isArray(req.args) ? req.args : [];
                const event = args.length > 0 ? String(args[0]) : undefined;
                keepawake.ping(event);
                resp = { ok: true, exitCode: 0, stdout: 'pong\n', stderr: '' };
              } else {
                resp = await dispatch(req, commandsDir, stateDir);
              }
            } catch (e) {
              resp = {
                ok: false,
                error: `bad request: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              };
            }
            await conn.write(encoder.encode(JSON.stringify(resp) + '\n'));
          }
        } catch (e) {
          if (!closed) log(`connection error: ${e}`);
        } finally {
          try {
            conn.close();
          } catch {
            // already closed
          }
        }
      })();
    }
  })().catch((e) => {
    if (!closed) log(`accept error: ${e}`);
  });

  return {
    address,
    active: () => currentActive,
    keys: () => tokens.keys(),
    settled: async () => {
      await tokens.sync();
      await keysSettled;
    },
    keepawake: () => keepawake?.status() ?? null,
    close: async () => {
      closed = true;
      // Await first: quitting must never leak a started keepawake command.
      if (keepawake) await keepawake.close();
      try {
        watcher.close();
      } catch { /* ignore */ }
      try {
        keysWatcher.close();
      } catch { /* ignore */ }
      try {
        listener.close();
      } catch { /* ignore */ }
    },
  };
}
