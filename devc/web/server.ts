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
  inspectMounts,
  probeDocker,
  resolveConnection,
} from './containers.ts';
import type {
  ContainerInfo,
  ContainerMount,
} from '@devc-tools/core/container.ts';
import {
  containerHome,
  createContainerEntry,
  deleteContainerEntry,
  listContainerDir,
  readContainerBytes,
  readContainerFile,
  renameContainerEntry,
  withHostPaths,
  writeContainerFile,
  writeContainerText,
} from './container_files.ts';
import { loadGlobalConfig } from '@devc-tools/core/config.ts';
import {
  containerToHostPath,
  findMountForContainerPath,
  findMountForHostPath,
  hostToContainerPath,
} from '@devc-tools/core/mount_paths.ts';
import { basenamePosix, dirnamePosix } from '@devc-tools/core/posix.ts';
import {
  confine,
  editorCommand,
  FilesError,
  listHostDir,
  listProjectDir,
  pickerRoots,
  readProjectBytes,
  readProjectFile,
} from './files.ts';
import {
  MAX_PREVIEW_BYTES,
  previewPath,
  type PreviewRead,
  previews,
} from './preview.ts';
import {
  BridgeError,
  bridgeRequest,
  commandInstalled,
  ContainerSession,
  createShell,
  type HerdrTarget,
  isHerdrLaunch,
  paneAtFolder,
  snapshotPaneIds,
  snapshotPanes,
} from './herdr_bridge.ts';
import { ControllerManager, type Subscriber } from './controllers.ts';
import {
  AGENT_COMMANDS,
  resumeTaskCommand,
  startTaskCommand,
  TASK_FILE_DIR,
  taskFilePath,
} from './agents.ts';
import {
  addTask,
  deleteTask,
  markSent,
  readTasks,
  restoreTask,
  TASKS_PATH,
  tasksMessage,
  type TaskState,
  taskTitle,
  updateTask,
  withSentPane,
  writeTasks,
} from './tasks.ts';
import {
  type AgentSession,
  listAgentSessions,
  runningPane,
} from './sessions.ts';
import { openRedirect } from './browser.ts';
import { openInVSCode } from './vscode.ts';
import { revealOnHost } from './reveal.ts';
import {
  forget as forgetProject,
  loadProjects,
  type ProjectEntry,
  PROJECTS_PATH,
  setPinned,
  updateProjects,
} from '../projects.ts';
import { downProject, startProject, stopProject } from './project_control.ts';
import {
  addFilePin,
  type FilePin,
  PINNED_FILES_PATH,
  pinnedFilesMessage,
  readPinnedFiles,
  reusablePinnedPane,
  updateFilePin,
  withLabel,
  writePinnedFiles,
} from './pinned_files.ts';
import {
  buildProjects,
  isProjectRepo,
  projectRefusal,
  repoFileFor,
} from './projects_view.ts';
import { GitStatusWatch } from './git_status.ts';
import {
  bridgeStatePaths,
  type BridgeStatus,
  watchBridgeStatus,
} from './bridge_status.ts';
import { usageFiles, type UsageSource, watchUsage } from './usage.ts';
import { type MountedRepo, mountedRepos } from './git_repo.ts';
import {
  type ClientMessage,
  parseClientMessage,
  type Rejection,
  rejectionReply,
} from './protocol.ts';
import { type PrMessage, PrReview } from './pr_review.ts';
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
 * (401). `/desktop/` routes are for devc-desktop's main process, never a page: any Origin is
 * refused (403), and the token comes only as `Authorization: Bearer` (401).
 */
export function authorize(
  headers: Headers,
  url: URL,
  port: number,
  token: string,
): 401 | 403 | null {
  if (!hostAllowed(headers.get('host'), port)) return 403;
  if (url.pathname.startsWith(DESKTOP_PREFIX)) {
    if (headers.get('origin') !== null) return 403;
    const auth = headers.get('authorization');
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    return tokenMatches(given, token) ? null : 401;
  }
  if (url.pathname !== '/ws') return null;
  if (!originAllowed(headers.get('origin'), port)) return 403;
  if (!tokenMatches(url.searchParams.get('token'), token)) return 401;
  return null;
}

/** The paths only devc-desktop's main process asks for. */
const DESKTOP_PREFIX = '/desktop/';

/** How long `GET /desktop/active-folder` waits for Herdr's live `pane.get`. */
const LIVE_PANE_MS = 2000;

/** What `GET /desktop/active-folder` answers. */
export type ActiveFolder =
  | {
    ok: true;
    /** The host path behind the pane's folder, unresolved: devc-desktop checks it. */
    folder: string;
    /** The bind mount's host `source` that covers it. */
    mount: string;
    container: string;
    containerFolder: string;
    primary?: PrimaryFolder;
  }
  | {
    ok: false;
    reason: 'no_active_pane' | 'no_session' | 'no_cwd' | 'not_mounted';
    primary?: PrimaryFolder;
  };

/**
 * The pane's container's own folder on this machine (its `devcontainer.local_folder` label, set
 * when it was created), and the bind mount that covers it. Absent when no mount does.
 */
export interface PrimaryFolder {
  folder: string;
  mount: string;
}

/**
 * The host folder of the active pane, the last one any page reported: its shell's own `cwd`
 * (never `foreground_cwd`) mapped through the container's bind mounts. `found` is the pane's
 * container's snapshot, mounts and `localFolder`, or `null` when no session runs for it. With
 * a session, `primary` names the container's own folder too, when a mount covers it.
 * Everything here comes from a page or a container, so devc-desktop verifies the answer
 * before using it.
 */
export function activeFolder(
  active: { container: string; pane_id: string } | null,
  found:
    | {
      snapshot: Record<string, unknown> | null;
      mounts: ContainerMount[];
      localFolder: string;
    }
    | null,
): ActiveFolder {
  if (active === null) return { ok: false, reason: 'no_active_pane' };
  if (found === null) return { ok: false, reason: 'no_session' };
  const own = found.localFolder
    ? findMountForHostPath(found.localFolder, found.mounts)
    : null;
  const primary = own
    ? { primary: { folder: found.localFolder, mount: own.mount.source } }
    : {};
  return { ...paneFolder(active, found), ...primary };
}

function paneFolder(
  active: { container: string; pane_id: string },
  found: { snapshot: Record<string, unknown> | null; mounts: ContainerMount[] },
): ActiveFolder {
  const pane = snapshotPanes(found.snapshot).find((p) =>
    p.pane_id === active.pane_id
  ) as Record<string, unknown> | undefined;
  const cwd = pane?.cwd;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    return { ok: false, reason: 'no_cwd' };
  }
  const match = findMountForContainerPath(cwd, found.mounts);
  const folder = containerToHostPath(cwd, found.mounts);
  if (match === null || folder === null) {
    return { ok: false, reason: 'not_mounted' };
  }
  return {
    ok: true,
    folder,
    mount: match.mount.source,
    container: active.container,
    containerFolder: cwd,
  };
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
    /** The nonce of the one-time link that opens the page (see `browser.ts`), if any. */
    openNonce?: string;
  },
): Promise<WebHandle> {
  const staticRoot = opts.staticDir === undefined
    ? STATIC_ROOT
    : toFileUrl(`${opts.staticDir.replace(/\/+$/, '')}/`);
  const projectStarts = opts.projectStarts ?? true;
  await requireDocker();

  const token = opts.token;
  const openLink = openRedirect(opts.openNonce, token);
  const previewList = previews();
  const sessions = new Map<string, ContainerSession>();
  // The focused terminal pane the last page to report one named (any client's), for
  // devc-desktop's host terminal. A client closing leaves it.
  let activePane: { container: string; pane_id: string } | null = null;
  // Each running container's remote user's home, for its Files node's home row: read once, on
  // the first container file request (the connection is resolved then anyway). `null` when it
  // couldn't be read; not retried.
  const containerHomes = new Map<string, string | null>();
  const clients = new Set<Client>();
  const controllers = new ControllerManager();

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of clients) c.send(text);
  };

  const homeField = (home: string | null | undefined) => home ? { home } : {};
  const containersMessage = () => ({
    type: 'containers',
    containers: [...sessions.values()]
      .map((s) => ({
        id: s.record.id,
        localFolder: s.record.localFolder,
        name: basename(s.record.localFolder) || s.record.id.slice(0, 12),
        state: s.state,
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...homeField(containerHomes.get(s.record.id)),
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

  // Pinned files (the page's Pinned section; not pinned projects), kept in their own file so every
  // devc web on this host (a browser tab's, the desktop window's) shows the same ones.
  let filePins: FilePin[] = await readPinnedFiles();
  const reloadPinnedFiles = async () => {
    filePins = await readPinnedFiles();
    broadcast(pinnedFilesMessage(filePins));
  };
  /**
   * Read → `change` → write, so a change another devc web made in between is kept; null (nothing
   * written) when `change` gives null. Every client is sent the new list.
   */
  const changePinnedFiles = async (
    change: (pins: FilePin[]) => FilePin[] | null,
  ): Promise<FilePin[] | null> => {
    const next = change(await readPinnedFiles());
    if (next === null) return null;
    await writePinnedFiles(next);
    filePins = next;
    broadcast(pinnedFilesMessage(filePins));
    return next;
  };

  // The task list (`tasks.json`), kept in its own file for the same reason as pinned files.
  let taskState: TaskState = await readTasks();
  const reloadTasks = async () => {
    taskState = await readTasks();
    broadcast(tasksMessage(taskState));
  };
  /** As {@link changePinnedFiles}: read → `change` → write, null when nothing changed. */
  const changeTasks = async (
    change: (state: TaskState) => TaskState | null,
  ): Promise<TaskState | null> => {
    const next = change(await readTasks());
    if (next === null) return null;
    await writeTasks(next);
    taskState = await readTasks();
    broadcast(tasksMessage(taskState));
    return next;
  };

  // devc-bridge's state on this host (running, keepawake markers), watched from its own files.
  // `null` until the first read, which the watch reports straight away.
  let bridgeStatus: BridgeStatus | null = null;
  const bridgeStatusMessage = (s: BridgeStatus) => ({
    type: 'bridge_status',
    running: s.running,
    active: s.active,
  });

  // Account-wide agent usage limits, the newest observation per agent, from the usage files
  // status-line reporters write. `null` until the first read, which the watch reports straight
  // away.
  let usageSources: UsageSource[] | null = null;
  const usageMessage = (sources: UsageSource[]) => ({
    type: 'usage',
    sources,
  });
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
      containerFolder: null,
      primaryFolder: null,
    }]);
    const mounts = await inspectMounts(record.id);
    const binds = mounts.filter((m) => m.type === 'bind');
    const repos = await mountedRepos(
      record.localFolder,
      binds.map((m) => m.source),
    );
    containerRepos.set(
      record.id,
      repos.map((r) => ({
        ...r,
        containerFolder: hostToContainerPath(r.folder, binds),
      })),
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
  // Each running container's mount table, read once: fixed when the container is created. A
  // failed read (an empty table) is not kept.
  const containerMounts = new Map<string, ContainerMount[]>();
  const mountsOf = async (id: string) => {
    let mounts = containerMounts.get(id);
    if (mounts === undefined) {
      mounts = await inspectMounts(id);
      if (mounts.length) containerMounts.set(id, mounts);
    }
    return mounts;
  };
  // How to reach each running container for its Files node, when its session has no Herdr
  // target to borrow one from. A failed resolution is not kept.
  const containerConnections = new Map<string, Promise<ContainerInfo>>();
  const connectionOf = (session: ContainerSession) => {
    if (session.target) return Promise.resolve(session.target.info);
    const id = session.record.id;
    let info = containerConnections.get(id);
    if (info === undefined) {
      info = resolveConnection(session.record);
      containerConnections.set(id, info);
      info.catch(() => {
        if (containerConnections.get(id) === info) {
          containerConnections.delete(id);
        }
      });
    }
    return info;
  };
  const loadHome = async (session: ContainerSession, info: ContainerInfo) => {
    const id = session.record.id;
    if (containerHomes.has(id)) return;
    containerHomes.set(id, null);
    const home = await containerHome(info);
    if (sessions.get(id) !== session) return;
    containerHomes.set(id, home);
    if (home !== null) broadcast(containersMessage());
  };
  // Each running container's last `list_sessions` answer, by container id: what `resume_session`
  // takes a session's folder and title from, never from the page.
  const sessionLists = new Map<string, AgentSession[]>();
  // The panes `resume_session` opened, by `container\nagent\nsession`, while the server runs.
  const resumedPanes = new Map<
    string,
    { containerId: string; paneId: string }
  >();
  const isListedProject = (localFolder: string) =>
    projectsMessage().projects.some((p) => p.localFolder === localFolder);
  // Each repo's pull request, through its running container's devc-bridge: grants read from the
  // host-only policy on every message, the last listing per repo kept here.
  const prReview = new PrReview({
    isRepo: (localFolder, root) =>
      isProjectRepo(projectsMessage().projects, localFolder, root),
    container: async (localFolder) => {
      const session = [...sessions.values()].find((s) =>
        s.record.localFolder === localFolder
      );
      if (!session) return null;
      return {
        info: await connectionOf(session),
        name: basename(localFolder) || session.record.id.slice(0, 12),
      };
    },
    home: Deno.env.get('HOME') ?? '.',
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
    broadcastProjects();
    void gitWatch.refresh();
    void loadRepos(record);
    void session.run();
  };

  const removeContainer = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    containerMounts.delete(id);
    containerConnections.delete(id);
    containerHomes.delete(id);
    sessionLists.delete(id);
    for (const key of resumedPanes.keys()) {
      if (key.startsWith(`${id}\n`)) resumedPanes.delete(key);
    }
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

  /** Answers a failed listing: a {@link FilesError}'s own code, else `list_failed`. */
  const failFiles = (c: Client, id: string, e: unknown) =>
    fail(c, id, e instanceof FilesError ? e.code : 'list_failed', e);

  /** The picker's opening folders: `codeRoots` from devc's config, read now, else `$HOME`. */
  const hostRoots = async () => {
    let codeRoots: string[] = [];
    try {
      codeRoots = (await loadGlobalConfig()).codeRootsExpanded();
    } catch { /* unreadable config or an unset $VAR: no code roots */ }
    return pickerRoots(codeRoots, Deno.env.get('HOME') ?? '/');
  };

  /**
   * Directory listings (a project's files, and the host folders "Add project…" browses) and
   * project file reads for the page's file viewer. Both project messages read the host side of
   * the bind mount, so they work while the container is stopped.
   */
  const handleListing = async (
    c: Client,
    msg: Extract<
      ClientMessage,
      { type: 'list_dir' | 'list_host_dir' | 'read_file' | 'preview_file' }
    >,
  ) => {
    if (
      msg.type === 'list_dir' || msg.type === 'read_file' ||
      msg.type === 'preview_file'
    ) {
      if (!isListedProject(msg.localFolder)) {
        reject(c, {
          id: msg.id,
          code: 'bad_request',
          message: 'unknown project',
        });
        return;
      }
      if (
        !isProjectRepo(projectsMessage().projects, msg.localFolder, msg.root)
      ) {
        reject(c, { id: msg.id, code: 'bad_request', message: 'unknown repo' });
        return;
      }
      if (msg.type === 'read_file') {
        try {
          const result = await readProjectFile(msg.root, msg.path);
          reply(c, { id: msg.id, ok: true, result });
        } catch (e) {
          fail(c, msg.id, e instanceof FilesError ? e.code : 'read_failed', e);
        }
        return;
      }
      if (msg.type === 'preview_file') {
        const root = msg.root;
        const read: PreviewRead = async (rel, max) =>
          (await readProjectBytes(root, rel, max)).bytes;
        try {
          // Read once here, so a missing or unreadable file fails the request, not the tab.
          await read(msg.path, MAX_PREVIEW_BYTES);
          const nonce = previewList.mint(`repo\n${root}`, read);
          reply(c, {
            id: msg.id,
            ok: true,
            result: { path: previewPath(nonce, msg.path) },
          });
        } catch (e) {
          fail(c, msg.id, e instanceof FilesError ? e.code : 'read_failed', e);
        }
        return;
      }
      try {
        const { path, ...listing } = await listProjectDir(msg.root, msg.path);
        // Where the directory is in its running container, for new shells and copied paths.
        const session = [...sessions.values()].find((s) =>
          s.record.localFolder === msg.localFolder
        );
        const containerPath = session
          ? hostToContainerPath(path, await mountsOf(session.record.id))
          : null;
        reply(c, {
          id: msg.id,
          ok: true,
          result: { ...listing, ...(containerPath ? { containerPath } : {}) },
        });
      } catch (e) {
        failFiles(c, msg.id, e);
      }
      return;
    }
    const refusal = projectRefusal(msg, projectStarts);
    if (refusal !== null) {
      fail(c, msg.id, 'not_allowed', refusal);
      return;
    }
    try {
      const result = msg.path === ''
        ? { roots: await hostRoots() }
        : await listHostDir(
          msg.path,
          new Set(projectsMessage().projects.map((p) => p.localFolder)),
        );
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      failFiles(c, msg.id, e);
    }
  };

  /**
   * Opens a file in a new pane running the container's editor, named after the file, and answers
   * with the pane (`open_file`). See {@link editorPane}.
   */
  const openFile = async (
    c: Client,
    session: ContainerSession,
    target: HerdrTarget,
    msg: Extract<ClientMessage, { type: 'open_file' }>,
  ) => {
    const result = await editorPane(c, session, target, msg);
    if (result !== null) reply(c, { id: msg.id, ok: true, result });
  };

  /**
   * A new pane running the container's editor on a file, named after the file; null once a
   * failure is answered. With `root`, `path` is relative to it, one of the repo folders of the
   * container's project, and confined to it; the editor gets the file's container path. Without,
   * `path` is already a container path (the Files node).
   */
  const editorPane = async (
    c: Client,
    session: ContainerSession,
    target: HerdrTarget,
    msg: { id: string; root?: string; path: string },
  ): Promise<{ pane_id: string; tab_id: string } | null> => {
    const containerPath = msg.root === undefined
      ? msg.path
      : await repoContainerPath(c, session, { ...msg, root: msg.root });
    if (containerPath === null) return null;
    try {
      const result = await createShell(target, {
        cwd: dirnamePosix(containerPath),
      });
      await bridgeRequest(target, 'pane.send_text', {
        pane_id: result.pane_id,
        text: editorCommand(containerPath),
      });
      // Named after the file, through the same label a rename sets (the page's `paneLabel`).
      // The editor is already open, so a failed rename leaves the folder's name and no error.
      await bridgeRequest(target, 'pane.rename', {
        pane_id: result.pane_id,
        label: basenamePosix(containerPath),
      }).then((r) => renamed(session, r), () => {});
      return result;
    } catch (e) {
      fail(c, msg.id, e instanceof BridgeError ? e.code : 'herdr_error', e);
      return null;
    }
  };

  /** Passes on a `pane.rename` reply's pane, which Herdr announces with no event of its own. */
  const renamed = (session: ContainerSession, result: unknown) => {
    const pane = (result as { pane?: unknown } | null)?.pane;
    if (typeof pane === 'object' && pane !== null) {
      session.paneChanged(pane as Record<string, unknown>);
    }
  };

  /**
   * A repo file's container path for {@link openFile}, or with `kind: 'dir'` a repo folder's for
   * {@link createFile}; null once the refusal is answered.
   */
  const repoContainerPath = async (
    c: Client,
    session: ContainerSession,
    msg: { id: string; root: string; path: string },
    kind: 'file' | 'dir' = 'file',
  ): Promise<string | null> => {
    const projects = projectsMessage().projects;
    if (!isProjectRepo(projects, session.record.localFolder, msg.root)) {
      fail(c, msg.id, 'bad_request', 'unknown repo');
      return null;
    }
    let hostPath: string | null;
    try {
      hostPath = await confine(msg.root, msg.path);
    } catch {
      fail(c, msg.id, 'not_found', `${msg.path} does not exist`);
      return null;
    }
    if (hostPath === null) {
      fail(c, msg.id, 'forbidden', `${msg.path} is outside the project`);
      return null;
    }
    const stat = await Deno.stat(hostPath).catch(() => null);
    if (!(kind === 'file' ? stat?.isFile : stat?.isDirectory)) {
      fail(
        c,
        msg.id,
        'bad_request',
        `${msg.path} is not a ${kind === 'file' ? 'file' : 'folder'}`,
      );
      return null;
    }
    const containerPath = hostToContainerPath(
      hostPath,
      await mountsOf(session.record.id),
    );
    if (containerPath === null) {
      fail(
        c,
        msg.id,
        'not_mounted',
        `${msg.path} is not mounted in the container`,
      );
    }
    return containerPath;
  };

  /**
   * Creates a file or folder in the container, as the remote user, and starts nothing: the page
   * opens a new file with `open_file` itself. With `root`, `path` is relative to that repo folder
   * and its parent is confined to it (the new path does not exist yet); without, it is a
   * container path, and the container is the boundary. Never written from the host side, where
   * the owner would be devc's user rather than the container's.
   */
  const createFile = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'create_file' }>,
  ) => {
    let path = msg.path;
    if (msg.root !== undefined) {
      const parent = await repoContainerPath(
        c,
        session,
        { id: msg.id, root: msg.root, path: dirnamePosix(msg.path) },
        'dir',
      );
      if (parent === null) return;
      path = `${parent === '/' ? '' : parent}/${basenamePosix(msg.path)}`;
    }
    try {
      const info = await connectionOf(session);
      const result = await createContainerEntry(info, path, msg.kind);
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(c, msg.id, e instanceof FilesError ? e.code : 'create_failed', e);
    }
  };

  /**
   * An existing entry's container path for {@link changeFile}: with `root`, its folder is
   * confined to that repo folder and the name taken as it is, so a link is renamed or deleted
   * itself, never what it points to; without, the path as given. Null once refused.
   */
  const entryContainerPath = async (
    c: Client,
    session: ContainerSession,
    msg: { id: string; root?: string; path: string },
  ): Promise<string | null> => {
    if (msg.root === undefined) return msg.path;
    const parent = await repoContainerPath(
      c,
      session,
      { id: msg.id, root: msg.root, path: dirnamePosix(msg.path) },
      'dir',
    );
    if (parent === null) return null;
    return `${parent === '/' ? '' : parent}/${basenamePosix(msg.path)}`;
  };

  /**
   * Renames or deletes a file or folder in the container, as the remote user, the way
   * {@link createFile} creates one. A rename stays in the entry's folder.
   */
  const changeFile = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'rename_file' | 'delete_file' }>,
  ) => {
    const path = await entryContainerPath(c, session, msg);
    if (path === null) return;
    try {
      const info = await connectionOf(session);
      const result = msg.type === 'rename_file'
        ? await renameContainerEntry(
          info,
          path,
          `${dirnamePosix(path) === '/' ? '' : dirnamePosix(path)}/${msg.to}`,
        )
        : await deleteContainerEntry(info, path);
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(
        c,
        msg.id,
        e instanceof FilesError
          ? e.code
          : msg.type === 'rename_file'
          ? 'rename_failed'
          : 'delete_failed',
        e,
      );
    }
  };

  /**
   * Saves the file viewer's text (`write_file`) in the container, as the remote user, in place:
   * with `root`, `path` must be an existing file in that repo folder (confined, mounted);
   * without, it is a container path. Never written from the host side, as {@link createFile}.
   */
  const writeFile = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'write_file' }>,
  ) => {
    const path = msg.root === undefined
      ? msg.path
      : await repoContainerPath(c, session, {
        id: msg.id,
        root: msg.root,
        path: msg.path,
      });
    if (path === null) return;
    try {
      const info = await connectionOf(session);
      const result = await writeContainerText(info, path, msg.text, msg.base);
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
    }
  };

  /**
   * Where a container path a terminal printed is on the host, for the page's file viewer:
   * `{localFolder, root, path}` as `read_file` takes them, when the file is in one of the
   * container's project repos (confined like `read_file`, symlinks included).
   */
  const locateFile = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'locate_file' }>,
  ) => {
    const localFolder = session.record.localFolder;
    const hostPath = containerToHostPath(
      msg.path,
      await mountsOf(session.record.id),
    );
    if (hostPath === null) {
      fail(c, msg.id, 'not_mounted', `${msg.path} is not in a mounted folder`);
      return;
    }
    const file = repoFileFor(projectsMessage().projects, localFolder, hostPath);
    if (file === null) {
      fail(
        c,
        msg.id,
        'forbidden',
        `${msg.path} is outside the project's repos`,
      );
      return;
    }
    let confined: string | null;
    try {
      confined = await confine(file.root, file.path);
    } catch {
      fail(c, msg.id, 'not_found', `${msg.path} does not exist`);
      return;
    }
    if (confined === null) {
      fail(
        c,
        msg.id,
        'forbidden',
        `${msg.path} is outside the project's repos`,
      );
      return;
    }
    if (!(await Deno.stat(confined).catch(() => null))?.isFile) {
      fail(c, msg.id, 'not_found', `${msg.path} is not a file`);
      return;
    }
    reply(c, { id: msg.id, ok: true, result: { localFolder, ...file } });
  };

  /**
   * The container's own filesystem, for the Files node: a directory listing or a file's text at
   * an absolute container path, whatever Herdr's state. See `container_files.ts`.
   */
  const containerFiles = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<
      ClientMessage,
      {
        type:
          | 'list_container_dir'
          | 'read_container_file'
          | 'preview_container_file';
      }
    >,
  ) => {
    try {
      const info = await connectionOf(session);
      void loadHome(session, info);
      if (msg.type === 'preview_container_file') {
        const read: PreviewRead = async (path, max) =>
          readContainerBytes(await connectionOf(session), `/${path}`, max);
        await readContainerBytes(info, msg.path, MAX_PREVIEW_BYTES);
        const nonce = previewList.mint(`container\n${msg.container}`, read);
        reply(c, {
          id: msg.id,
          ok: true,
          result: { path: previewPath(nonce, msg.path) },
        });
        return;
      }
      const result = msg.type === 'list_container_dir'
        ? withHostPaths(
          await listContainerDir(info, msg.path),
          msg.path,
          await mountsOf(session.record.id),
        )
        : await readContainerFile(info, msg.path);
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(
        c,
        msg.id,
        e instanceof FilesError
          ? e.code
          : msg.type === 'list_container_dir'
          ? 'list_failed'
          : 'read_failed',
        e,
      );
    }
  };

  /**
   * The host path of an `open_in_code` or `reveal_path` target: a repo path, or a container path
   * that a bind mount puts in one of the project's repos. Confined like `read_file`, symlinks
   * included. Null once a failure is answered.
   */
  const hostPathFor = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'open_in_code' | 'reveal_path' }>,
  ): Promise<string | null> => {
    let file: { root: string; path: string };
    if ('container' in msg) {
      const session = sessions.get(msg.container);
      if (!session) {
        reject(c, {
          id: msg.id,
          code: 'bad_request',
          message: 'unknown container',
        });
        return null;
      }
      const hostPath = containerToHostPath(
        msg.path,
        await mountsOf(session.record.id),
      );
      if (hostPath === null) {
        fail(
          c,
          msg.id,
          'not_mounted',
          `${msg.path} is not in a mounted folder`,
        );
        return null;
      }
      const found = repoFileFor(
        projectsMessage().projects,
        session.record.localFolder,
        hostPath,
      );
      if (found === null) {
        fail(
          c,
          msg.id,
          'forbidden',
          `${msg.path} is outside the project's repos`,
        );
        return null;
      }
      file = found;
    } else {
      if (
        !isListedProject(msg.localFolder) ||
        !isProjectRepo(projectsMessage().projects, msg.localFolder, msg.root)
      ) {
        reject(c, { id: msg.id, code: 'bad_request', message: 'unknown repo' });
        return null;
      }
      file = msg;
    }
    let confined: string | null;
    try {
      confined = await confine(file.root, file.path);
    } catch {
      fail(c, msg.id, 'not_found', `${msg.path} does not exist`);
      return null;
    }
    if (confined === null) {
      fail(c, msg.id, 'forbidden', `${msg.path} is outside the repo`);
      return null;
    }
    return confined;
  };

  /** Opens a project file or folder in VS Code on the host (`open_in_code`). */
  const openInCode = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'open_in_code' }>,
  ) => {
    const path = await hostPathFor(c, msg);
    if (path === null) return;
    try {
      openInVSCode(path);
    } catch (e) {
      fail(c, msg.id, 'no_code', e);
      return;
    }
    reply(c, { id: msg.id, ok: true, result: {} });
  };

  /**
   * Shows a project file or folder selected in the host's file manager (`reveal_path`), resolved
   * as `open_in_code` resolves it.
   */
  const revealPath = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'reveal_path' }>,
  ) => {
    const path = await hostPathFor(c, msg);
    if (path === null) return;
    try {
      revealOnHost(path);
    } catch (e) {
      fail(c, msg.id, 'reveal_failed', e);
      return;
    }
    reply(c, { id: msg.id, ok: true, result: {} });
  };

  /**
   * Waits until the session is no longer `connecting` (a run in progress), up to about the time
   * a session start may take.
   */
  const settled = async (session: ContainerSession) => {
    const until = Date.now() + OPEN_TAB_WAIT_MS;
    while (session.state === 'connecting' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /**
   * The session's Herdr, once it is connected: waits out a run in progress and starts a session
   * when there is none. Null once a failure is answered.
   */
  const readyTarget = async (
    c: Client,
    session: ContainerSession,
    id: string,
  ): Promise<HerdrTarget | null> => {
    try {
      await settled(session);
      if (session.state === 'no-session') await session.startSession();
    } catch (e) {
      fail(c, id, e instanceof BridgeError ? e.code : 'start_failed', e);
      return null;
    }
    const target = session.target;
    if (session.state === 'connecting') {
      fail(c, id, 'not_ready', 'Herdr is still connecting');
      return null;
    }
    if (session.state !== 'connected' || target === null) {
      fail(
        c,
        id,
        'herdr_unavailable',
        session.error ?? `Herdr is unavailable (${session.state})`,
      );
      return null;
    }
    return target;
  };

  /**
   * A Herdr tab at a project folder: `path` (a directory relative to `root`, one of the
   * container's project's repo folders). Starts the session when there is none; with `reuse`,
   * answers with a shell pane already at the folder (see {@link paneAtFolder}) instead of making
   * one. Never starts the container.
   */
  const openTab = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'open_tab' }>,
  ) => {
    const projects = projectsMessage().projects;
    if (!isProjectRepo(projects, session.record.localFolder, msg.root)) {
      fail(c, msg.id, 'bad_request', 'unknown repo');
      return;
    }
    const shown = msg.path || '.';
    let hostPath: string | null;
    try {
      hostPath = await confine(msg.root, msg.path);
    } catch {
      fail(c, msg.id, 'not_found', `${shown} does not exist`);
      return;
    }
    if (hostPath === null) {
      fail(c, msg.id, 'forbidden', `${shown} is outside the project`);
      return;
    }
    if (!(await Deno.stat(hostPath).catch(() => null))?.isDirectory) {
      fail(c, msg.id, 'bad_request', `${shown} is not a directory`);
      return;
    }
    const cwd = hostToContainerPath(
      hostPath,
      await mountsOf(session.record.id),
    );
    if (cwd === null) {
      fail(
        c,
        msg.id,
        'not_mounted',
        `${shown} is not mounted in the container`,
      );
      return;
    }
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    const command = msg.agent !== undefined ? AGENT_COMMANDS[msg.agent] : null;
    if (command !== null && !(await commandInstalled(target, command))) {
      fail(
        c,
        msg.id,
        'not_installed',
        `${command} isn't installed in this container`,
      );
      return;
    }
    if (msg.reuse) {
      const found = paneAtFolder(session.snapshot, cwd);
      if (found !== null) {
        reply(c, { id: msg.id, ok: true, result: { ...found, reused: true } });
        return;
      }
    }
    try {
      const created = await createShell(target, { cwd });
      // Not `exec`: quitting the agent leaves the shell.
      if (command !== null) {
        await bridgeRequest(target, 'pane.send_text', {
          pane_id: created.pane_id,
          text: `${command}\n`,
        });
      }
      reply(c, {
        id: msg.id,
        ok: true,
        result: { ...created, reused: false },
      });
    } catch (e) {
      fail(c, msg.id, e instanceof BridgeError ? e.code : 'herdr_error', e);
    }
  };

  /**
   * Pinned files: pin a repo file of a listed project, unpin or relabel one, and `open_pinned`,
   * which answers with the pin's editor pane, reusing the one it last opened while that pane is
   * still in its container's session, else making one as `open_file` does. Unpinning leaves the
   * editor pane alone.
   */
  const handleFilePin = async (
    c: Client,
    msg: Extract<
      ClientMessage,
      { type: 'pin_file' | 'unpin_file' | 'rename_pin' | 'open_pinned' }
    >,
  ) => {
    if (msg.type === 'pin_file') {
      if (
        !isListedProject(msg.localFolder) ||
        !isProjectRepo(projectsMessage().projects, msg.localFolder, msg.root)
      ) {
        reject(c, {
          id: msg.id,
          code: 'bad_request',
          message: isListedProject(msg.localFolder)
            ? 'unknown repo'
            : 'unknown project',
        });
        return;
      }
      let hostPath: string | null;
      try {
        hostPath = await confine(msg.root, msg.path);
      } catch {
        fail(c, msg.id, 'not_found', `${msg.path} does not exist`);
        return;
      }
      if (hostPath === null) {
        fail(c, msg.id, 'forbidden', `${msg.path} is outside the project`);
        return;
      }
      if (!(await Deno.stat(hostPath).catch(() => null))?.isFile) {
        fail(c, msg.id, 'bad_request', `${msg.path} is not a file`);
        return;
      }
      let id = '';
      try {
        await changePinnedFiles((pins) => {
          const added = addFilePin(pins, msg);
          id = added.id;
          return added.pins === pins ? null : added.pins;
        });
      } catch (e) {
        fail(c, msg.id, 'pinned_files_error', e);
        return;
      }
      reply(c, { id: msg.id, ok: true, result: { pin: id } });
      return;
    }
    if (msg.type === 'unpin_file' || msg.type === 'rename_pin') {
      const label = msg.type === 'rename_pin' ? msg.label : null;
      let changed: FilePin[] | null;
      try {
        changed = await changePinnedFiles((pins) =>
          label === null
            ? pins.some((p) => p.id === msg.pin)
              ? pins.filter((p) => p.id !== msg.pin)
              : null
            : updateFilePin(pins, msg.pin, (p) => withLabel(p, label))
        );
      } catch (e) {
        fail(c, msg.id, 'pinned_files_error', e);
        return;
      }
      if (changed === null) {
        fail(c, msg.id, 'not_found', 'no such pinned file');
        return;
      }
      reply(c, { id: msg.id, ok: true, result: {} });
      return;
    }
    const pin = filePins.find((p) => p.id === msg.pin);
    if (!pin) {
      fail(c, msg.id, 'not_found', 'no such pinned file');
      return;
    }
    const session = [...sessions.values()].find((s) =>
      s.record.localFolder === pin.localFolder
    );
    if (!session) {
      fail(c, msg.id, 'not_running', 'the container is not running');
      return;
    }
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    const containerId = session.record.id;
    const reused = reusablePinnedPane(
      pin.last,
      containerId,
      snapshotPanes(session.snapshot),
    );
    if (reused !== null) {
      reply(c, { id: msg.id, ok: true, result: { ...reused, reused: true } });
      return;
    }
    const created = await editorPane(c, session, target, {
      id: msg.id,
      root: pin.root,
      path: pin.path,
    });
    if (created === null) return;
    // A hint for the next open, checked before use: a failed write only costs a new pane then.
    await changePinnedFiles((pins) =>
      updateFilePin(pins, pin.id, (p) => ({
        ...p,
        last: { containerId, paneId: created.pane_id },
      }))
    ).catch((e) =>
      console.error(`devc web: ${e instanceof Error ? e.message : e}`)
    );
    reply(c, { id: msg.id, ok: true, result: { ...created, reused: false } });
  };

  /**
   * The task list: add, edit, delete and restore change `tasks.json` only. `send_task` writes the
   * task's text into its project's container, starts the agent on it in a new tab with a session
   * id chosen here, and moves the task to `sent`. `open_sent` answers with that agent's pane while
   * it is still in the session, else resumes the session in a new tab. Nothing a container says
   * is written to the list.
   */
  const handleTask = async (
    c: Client,
    msg: Extract<
      ClientMessage,
      {
        type:
          | 'add_task'
          | 'update_task'
          | 'delete_task'
          | 'restore_task'
          | 'send_task'
          | 'open_sent';
      }
    >,
  ) => {
    const badRoute = (localFolder?: string, root?: string) => {
      if (localFolder === undefined || root === undefined) return null;
      if (!isListedProject(localFolder)) return 'unknown project';
      if (!isProjectRepo(projectsMessage().projects, localFolder, root)) {
        return 'unknown repo';
      }
      return null;
    };
    /** Applies `change`; answers `not_found` when it gives null, `tasks_error` when writing fails. */
    const change = async (
      apply: (state: TaskState) => TaskState | null,
      result: Record<string, unknown> = {},
    ) => {
      let changed: TaskState | null;
      try {
        changed = await changeTasks(apply);
      } catch (e) {
        fail(c, msg.id, 'tasks_error', e);
        return;
      }
      if (changed === null) {
        fail(c, msg.id, 'not_found', 'no such task');
        return;
      }
      reply(c, { id: msg.id, ok: true, result });
    };
    if (msg.type === 'add_task' || msg.type === 'update_task') {
      const refusal = badRoute(msg.localFolder, msg.root);
      if (refusal !== null) {
        reject(c, { id: msg.id, code: 'bad_request', message: refusal });
        return;
      }
      const task = {
        text: msg.text,
        ...(msg.localFolder !== undefined && msg.root !== undefined
          ? { route: { localFolder: msg.localFolder, root: msg.root } }
          : {}),
      };
      if (msg.type === 'update_task') {
        await change((state) => updateTask(state, msg.task, task));
        return;
      }
      const id = crypto.randomUUID();
      await change(
        (state) => addTask(state, task, new Date(), () => id).state,
        { task: id },
      );
      return;
    }
    if (msg.type === 'delete_task') {
      await change((state) => deleteTask(state, msg.task));
      return;
    }
    if (msg.type === 'restore_task') {
      await change((state) => restoreTask(state, msg.task));
      return;
    }
    const localFolder = msg.type === 'send_task'
      ? msg.localFolder
      : taskState.sent.find((t) => t.id === msg.task)?.localFolder;
    const task = msg.type === 'send_task'
      ? taskState.tasks.find((t) => t.id === msg.task)
      : taskState.sent.find((t) => t.id === msg.task);
    if (!task || localFolder === undefined) {
      fail(c, msg.id, 'not_found', 'no such task');
      return;
    }
    if (msg.type === 'send_task') {
      const refusal = badRoute(msg.localFolder, msg.root);
      if (refusal !== null) {
        reject(c, { id: msg.id, code: 'bad_request', message: refusal });
        return;
      }
    }
    const session = [...sessions.values()].find((s) =>
      s.record.localFolder === localFolder
    );
    if (!session) {
      fail(c, msg.id, 'not_running', 'the container is not running');
      return;
    }
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    const containerId = session.record.id;
    const sent = msg.type === 'open_sent'
      ? taskState.sent.find((t) => t.id === msg.task)!
      : null;
    if (sent !== null) {
      const reused = reusablePinnedPane(
        sent.last,
        containerId,
        snapshotPanes(session.snapshot),
      );
      if (reused !== null) {
        reply(c, { id: msg.id, ok: true, result: { ...reused, reused: true } });
        return;
      }
    }
    const root = msg.type === 'send_task' ? msg.root : sent!.root;
    const agent = msg.type === 'send_task' ? msg.agent : sent!.agent;
    const cwd = await repoContainerPath(
      c,
      session,
      { id: msg.id, root, path: '' },
      'dir',
    );
    if (cwd === null) return;
    if (!(await commandInstalled(target, AGENT_COMMANDS[agent]))) {
      fail(
        c,
        msg.id,
        'not_installed',
        `${AGENT_COMMANDS[agent]} isn't installed in this container`,
      );
      return;
    }
    const sessionId = sent?.sessionId ?? crypto.randomUUID();
    let command: string;
    if (msg.type === 'send_task') {
      try {
        await writeContainerFile(
          await connectionOf(session),
          TASK_FILE_DIR,
          taskFilePath(sessionId),
          `${task.text}\n`,
        );
      } catch (e) {
        fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
        return;
      }
      command = startTaskCommand(agent, sessionId, msg.action);
    } else {
      command = resumeTaskCommand(agent, sessionId);
    }
    let created: { pane_id: string; tab_id: string };
    try {
      created = await createShell(target, { cwd });
      // Not `exec`: quitting the agent leaves the shell.
      await bridgeRequest(target, 'pane.send_text', {
        pane_id: created.pane_id,
        text: `${command}\n`,
      });
    } catch (e) {
      fail(c, msg.id, e instanceof BridgeError ? e.code : 'herdr_error', e);
      return;
    }
    // Named after the task; the agent is already starting, so a failed rename is no error.
    await bridgeRequest(target, 'pane.rename', {
      pane_id: created.pane_id,
      label: taskTitle(task.text),
    }).then((r) => renamed(session, r), () => {});
    const last = { containerId, paneId: created.pane_id };
    try {
      await changeTasks((state) =>
        msg.type === 'send_task'
          ? markSent(state, msg.task, {
            action: msg.action,
            agent: msg.agent,
            sentAt: new Date().toISOString(),
            localFolder: msg.localFolder,
            root: msg.root,
            cwd,
            sessionId,
            last,
          })
          : withSentPane(state, msg.task, last)
      );
    } catch (e) {
      // The agent is already running, so the send still answers ok: only its Sent entry is lost.
      console.error(`devc web: ${e instanceof Error ? e.message : e}`);
    }
    reply(c, { id: msg.id, ok: true, result: { ...created, reused: false } });
  };

  /**
   * A container's recent agent sessions (`list_sessions`, see `sessions.ts`), and resuming one
   * of them in a new tab at the folder it started in (`resume_session`): the pane `resume_session`
   * opened before while it is still in the session, else the pane a live agent process has it
   * open in, else a new shell running the agent's resume command. The folder and title come from the container's last listing.
   */
  const handleAgentSession = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<
      ClientMessage,
      { type: 'list_sessions' | 'resume_session' }
    >,
  ) => {
    const containerId = session.record.id;
    if (msg.type === 'list_sessions') {
      const repos = projectsMessage().projects.find((p) =>
        p.localFolder === session.record.localFolder
      )?.repos ?? [];
      try {
        const listed = await listAgentSessions(
          await connectionOf(session),
          repos,
          opts.session,
        );
        if (sessions.get(containerId) === session) {
          sessionLists.set(containerId, listed);
        }
        reply(c, { id: msg.id, ok: true, result: { sessions: listed } });
      } catch (e) {
        fail(c, msg.id, 'list_failed', e);
      }
      return;
    }
    const listed = sessionLists.get(containerId)?.find((s) =>
      s.agent === msg.agent && s.session === msg.session
    );
    if (!listed) {
      fail(c, msg.id, 'not_found', 'no such session');
      return;
    }
    const key = `${containerId}\n${listed.agent}\n${listed.session}`;
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    // The pane this server resumed it in, else one a live agent process has it open in (started
    // by hand, or before this server): never a second process on the same session.
    const panes = snapshotPanes(session.snapshot);
    const live = listed.agent === 'claude'
      ? await runningPane(
        await connectionOf(session),
        listed.session,
        opts.session,
      )
      : null;
    const reused = reusablePinnedPane(
      resumedPanes.get(key),
      containerId,
      panes,
    ) ?? reusablePinnedPane(
      live === null ? undefined : { containerId, paneId: live },
      containerId,
      panes,
    );
    if (reused !== null) {
      reply(c, { id: msg.id, ok: true, result: { ...reused, reused: true } });
      return;
    }
    if (!(await commandInstalled(target, AGENT_COMMANDS[listed.agent]))) {
      fail(
        c,
        msg.id,
        'not_installed',
        `${AGENT_COMMANDS[listed.agent]} isn't installed in this container`,
      );
      return;
    }
    let created: { pane_id: string; tab_id: string };
    try {
      created = await createShell(target, { cwd: listed.cwd });
      // Not `exec`: quitting the agent leaves the shell.
      await bridgeRequest(target, 'pane.send_text', {
        pane_id: created.pane_id,
        text: `${resumeTaskCommand(listed.agent, listed.session)}\n`,
      });
    } catch (e) {
      fail(c, msg.id, e instanceof BridgeError ? e.code : 'herdr_error', e);
      return;
    }
    // The agent is already starting, so a failed rename is no error.
    await bridgeRequest(target, 'pane.rename', {
      pane_id: created.pane_id,
      label: listed.title,
    }).then((r) => renamed(session, r), () => {});
    resumedPanes.set(key, { containerId, paneId: created.pane_id });
    reply(c, { id: msg.id, ok: true, result: { ...created, reused: false } });
  };

  /** A repo's pull request (`pr_files` … `pr_resolve`, see `pr_review.ts`). */
  const handlePr = async (
    c: Client,
    msg: Extract<ClientMessage, { type: PrMessage['type'] }>,
  ) => {
    const { id, ...rest } = msg;
    if (!isListedProject(msg.localFolder)) {
      reject(c, { id, code: 'bad_request', message: 'unknown project' });
      return;
    }
    let answer;
    try {
      answer = await prReview.handle(rest as PrMessage);
    } catch (e) {
      fail(c, id, 'pr_failed', e);
      return;
    }
    if (answer.ok) reply(c, { id, ok: true, result: answer.result });
    else fail(c, id, answer.code, answer.message);
  };

  /** The messages about projects, which name a folder rather than a running container. */
  const handleProject = async (
    c: Client,
    msg: Exclude<
      Extract<ClientMessage, { localFolder: string }>,
      { type: 'list_dir' | 'read_file' | 'preview_file' }
    >,
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
      case 'down_project':
        if (!isListedProject(folder)) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: 'unknown project',
          });
          return;
        }
        try {
          const removed = await downProject(folder);
          reply(c, { id: msg.id, ok: true, result: { removed } });
        } catch (e) {
          fail(c, msg.id, 'down_failed', e);
        } finally {
          await reloadProjects();
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
    if (msg.type === 'active_pane') {
      activePane = 'container' in msg
        ? { container: msg.container, pane_id: msg.pane_id }
        : null;
      return;
    }
    if (msg.type === 'client_ready') {
      await liveStatic?.clientReady(msg.generation);
      return;
    }
    if (
      msg.type === 'list_dir' || msg.type === 'list_host_dir' ||
      msg.type === 'read_file' || msg.type === 'preview_file'
    ) {
      await handleListing(c, msg);
      return;
    }
    if (
      msg.type === 'pin_file' || msg.type === 'unpin_file' ||
      msg.type === 'rename_pin' || msg.type === 'open_pinned'
    ) {
      await handleFilePin(c, msg);
      return;
    }
    // Before the `localFolder` check: it names a project or a container.
    if (msg.type === 'open_in_code') {
      await openInCode(c, msg);
      return;
    }
    if (msg.type === 'reveal_path') {
      await revealPath(c, msg);
      return;
    }
    // Before the `localFolder` check: a routed task names a project too.
    if (
      msg.type === 'add_task' || msg.type === 'update_task' ||
      msg.type === 'delete_task' || msg.type === 'restore_task' ||
      msg.type === 'send_task' || msg.type === 'open_sent'
    ) {
      await handleTask(c, msg);
      return;
    }
    // Before the `localFolder` check: these name a repo of a project, and need its container.
    if (
      msg.type === 'pr_files' || msg.type === 'pr_diff' ||
      msg.type === 'pr_threads' || msg.type === 'pr_viewed' ||
      msg.type === 'pr_reply' || msg.type === 'pr_resolve'
    ) {
      await handlePr(c, msg);
      return;
    }
    if ('localFolder' in msg) {
      await handleProject(c, msg);
      return;
    }
    const session = sessions.get(msg.container);
    const id = 'id' in msg ? msg.id : undefined;
    if (!session) {
      if (
        msg.type === 'create_file' || msg.type === 'rename_file' ||
        msg.type === 'delete_file' || msg.type === 'write_file'
      ) {
        fail(c, msg.id, 'not_running', 'the container is not running');
        return;
      }
      reject(c, { id, code: 'bad_request', message: 'unknown container' });
      return;
    }
    switch (msg.type) {
      case 'retry':
        void session.retry();
        return;
      case 'start_session':
        try {
          await session.startSession();
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(
            c,
            msg.id,
            e instanceof BridgeError ? e.code : 'start_failed',
            e,
          );
        }
        return;
      case 'open_tab':
        await openTab(c, session, msg);
        return;
      case 'locate_file':
        await locateFile(c, session, msg);
        return;
      case 'list_container_dir':
      case 'read_container_file':
      case 'preview_container_file':
        await containerFiles(c, session, msg);
        return;
      case 'list_sessions':
      case 'resume_session':
        await handleAgentSession(c, session, msg);
        return;
      case 'create_file':
        await createFile(c, session, msg);
        return;
      case 'write_file':
        await writeFile(c, session, msg);
        return;
      case 'rename_file':
      case 'delete_file':
        await changeFile(c, session, msg);
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
      case 'open_file':
        await openFile(c, session, target, msg);
        return;
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
          if (msg.method === 'pane.rename') renamed(session, result);
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
        hostOs: Deno.build.os,
      }));
      client.send(JSON.stringify(containersMessage()));
      client.send(JSON.stringify(projectsMessage()));
      client.send(JSON.stringify(pinnedFilesMessage(filePins)));
      client.send(JSON.stringify(tasksMessage(taskState)));
      if (bridgeStatus !== null) {
        client.send(JSON.stringify(bridgeStatusMessage(bridgeStatus)));
      }
      if (usageSources !== null) {
        client.send(JSON.stringify(usageMessage(usageSources)));
      }
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

  /**
   * The active pane as Herdr has it now: a shell's `cd` does not reach the cached snapshot, so
   * `pane.get` is asked live, for up to {@link LIVE_PANE_MS}. `null` (the cached snapshot is
   * used) when there is no target, or the request fails or is slow.
   */
  const livePane = async (
    session: ContainerSession,
    paneId: string,
  ): Promise<Record<string, unknown> | null> => {
    const target = session.target;
    if (!target) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        bridgeRequest(target, 'pane.get', { pane_id: paneId }),
        new Promise<null>((r) =>
          timer = setTimeout(() => r(null), LIVE_PANE_MS)
        ),
      ]) as { pane?: unknown } | null;
      const pane = result?.pane;
      return typeof pane === 'object' && pane !== null
        ? pane as Record<string, unknown>
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const serveActiveFolder = async () => {
    const active = activePane;
    const session = active ? sessions.get(active.container) : undefined;
    const live = session && active
      ? await livePane(session, active.pane_id)
      : null;
    const answer = activeFolder(
      active,
      session
        ? {
          snapshot: live ? { panes: [live] } : session.snapshot,
          mounts: await mountsOf(session.record.id),
          localFolder: session.record.localFolder,
        }
        : null,
    );
    return new Response(JSON.stringify(answer), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
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
      if (url.pathname.startsWith(DESKTOP_PREFIX)) {
        if (req.method !== 'GET') {
          return new Response('method not allowed', { status: 405 });
        }
        if (url.pathname !== `${DESKTOP_PREFIX}active-folder`) {
          return new Response('not found', { status: 404 });
        }
        return serveActiveFolder();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', { status: 405 });
      }
      if (url.pathname.startsWith('/preview/')) {
        return previewList.serve(url.pathname, req.method === 'HEAD');
      }
      const opened = openLink(url.pathname);
      if (opened !== null) return opened;
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
  const projectsWatch = watchConfigFile(
    PROJECTS_PATH,
    () => void reloadProjects(),
  );
  // Another devc web (the desktop window's, a browser's) pinning or unpinning a file.
  const pinnedFilesWatch = watchConfigFile(
    PINNED_FILES_PATH,
    () => void reloadPinnedFiles(),
  );
  // Another devc web adding, sending or deleting a task.
  const tasksWatch = watchConfigFile(TASKS_PATH, () => void reloadTasks());
  const bridgeWatch = watchBridgeStatus(
    bridgeStatePaths(Deno.env, Deno.env.get('HOME') ?? '.'),
    (s) => {
      bridgeStatus = s;
      broadcast(bridgeStatusMessage(s));
    },
  );
  const usageWatch = watchUsage(
    usageFiles(Deno.env, Deno.env.get('HOME') ?? '.'),
    (sources) => {
      usageSources = sources;
      broadcast(usageMessage(sources));
    },
  );

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      discovery.stop();
      liveStatic?.stop();
      gitWatch.stop();
      projectsWatch.stop();
      pinnedFilesWatch.stop();
      tasksWatch.stop();
      bridgeWatch.stop();
      usageWatch.stop();
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

/** How long a watched config file must be quiet before a change to it is re-read. */
const CONFIG_DEBOUNCE_MS = 200;
/** How long `open_tab` waits for a `connecting` container: about a session start's wait. */
const OPEN_TAB_WAIT_MS = 15_000;

/**
 * Calls `onChange` (debounced) whenever a file of devc's config dir changes: the projects file (a
 * start in some terminal records its project there) or the pinned files (another devc web pinned
 * one). Watches the file's directory, since the file is replaced by a rename and may not exist
 * yet. Never throws: without a watch, the list just refreshes on the page's own changes.
 */
function watchConfigFile(path: string, onChange: () => void): { stop(): void } {
  const dir = dirname(path);
  const file = basename(path);
  let watcher: Deno.FsWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  (async () => {
    try {
      await Deno.mkdir(dir, { recursive: true });
      watcher = Deno.watchFs(dir, { recursive: false });
      for await (const ev of watcher) {
        if (!ev.paths.some((p) => basename(p) === file)) continue;
        clearTimeout(timer);
        timer = setTimeout(onChange, CONFIG_DEBOUNCE_MS);
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
