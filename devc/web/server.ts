// `devc web`: a loopback HTTP + WebSocket server that serves the page in `static/` and routes
// its `/ws` protocol (`protocol.ts`) to each running devcontainer's Herdr server
// (`herdr_bridge.ts`) and pane streams (`controllers.ts`). See `.plans/devc-web.md`.
//
// Any website the user visits can open a WebSocket to 127.0.0.1, and `/ws` is a shell in every
// container, so every request passes `authorize` first: Host (DNS rebinding), then for `/ws`
// Origin and the per-start token. Containers reach the server too: on Docker Desktop,
// `host.docker.internal` is the host's loopback, so that name is an accepted Host.

import { basename, extname } from 'jsr:@std/path';
import { type ContainerRecord, Discovery, probeDocker } from './containers.ts';
import {
  BridgeError,
  bridgeRequest,
  ContainerSession,
  isHerdrLaunch,
  snapshotPaneIds,
} from './herdr_bridge.ts';
import { ControllerManager, type Subscriber } from './controllers.ts';
import {
  type ClientMessage,
  parseClientMessage,
  type Rejection,
  rejectionReply,
} from './protocol.ts';
import { closeGracefully, liveProcs } from './proc.ts';

export interface WebOptions {
  port: number;
  session: string;
}

// ---------------------------------------------------------------------------------------------
// Request checks (pure)
// ---------------------------------------------------------------------------------------------

/**
 * The names this server answers to. `host.docker.internal` is how a container on Docker
 * Desktop reaches the host's loopback. A fixed name keeps the DNS rebinding check intact: a
 * rebinding page arrives with its own domain as Host.
 */
const HOST_NAMES = ['127.0.0.1', 'localhost', 'host.docker.internal'];

/** Whether `host` (the Host header) names this server: one of {@link HOST_NAMES} on `port`. */
export function hostAllowed(host: string | null, port: number): boolean {
  return HOST_NAMES.some((name) => host === `${name}:${port}`);
}

/**
 * Whether `origin` (a WebSocket upgrade's Origin header) may connect: this server's own page
 * under any of {@link HOST_NAMES}, or no Origin at all. Browsers always send Origin on an
 * upgrade, so a missing one is a non-browser client (an agent's script in a container), which
 * no website can impersonate; the token still has to match.
 */
export function originAllowed(origin: string | null, port: number): boolean {
  return origin === null ||
    HOST_NAMES.some((name) => origin === `http://${name}:${port}`);
}

/** Constant-time token comparison. */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The HTTP status a request is refused with, or `null` when it may proceed. Host is checked on
 * every request (403); `/ws` additionally needs this page's Origin or none (403) and the token
 * (401).
 */
export function authorize(
  headers: Headers,
  url: URL,
  port: number,
  token: string,
): 401 | 403 | null {
  if (!hostAllowed(headers.get('host'), port)) return 403;
  if (url.pathname !== '/ws') return null;
  if (!originAllowed(headers.get('origin'), port)) return 403;
  if (!tokenMatches(url.searchParams.get('token'), token)) return 401;
  return null;
}

/** A fresh 32-byte token, hex. */
export function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

/** Whether `pathname` may name a file under `static/`: no `..`, no hidden or odd segments. */
export function staticPathAllowed(pathname: string): boolean {
  return /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
    .test(pathname) && !pathname.split('/').includes('..');
}

function securityHeaders(port: number): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // xterm.js injects <style> elements, hence the inline styles.
    'Content-Security-Policy': [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      "frame-ancestors 'none'",
    ].join('; '),
  };
}

async function serveStatic(pathname: string, port: number): Promise<Response> {
  const path = pathname === '/' ? '/index.html' : pathname;
  const type = CONTENT_TYPES[extname(path)];
  if (!staticPathAllowed(path) || type === undefined) {
    return new Response('not found', { status: 404 });
  }
  try {
    // Relative to this module, so it works from source and from the compiled binary, whose
    // `--include web/static` embeds the directory. Never `Deno.cwd()`.
    const body = await Deno.readFile(
      new URL(`./static${path}`, import.meta.url),
    );
    return new Response(body, {
      headers: { 'Content-Type': type, ...securityHeaders(port) },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

interface Client extends Subscriber {
  socket: WebSocket;
}

/** Thrown by {@link serveWeb} for a startup failure worth a one-line message. */
export class WebStartError extends Error {}

/**
 * Runs `devc web` until SIGINT/SIGTERM, then exits the process with 0. Throws
 * {@link WebStartError} when docker is missing or the port cannot be bound.
 */
export async function serveWeb(opts: WebOptions): Promise<never> {
  try {
    await probeDocker();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new WebStartError('docker not found on PATH');
    }
    throw e;
  }

  const token = mintToken();
  const sessions = new Map<string, ContainerSession>();
  const clients = new Set<Client>();
  const controllers = new ControllerManager();

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of clients) c.send(text);
  };

  const containersMessage = () => ({
    type: 'containers',
    containers: [...sessions.values()]
      .map((s) => ({
        id: s.record.id,
        localFolder: s.record.localFolder,
        name: basename(s.record.localFolder) || s.record.id.slice(0, 12),
        state: s.state,
        ...(s.error !== undefined ? { error: s.error } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  });

  const addContainer = (record: ContainerRecord) => {
    const id = record.id;
    const session = new ContainerSession(record, opts.session, {
      onState: () => broadcast(containersMessage()),
      onSnapshot: (snapshot) =>
        broadcast({ type: 'snapshot', container: id, snapshot }),
      onPaneUpdated: (pane) =>
        broadcast({ type: 'pane_updated', container: id, pane }),
      onAgentStatus: (pane_id, agent, agent_status) =>
        broadcast({
          type: 'agent_status',
          container: id,
          pane_id,
          agent,
          agent_status,
        }),
      onTeardown: (reason) => void controllers.closeContainer(id, reason),
    });
    sessions.set(id, session);
    broadcast(containersMessage());
    void session.run();
  };

  const removeContainer = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    void controllers.closeContainer(id, 'container stopped');
    void session.dispose();
    broadcast(containersMessage());
  };

  const discovery = new Discovery({
    onAdd: addContainer,
    onRemove: removeContainer,
    onExec: (id, command) => {
      if (isHerdrLaunch(command)) void sessions.get(id)?.herdrLaunched();
    },
    onError: (m) => console.error(`devc web: ${m}`),
  });

  const reply = (c: Client, msg: Record<string, unknown>) =>
    c.send(JSON.stringify({ type: 'result', ...msg }));

  const reject = (c: Client, r: Rejection) => {
    if (r.id !== undefined) {
      c.send(JSON.stringify(rejectionReply({ ...r, id: r.id })));
    }
  };

  const handle = async (c: Client, msg: ClientMessage) => {
    const session = sessions.get(msg.container);
    const id = 'id' in msg ? msg.id : undefined;
    if (!session) {
      reject(c, { id, code: 'bad_request', message: 'unknown container' });
      return;
    }
    switch (msg.type) {
      case 'retry':
        void session.run();
        return;
      case 'start_session':
        try {
          await session.startSession();
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          reply(c, {
            id: msg.id,
            ok: false,
            error: {
              code: 'start_failed',
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
        return;
    }
    const target = session.target;
    if (session.state !== 'connected' || target === null) {
      reject(c, {
        id,
        code: 'bad_request',
        message: 'container not connected',
      });
      return;
    }
    switch (msg.type) {
      case 'open': {
        const panes = session.snapshot ? snapshotPaneIds(session.snapshot) : [];
        if (!panes.includes(msg.pane_id)) {
          reject(c, { id, code: 'bad_request', message: 'unknown pane' });
          return;
        }
        try {
          await controllers.open(c, target, msg.pane_id, msg.cols, msg.rows);
        } catch (e) {
          reply(c, {
            id: msg.id,
            ok: false,
            error: {
              code: 'open_failed',
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
        return;
      }
      case 'close':
        controllers.close(c, msg.container, msg.pane_id);
        return;
      case 'input':
        controllers.send(c, msg.container, msg.pane_id, {
          type: 'terminal.input',
          bytes: msg.bytes,
        });
        return;
      case 'resize':
        controllers.send(c, msg.container, msg.pane_id, {
          type: 'terminal.resize',
          cols: msg.cols,
          rows: msg.rows,
        });
        return;
      case 'scroll':
        controllers.send(c, msg.container, msg.pane_id, {
          type: 'terminal.scroll',
          direction: msg.direction,
          lines: msg.lines,
        });
        return;
      case 'mouse':
        controllers.send(c, msg.container, msg.pane_id, {
          type: 'terminal.mouse',
          action: msg.action,
          ...(msg.button !== undefined ? { button: msg.button } : {}),
          column: msg.column,
          row: msg.row,
        });
        return;
      case 'request':
        try {
          const result = await bridgeRequest(target, msg.method, msg.params);
          reply(c, { id: msg.id, ok: true, result: result ?? {} });
        } catch (e) {
          reply(c, {
            id: msg.id,
            ok: false,
            error: {
              code: e instanceof BridgeError ? e.code : 'herdr_error',
              message: e instanceof Error ? e.message : String(e),
            },
          });
        }
        return;
    }
  };

  const onSocket = (socket: WebSocket) => {
    const client: Client = {
      socket,
      send(text) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
    };
    socket.onopen = () => {
      clients.add(client);
      client.send(JSON.stringify(containersMessage()));
      for (const s of sessions.values()) {
        if (s.state === 'connected' && s.snapshot !== null) {
          client.send(JSON.stringify({
            type: 'snapshot',
            container: s.record.id,
            snapshot: s.snapshot,
          }));
        }
      }
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const parsed = parseClientMessage(ev.data);
      if (!parsed.ok) {
        reject(client, parsed.rejection);
        return;
      }
      handle(client, parsed.msg).catch((e) =>
        console.error(`devc web: ${e instanceof Error ? e.message : e}`)
      );
    };
    socket.onclose = () => {
      clients.delete(client);
      controllers.closeAll(client);
    };
    socket.onerror = () => {};
  };

  let server: Deno.HttpServer;
  try {
    server = Deno.serve({
      hostname: '127.0.0.1',
      port: opts.port,
      onListen: () => {},
    }, (req) => {
      const url = new URL(req.url);
      const refused = authorize(req.headers, url, opts.port, token);
      if (refused !== null) {
        return new Response(refused === 401 ? 'unauthorized' : 'forbidden', {
          status: refused,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      if (url.pathname === '/ws') {
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('expected a WebSocket upgrade', { status: 400 });
        }
        const { socket, response } = Deno.upgradeWebSocket(req);
        onSocket(socket);
        return response;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      return serveStatic(url.pathname, opts.port);
    });
  } catch (e) {
    if (e instanceof Deno.errors.AddrInUse) {
      throw new WebStartError(`port ${opts.port} is already in use`);
    }
    throw new WebStartError(
      `cannot listen on 127.0.0.1:${opts.port}: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }

  console.log(`devc web: http://127.0.0.1:${opts.port}/#token=${token}`);
  discovery.start();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A hung child must not hold the exit hostage.
    setTimeout(() => Deno.exit(0), 6000);
    discovery.stop();
    for (const c of clients) {
      try {
        c.socket.close();
      } catch { /* already closing */ }
    }
    await controllers.releaseAll();
    await Promise.all([...sessions.values()].map((s) => s.dispose()));
    await Promise.all(liveProcs().map((p) => closeGracefully(p, 1000)));
    await server.shutdown().catch(() => {});
    Deno.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    try {
      Deno.addSignalListener(sig, () => void shutdown());
    } catch { /* signal unsupported on this platform */ }
  }

  await server.finished;
  return Deno.exit(0);
}
