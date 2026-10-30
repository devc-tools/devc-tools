// `devc web`: a loopback HTTP + WebSocket server that serves the page in `static/` and routes
// its `/ws` protocol (`protocol.ts`) to each running environment's Herdr server
// (`herdr_bridge.ts`) and pane streams (`controllers.ts`): every running devcontainer
// (`containers.ts`), and every project on this machine whose own Herdr session runs
// (`env_host.ts`). See `.plans/devc-web.md` and `.plans/devc-web-host-environments.md`.
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
import { ContainerSource, probeDocker } from './containers.ts';
import { HostSource } from './env_host.ts';
import {
  ASKED,
  type DesktopRequestKind,
  DesktopRequests,
  LONG_POLL_MS,
} from './desktop_requests.ts';
import {
  type Environment,
  ENVIRONMENT_KINDS,
  type EnvironmentKind,
  type EnvironmentSource,
} from './environment.ts';
import type { ContainerMount } from '@devc-tools/core/container.ts';
import { withHostPaths } from './container_files.ts';
import { attachImage } from './images.ts';
import {
  GLOBAL_CONFIG_PATHS,
  type JiraConfig,
  jiraFromConfig,
  loadGlobalConfig,
} from '@devc-tools/core/config.ts';
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
import { listRepoFiles } from './file_index.ts';
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
  paneAtFolder,
  snapshotPaneIds,
  snapshotPanes,
} from './herdr_bridge.ts';
import { ControllerManager, type Subscriber } from './controllers.ts';
import {
  AGENT_COMMANDS,
  resumeAskCommand,
  resumeTaskCommand,
  startAskCommand,
  startTaskCommand,
  TASK_FILE_DIR,
  taskFilePath,
  taskOutcome,
  taskResultPath,
} from './agents.ts';
import {
  addTask,
  deleteTask,
  markSent,
  queueFailed,
  queueHeads,
  queueTasks,
  readTasks,
  restoreTask,
  routeKey,
  type Task,
  TASKS_PATH,
  tasksMessage,
  type TaskState,
  taskTitle,
  unqueueTask,
  updateTask,
  withSentPane,
  withTasksLock,
  writeTasks,
} from '@devc-tools/core/tasks.ts';
import {
  type AgentSession,
  listAgentSessions,
  runningPane,
} from './sessions.ts';
import { openRedirect } from './browser.ts';
import { openInVSCode } from './vscode.ts';
import { revealOnHost } from './reveal.ts';
import {
  addProject,
  loadProjects,
  type ProjectEntry,
  PROJECTS_PATH,
  removeProject,
  setEnvironment,
  updateProjects,
} from '../projects.ts';
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
  DASHBOARD_PATH,
  type DashboardFile,
  dashboardMessage,
  readDashboard,
  writeDashboard,
} from './dashboard.ts';
import {
  buildProjects,
  effectiveEnvironment,
  isProjectRepo,
  projectRefusal,
  repoFileFor,
  type WsRole,
} from './projects_view.ts';
import { type GitProblem, GitStatusWatch, isGitProblem } from './git_status.ts';
import { type ChangesReading, GitChangesWatch } from './git_changes.ts';
import { fetchRepo, fetchRunning, pullRepo, pullRunning } from './git_fetch.ts';
import {
  ActivityRecorder,
  catchUpRollups,
  localDate,
  paneFacts,
  ROLLUP_EVERY_MS,
  writeDayRollup,
} from './activity.ts';
import { lead } from './leader.ts';
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
import { type Delivery, ViewRegistry } from './views.ts';
import { PROTOCOL } from './static/lib/protocol_version.js';
import { PR_MESSAGE_TYPES, type PrMessage, PrReview } from './pr_review.ts';
import { closeGracefully, liveProcs } from './proc.ts';
import { LspError, LspManager, type LspTarget } from './lsp_manager.ts';
import { LspConfigStore } from './lsp_config.ts';
import { lspIdleMs } from './lsp_session.ts';
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
 * refused (403), and a token comes only as `Authorization: Bearer` (401). Which token: the
 * **desktop** token (`--desktop-channel`) on {@link desktopTokenPath}s, and only there, else the
 * page token. Anything holding the page token counts as the page, so neither is ever accepted
 * where the other is required; with no desktop token, those routes refuse everything.
 */
export function authorize(
  headers: Headers,
  url: URL,
  port: number,
  token: string,
  desktopToken: string | null = null,
): 401 | 403 | null {
  if (!hostAllowed(headers.get('host'), port)) return 403;
  if (url.pathname.startsWith(DESKTOP_PREFIX)) {
    if (headers.get('origin') !== null) return 403;
    const auth = headers.get('authorization');
    const given = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const expected = desktopTokenPath(url.pathname) ? desktopToken : token;
    return expected !== null && tokenMatches(given, expected) ? null : 401;
  }
  if (url.pathname !== '/ws') return null;
  if (wsRole(url) === 'desktop') {
    // devc-desktop's Containers pane: a `file:` page, whose Origin Chromium sends as `file://`
    // (`null` in other browsers), or none. Never a web page's: no site can send these.
    const origin = headers.get('origin');
    if (origin !== null && origin !== 'null' && origin !== 'file://') {
      return 403;
    }
    const given = url.searchParams.get('desktop_token');
    return desktopToken !== null && url.searchParams.get('token') === null &&
        tokenMatches(given, desktopToken)
      ? null
      : 401;
  }
  if (!originAllowed(headers.get('origin'), port)) return 403;
  if (!tokenMatches(url.searchParams.get('token'), token)) return 401;
  return null;
}

/**
 * Which role a `/ws` connection that passed {@link authorize} has: `desktop` when it came with
 * the desktop token (`?desktop_token=`, devc-desktop's bundled Containers pane), else `page`.
 * Handlers check the role, never the token again (see {@link projectRefusal}).
 */
export function wsRole(url: URL): WsRole {
  return url.searchParams.has('desktop_token') ? 'desktop' : 'page';
}

/**
 * The server's first `/ws` message. `protocol` is {@link PROTOCOL}: devc-desktop's bundled
 * Containers pane draws nothing when it was built for another. `projectStarts` is what this
 * connection's role may start (see {@link projectRefusal}): a page's under `--live` is off, the
 * desktop role's is on except under `--live-yolo`.
 */
export function helloMessage(o: {
  role: WsRole;
  generation: string;
  live: boolean;
  projectStarts: boolean;
  desktopProjects: boolean;
  desktopChannel: boolean;
  hostOs: string;
}): Record<string, unknown> {
  return {
    type: 'hello',
    protocol: PROTOCOL,
    generation: o.generation,
    live: o.live,
    projectStarts: o.role === 'desktop' ? o.desktopProjects : o.projectStarts,
    desktopChannel: o.desktopChannel,
    hostOs: o.hostOs,
  };
}

/** The paths only devc-desktop's main process asks for. */
const DESKTOP_PREFIX = '/desktop/';

/**
 * The `/desktop/` paths that take the desktop token, never the page token: the requests the page
 * made (`GET /desktop/requests`, `POST /desktop/requests/<id>/dismiss`) and the project actions
 * the app confirmed (`POST /desktop/project`).
 */
export function desktopTokenPath(pathname: string): boolean {
  return pathname === `${DESKTOP_PREFIX}requests` ||
    pathname.startsWith(`${DESKTOP_PREFIX}requests/`) ||
    pathname === `${DESKTOP_PREFIX}project`;
}

/** How often one repo may be fetched (`fetch_repo`). */
const FETCH_INTERVAL_MS = 10_000;

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

/** A `POST /desktop/project` body, or `null` when it isn't one. */
export function parseDesktopProject(
  text: string,
): { action: 'start' | 'stop' | 'down'; localFolder: string } | null {
  if (text.length > 8192) return null;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const { action, localFolder } = o as Record<string, unknown>;
  if (action !== 'start' && action !== 'stop' && action !== 'down') return null;
  if (typeof localFolder !== 'string' || !localFolder.startsWith('/')) {
    return null;
  }
  return { action, localFolder };
}

/**
 * Why a `POST /desktop/project` is refused, or `null`: never under `--live-yolo`
 * (`desktopProjects` false: 409, whatever the body), a body that isn't one (400), a project devc
 * web doesn't list (404). `--live` is no refusal: the page can't reach this route.
 */
export function desktopProjectRefusal(
  desktopProjects: boolean,
  body: ReturnType<typeof parseDesktopProject>,
  listed: boolean,
): { status: 400 | 404 | 409; problem: string } | null {
  if (!desktopProjects) return { status: 409, problem: 'live-yolo' };
  if (body === null) return { status: 400, problem: 'bad request' };
  if (!listed) return { status: 404, problem: 'unknown project' };
  return null;
}

/** Why {@link startWeb}'s project action could not run: the `result` error's code, and text. */
export class ProjectActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

/**
 * Who may frame a page: VS Code webviews (devc-vscode's devc web view, Simple Browser) for the
 * split pages, nobody for anything else. `frame-ancestors` checks every ancestor, and a webview's
 * frames sit in the workbench, whose origin on the desktop is `vscode-file://vscode-app`.
 */
const WEBVIEW_ANCESTORS = 'vscode-webview: vscode-file:';

/** The split pages' routes, the only responses a VS Code webview may frame. Not their `.html` names. */
const FRAMABLE_ROUTES = new Set(['/sidebar', '/main', '/containers']);

function securityHeaders(
  port: number,
  framable = false,
): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // xterm.js injects <style> elements, hence the inline styles.
    'Content-Security-Policy': [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      `frame-ancestors ${framable ? WEBVIEW_ANCESTORS : "'none'"}`,
    ].join('; '),
  };
}

/**
 * The page's own files. Relative to this module, so it works from source (a checkout, in live
 * mode) and from the compiled binary, whose `--include web/static` embeds the directory. Never
 * `Deno.cwd()`.
 */
export const STATIC_ROOT = new URL('./static/', import.meta.url);

/**
 * The page routes: `/` is the whole page; `/sidebar` and `/main` its halves, as pages of their
 * own, `/containers` the sidebar's Containers section alone, and `/host-status` the host status
 * strip alone (devc-desktop draws it across the foot of its window).
 */
const PAGE_ROUTES: Record<string, string> = {
  '/': '/index.html',
  '/sidebar': '/sidebar.html',
  '/main': '/main.html',
  '/containers': '/containers.html',
  '/host-status': '/host-status.html',
};

/** Serves `pathname` (a page route, see {@link PAGE_ROUTES}, or a file) from the directory `root`. */
export async function serveStatic(
  root: URL,
  pathname: string,
  port: number,
): Promise<Response> {
  const path = PAGE_ROUTES[pathname] ?? pathname;
  const type = CONTENT_TYPES[extname(path)];
  if (!staticPathAllowed(path) || type === undefined) {
    return new Response('not found', { status: 404 });
  }
  try {
    const body = await Deno.readFile(new URL(`.${path}`, root));
    return new Response(body, {
      headers: {
        'Content-Type': type,
        ...securityHeaders(port, FRAMABLE_ROUTES.has(pathname)),
      },
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
  /** What this connection may do: see {@link wsRole}. */
  role: WsRole;
  /** This connection's id in the activity log: random, not the token. */
  activityId: string;
}

/** Thrown by {@link startWeb} for a startup failure worth a one-line message. */
export class WebStartError extends Error {}

/** Whether `docker` is on PATH. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await probeDocker();
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

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
 * Throws {@link WebStartError} when the port cannot be bound, or when docker is missing and
 * projects on this machine are off too (`projectStarts` false).
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
    /**
     * `--desktop-channel`'s token, which only devc-desktop's main process holds: it unlocks
     * `/desktop/requests` and `/desktop/project` (see {@link authorize}), and lets the page ask
     * the app (`request_push`, `request_project`). Without it those routes refuse everything.
     */
    desktopToken?: string;
    /**
     * Whether `POST /desktop/project` may start, stop or remove containers (default `true`).
     * Off under `--live-yolo` (its child, and the built-in fallback it swaps in), where the
     * server code itself comes from a checkout agents can write to.
     */
    desktopProjects?: boolean;
  },
): Promise<WebHandle> {
  const staticRoot = opts.staticDir === undefined
    ? STATIC_ROOT
    : toFileUrl(`${opts.staticDir.replace(/\/+$/, '')}/`);
  const projectStarts = opts.projectStarts ?? true;
  const hasDocker = await dockerAvailable();
  // A page agents can write (`--live`) never gets a host shell: no projects on this machine.
  if (!hasDocker && !projectStarts) {
    throw new WebStartError('docker not found on PATH');
  }
  if (!hasDocker) {
    console.error('devc web: docker not found on PATH; devcontainers are off');
  }

  const token = opts.token;
  const desktopToken = opts.desktopToken ?? null;
  const desktopProjects = opts.desktopProjects ?? true;
  // What the page asked devc-desktop to do, until the app dismisses it.
  const desktopRequests = new DesktopRequests();
  const openLink = openRedirect(opts.openNonce, token);
  const previewList = previews();
  const sessions = new Map<string, ContainerSession>();
  // The focused terminal pane the last page to report one named (any client's), for
  // devc-desktop's host terminal. A client closing leaves it.
  let activePane: { container: string; pane_id: string } | null = null;
  // Each running environment's user's home, for its Files node's home row: read once, on the
  // first file request there. `null` when it couldn't be read; not retried.
  const containerHomes = new Map<string, string | null>();
  const clients = new Set<Client>();
  const controllers = new ControllerManager();
  // Language servers for the file editor (`lsp_*`): one session per container, language, root and
  // per-project options, shared by every page; the repos' `language-servers.json` re-read on
  // change, which restarts the sessions it affects.
  const lspConfig = new LspConfigStore({
    watch: (path, onChange) => watchConfigFile(path, onChange),
    onChange: (path) => void lsp.settingsChanged(path),
  });
  const lsp: LspManager = new LspManager({
    idleMs: lspIdleMs(Deno.env),
    config: lspConfig,
  });
  /** The `/sidebar` and `/main` pages' views, and what they relay to each other. */
  const views = new ViewRegistry<Client>();
  const deliver = (out: Delivery<Client>[]) => {
    for (const d of out) d.to.send(JSON.stringify(d.msg));
  };

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
        kind: s.env.kind,
        localFolder: s.record.localFolder,
        name: basename(s.record.localFolder) || s.record.id.slice(0, 12),
        state: s.state,
        ...(s.error !== undefined ? { error: s.error } : {}),
        ...homeField(containerHomes.get(s.record.id)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  });

  // Where projects run: devcontainers when Docker is here, and projects on this machine unless
  // the page is one agents can write (`--live`). Set up below, once the hooks exist.
  let containerSource: ContainerSource | null = null;
  let hostSource: HostSource | null = null;
  const sources = (): EnvironmentSource[] =>
    [containerSource, hostSource].filter((s) => s !== null);
  const available: EnvironmentKind[] = ENVIRONMENT_KINDS.filter((k) =>
    k === 'container' ? hasDocker : projectStarts
  );
  /** Every source's stopped environments. */
  const allStopped = () =>
    sources().flatMap((src) =>
      [...src.stopped().values()].map((r) => ({ ...r, source: src }))
    );
  /** The folders a devcontainer, running or stopped, carries: they run in it (rule 1). */
  const containerFolders = () =>
    new Set([
      ...[...sessions.values()].filter((s) => s.env.kind === 'container')
        .map((s) => s.record.localFolder),
      ...[...(containerSource?.stopped().values() ?? [])].map((r) =>
        r.localFolder
      ),
    ]);
  /** The listed folders that run on this machine: the host source's candidates. */
  const hostCandidates = () => {
    const containers = containerFolders();
    return projectEntries.filter((e) =>
      effectiveEnvironment(e, containers.has(e.localFolder), available) ===
        'host'
    ).map((e) => e.localFolder);
  };

  // Projects: devc's projects list (pinned and recent folders) merged with what discovery knows.
  let projectEntries: ProjectEntry[] = await loadProjects();
  const startingProjects = new Set<string>();
  const projectsMessage = () => ({
    type: 'projects',
    environments: available,
    projects: buildProjects(
      projectEntries,
      [...sessions.values()].map((s) => s.record.localFolder),
      allStopped().map((r) => r.localFolder),
      startingProjects,
      reposByFolder(),
      gitWatch.statuses,
      { containers: containerFolders(), available },
      changesByFolder(),
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

  // The dashboard (`dashboard.json`): one repo file, kept apart from the pins so unpinning never
  // loses it.
  let dashboard: DashboardFile | null = await readDashboard();
  const reloadDashboard = async () => {
    dashboard = await readDashboard();
    broadcast(dashboardMessage(dashboard));
  };

  // The task list (`tasks/tasks.json`), kept in its own file for the same reason as pinned files.
  let taskState: TaskState = await readTasks();
  /** `"jira"` from the global config, for the page's Open in Jira items; null when unset or bad. */
  let jira: JiraConfig | null = null;
  const readJira = async () => {
    try {
      jira = jiraFromConfig(await loadGlobalConfig());
    } catch (e) {
      jira = null;
      console.error(`devc web: ${e instanceof Error ? e.message : e}`);
    }
  };
  await readJira();
  const jiraMessage = () => ({ type: 'jira', jira });
  /** Sends what the repos' task queues have ready; set once the queue runner is (below). */
  let schedulePump = () => {};
  /**
   * Whether this server runs the task queues: only the leader (`leader.ts`) does, or every
   * server would send each queued task. Set once it leads, cleared as it stops.
   */
  let runsQueues = false;
  /**
   * The agents this server started on tasks and that are still at work, by route
   * (`routeKey`), each by `${containerId}\n${paneId}`. A repo's queue sends its next task only
   * once its route has none. `worked`: the agent was seen working (or blocked) since it started,
   * so a `done` or `idle` after that is its end; before that it is still starting up. `seen`: its
   * pane was in a snapshot, so one without it means the pane closed rather than a snapshot taken
   * before the pane was made.
   */
  const taskRuns = new Map<
    string,
    Map<
      string,
      { containerId: string; paneId: string; worked: boolean; seen: boolean }
    >
  >();
  /**
   * Forgets the runs whose pane was in container `id`'s snapshots and no longer is (all, with
   * null: the container stopped).
   */
  const taskRunsSeen = (
    id: string,
    snapshot: Record<string, unknown> | null,
  ) => {
    const live = new Set(snapshot ? snapshotPaneIds(snapshot) : []);
    for (const runs of taskRuns.values()) {
      for (const [k, run] of runs) {
        if (run.containerId !== id) continue;
        if (live.has(run.paneId)) run.seen = true;
        else if (run.seen || snapshot === null) runs.delete(k);
      }
    }
    schedulePump();
  };
  /** Follows a task run's agent status: working or blocked, then done or idle, ends it. */
  const taskRunStatus = (id: string, paneId: string, status: unknown) => {
    const k = `${id}\n${paneId}`;
    for (const runs of taskRuns.values()) {
      const run = runs.get(k);
      if (!run) continue;
      if (status === 'working' || status === 'blocked') run.worked = true;
      else if ((status === 'done' || status === 'idle') && run.worked) {
        runs.delete(k);
        schedulePump();
      }
    }
  };
  const reloadTasks = async () => {
    taskState = await readTasks();
    broadcast(tasksMessage(taskState));
    schedulePump();
  };
  /**
   * As {@link changePinnedFiles}: read → `change` → write, null when nothing changed. Under the
   * tasks lock, which the devc-bridge host also takes to add an agent's task.
   */
  const changeTasks = async (
    change: (state: TaskState) => TaskState | null,
  ): Promise<TaskState | null> => {
    const next = await withTasksLock(async () => {
      const next = change(await readTasks());
      if (next !== null) await writeTasks(next);
      return next;
    });
    if (next === null) return null;
    taskState = await readTasks();
    broadcast(tasksMessage(taskState));
    schedulePump();
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
  // Each environment's repos by id, from its mounts and repo sources (a container's bind mounts,
  // a host project's worktrees), read once per environment: a container's mounts are fixed when
  // it is created.
  const containerRepos = new Map<string, MountedRepo[]>();
  const reposByFolder = () => {
    const byFolder = new Map<string, MountedRepo[]>();
    // A running environment's repos win over a stopped one's for the same folder.
    const records = [
      ...allStopped(),
      ...[...sessions.values()].map((s) => s.record),
    ];
    for (const r of records) {
      const repos = containerRepos.get(r.id);
      if (repos) byFolder.set(r.localFolder, repos);
    }
    return byFolder;
  };
  // An SSH environment would need `mountedRepos`' reads to go through `env.run`: they read
  // the host's FS.
  const loadRepos = async (
    record: Pick<Environment, 'id' | 'localFolder' | 'mounts' | 'repoSources'>,
  ) => {
    if (containerRepos.has(record.id)) return;
    containerRepos.set(record.id, [{
      folder: record.localFolder,
      worktreeOf: null,
      containerFolder: null,
      primaryFolder: null,
    }]);
    const binds = (await record.mounts()).filter((m) => m.type === 'bind');
    const repos = await mountedRepos(
      record.localFolder,
      await record.repoSources(),
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
    void changesWatch.refreshEnvironment(record.id);
    recordPanes(record.id);
  };
  // Every running environment's repos' changes to commit, read there (`git_changes.ts`) on a
  // timer and when one of its agents turns idle or done.
  const changesWatch: GitChangesWatch = new GitChangesWatch({
    targets: () =>
      [...sessions.values()].map((s) => ({
        env: s.env,
        folders: (containerRepos.get(s.record.id) ?? []).map((r) => r.folder),
      })),
    onChange: () => broadcastProjects(),
  });
  /** {@link changesWatch}'s readings by running project folder, for {@link buildProjects}. */
  const changesByFolder = () => {
    const byFolder = new Map<string, ReadonlyMap<string, ChangesReading>>();
    for (const [id, s] of sessions) {
      const readings = changesWatch.readings.get(id);
      if (readings) byFolder.set(s.record.localFolder, readings);
    }
    return byFolder;
  };
  // Every listed repo's push/pull state, read again on a timer and whenever the list changes.
  const gitWatch: GitStatusWatch = new GitStatusWatch({
    folders: () =>
      projectsMessage().projects.flatMap((p) => p.repos.map((r) => r.folder)),
    onChange: () => {
      broadcastProjects();
      recordAllPanes();
    },
  });
  const reloadProjects = async () => {
    projectEntries = await loadProjects();
    broadcastProjects();
    void gitWatch.refresh();
    void hostSource?.refresh().catch(() => {});
  };
  // Each running environment's path map (`Environment.mounts`, cached there).
  const mountsOf = (id: string) =>
    sessions.get(id)?.env.mounts() ?? Promise.resolve([]);
  const loadHome = async (session: ContainerSession) => {
    const id = session.record.id;
    if (containerHomes.has(id)) return;
    containerHomes.set(id, null);
    const home = await session.env.home();
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
  // Each repo's pull request, through its running environment's PR backend (a container's
  // devc-bridge, with grants read from the host-only policy on every message; the host's own
  // recipes), the last listing per repo kept here.
  const prReview = new PrReview({
    isRepo: (localFolder, root) =>
      isProjectRepo(projectsMessage().projects, localFolder, root),
    environment: (localFolder) => {
      const session = [...sessions.values()].find((s) =>
        s.record.localFolder === localFolder
      );
      const kind = session?.env.kind ??
        projectsMessage().projects.find((p) => p.localFolder === localFolder)
          ?.environment ??
        'container';
      return Promise.resolve({
        kind,
        name: basename(localFolder) || localFolder,
        pr: session?.env.pr ?? null,
      });
    },
    home: Deno.env.get('HOME') ?? '.',
  });

  // The activity log (`activity.ts`): what this server observes, as state changes, attributed to
  // each container by its `localFolder`.
  const activity = new ActivityRecorder({
    // Container events once this server leads (below).
    leading: false,
    onError: (e) =>
      console.error(
        `devc web: activity log: ${e instanceof Error ? e.message : e}`,
      ),
  });
  /** A pane of running container `id`, for the log; null when it isn't one. */
  const activityPane = (id: string, pane: Record<string, unknown>) => {
    const session = sessions.get(id);
    if (!session) return null;
    const facts = paneFacts(
      session.record.localFolder,
      pane,
      containerRepos.get(id) ?? [],
      (folder) => {
        const status = gitWatch.statuses.get(folder);
        return status && !isGitProblem(status) ? status.branch : null;
      },
    );
    if (!facts) return null;
    // A pane a sent task started carries the task's session id.
    const sent = taskState.sent.find((t) =>
      t.last?.containerId === id && t.last.paneId === facts.pane
    );
    return sent ? { ...facts, sessionId: sent.sessionId } : facts;
  };
  /** Records container `id`'s panes from its cached snapshot. */
  const recordPanes = (id: string) => {
    const session = sessions.get(id);
    if (!session?.snapshot) return;
    activity.snapshot(
      session.record.localFolder,
      snapshotPanes(session.snapshot).flatMap((p) => {
        const facts = activityPane(id, p as Record<string, unknown>);
        return facts
          ? [{ facts, status: (p as Record<string, unknown>).agent_status }]
          : [];
      }),
    );
  };
  /** Records every running container's panes: a repo's branch or the repo list changed. */
  const recordAllPanes = () => {
    for (const id of sessions.keys()) recordPanes(id);
  };

  const addContainer = (env: Environment) => {
    const id = env.id;
    const record = env;
    const session = new ContainerSession(env, {
      onState: () => {
        broadcast(containersMessage());
        schedulePump();
      },
      onSnapshot: (snapshot) => {
        broadcast({ type: 'snapshot', container: id, snapshot });
        taskRunsSeen(id, snapshot);
        recordPanes(id);
      },
      onPaneUpdated: (pane) => {
        broadcast({ type: 'pane_updated', container: id, pane });
        const facts = activityPane(id, pane);
        if (facts) activity.pane(facts);
      },
      onAgentStatus: (pane_id, agent, agent_status) => {
        broadcast({
          type: 'agent_status',
          container: id,
          pane_id,
          agent,
          agent_status,
        });
        taskRunStatus(id, pane_id, agent_status);
        // An agent that finished a turn has likely changed files.
        if (agent_status === 'idle' || agent_status === 'done') {
          void changesWatch.refreshEnvironment(id);
        }
        // The bridge has patched the pane's agent into the cached snapshot, with no
        // `pane_updated`: its `pane` event (a new or departed agent) comes from there.
        const pane = snapshotPanes(sessions.get(id)?.snapshot ?? null).find((
          p,
        ) => p.pane_id === pane_id);
        const facts = pane ? activityPane(id, pane) : null;
        if (facts) activity.pane(facts);
        if (
          typeof agent_status === 'string' && typeof agent === 'string' &&
          agent !== ''
        ) {
          activity.agentStatus(
            record.localFolder,
            pane_id,
            null,
            agent,
            agent_status,
          );
        }
      },
      onTeardown: (reason) => void controllers.closeContainer(id, reason),
    });
    sessions.set(id, session);
    broadcast(containersMessage());
    broadcastProjects();
    void gitWatch.refresh();
    void changesWatch.refreshEnvironment(id);
    void loadRepos(env);
    void session.run();
    // A container now carries the folder: it no longer runs on this machine.
    if (env.kind === 'container') void hostSource?.refresh().catch(() => {});
  };

  const removeContainer = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    containerHomes.delete(id);
    sessionLists.delete(id);
    for (const key of resumedPanes.keys()) {
      if (key.startsWith(`${id}\n`)) resumedPanes.delete(key);
    }
    taskRunsSeen(id, null);
    activity.containerGone(session.record.localFolder);
    void controllers.closeContainer(id, 'container stopped');
    lsp.containerGone(id);
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

  containerSource = hasDocker ? new ContainerSource(opts.session) : null;
  hostSource = projectStarts
    ? new HostSource({ session: opts.session, candidates: hostCandidates })
    : null;
  const sourceHooks = (source: EnvironmentSource) => ({
    onAdd: addContainer,
    onRemove: removeContainer,
    onStoppedChange: () => {
      broadcastProjects();
      void gitWatch.refresh();
      for (const r of source.stopped().values()) {
        void loadRepos(source.environment(r));
      }
      // A stopped container carries its folder too (rule 1).
      if (source.kind === 'container') {
        void hostSource?.refresh().catch(() => {});
      }
    },
    onLaunch: (id: string) => void sessions.get(id)?.herdrLaunched(),
    onError: (m: string) => console.error(`devc web: ${m}`),
  });
  /** The source that runs project `folder`: its effective environment's, if this server has it. */
  const projectSource = (folder: string) => {
    const kind =
      projectsMessage().projects.find((p) => p.localFolder === folder)
        ?.environment ?? effectiveEnvironment(
          undefined,
          containerFolders().has(folder),
          available,
        );
    return { kind, source: kind === 'host' ? hostSource : containerSource };
  };

  /** Where a session's environment is, in a message: `in this container`, `on this machine`. */
  const placeOf = (session: ContainerSession) =>
    session.env.kind === 'host' ? 'on this machine' : 'in this container';

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
      {
        type:
          | 'list_dir'
          | 'find_files'
          | 'list_host_dir'
          | 'read_file'
          | 'preview_file';
      }
    >,
  ) => {
    if (
      msg.type === 'list_dir' || msg.type === 'find_files' ||
      msg.type === 'read_file' || msg.type === 'preview_file'
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
      if (msg.type === 'find_files') {
        try {
          const result = await listRepoFiles(msg.root);
          reply(c, { id: msg.id, ok: true, result });
        } catch (e) {
          failFiles(c, msg.id, e);
        }
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
    const refusal = projectRefusal(msg, c.role, {
      startsAllowed: projectStarts,
      desktopProjects,
    });
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

  /** Each repo folder's last `fetch_repo` start, for its rate limit. */
  const fetchStarts = new Map<string, number>();
  /** Each repo folder's last `pull_repo` start, for its rate limit. */
  const pullStarts = new Map<string, number>();

  /**
   * The running session and in-environment path of a project's repo (`fetch_repo`,
   * `pull_repo`), or why there is none.
   */
  const repoTarget = async (
    msg: { localFolder: string; folder: string },
  ): Promise<{ session: ContainerSession; path: string } | GitProblem> => {
    if (
      !isProjectRepo(projectsMessage().projects, msg.localFolder, msg.folder)
    ) {
      return { problem: 'unknown repo' };
    }
    const session = [...sessions.values()].find((s) =>
      s.record.localFolder === msg.localFolder
    );
    if (!session) return { problem: 'not running' };
    const path = hostToContainerPath(
      msg.folder,
      await mountsOf(session.record.id),
    );
    if (path === null) {
      return { problem: `the repo is not ${placeOf(session)}` };
    }
    return { session, path };
  };

  /** Whether `starts` allows a new start for `folder` now; records it when it does. */
  const startAllowed = (starts: Map<string, number>, folder: string) => {
    const last = starts.get(folder);
    if (last !== undefined && Date.now() - last < FETCH_INTERVAL_MS) {
      return false;
    }
    starts.set(folder, Date.now());
    return true;
  };

  /**
   * Fetches a repo of a running project (`git_fetch.ts`) and answers the requester with
   * `fetch_result`. Allowed under `--live`: it publishes nothing, and runs nothing on the host but
   * git in a mirror. One start per folder per {@link FETCH_INTERVAL_MS}; a request while one runs
   * shares its outcome.
   */
  const fetchRepoFor = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'fetch_repo' }>,
  ) => {
    const answer = (
      o: { ok: true; updated: boolean } | { ok: false; problem: string },
    ) =>
      c.send(
        JSON.stringify({
          type: 'fetch_result',
          id: msg.id,
          folder: msg.folder,
          ...o,
        }),
      );
    const at = await repoTarget(msg);
    if (isGitProblem(at)) {
      answer({ ok: false, problem: at.problem });
      return;
    }
    if (!fetchRunning(msg.folder) && !startAllowed(fetchStarts, msg.folder)) {
      answer({ ok: false, problem: 'fetched moments ago: try again soon' });
      return;
    }
    const outcome = await fetchRepo(at.session.env, msg.folder, at.path);
    answer(outcome);
    // Its Fetch goes once the repo's own remote-tracking ref has the mirror's commits (read
    // again even when this fetch found it already had them). Its changes to commit stay: a
    // fetch touches no working tree.
    if (outcome.ok) void gitWatch.refresh();
  };

  /**
   * Pulls a repo of a running project (`git_fetch.ts`'s `pullRepo`: a Fetch, then a fast-forward)
   * and answers the requester with `pull_result`. Refused while an agent there is working or
   * blocked, and unless the last status is behind and not ahead: checked here, not only in the
   * page, whose code comes from a checkout agents can edit under `--live`. Allowed under `--live`:
   * it only fast-forwards a listed repo to its own upstream. Rate-limited as fetches are.
   */
  const pullRepoFor = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'pull_repo' }>,
  ) => {
    const answer = (
      o: { ok: true; updated: boolean } | { ok: false; problem: string },
    ) =>
      c.send(
        JSON.stringify({
          type: 'pull_result',
          id: msg.id,
          folder: msg.folder,
          ...o,
        }),
      );
    const at = await repoTarget(msg);
    if (isGitProblem(at)) {
      answer({ ok: false, problem: at.problem });
      return;
    }
    const panes = snapshotPanes(at.session.snapshot) as {
      agent_status?: unknown;
    }[];
    if (
      panes.some((p) =>
        p.agent_status === 'working' || p.agent_status === 'blocked'
      )
    ) {
      answer({
        ok: false,
        problem: 'an agent is working in this project: pull when it is idle',
      });
      return;
    }
    const status = gitWatch.statuses.get(msg.folder);
    if (!status || isGitProblem(status)) {
      answer({ ok: false, problem: 'git status unknown: try again soon' });
      return;
    }
    if (status.ahead > 0) {
      answer({
        ok: false,
        problem: 'diverged: merge or rebase in the project',
      });
      return;
    }
    if (status.behind === 0) {
      answer({ ok: false, problem: 'nothing to pull' });
      return;
    }
    if (!pullRunning(msg.folder) && !startAllowed(pullStarts, msg.folder)) {
      answer({ ok: false, problem: 'pulled moments ago: try again soon' });
      return;
    }
    const outcome = await pullRepo(at.session.env, msg.folder, at.path);
    answer(outcome);
    // Its marks, and its changes to commit: a pull moves the working tree.
    if (outcome.ok) {
      void gitWatch.refresh();
      void changesWatch.refreshEnvironment(at.session.record.id);
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
      const result = await session.env.files.create(path, msg.kind);
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
      const result = msg.type === 'rename_file'
        ? await session.env.files.rename(
          path,
          `${dirnamePosix(path) === '/' ? '' : dirnamePosix(path)}/${msg.to}`,
        )
        : await session.env.files.delete(path);
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
      const result = await session.env.files.writeText(
        path,
        msg.text,
        msg.base,
      );
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
    }
  };

  /**
   * The file an `lsp_attach`, `lsp_settings_get` or `lsp_settings_set` names, as the language
   * servers take it: with `root`, a file in that repo folder (confined and mounted, as
   * `write_file`'s); without, a container path. Null once refused.
   */
  const lspTarget = async (
    c: Client,
    session: ContainerSession,
    msg: { id: string; root?: string; path: string },
  ): Promise<LspTarget | null> => {
    const path = msg.root === undefined
      ? msg.path
      : await repoContainerPath(c, session, {
        id: msg.id,
        root: msg.root,
        path: msg.path,
      });
    if (path === null) return null;
    const hostPath = msg.root === undefined
      ? null
      : await confine(msg.root, msg.path).catch(() => null);
    return {
      env: session.env,
      mounts: await session.env.mounts(),
      path,
      ...(msg.root !== undefined && hostPath
        ? { repo: { folder: msg.root, hostPath } }
        : {}),
    };
  };

  /**
   * The language server messages that name a file: `lsp_attach` (start or reuse its session and
   * attach this connection), `lsp_settings_get` and `lsp_settings_set`. Only a connected
   * container's files: an editable tile's.
   */
  const handleLsp = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<
      ClientMessage,
      { type: 'lsp_attach' | 'lsp_settings_get' | 'lsp_settings_set' }
    >,
  ) => {
    if (session.state !== 'connected') {
      fail(c, msg.id, 'not_connected', 'the container is not connected');
      return;
    }
    try {
      const target = await lspTarget(c, session, msg);
      if (target === null) return;
      let result: unknown = {};
      if (msg.type === 'lsp_settings_set') {
        await lsp.settingsSet(target, msg.entry);
      } else if (msg.type === 'lsp_attach') {
        result = await lsp.attach(c, target);
      } else result = await lsp.settingsGet(target);
      reply(c, { id: msg.id, ok: true, result });
    } catch (e) {
      fail(c, msg.id, e instanceof LspError ? e.code : 'describe_failed', e);
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
      const files = session.env.files;
      void loadHome(session);
      if (msg.type === 'preview_container_file') {
        const read: PreviewRead = (path, max) =>
          files.readBytes(`/${path}`, max);
        await files.readBytes(msg.path, MAX_PREVIEW_BYTES);
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
          await files.list(msg.path),
          msg.path,
          await session.env.mounts(),
        )
        : await files.read(msg.path);
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
        `${command} isn't installed ${placeOf(session)}`,
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
   * Whether `file` is a file in one of a listed project's repos; if not, the request `id` is
   * refused (`bad_request`, `not_found` or `forbidden`). What `pin_file` and `set_dashboard` take.
   */
  const checkRepoFile = async (
    c: Client,
    id: string,
    file: { localFolder: string; root: string; path: string },
  ): Promise<boolean> => {
    if (
      !isListedProject(file.localFolder) ||
      !isProjectRepo(projectsMessage().projects, file.localFolder, file.root)
    ) {
      reject(c, {
        id,
        code: 'bad_request',
        message: isListedProject(file.localFolder)
          ? 'unknown repo'
          : 'unknown project',
      });
      return false;
    }
    let hostPath: string | null;
    try {
      hostPath = await confine(file.root, file.path);
    } catch {
      fail(c, id, 'not_found', `${file.path} does not exist`);
      return false;
    }
    if (hostPath === null) {
      fail(c, id, 'forbidden', `${file.path} is outside the project`);
      return false;
    }
    if (!(await Deno.stat(hostPath).catch(() => null))?.isFile) {
      fail(c, id, 'bad_request', `${file.path} is not a file`);
      return false;
    }
    return true;
  };

  /** Makes a repo file the dashboard, or clears it (`file: null`); every client is told. */
  const setDashboard = async (
    c: Client,
    msg: Extract<ClientMessage, { type: 'set_dashboard' }>,
  ) => {
    if (msg.file && !(await checkRepoFile(c, msg.id, msg.file))) return;
    try {
      await writeDashboard(msg.file);
    } catch (e) {
      fail(c, msg.id, 'dashboard_error', e);
      return;
    }
    dashboard = msg.file;
    broadcast(dashboardMessage(dashboard));
    reply(c, { id: msg.id, ok: true, result: {} });
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
      if (!(await checkRepoFile(c, msg.id, msg))) return;
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
   * The task list: add, edit, delete and restore change `tasks/tasks.json` only. `send_task` writes the
   * task's text into its project's container, starts the agent on it in a new tab with a session
   * id chosen here, and moves the task to `sent`. `open_sent` answers with that agent's pane while
   * it is still in the session, else resumes the session in a new tab. `queue_tasks` and
   * `unqueue_task` put tasks in their repo's queue and take them out; the queue runner
   * (`pumpQueues`) sends them, with `queued` set. Nothing a container says is written to the
   * list.
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
          | 'queue_tasks'
          | 'unqueue_task'
          | 'send_task'
          | 'open_sent';
      }
    >,
    queued = false,
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
      notFound = 'no such task',
    ) => {
      let changed: TaskState | null;
      try {
        changed = await changeTasks(apply);
      } catch (e) {
        fail(c, msg.id, 'tasks_error', e);
        return;
      }
      if (changed === null) {
        fail(c, msg.id, 'not_found', notFound);
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
    if (msg.type === 'queue_tasks') {
      const how = { action: msg.action, agent: msg.agent };
      await change(
        (state) => queueTasks(state, msg.tasks, how, new Date()),
        {},
        'no routed task to queue',
      );
      return;
    }
    if (msg.type === 'unqueue_task') {
      await change((state) => unqueueTask(state, msg.task), {}, 'not queued');
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
        `${AGENT_COMMANDS[agent]} isn't installed ${placeOf(session)}`,
      );
      return;
    }
    const sessionId = sent?.sessionId ?? crypto.randomUUID();
    let command: string;
    if (msg.type === 'send_task') {
      try {
        await session.env.files.write(
          TASK_FILE_DIR,
          taskFilePath(sessionId),
          `${task.text}\n`,
        );
      } catch (e) {
        fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
        return;
      }
      command = startTaskCommand(
        agent,
        sessionId,
        msg.action,
        taskTitle(task.text),
        queued,
      );
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
    if (msg.type === 'send_task') {
      const key = routeKey({ localFolder: msg.localFolder, root: msg.root });
      const runs = taskRuns.get(key) ?? new Map();
      runs.set(`${containerId}\n${created.pane_id}`, {
        ...last,
        worked: false,
        seen: false,
      });
      taskRuns.set(key, runs);
    }
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
   * Whether a route has an agent at work on a task: one this server started (`taskRuns`), else,
   * after a restart, a sent task's pane there still working or blocked, which is then adopted.
   */
  const routeBusy = (key: string, localFolder: string, root: string) => {
    const runs = taskRuns.get(key);
    if (runs?.size) return true;
    const session = [...sessions.values()].find((s) =>
      s.record.localFolder === localFolder
    );
    if (!session) return false;
    const panes = snapshotPanes(session.snapshot) as {
      pane_id?: unknown;
      agent_status?: unknown;
    }[];
    for (const t of taskState.sent) {
      if (t.localFolder !== localFolder || t.root !== root) continue;
      if (t.last?.containerId !== session.record.id) continue;
      const pane = panes.find((p) => p.pane_id === t.last!.paneId);
      if (
        pane?.agent_status !== 'working' && pane?.agent_status !== 'blocked'
      ) {
        continue;
      }
      taskRuns.set(
        key,
        new Map([[`${t.last.containerId}\n${t.last.paneId}`, {
          ...t.last,
          worked: true,
          seen: true,
        }]]),
      );
      return true;
    }
    return false;
  };

  /** Routes with a queued task being sent, or a queued run's outcome being read, now. */
  const dispatching = new Set<string>();
  /**
   * The last task each route's queue sent, by route, until its agent stops and the outcome it
   * wrote (`taskResultPath`) is read: anything but ok halts the queue on its next task. Kept in
   * memory only: a run this server didn't send is never checked.
   */
  const queuedRuns = new Map<
    string,
    { localFolder: string; sessionId: string; title: string }
  >();

  /**
   * Sends queued task `task` as `send_task` would. A container that stopped or whose Herdr is
   * still connecting leaves it queued for the next try; any other failure halts its queue on it.
   */
  const dispatchQueued = async (task: Task, key: string) => {
    const { localFolder, root, queued } = task;
    if (localFolder === undefined || root === undefined || !queued) return;
    dispatching.add(key);
    let answer: { ok?: boolean; error?: { code: string; message: string } } =
      {};
    // Answers go here, not to a page.
    const sink = {
      send: (text: string) => answer = JSON.parse(text),
    } as unknown as Client;
    try {
      await handleTask(sink, {
        type: 'send_task',
        id: 'queue',
        task: task.id,
        localFolder,
        root,
        agent: queued.agent,
        action: queued.action,
      }, true);
      const code = answer.error?.code;
      if (answer.ok) {
        const sent = taskState.sent.find((t) => t.id === task.id);
        if (sent) {
          queuedRuns.set(key, {
            localFolder,
            sessionId: sent.sessionId,
            title: taskTitle(task.text),
          });
        }
        return;
      }
      if (code === 'not_running' || code === 'not_ready') return;
      const message = answer.error?.message ?? 'send failed';
      console.error(`devc web: queued task ${task.id}: ${message}`);
      await changeTasks((state) => queueFailed(state, task.id, message));
    } catch (e) {
      console.error(`devc web: ${e instanceof Error ? e.message : e}`);
    } finally {
      dispatching.delete(key);
    }
  };

  /**
   * Reads the outcome queued run `run` wrote once its agent stopped. Not ok (or none written)
   * halts route `key`'s queue on its next task, saying why; the run's own task is already sent.
   */
  const checkQueuedRun = async (
    key: string,
    run: { localFolder: string; sessionId: string; title: string },
    session: ContainerSession,
  ) => {
    dispatching.add(key);
    try {
      let outcome: ReturnType<typeof taskOutcome>;
      try {
        const bytes = await session.env.files.readBytes(
          taskResultPath(run.sessionId),
          4096,
        );
        outcome = taskOutcome(new TextDecoder().decode(bytes));
      } catch {
        outcome = { ok: false, reason: 'it wrote no outcome' };
      }
      if (outcome.ok) return;
      const next = queueHeads(taskState).find((t) =>
        t.localFolder !== undefined && t.root !== undefined &&
        routeKey({ localFolder: t.localFolder, root: t.root }) === key
      );
      if (!next) return;
      const message = `queue stopped: “${run.title}” did not succeed: ` +
        outcome.reason;
      console.error(`devc web: queued task ${next.id}: ${message}`);
      await changeTasks((state) => queueFailed(state, next.id, message));
    } catch (e) {
      console.error(`devc web: ${e instanceof Error ? e.message : e}`);
    } finally {
      dispatching.delete(key);
      schedulePump();
    }
  };

  /**
   * Each repo's queue sends its next task once nothing runs there, its container runs and the
   * task it sent before reported success; the queues of different repos run side by side.
   */
  const pumpQueues = () => {
    if (!runsQueues) return;
    const runningSession = (localFolder: string) => {
      const session = [...sessions.values()].find((s) =>
        s.record.localFolder === localFolder
      );
      return session?.state === 'connected' || session?.state === 'no-session'
        ? session
        : null;
    };
    for (const [key, run] of queuedRuns) {
      if (dispatching.has(key) || taskRuns.get(key)?.size) continue;
      const session = runningSession(run.localFolder);
      if (session === null) continue;
      queuedRuns.delete(key);
      void checkQueuedRun(key, run, session);
    }
    for (const head of queueHeads(taskState)) {
      const { localFolder, root } = head;
      if (localFolder === undefined || root === undefined) continue;
      const key = routeKey({ localFolder, root });
      if (dispatching.has(key) || queuedRuns.has(key)) continue;
      if (routeBusy(key, localFolder, root)) continue;
      if (runningSession(localFolder) === null) continue;
      void dispatchQueued(head, key);
    }
  };
  let pumpScheduled = false;
  schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pumpQueues();
    });
  };
  schedulePump();

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
          session.env,
          repos,
          session.session,
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
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    const reused = await sessionPane(session, listed);
    if (reused !== null) {
      reply(c, { id: msg.id, ok: true, result: { ...reused, reused: true } });
      return;
    }
    if (!(await commandInstalled(target, AGENT_COMMANDS[listed.agent]))) {
      fail(
        c,
        msg.id,
        'not_installed',
        `${AGENT_COMMANDS[listed.agent]} isn't installed ${placeOf(session)}`,
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
    resumedPanes.set(resumedKey(containerId, listed), {
      containerId,
      paneId: created.pane_id,
    });
    reply(c, { id: msg.id, ok: true, result: { ...created, reused: false } });
  };

  const resumedKey = (containerId: string, listed: AgentSession) =>
    `${containerId}\n${listed.agent}\n${listed.session}`;

  /**
   * The pane a listed session runs in: the one this server resumed it in, else one a live agent
   * process has it open in (started by hand, or before this server); null when neither is in the
   * container's session. Never a second process on the same session.
   */
  const sessionPane = async (
    session: ContainerSession,
    listed: AgentSession,
  ): Promise<{ pane_id: string; tab_id: string } | null> => {
    const containerId = session.record.id;
    const panes = snapshotPanes(session.snapshot);
    const live = listed.agent === 'claude'
      ? await runningPane(session.env, listed.session, session.session)
      : null;
    return reusablePinnedPane(
      resumedPanes.get(resumedKey(containerId, listed)),
      containerId,
      panes,
    ) ?? reusablePinnedPane(
      live === null ? undefined : { containerId, paneId: live },
      containerId,
      panes,
    );
  };

  /**
   * A question for an agent about a file of one of the container's project's repos (`ask_agent`),
   * answered with the agent's pane. An agent running in a pane (`pane_id`, or the pane a listed
   * session runs in, see {@link sessionPane}) is prompted with the text through Herdr's
   * `agent.prompt`; otherwise the text is written to a file and the listed session is resumed on
   * it (at the folder it started in), or a new session of `agent` is started on it at the repo.
   */
  const askAgent = async (
    c: Client,
    session: ContainerSession,
    msg: Extract<ClientMessage, { type: 'ask_agent' }>,
  ) => {
    const containerId = session.record.id;
    const projects = projectsMessage().projects;
    if (!isProjectRepo(projects, session.record.localFolder, msg.root)) {
      fail(c, msg.id, 'bad_request', 'unknown repo');
      return;
    }
    const listed = msg.session === undefined
      ? undefined
      : sessionLists.get(containerId)?.find((s) =>
        s.agent === msg.agent && s.session === msg.session
      );
    if (msg.session !== undefined && !listed) {
      fail(c, msg.id, 'not_found', 'no such session');
      return;
    }
    const target = await readyTarget(c, session, msg.id);
    if (target === null) return;
    let running: { pane_id: string; tab_id: string } | null = null;
    if (msg.pane_id !== undefined) {
      const pane = snapshotPanes(session.snapshot).find((p) =>
        p.pane_id === msg.pane_id
      ) as { pane_id: string; tab_id?: unknown; agent?: unknown } | undefined;
      if (!pane) {
        fail(c, msg.id, 'not_found', 'that terminal is gone');
        return;
      }
      if (typeof pane.agent !== 'string' || pane.agent === '') {
        fail(c, msg.id, 'bad_request', 'no agent runs in that terminal');
        return;
      }
      running = {
        pane_id: pane.pane_id,
        tab_id: typeof pane.tab_id === 'string' ? pane.tab_id : '',
      };
    } else if (listed) {
      running = await sessionPane(session, listed);
    }
    if (running !== null) {
      try {
        await bridgeRequest(target, 'agent.prompt', {
          target: running.pane_id,
          text: msg.text,
        });
      } catch (e) {
        fail(c, msg.id, e instanceof BridgeError ? e.code : 'herdr_error', e);
        return;
      }
      reply(c, { id: msg.id, ok: true, result: { ...running, reused: true } });
      return;
    }
    const agent = listed?.agent ?? msg.agent!;
    const cwd = listed ? listed.cwd : await repoContainerPath(
      c,
      session,
      { id: msg.id, root: msg.root, path: '' },
      'dir',
    );
    if (cwd === null) return;
    if (!(await commandInstalled(target, AGENT_COMMANDS[agent]))) {
      fail(
        c,
        msg.id,
        'not_installed',
        `${AGENT_COMMANDS[agent]} isn't installed ${placeOf(session)}`,
      );
      return;
    }
    const askId = crypto.randomUUID();
    try {
      await session.env.files.write(
        TASK_FILE_DIR,
        taskFilePath(askId),
        `${msg.text}\n`,
      );
    } catch (e) {
      fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
      return;
    }
    const sessionId = listed?.session ?? crypto.randomUUID();
    const title = listed?.title ?? taskTitle(msg.text);
    const command = listed
      ? resumeAskCommand(agent, sessionId, askId)
      : startAskCommand(agent, sessionId, askId, title);
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
    // The agent is already starting, so a failed rename is no error.
    await bridgeRequest(target, 'pane.rename', {
      pane_id: created.pane_id,
      label: title,
    }).then((r) => renamed(session, r), () => {});
    if (listed) {
      resumedPanes.set(resumedKey(containerId, listed), {
        containerId,
        paneId: created.pane_id,
      });
    }
    reply(c, { id: msg.id, ok: true, result: { ...created, reused: false } });
  };

  /** A repo's pull request (`pr_files` … `pr_pending_discard`, see `pr_review.ts`). */
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

  /**
   * Starts, stops or removes a project's container (or starts or stops a project on this
   * machine), its start's output lines broadcast as `project_output`: the page's
   * `start_project` / `stop_project` / `down_project`, and devc-desktop's confirmed
   * `POST /desktop/project`. Throws a {@link ProjectActionError} when it can't.
   */
  const projectAction = async (
    action: 'start' | 'stop' | 'down',
    folder: string,
    onLine?: (line: string) => void,
  ): Promise<Record<string, unknown>> => {
    if (action !== 'stop' && !isListedProject(folder)) {
      throw new ProjectActionError('bad_request', 'unknown project');
    }
    const { kind, source } = projectSource(folder);
    if (action === 'stop') {
      try {
        return {
          stopped: source === null ? false : await source.stopProject(folder),
        };
      } catch (e) {
        throw new ProjectActionError('stop_failed', errorText(e));
      }
    }
    if (action === 'down') {
      if (kind === 'host') {
        throw new ProjectActionError(
          'bad_request',
          'host projects have no container to remove',
        );
      }
      try {
        return {
          removed: await containerSource?.downProject(folder) ?? false,
        };
      } catch (e) {
        throw new ProjectActionError('down_failed', errorText(e));
      } finally {
        await reloadProjects();
      }
    }
    if (startingProjects.has(folder)) {
      throw new ProjectActionError(
        'already_starting',
        `${folder} is already starting`,
      );
    }
    if (source === null) {
      throw new ProjectActionError(
        'bad_request',
        'this server cannot start it',
      );
    }
    startingProjects.add(folder);
    broadcastProjects();
    try {
      await source.startProject(
        folder,
        (line) => {
          broadcast({ type: 'project_output', localFolder: folder, line });
          onLine?.(line);
        },
      );
      return {};
    } catch (e) {
      throw new ProjectActionError('start_failed', errorText(e));
    } finally {
      startingProjects.delete(folder);
      await reloadProjects();
    }
  };

  /**
   * The page asking devc-desktop to push a repo or start, stop or remove a project's container
   * (`request_push`, `request_project`). Nothing runs here: the request waits for the app's
   * `GET /desktop/requests`, the app works it out itself and the user confirms it in its HOST
   * drawer. Answered at once, `asked devc-desktop…` or why not (no `--desktop-channel`, a folder
   * that isn't the project's, the queue's limits).
   */
  const askDesktop = (
    c: Client,
    msg: Extract<
      ClientMessage,
      { type: 'request_push' } | { type: 'request_project' }
    >,
  ) => {
    if (desktopToken === null) {
      fail(c, msg.id, 'needs_desktop', 'needs devc-desktop');
      return;
    }
    const known = msg.type === 'request_push'
      ? isProjectRepo(projectsMessage().projects, msg.localFolder, msg.folder)
      : isListedProject(msg.localFolder);
    if (!known) {
      fail(c, msg.id, 'bad_request', 'unknown folder');
      return;
    }
    if (msg.type === 'request_project' && !desktopProjects) {
      fail(
        c,
        msg.id,
        'not_allowed',
        'devc-desktop starts no containers under --live-yolo',
      );
      return;
    }
    const kind: DesktopRequestKind = msg.type === 'request_push'
      ? 'push'
      : msg.action;
    const added = desktopRequests.add(
      kind,
      msg.localFolder,
      msg.type === 'request_push' ? msg.folder : null,
    );
    if (added.ok) {
      reply(c, { id: msg.id, ok: true, result: { message: ASKED } });
    } else fail(c, msg.id, 'not_allowed', added.problem);
  };

  /** The messages about projects, which name a folder rather than a running container. */
  const handleProject = async (
    c: Client,
    msg: Exclude<
      Extract<ClientMessage, { localFolder: string }>,
      { type: 'list_dir' | 'find_files' | 'read_file' | 'preview_file' }
    >,
  ) => {
    const folder = msg.localFolder;
    const refusal = projectRefusal(msg, c.role, {
      startsAllowed: projectStarts,
      desktopProjects,
    });
    if (refusal !== null) {
      fail(c, msg.id, 'not_allowed', refusal);
      return;
    }
    switch (msg.type) {
      case 'start_project':
      case 'stop_project':
      case 'down_project': {
        const action = msg.type === 'start_project'
          ? 'start'
          : msg.type === 'stop_project'
          ? 'stop'
          : 'down';
        try {
          const result = await projectAction(action, folder);
          reply(c, { id: msg.id, ok: true, result });
        } catch (e) {
          fail(
            c,
            msg.id,
            e instanceof ProjectActionError ? e.code : `${action}_failed`,
            e,
          );
        }
        return;
      }
      case 'set_project_environment': {
        if (!isListedProject(folder)) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: 'unknown project',
          });
          return;
        }
        if (containerFolders().has(folder)) {
          fail(
            c,
            msg.id,
            'has_container',
            `${folder} has a container; remove it first`,
          );
          return;
        }
        if (!available.includes(msg.environment)) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: `this server cannot run projects in ${msg.environment}`,
          });
          return;
        }
        try {
          projectEntries = await updateProjects((list) =>
            setEnvironment(list, folder, msg.environment)
          );
          broadcastProjects();
          void hostSource?.refresh().catch(() => {});
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(c, msg.id, 'projects_error', e);
        }
        return;
      }
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
        if (
          msg.environment !== undefined && !available.includes(msg.environment)
        ) {
          reject(c, {
            id: msg.id,
            code: 'bad_request',
            message: `this server cannot run projects in ${msg.environment}`,
          });
          return;
        }
        try {
          projectEntries = await updateProjects((list) =>
            addProject(list, folder, msg.environment)
          );
          broadcastProjects();
          void hostSource?.refresh().catch(() => {});
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(c, msg.id, 'projects_error', e);
        }
        return;
      }
      case 'remove_project':
        // A container would keep listing it, and a running session would lose its row.
        if (containerFolders().has(folder)) {
          fail(
            c,
            msg.id,
            'has_container',
            `${folder} has a container; remove it first`,
          );
          return;
        }
        if (
          [...sessions.values()].some((s) => s.record.localFolder === folder)
        ) {
          fail(c, msg.id, 'running', `${folder} is running; stop it first`);
          return;
        }
        try {
          projectEntries = await updateProjects((list) =>
            removeProject(list, folder)
          );
          broadcastProjects();
          void hostSource?.refresh().catch(() => {});
          reply(c, { id: msg.id, ok: true, result: {} });
        } catch (e) {
          fail(c, msg.id, 'projects_error', e);
        }
        return;
    }
  };

  /**
   * Focuses a page's active pane in its container's Herdr, which marks its agent's finished turn
   * seen: `done` becomes `idle`, and a turn it finishes while still focused ends `idle`. Moves
   * the focus of a Herdr TUI attached to the session too. A pane not in the snapshot, or a
   * failed request, is left alone.
   */
  const focusPane = async (container: string, paneId: string) => {
    const session = sessions.get(container);
    const target = session?.target;
    if (!target || !session.snapshot) return;
    if (!snapshotPaneIds(session.snapshot).includes(paneId)) return;
    await bridgeRequest(target, 'pane.focus', { pane_id: paneId })
      .catch(() => {});
  };

  const handle = async (c: Client, msg: ClientMessage) => {
    switch (msg.type) {
      case 'view_join':
        deliver(views.join(c, msg.view, msg.role));
        return;
      case 'view_state':
        deliver(views.state(c, msg.view, msg.state));
        return;
      case 'view_intent':
        deliver(views.viewIntent(c, msg.view, msg.name, msg.args));
        return;
      case 'sidebar_intent':
        deliver(views.sidebarIntent(c, msg.view, msg.name, msg.args));
        return;
      case 'containers_intent':
        deliver(views.containersIntent(c, msg.view, msg.name, msg.args));
        return;
      case 'inuse_intent':
        deliver(views.inUseIntent(c, msg.view, msg.name, msg.args));
        return;
    }
    if (msg.type === 'active_pane') {
      activePane = 'container' in msg
        ? { container: msg.container, pane_id: msg.pane_id }
        : null;
      if ('container' in msg) void focusPane(msg.container, msg.pane_id);
      const folder = 'container' in msg
        ? sessions.get(msg.container)?.record.localFolder
        : undefined;
      activity.focus(c.activityId, {
        active: 'container' in msg && folder
          ? { container: folder, pane: msg.pane_id }
          : null,
      });
      return;
    }
    if (msg.type === 'page_state') {
      activity.focus(c.activityId, {
        visible: msg.visible,
        focused: msg.focused,
      });
      return;
    }
    if (msg.type === 'client_ready') {
      await liveStatic?.clientReady(msg.generation);
      return;
    }
    if (msg.type === 'refresh_containers') {
      try {
        await Promise.all(sources().map((s) => s.refresh()));
        await reloadProjects();
        reply(c, { id: msg.id, ok: true, result: {} });
      } catch (e) {
        fail(c, msg.id, 'refresh_failed', e);
      }
      return;
    }
    if (
      msg.type === 'list_dir' || msg.type === 'find_files' ||
      msg.type === 'list_host_dir' || msg.type === 'read_file' ||
      msg.type === 'preview_file'
    ) {
      await handleListing(c, msg);
      return;
    }
    if (msg.type === 'request_push' || msg.type === 'request_project') {
      askDesktop(c, msg);
      return;
    }
    if (msg.type === 'fetch_repo') {
      await fetchRepoFor(c, msg);
      return;
    }
    if (msg.type === 'pull_repo') {
      await pullRepoFor(c, msg);
      return;
    }
    if (
      msg.type === 'pin_file' || msg.type === 'unpin_file' ||
      msg.type === 'rename_pin' || msg.type === 'open_pinned'
    ) {
      await handleFilePin(c, msg);
      return;
    }
    if (msg.type === 'set_dashboard') {
      await setDashboard(c, msg);
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
      msg.type === 'queue_tasks' || msg.type === 'unqueue_task' ||
      msg.type === 'send_task' || msg.type === 'open_sent'
    ) {
      await handleTask(c, msg);
      return;
    }
    // Before the `localFolder` check: these name a repo of a project, and need its container.
    if ((PR_MESSAGE_TYPES as readonly string[]).includes(msg.type)) {
      await handlePr(
        c,
        msg as Extract<ClientMessage, { type: PrMessage['type'] }>,
      );
      return;
    }
    // Language server messages that name a session, not a container.
    if (msg.type === 'lsp_send') {
      lsp.send(c, msg.session, msg.message);
      return;
    }
    if (msg.type === 'lsp_detach') {
      lsp.detach(c, msg.session);
      return;
    }
    if (msg.type === 'lsp_restart') {
      try {
        await lsp.restart(msg.session);
        reply(c, { id: msg.id, ok: true, result: {} });
      } catch (e) {
        fail(c, msg.id, e instanceof LspError ? e.code : 'start_failed', e);
      }
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
        msg.type === 'delete_file' || msg.type === 'write_file' ||
        msg.type === 'ask_agent' || msg.type === 'attach_image'
      ) {
        fail(c, msg.id, 'not_running', 'the container is not running');
        return;
      }
      if (
        msg.type === 'lsp_attach' || msg.type === 'lsp_settings_get' ||
        msg.type === 'lsp_settings_set'
      ) {
        fail(c, msg.id, 'not_connected', 'the container is not running');
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
      case 'ask_agent':
        await askAgent(c, session, msg);
        return;
      case 'create_file':
        await createFile(c, session, msg);
        return;
      case 'write_file':
        await writeFile(c, session, msg);
        return;
      case 'attach_image':
        try {
          reply(c, {
            id: msg.id,
            ok: true,
            result: await attachImage(session.env, msg),
          });
        } catch (e) {
          fail(c, msg.id, e instanceof FilesError ? e.code : 'write_failed', e);
        }
        return;
      case 'lsp_attach':
      case 'lsp_settings_get':
      case 'lsp_settings_set':
        await handleLsp(c, session, msg);
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
        activity.input(c.activityId, session.record.localFolder, msg.pane_id);
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
        activity.input(c.activityId, session.record.localFolder, msg.pane_id);
        controllers.send(c, msg.container, msg.pane_id, {
          type: 'terminal.scroll',
          direction: msg.direction,
          lines: msg.lines,
        });
        return;
      case 'mouse':
        activity.input(c.activityId, session.record.localFolder, msg.pane_id);
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

  const onSocket = (socket: WebSocket, role: WsRole) => {
    const client: Client = {
      socket,
      role,
      activityId: crypto.randomUUID(),
      send(text) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
    };
    socket.onopen = () => {
      clients.add(client);
      client.send(JSON.stringify(helloMessage({
        role,
        generation: generation(),
        live: opts.live,
        projectStarts,
        desktopProjects,
        desktopChannel: desktopToken !== null,
        hostOs: Deno.build.os,
      })));
      client.send(JSON.stringify(containersMessage()));
      client.send(JSON.stringify(projectsMessage()));
      client.send(JSON.stringify(pinnedFilesMessage(filePins)));
      client.send(JSON.stringify(dashboardMessage(dashboard)));
      client.send(JSON.stringify(tasksMessage(taskState)));
      client.send(JSON.stringify(jiraMessage()));
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
      views.leave(client);
      controllers.closeAll(client);
      lsp.detachAll(client);
      activity.clientGone(client.activityId);
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

  const desktopJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });

  /**
   * devc-desktop's routes, past {@link authorize}: `GET /desktop/active-folder` (the page
   * token), and with the desktop token `GET /desktop/requests?after=<seq>` (a long poll),
   * `POST /desktop/requests/<id>/dismiss` and `POST /desktop/project`.
   */
  const serveDesktop = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice(DESKTOP_PREFIX.length);
    const method = (m: string) =>
      req.method === m
        ? null
        : new Response('method not allowed', { status: 405 });
    if (path === 'active-folder') return method('GET') ?? serveActiveFolder();
    if (path === 'requests') {
      const after = Number(url.searchParams.get('after') ?? '-1');
      return method('GET') ?? desktopJson(
        await desktopRequests.wait(
          Number.isSafeInteger(after) ? after : -1,
          LONG_POLL_MS,
          req.signal,
        ),
      );
    }
    const dismiss = /^requests\/([0-9a-f]{1,64})\/dismiss$/.exec(path);
    if (dismiss) {
      const refused = method('POST');
      if (refused) return refused;
      desktopRequests.dismiss(dismiss[1]);
      return new Response(null, { status: 204 });
    }
    if (path === 'project') return method('POST') ?? desktopProject(req);
    return new Response('not found', { status: 404 });
  };

  /**
   * `POST /desktop/project {action, localFolder}`: a start, stop or removal devc-desktop's user
   * confirmed. Unlike the page's `start_project` it ignores `--live` (the page can't reach this
   * route), but never runs under `--live-yolo` (409), whose server code a container may have
   * written. Projects on this machine stay off under `--live`: no host source exists there.
   * Answers NDJSON: `{line}` for each line of a start's output, then `{done, ok, problem?}`.
   */
  const desktopProject = async (req: Request): Promise<Response> => {
    const body = parseDesktopProject(
      desktopProjects ? await req.text().catch(() => '') : '',
    );
    const refused = desktopProjectRefusal(
      desktopProjects,
      body,
      body !== null && isListedProject(body.localFolder),
    );
    if (refused !== null || body === null) {
      return desktopJson(
        { problem: refused?.problem ?? 'bad request' },
        refused?.status ?? 400,
      );
    }
    const encoder = new TextEncoder();
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (o: unknown) => {
          if (open) {
            controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
          }
        };
        void projectAction(
          body.action,
          body.localFolder,
          (line) => write({ line }),
        ).then(
          () => write({ done: true, ok: true }),
          (e) => write({ done: true, ok: false, problem: errorText(e) }),
        ).finally(() => {
          if (open) controller.close();
          open = false;
        });
      },
      // The app went away: the action carries on, as a page's start does.
      cancel() {
        open = false;
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
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
      const refused = authorize(
        req.headers,
        url,
        opts.port,
        token,
        desktopToken,
      );
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
        onSocket(socket, wsRole(url));
        return response;
      }
      if (url.pathname.startsWith(DESKTOP_PREFIX)) {
        return serveDesktop(req, url);
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

  for (const source of sources()) source.start(sourceHooks(source));
  liveStatic?.watch();
  gitWatch.start();
  changesWatch.start();
  // Host-wide work, done by one server at a time (`leader.ts`): the task queues, and the activity
  // log's container events and rollups — a start, every past day's rollup it lacks, then today's
  // every few minutes. A day that ends while it leads is rolled up complete on the next tick.
  const logActivityError = (e: unknown) =>
    console.error(
      `devc web: activity rollup: ${e instanceof Error ? e.message : e}`,
    );
  let rollupDayNow = localDate(new Date());
  let rollupTimer: ReturnType<typeof setInterval> | undefined;
  const leader = lead(() => {
    // Won while stopping: the lock is released at the end of the stop, with nothing started.
    if (stopping) return;
    activity.lead();
    rollupDayNow = localDate(new Date());
    void activity.flush()
      .then(() => catchUpRollups(rollupDayNow))
      .catch(logActivityError);
    rollupTimer = setInterval(() => {
      const now = new Date();
      const today = localDate(now);
      const ended = today !== rollupDayNow ? rollupDayNow : null;
      rollupDayNow = today;
      void activity.flush().then(async () => {
        if (ended) await writeDayRollup(ended, { complete: true });
        await writeDayRollup(today, { complete: false, until: now });
      }).catch(logActivityError);
    }, ROLLUP_EVERY_MS);
    runsQueues = true;
    schedulePump();
  }, {
    onError: (e) =>
      console.error(
        `devc web: leader lock: ${
          e instanceof Error ? e.message : e
        }; running the task queues and activity log anyway`,
      ),
  });
  const projectsWatch = watchConfigFile(
    PROJECTS_PATH,
    () => void reloadProjects(),
  );
  // Another devc web (the desktop window's, a browser's) pinning or unpinning a file.
  const pinnedFilesWatch = watchConfigFile(
    PINNED_FILES_PATH,
    () => void reloadPinnedFiles(),
  );
  // Another devc web (or the user, by hand) changing the dashboard.
  const dashboardWatch = watchConfigFile(
    DASHBOARD_PATH,
    () => void reloadDashboard(),
  );
  // Another devc web adding, sending or deleting a task.
  const tasksWatch = watchConfigFile(TASKS_PATH, () => void reloadTasks());
  // An edit to the global config's `"jira"`.
  const globalConfigWatch = watchConfigFile(GLOBAL_CONFIG_PATHS, async () => {
    await readJira();
    broadcast(jiraMessage());
  });
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
      for (const source of sources()) source.stop();
      desktopRequests.close();
      liveStatic?.stop();
      gitWatch.stop();
      changesWatch.stop();
      projectsWatch.stop();
      pinnedFilesWatch.stop();
      dashboardWatch.stop();
      tasksWatch.stop();
      globalConfigWatch.stop();
      bridgeWatch.stop();
      usageWatch.stop();
      runsQueues = false;
      clearInterval(rollupTimer);
      for (const c of clients) {
        try {
          c.socket.close();
        } catch { /* already closing */ }
        activity.clientGone(c.activityId);
      }
      activity.server('stop');
      await activity.flush();
      if (leader.leading()) {
        await writeDayRollup(localDate(new Date()), { complete: false })
          .catch(logActivityError);
      }
      // Only now: a server taking over writes its start after this one's stop.
      leader.stop();
      lspConfig.stop();
      await Promise.all([controllers.releaseAll(), lsp.shutdown()]);
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
 * Whether a watch event on `eventPaths` concerns one of the files `names` (basenames). A watch of
 * the global config passes both `config.jsonc` and `config.json`: creating or deleting
 * `config.jsonc` switches which one is read.
 */
export function configEventMatches(
  eventPaths: readonly string[],
  names: readonly string[],
): boolean {
  return eventPaths.some((p) => names.includes(basename(p)));
}

/**
 * Calls `onChange` (debounced) whenever a file of devc's config dir changes: the projects file (a
 * start in some terminal records its project there) or the pinned files (another devc web pinned
 * one). `path` may list several files of one directory — a global-config watch must pass
 * `GLOBAL_CONFIG_PATHS` (both `config.jsonc` and `config.json`) — and a change to any counts.
 * Watches the directory, since the file is replaced by a rename and may not exist yet. Never
 * throws: without a watch, the list just refreshes on the page's own changes.
 */
function watchConfigFile(
  path: string | readonly string[],
  onChange: () => void,
): { stop(): void } {
  const paths = typeof path === 'string' ? [path] : path;
  const dir = dirname(paths[0]);
  const names = paths.map((p) => basename(p));
  let watcher: Deno.FsWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  (async () => {
    try {
      await Deno.mkdir(dir, { recursive: true });
      watcher = Deno.watchFs(dir, { recursive: false });
      for await (const ev of watcher) {
        if (!configEventMatches(ev.paths, names)) continue;
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
