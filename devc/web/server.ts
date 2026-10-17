// `devc web`: a loopback HTTP + WebSocket server that serves the page in `static/` and routes
// its `/ws` protocol (`protocol.ts`) to each running devcontainer's Herdr server
// (`herdr_bridge.ts`) and pane streams (`controllers.ts`). See `.plans/devc-web.md`.
//
// Any website the user visits can open a WebSocket to 127.0.0.1, and `/ws` is a shell in every
// container, so every request passes `authorize` first: Host (DNS rebinding), then for `/ws`
// Origin and the per-start token. Containers reach the server too: on Docker Desktop,
// `host.docker.internal` is the host's loopback, so that name is an accepted Host.

import {
  basename,
  dirname,
  extname,
  fromFileUrl,
  toFileUrl,
} from 'jsr:@std/path';
import {
  type ContainerRecord,
  Discovery,
  inspectBindSources,
  probeDocker,
} from './containers.ts';
import {
  BridgeError,
  bridgeRequest,
  ContainerSession,
  createShell,
  isHerdrLaunch,
  snapshotPaneIds,
} from './herdr_bridge.ts';
import { ControllerManager, type Subscriber } from './controllers.ts';
import {
  forget as forgetProject,
  loadProjects,
  type ProjectEntry,
  PROJECTS_PATH,
  setPinned,
  updateProjects,
} from '../projects.ts';
import { startProject, stopProject } from './project_control.ts';
import { buildProjects, projectRefusal } from './projects_view.ts';
import { GitStatusWatch } from './git_status.ts';
import { type MountedRepo, mountedRepos } from './git_repo.ts';
import {
  type ClientMessage,
  parseClientMessage,
  type Rejection,
  rejectionReply,
} from './protocol.ts';
import { closeGracefully, liveProcs } from './proc.ts';
import { paneScroll, toTextPoint } from './selection.ts';
import {
  EMBEDDED_GENERATION,
  lastGoodDir,
  LiveStatic,
  snapshotGeneration,
} from './live.ts';

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

/**
 * The page's own files. Relative to this module, so it works from source (a checkout, in live
 * mode) and from the compiled binary, whose `--include web/static` embeds the directory. Never
 * `Deno.cwd()`.
 */
export const STATIC_ROOT = new URL('./static/', import.meta.url);

/** Serves `pathname` (`/` meaning `/index.html`) from the directory `root`. */
export async function serveStatic(
  root: URL,
  pathname: string,
  port: number,
): Promise<Response> {
  const path = pathname === '/' ? '/index.html' : pathname;
  const type = CONTENT_TYPES[extname(path)];
  if (!staticPathAllowed(path) || type === undefined) {
    return new Response('not found', { status: 404 });
  }
  try {
    const body = await Deno.readFile(new URL(`.${path}`, root));
    return new Response(body, {
      headers: { 'Content-Type': type, ...securityHeaders(port) },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

/**
 * Routes a static GET: `/safe/…` to `safeRoot` (`null`: no last-good snapshot yet, a 404 that
 * says so), everything else to `root`. The page uses only relative URLs, so it works under both.
 */
export function routeStatic(
  pathname: string,
  port: number,
  root: URL,
  safeRoot: URL | null,
): Promise<Response> {
  if (!pathname.startsWith('/safe/')) return serveStatic(root, pathname, port);
  if (safeRoot === null) {
    return Promise.resolve(
      new Response('no last-good snapshot yet', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
  }
  return serveStatic(safeRoot, pathname.slice('/safe'.length), port);
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

interface Client extends Subscriber {
  socket: WebSocket;
}

/** Thrown by {@link startWeb} for a startup failure worth a one-line message. */
export class WebStartError extends Error {}

/** Throws {@link WebStartError} when `docker` is not on PATH. */
export async function requireDocker(): Promise<void> {
  try {
    await probeDocker();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new WebStartError('docker not found on PATH');
    }
    throw e;
  }
}

/** A running `devc web` server. */
export interface WebHandle {
  /**
   * The shutdown sequence (release controllers, dispose sessions, kill procs, stop the HTTP
   * server). Never exits the process; callers cap how long they wait. Idempotent.
   */
  stop(): Promise<void>;
  /** Resolves when the HTTP server has finished. */
  finished: Promise<void>;
}

/**
 * Starts the server and returns once it is listening. `live` is the supervised child of a
 * checkout (`supervisor.ts`): it watches `static/`, reports its generation and keeps the
 * last-good snapshot for `/safe/`. Prints nothing on success; the caller prints the URL.
 * Throws {@link WebStartError} when docker is missing or the port cannot be bound.
 */
export async function startWeb(
  opts: WebOptions & {
    token: string;
    live: boolean;
    /**
     * The page's directory, absolute: a checkout's `web/static/` for `devc web --live`.
     * Defaults to this module's own {@link STATIC_ROOT}.
     */
    staticDir?: string;
    /**
     * Whether project messages may start containers or bring in folders (default `true`).
     * `devc web --live` turns it off: its page comes from a checkout agents can write to. See
     * {@link projectRefusal}.
     */
    projectStarts?: boolean;
  },
): Promise<WebHandle> {
  const staticRoot = opts.staticDir === undefined
    ? STATIC_ROOT
    : toFileUrl(`${opts.staticDir.replace(/\/+$/, '')}/`);
  const projectStarts = opts.projectStarts ?? true;
  await requireDocker();

  const token = opts.token;
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

  // Projects: devc's projects list (pinned and recent folders) merged with what discovery knows.
  let projectEntries: ProjectEntry[] = await loadProjects();
  const startingProjects = new Set<string>();
  const projectsMessage = () => ({
    type: 'projects',
    projects: buildProjects(
      projectEntries,
      [...sessions.values()].map((s) => s.record.localFolder),
      [...discovery.stopped.values()].map((r) => r.localFolder),
      startingProjects,
      reposByFolder(),
      gitWatch.statuses,
    ),
  });
  const broadcastProjects = () => broadcast(projectsMessage());
  // Each container's repos by container id, from its bind mounts, read once per container: a
  // container's mounts are fixed when it is created.
  const containerRepos = new Map<string, MountedRepo[]>();
  const reposByFolder = () => {
    const byFolder = new Map<string, MountedRepo[]>();
    // A running container's mounts win over a stopped one's for the same folder.
    const records = [
      ...discovery.stopped.values(),
      ...[...sessions.values()].map((s) => s.record),
    ];
    for (const r of records) {
      const repos = containerRepos.get(r.id);
      if (repos) byFolder.set(r.localFolder, repos);
    }
    return byFolder;
  };
  const loadRepos = async (record: ContainerRecord) => {
    if (containerRepos.has(record.id)) return;
    containerRepos.set(record.id, [{
      folder: record.localFolder,
      worktreeOf: null,
    }]);
    const sources = await inspectBindSources(record.id);
    containerRepos.set(
      record.id,
      await mountedRepos(record.localFolder, sources),
    );
    broadcastProjects();
    void gitWatch.refresh();
  };
  // Every listed repo's push/pull state, read again on a timer and whenever the list changes.
  const gitWatch: GitStatusWatch = new GitStatusWatch({
    folders: () =>
      projectsMessage().projects.flatMap((p) => p.repos.map((r) => r.folder)),
    onChange: broadcastProjects,
  });
  const reloadProjects = async () => {
    projectEntries = await loadProjects();
    broadcastProjects();
    void gitWatch.refresh();
  };
  const isListedProject = (localFolder: string) =>
    projectsMessage().projects.some((p) => p.localFolder === localFolder);

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
    broadcastProjects();
    void gitWatch.refresh();
    void loadRepos(record);
    void session.run();
  };

  const removeContainer = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    void controllers.closeContainer(id, 'container stopped');
    void session.dispose();
    broadcast(containersMessage());
    broadcastProjects();
  };

  const liveStatic = opts.live
    ? new LiveStatic({
      staticDir: fromFileUrl(staticRoot),
      snapshotDir: lastGoodDir(),
      onChange: (generation, paths) =>
        broadcast({ type: 'static_changed', generation, paths }),
      onError: (m) => console.error(`devc web: ${m}`),
    })
    : null;
  await liveStatic?.init();
  const generation = () => liveStatic?.generation ?? EMBEDDED_GENERATION;

  const discovery = new Discovery({
    onAdd: addContainer,
    onRemove: removeContainer,
    onStoppedChange: () => {
      broadcastProjects();
      void gitWatch.refresh();
      for (const r of discovery.stopped.values()) void loadRepos(r);
    },
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

  const fail = (c: Client, id: string, code: string, e: unknown) =>
    reply(c, {
      id,
      ok: false,
      error: { code, message: e instanceof Error ? e.message : String(e) },
    });

  /** The messages about projects, which name a folder rather than a running container. */
  const handleProject = async (
    c: Client,
    msg: Extract<ClientMessage, { localFolder: string }>,
  ) => {
    const folder = msg.localFolder;
    const refusal = projectRefusal(msg, projectStarts);
    if (refusal !== null) {
      fail(c, msg.id, 'not_allowed', refusal);
      return;
    }
    switch (msg.type) {
      case 'start_project': {
        if (!isListedProject(folder)) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: 'unknown project',
          });
          return;
        }
        if (startingProjects.has(folder)) {
          fail(c, msg.id, 'already_starting', `${folder} is already starting`);
          return;
        }
        startingProjects.add(folder);
        broadcastProjects();
        try {
          await startProject(
            folder,
            (line) =>
              broadcast({ type: 'project_output', localFolder: folder, line }),
          );
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(c, msg.id, 'start_failed', e);
        } finally {
          startingProjects.delete(folder);
          await reloadProjects();
        }
        return;
      }
      case 'stop_project':
        try {
          const stopped = await stopProject(folder);
          reply(c, { id: msg.id, ok: true, result: { stopped } });
        } catch (e) {
          fail(c, msg.id, 'stop_failed', e);
        }
        return;
      case 'add_project': {
        let isDir = false;
        try {
          isDir = (await Deno.stat(folder)).isDirectory;
        } catch { /* missing: not a directory */ }
        if (!isDir) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: `${folder} is not a directory`,
          });
          return;
        }
      }
      // falls through: adding is pinning
      case 'pin_project':
      case 'forget_project':
        try {
          projectEntries = await updateProjects((list) =>
            msg.type === 'forget_project'
              ? forgetProject(list, folder)
              : setPinned(
                list,
                folder,
                msg.type === 'pin_project' ? msg.pinned : true,
              )
          );
          broadcastProjects();
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(c, msg.id, 'projects_error', e);
        }
        return;
    }
  };

  const handle = async (c: Client, msg: ClientMessage) => {
    if (msg.type === 'client_ready') {
      await liveStatic?.clientReady(msg.generation);
      return;
    }
    if ('localFolder' in msg) {
      await handleProject(c, msg);
      return;
    }
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
      case 'read_selection': {
        const panes = session.snapshot ? snapshotPaneIds(session.snapshot) : [];
        if (!panes.includes(msg.pane_id)) {
          reject(c, { id, code: 'bad_request', message: 'unknown pane' });
          return;
        }
        try {
          const scroll = paneScroll(
            await bridgeRequest(target, 'pane.get', { pane_id: msg.pane_id }),
          );
          if (!scroll) {
            reply(c, {
              id: msg.id,
              ok: false,
              error: {
                code: 'bad_reply',
                message: 'pane.get returned no scroll position',
              },
            });
            return;
          }
          // No content_revision: pane.get's `revision` is not the value Herdr checks it against.
          const result = await bridgeRequest(target, 'pane.selection.read', {
            pane_id: msg.pane_id,
            anchor: toTextPoint(scroll, msg.anchor),
            cursor: toTextPoint(scroll, msg.cursor),
          }) as { text?: unknown } | null;
          reply(c, {
            id: msg.id,
            ok: true,
            result: {
              text: typeof result?.text === 'string' ? result.text : '',
            },
          });
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
      case 'new_shell':
        try {
          const result = await createShell(target, {
            ...(msg.workspace_id !== undefined
              ? { workspace_id: msg.workspace_id }
              : {}),
            ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
          });
          reply(c, { id: msg.id, ok: true, result });
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
      client.send(JSON.stringify({
        type: 'hello',
        generation: generation(),
        live: opts.live,
        projectStarts,
      }));
      client.send(JSON.stringify(containersMessage()));
      client.send(JSON.stringify(projectsMessage()));
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
      if (!liveStatic) {
        return routeStatic(url.pathname, opts.port, staticRoot, staticRoot);
      }
      const snapshotDir = lastGoodDir();
      return snapshotGeneration(snapshotDir).then((snap) =>
        routeStatic(
          url.pathname,
          opts.port,
          staticRoot,
          snap === null ? null : toFileUrl(`${snapshotDir}/`),
        )
      );
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

  discovery.start();
  liveStatic?.watch();
  gitWatch.start();
  const projectsWatch = watchProjectsFile(() => void reloadProjects());

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      discovery.stop();
      liveStatic?.stop();
      gitWatch.stop();
      projectsWatch.stop();
      for (const c of clients) {
        try {
          c.socket.close();
        } catch { /* already closing */ }
      }
      await controllers.releaseAll();
      await Promise.all([...sessions.values()].map((s) => s.dispose()));
      await Promise.all(liveProcs().map((p) => closeGracefully(p, 1000)));
      await server.shutdown().catch(() => {});
    })();
    return stopping;
  };

  return { stop, finished: server.finished };
}

/** How long the projects file must be quiet before a change to it is re-read. */
const PROJECTS_DEBOUNCE_MS = 200;

/**
 * Calls `onChange` (debounced) whenever devc's projects file changes — a start in some terminal
 * records its project there. Watches the file's directory, since the file is replaced by a rename
 * and may not exist yet. Never throws: without a watch, the list just refreshes on the page's
 * own changes.
 */
function watchProjectsFile(onChange: () => void): { stop(): void } {
  const dir = dirname(PROJECTS_PATH);
  const file = basename(PROJECTS_PATH);
  let watcher: Deno.FsWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  (async () => {
    try {
      await Deno.mkdir(dir, { recursive: true });
      watcher = Deno.watchFs(dir, { recursive: false });
      for await (const ev of watcher) {
        if (!ev.paths.some((p) => basename(p) === file)) continue;
        clearTimeout(timer);
        timer = setTimeout(onChange, PROJECTS_DEBOUNCE_MS);
      }
    } catch { /* no watch: see above */ }
  })();
  return {
    stop() {
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch { /* already closed */ }
    },
  };
}

/** How long a stop may take before the process exits anyway: a hung child must not hold the
 * exit hostage. */
export const STOP_CAP_MS = 6000;

/** Runs `handle.stop()`, giving up after {@link STOP_CAP_MS}. */
export async function stopCapped(handle: WebHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    handle.stop(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_CAP_MS);
    }),
  ]);
  clearTimeout(timer);
}
