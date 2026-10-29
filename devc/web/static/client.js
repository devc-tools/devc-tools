// The `devc web` page's connection to the server: the `/ws` socket (reconnecting, live reload,
// the `/safe/` banner), the requests sent over it, and the server's data (containers, Herdr
// snapshots, projects, pinned files, tasks, usage, devc-bridge status, the Jira config) with the
// lookups over it. The sidebar and the tiling area subscribe to the server's messages
// (`onServerMessage`) once they are applied here. The protocol is specified in
// `.plans/devc-web.md`.

import { containerLabel, labelText, paneLabel, repoAt } from './lib/sidebar.js';
import { parseBridgeStatus, parseUsage } from './lib/host_status.js';
import { childPath } from './lib/files.js';
import { parseFilePinPanes, parsePinnedFiles } from './lib/pinned_files.js';
import { parseDashboard } from './lib/dashboard.js';
import { parseTasks } from './lib/tasks.js';
import { booted, errorToast, h, markBooted, toast } from './ui.js';
import { loadedPaths, planStaticChange } from './lib/live_reload.js';
import { viewIdFromHash } from './lib/view.js';

/** @typedef {import('./lib/view.js').TileState} TileState */

const RECONNECT_MS = 2000;
/** A held live reload waits this long after the last key or click. */
const RELOAD_IDLE_MS = 2000;
/** How often a held live reload checks again whether the page is still busy. */
const RELOAD_RETRY_MS = 1000;
/** Served from the last-good snapshot (`/safe/`): no reloads, no `client_ready`. */
export const SAFE_MODE = location.pathname.startsWith('/safe/');
/** Where this tab keeps live reload paused across its own reloads: `sessionStorage`. */
const LIVE_PAUSE_KEY = 'devc-web-live-paused-v1';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, kind?: 'container' | 'host', localFolder: string, name: string,
 *   state: string, error?: string, home?: string}} ContainerInfo
 */

/** @type {Map<string, ContainerInfo>} by container id */
export const containers = new Map();
/** @type {Map<string, any>} Herdr snapshots, by container id */
export const snapshots = new Map();
/**
 * @typedef {{localFolder: string, name: string,
 *   container: 'running' | 'stopped' | 'missing', starting: boolean,
 *   environment?: 'container' | 'host'}} ProjectInfo
 */
/** @type {Map<string, ProjectInfo>} devc's projects (the `projects` message), by local folder */
export const projects = new Map();
/** Each project's container-start output, its last {@link OUTPUT_LINES} lines. Memory only. */
export const projectOutput = new Map();
const OUTPUT_LINES = 500;
/** Whether the server starts containers and adds projects for this page (see `onHello`). */
export let projectStarts = true;
/**
 * Whether devc web runs with `--desktop-channel` (inside devc-desktop), so the page can ask the
 * app for a push or a container start (`request_push`, `request_project`), which the user
 * confirms in its HOST drawer.
 */
export let desktopChannel = false;
/**
 * Where this server can run projects (the `projects` message's `environments`): in containers,
 * on this machine, or both.
 *
 * @type {('container' | 'host')[]}
 */
export let environments = ['container'];
/** The host's OS (`hello`'s `hostOs`), which names the reveal item. */
export let hostOs = '';
/**
 * Pinned files (the `pinned_files` message), in pin order: the Pinned section's rows. Not pinned
 * projects, and not a preview tile's "Keep open".
 *
 * @type {import('./lib/pinned_files.js').FilePin[]}
 */
export let pinnedFiles = [];

/**
 * The dashboard (the `dashboard` message): the repo file the header button and an empty tiling
 * area open. Not a pinned file. Null until the server says, or when none is set.
 *
 * @type {import('./lib/dashboard.js').DashboardFile | null}
 */
export let dashboard = null;
/** Where {@link filePinPanes} is saved, so a reload still knows which tiles are a pin's. */
const FILE_PIN_PANES_KEY = 'devc-web-file-pin-panes-v1';
/** The task list, as the last `tasks` message gave it. @type {import('./lib/tasks.js').Task[]} */
export let tasks = [];
/** Sent tasks, newest first. @type {import('./lib/tasks.js').SentTask[]} */
export let sentTasks = [];
/** Each pinned file's editor pane (pin id → pane_id), from `open_pinned` replies. */
export const filePinPanes = loadFilePinPanes();
/** Pending `request`/`start_session` ids → description, for error toasts. */
export const pendingRequests = new Map();
/**
 * Pending `new_shell` ids → the placement waiting on the new pane.
 * @type {Map<string, {resolve: (r: {pane_id: string}) => void, reject: (e: Error) => void}>}
 */
const pendingShells = new Map();
/** Pending {@link call} ids → their promise's settlers. */
const pendingCalls = new Map();

export let socket = /** @type {WebSocket | null} */ (null);
let nextRequestId = 0;
/** The static generation this page was loaded from: the first `hello`'s. */
let bootGeneration = /** @type {string | null} */ (null);

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
/**
 * Where `/ws` is and how it is opened: this page's own server with the URL's `#token=`, unless a
 * bundled copy set its own ({@link useBundledEndpoint}).
 */
let endpoint = {
  origin: location.origin,
  ws: `ws://${location.host}/ws`,
  query: token ? `token=${encodeURIComponent(token)}` : '',
};
/**
 * devc-desktop's Containers pane: this code bundled into the app and loaded from a `file:` URL,
 * its server and desktop token handed over by the app. No live reload, no `client_ready`, and
 * nothing from a server that speaks another protocol. `null` in a page devc web serves.
 *
 * @type {{protocol: number, onProtocol: (ok: boolean, server: unknown) => void} | null}
 */
let bundled = null;
/** The last `hello` named a protocol other than the bundle's: messages are dropped both ways. */
let protocolMismatch = false;
/**
 * The URL hash's view id (`#token=…&view=<id>`, `default` without one): what pairs a `/sidebar`
 * page with a `/main` page. Not a file view or a `TileView`. `/` never uses it.
 */
export const VIEW_ID = viewIdFromHash(location.hash);

/** @type {{running: boolean, active: string[]} | null} The last `bridge_status`. */
export let hostBridgeStatus = null;
/** @type {import('./lib/host_status.js').UsageSource[] | null} The last `usage`. */
export let hostUsage = null;
/** @type {import('./lib/jira.js').JiraConfig | null} The last `jira`: the global config's. */
export let jiraConfig = null;

export function paneKey(containerId, paneId) {
  return `${containerId}\n${paneId}`;
}

export function basename(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// ---------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------

export function send(msg) {
  if (protocolMismatch) return;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** A fresh request id: `prefix` then a number no other request on this page has. */
export function nextId(prefix) {
  return `${prefix}${++nextRequestId}`;
}

export function request(container, method, params, what) {
  const id = nextId('r');
  pendingRequests.set(id, what);
  send({ type: 'request', id, container, method, params });
}

/** Sends `msg` with a fresh id; resolves with its `result`, rejects with its error. */
export function call(msg) {
  const id = nextId('c');
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    send({ ...msg, id });
  });
}

/**
 * Sends `msg` (`new_shell`, `open_file` or `open_tab`: a message that answers with a pane) with a
 * fresh id; resolves with the pane, rejects with the error (also when the connection drops first).
 *
 * @param {Record<string, unknown> & {type: string}} msg
 * @returns {Promise<{pane_id: string, reused?: boolean}>}
 */
export function requestPane(msg) {
  const id = nextId('n');
  /** @type {Promise<{pane_id: string, reused?: boolean}>} */
  const created = new Promise((resolve, reject) =>
    pendingShells.set(id, { resolve, reject })
  );
  send({ ...msg, id });
  return created;
}

/** @type {((msg: any) => void)[]} */
const serverListeners = [];

/**
 * Subscribes to the server's messages after `client.js` has applied them to its data: `fn(msg)`
 * runs for every message, in order. Returns an unsubscribe function.
 *
 * @param {(msg: any) => void} fn
 */
export function onServerMessage(fn) {
  serverListeners.push(fn);
  return () => {
    const i = serverListeners.indexOf(fn);
    if (i !== -1) serverListeners.splice(i, 1);
  };
}

/** @typedef {'no-token' | 'connecting' | 'open' | 'closed'} ConnectionState */

/** @type {((state: ConnectionState) => void)[]} */
const connectionListeners = [];

/**
 * Subscribes to the connection's state: `'connecting'`, `'open'`, `'closed'` (the server dropped
 * every pane this connection had open, and the server's data here is cleared; a reconnect
 * follows), or `'no-token'` (the URL has no token: the page never connects). Returns an
 * unsubscribe function.
 *
 * @param {(state: ConnectionState) => void} fn
 */
export function onConnectionChange(fn) {
  connectionListeners.push(fn);
  return () => {
    const i = connectionListeners.indexOf(fn);
    if (i !== -1) connectionListeners.splice(i, 1);
  };
}

/** @param {ConnectionState} state */
function connectionChanged(state) {
  for (const fn of [...connectionListeners]) fn(state);
}

/**
 * Serves this code from somewhere other than devc web (devc-desktop's bundled Containers pane):
 * `/ws` at `origin` (`http://127.0.0.1:<port>`) with `desktopToken`, which gives the connection
 * the server's desktop role. Each `hello` is checked against `protocol`, the version the bundle
 * was built for, and `onProtocol` told the outcome; on a mismatch nothing more is applied or
 * sent until a `hello` that matches. Call before {@link connect}.
 *
 * @param {{origin: string, desktopToken: string, protocol: number,
 *   onProtocol: (ok: boolean, server: unknown) => void}} o
 */
export function useBundledEndpoint(o) {
  endpoint = {
    origin: o.origin,
    ws: `${o.origin.replace(/^http:/, 'ws:')}/ws`,
    query: `desktop_token=${encodeURIComponent(o.desktopToken)}`,
  };
  bundled = { protocol: o.protocol, onProtocol: o.onProtocol };
}

/** The server's origin (`http://127.0.0.1:<port>`): the page's own, or a bundle's. */
export function serverOrigin() {
  return endpoint.origin;
}

/** Opens `/ws` (token from the URL hash, or a bundle's endpoint) and starts dispatching. */
export function connect() {
  if (!endpoint.query) {
    connectionChanged('no-token');
    markBooted();
    return;
  }
  const ws = new WebSocket(`${endpoint.ws}?${endpoint.query}`);
  socket = ws;
  connectionChanged('connecting');
  ws.onopen = () => connectionChanged('open');
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    // The server dropped every controller this connection had; reopen on reconnect.
    for (const p of pendingShells.values()) p.reject(new Error('disconnected'));
    pendingShells.clear();
    // Unsettled: the trees waiting on these list again on the next `hello`.
    pendingCalls.clear();
    containers.clear();
    snapshots.clear();
    projects.clear();
    connectionChanged('closed');
    setTimeout(connect, RECONNECT_MS);
  };
}

// ---------------------------------------------------------------------------------------------
// Live reload (devc web --source): see .plans/devc-web-live.md
// ---------------------------------------------------------------------------------------------

function onHello(msg) {
  // `devc web --live` starts no containers for the page (its code comes from a checkout agents can
  // write to): hide what would only be refused. A server that doesn't say allows them.
  projectStarts = msg.projectStarts !== false;
  desktopChannel = msg.desktopChannel === true;
  liveMode = msg.live === true && !SAFE_MODE && bundled === null;
  hostOs = typeof msg.hostOs === 'string' ? msg.hostOs : '';
  if (bootGeneration === null || bundled !== null) {
    bootGeneration = msg.generation;
    return;
  }
  // A reconnect to a server whose files changed while the socket was down (a restart, or the
  // fallback to the built-in copy and back).
  if (!SAFE_MODE && msg.generation !== bootGeneration) requestReload();
}

/**
 * Whether the server serves a checkout live (`hello`'s `live`: `devc web --live` or
 * `--live-yolo`), so page edits reload this tab. Never in safe mode.
 */
export let liveMode = false;
/** Live reload paused from the host status strip: page edits wait for it to be resumed. */
export let liveReloadPaused = loadLiveReloadPaused();
/** A page edit arrived while paused: resuming reloads. */
export let liveReloadHeld = false;
const liveReloadListeners = /** @type {(() => void)[]} */ ([]);

/** Calls `fn` when {@link liveReloadPaused} or {@link liveReloadHeld} changes. */
export function onLiveReloadChange(fn) {
  liveReloadListeners.push(fn);
}

function liveReloadChanged() {
  for (const fn of [...liveReloadListeners]) fn();
}

function loadLiveReloadPaused() {
  try {
    return sessionStorage.getItem(LIVE_PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Pauses or resumes live reload; resuming with an edit held reloads (when not busy). */
export function setLiveReloadPaused(on) {
  if (on === liveReloadPaused) return;
  liveReloadPaused = on;
  try {
    if (on) sessionStorage.setItem(LIVE_PAUSE_KEY, '1');
    else sessionStorage.removeItem(LIVE_PAUSE_KEY);
  } catch { /* unavailable: the pause just won't survive a reload */ }
  const held = liveReloadHeld;
  liveReloadHeld = false;
  liveReloadChanged();
  if (!on && held) requestReload();
}

/** Paused: the reload (or stylesheet swap) waits for {@link setLiveReloadPaused}. */
function holdForPause() {
  if (liveReloadHeld) return;
  liveReloadHeld = true;
  liveReloadChanged();
}

function onStaticChanged(msg) {
  if (SAFE_MODE || bundled !== null) return;
  const paths = Array.isArray(msg.paths) ? msg.paths : [];
  const base = new URL('./', location.href).pathname;
  const loaded = loadedPaths(
    performance.getEntriesByType('resource').map((e) => e.name),
    location.origin,
    base,
    location.pathname.slice(base.length),
  );
  // Files this page never loaded (another page's script) leave it alone.
  const plan = planStaticChange(paths, loaded);
  if (plan.reload) {
    requestReload();
    return;
  }
  // Resuming reloads the whole page, stylesheets and all.
  if (liveReloadPaused && plan.css.length > 0) {
    holdForPause();
    return;
  }
  // CSS only: swap each changed stylesheet in place, so the terminals keep their state.
  const changed = new Set(plan.css);
  for (const link of document.querySelectorAll('link[rel=stylesheet]')) {
    const url = new URL(/** @type {HTMLLinkElement} */ (link).href);
    const path = url.pathname.slice(base.length);
    if (changed.has(path)) {
      link.setAttribute(
        'href',
        `./${path}?g=${encodeURIComponent(msg.generation)}`,
      );
    }
  }
  bootGeneration = msg.generation;
}

/** Whether something on the page holds a live reload back: see {@link holdReloadWhile}. */
const reloadHolds = /** @type {(() => boolean)[]} */ ([]);
let reloadPending = false;
let lastInputAt = 0;
addEventListener('keydown', () => lastInputAt = Date.now(), true);
addEventListener('pointerdown', () => lastInputAt = Date.now(), true);

/** Holds a live reload back while `busy()` is true (unsaved edits, say). */
export function holdReloadWhile(busy) {
  reloadHolds.push(busy);
}

/**
 * Reloads for a live edit once the page isn't busy: no open dialog, no text in a focused field,
 * no hold, and nothing typed or clicked for {@link RELOAD_IDLE_MS}. A toast says so when it waits.
 * While live reload is paused it waits for the resume instead.
 */
function requestReload() {
  if (liveReloadPaused) {
    holdForPause();
    return;
  }
  if (reloadPending) return;
  reloadPending = true;
  if (!reloadBusy()) {
    location.reload();
    return;
  }
  toast('The UI changed: reloading when you’re done', {
    label: 'Reload now',
    run: () => location.reload(),
  });
  const retry = () => {
    if (liveReloadPaused) {
      reloadPending = false;
      holdForPause();
    } else if (reloadBusy()) setTimeout(retry, RELOAD_RETRY_MS);
    else location.reload();
  };
  setTimeout(retry, RELOAD_RETRY_MS);
}

function reloadBusy() {
  if (Date.now() - lastInputAt < RELOAD_IDLE_MS) return true;
  if (document.querySelector('dialog[open], .dialog-backdrop')) return true;
  const el = document.activeElement;
  // xterm's helper textarea holds a focused terminal's keys, not a draft.
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    !el.classList.contains('xterm-helper-textarea') && el.value !== ''
  ) return true;
  return reloadHolds.some((busy) => busy());
}

export function showSafeBanner() {
  const back = h(
    'a',
    {
      // The same page live: `/safe/sidebar` → `/sidebar`, `/safe/` → `/`.
      href: `${
        location.pathname.slice('/safe'.length)
      }${location.search}${location.hash}`,
      class: 'safe-banner-link',
    },
    'Back to live',
  );
  document.body.prepend(
    h(
      'div',
      { class: 'safe-banner', role: 'status' },
      'Safe mode — last good UI ',
      back,
    ),
  );
  document.body.classList.add('safe-mode');
}

// ---------------------------------------------------------------------------------------------
// Server data
// ---------------------------------------------------------------------------------------------

/**
 * One server message: applied to the server's data here, then handed to every
 * {@link onServerMessage} subscriber. The first `containers` releases the boot guard once the
 * subscribers have rendered it.
 */
function onMessage(msg) {
  if (bundled !== null && msg.type === 'hello') {
    protocolMismatch = msg.protocol !== bundled.protocol;
    bundled.onProtocol(!protocolMismatch, msg.protocol);
  }
  if (protocolMismatch) return;
  applyMessage(msg);
  for (const fn of [...serverListeners]) fn(msg);
  if (msg.type === 'containers' && !booted) {
    if (!SAFE_MODE && bundled === null && bootGeneration !== null) {
      send({ type: 'client_ready', generation: bootGeneration });
    }
    markBooted();
  }
}

function applyMessage(msg) {
  switch (msg.type) {
    case 'hello':
      onHello(msg);
      break;
    case 'static_changed':
      onStaticChanged(msg);
      break;
    case 'containers': {
      containers.clear();
      for (const c of msg.containers) containers.set(c.id, c);
      for (const id of [...snapshots.keys()]) {
        const c = containers.get(id);
        if (!c || c.state !== 'connected') snapshots.delete(id);
      }
      break;
    }
    case 'projects':
      projects.clear();
      for (const p of msg.projects) projects.set(p.localFolder, p);
      if (Array.isArray(msg.environments)) environments = msg.environments;
      break;
    case 'project_output':
      onProjectOutput(msg.localFolder, msg.line);
      break;
    case 'pinned_files':
      onPinnedFiles(msg);
      break;
    case 'dashboard':
      dashboard = parseDashboard(msg);
      break;
    case 'tasks': {
      const parsed = parseTasks(msg);
      tasks = parsed.tasks;
      sentTasks = parsed.sent;
      break;
    }
    case 'bridge_status':
      hostBridgeStatus = parseBridgeStatus(msg);
      break;
    case 'usage':
      hostUsage = parseUsage(msg);
      break;
    case 'jira': {
      const j = msg.jira;
      jiraConfig =
        j && typeof j.pattern === 'string' && typeof j.url === 'string'
          ? { pattern: j.pattern, url: j.url }
          : null;
      break;
    }
    case 'snapshot':
      snapshots.set(msg.container, msg.snapshot);
      break;
    case 'pane_updated':
      patchPane(msg.container, msg.pane, false);
      break;
    case 'agent_status':
      patchPane(msg.container, {
        pane_id: msg.pane_id,
        agent: msg.agent,
        agent_status: msg.agent_status,
      }, true);
      break;
    case 'result':
      onResult(msg);
      break;
  }
}

function patchPane(containerId, pane, merge) {
  const snap = snapshots.get(containerId);
  if (!snap || !Array.isArray(snap.panes)) return;
  const i = snap.panes.findIndex((p) => p.pane_id === pane.pane_id);
  if (i === -1) return;
  snap.panes[i] = merge ? { ...snap.panes[i], ...pane } : pane;
}

/** One line of a container start's output, kept: its last {@link OUTPUT_LINES}. */
function onProjectOutput(localFolder, line) {
  const lines = projectOutput.get(localFolder) ?? [];
  lines.push(line);
  if (lines.length > OUTPUT_LINES) lines.splice(0, lines.length - OUTPUT_LINES);
  projectOutput.set(localFolder, lines);
}

/**
 * Settles the requests made here ({@link call}, {@link requestPane}, {@link request}); a failed
 * {@link request} is a toast. A tile's own requests are the tiling area's to settle.
 */
function onResult(msg) {
  const pending = pendingCalls.get(msg.id);
  if (pending) {
    pendingCalls.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else {
      pending.reject(
        Object.assign(
          new Error(msg.error?.message ?? msg.error?.code ?? 'failed'),
          { code: msg.error?.code },
        ),
      );
    }
    return;
  }
  const shell = pendingShells.get(msg.id);
  if (shell) {
    pendingShells.delete(msg.id);
    if (msg.ok && typeof msg.result?.pane_id === 'string') {
      shell.resolve(msg.result);
    } else {
      shell.reject(
        new Error(msg.error?.message ?? msg.error?.code ?? 'failed'),
      );
    }
    return;
  }
  if (!pendingRequests.has(msg.id)) return;
  const what = pendingRequests.get(msg.id);
  pendingRequests.delete(msg.id);
  if (!msg.ok) {
    errorToast(
      `${what ?? 'Request'} failed: ${msg.error?.message ?? msg.error?.code}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------------------------

export function list(v) {
  return Array.isArray(v)
    ? v
    : v && typeof v === 'object'
    ? Object.values(v)
    : [];
}

export function byNumber(a, b) {
  return (a.number ?? 0) - (b.number ?? 0);
}

export function containerByFolder(localFolder) {
  for (const c of containers.values()) {
    if (c.localFolder === localFolder) return c;
  }
  return null;
}

export function findPane(containerId, paneId) {
  return list(snapshots.get(containerId)?.panes).find((p) =>
    p.pane_id === paneId
  ) ?? null;
}

/**
 * The pane a listed session is running in, while that pane is still there with an agent in it
 * (`pane_id` is as of the last listing); null otherwise.
 */
export function sessionPane(c, s) {
  const pane = s.pane_id ? findPane(c.id, s.pane_id) : null;
  return pane?.agent ? pane : null;
}

/** A file's host path; a container file's path in the container. */
export function fileHostPath(file) {
  return childPath(file.root, file.path);
}

/** A container's name, told apart from any other container with the same name. */
export function displayName(c) {
  return containerLabel(c, containers.values());
}

/** The container and pane a ref points at, when they are known. */
export function resolveRef(ref) {
  const c = ref ? containerByFolder(ref.localFolder) : null;
  const pane = c && ref ? findPane(c.id, ref.pane_id) : null;
  return { c, pane };
}

/** A tile's label (see `paneLabel`), the same as its sidebar row's. */
export function refLabel(ref) {
  if (!ref) return { name: 'empty', title: '' };
  const { pane } = resolveRef(ref);
  return pane ? paneLabel(pane) : { name: ref.pane_id, title: '' };
}

/** A tile's tooltip lines: its container (which its label leaves out), label and folder. */
export function refTooltip(ref) {
  if (!ref) return [];
  const { c, pane } = resolveRef(ref);
  return [
    c ? displayName(c) : basename(ref.localFolder),
    labelText(refLabel(ref)),
    pane?.foreground_cwd || pane?.cwd || '',
  ].filter((s) => s);
}

/**
 * The repo a tile is in, for the window title: the basename of the repo it belongs to (a
 * worktree's main repo, from `primaryFolder`; else its own folder), and its branch (none while unread, detached or unreadable). That is a repo file's own repo, else the
 * repo whose container folder holds the pane's directory or the container file. Outside every
 * repo, the label is its project's name, as its container row shows it; none for an empty tile.
 */
export function activeRepo(tile) {
  const { localFolder, repo } = tileRepo(tile);
  if (!localFolder) return {};
  if (repo) {
    return {
      label: basename(repo.primaryFolder ?? repo.worktreeOf ?? repo.folder),
      branch: repo.git?.branch,
    };
  }
  const c = containerByFolder(localFolder);
  if (c) return { label: displayName(c) };
  const p = projects.get(localFolder);
  return {
    label: p ? containerLabel(p, projects.values()) : basename(localFolder),
  };
}

/**
 * The project a tile is in (none for an empty tile) and the repo of it (`activeRepo`'s), null
 * outside every repo.
 */
export function tileRepo(tile) {
  const file = tile.kind === 'file' ? tile.file : tile.diff;
  const localFolder = file ? file.localFolder : tile.ref?.localFolder;
  if (!localFolder) return { localFolder: null, repo: null };
  const repos = projectRepos(localFolder);
  let repo;
  if (file && !('container' in file && file.container)) {
    repo = repos.find((r) => r.folder === file.root);
  } else if (file) {
    repo = repoAt(repos, fileHostPath(file));
  } else {
    repo = paneRepo(localFolder, resolveRef(tile.ref).pane);
  }
  return { localFolder, repo: repo ?? null };
}

/** The repo of project `localFolder` that holds `pane`'s folder, as its tile's tab says. */
export function paneRepo(localFolder, pane) {
  return repoAt(
    projectRepos(localFolder),
    pane?.foreground_cwd || pane?.cwd || '',
  );
}

/** A project's repos (its `repos` field), the folder itself first. */
export function projectRepos(localFolder) {
  return list(projects.get(localFolder)?.repos);
}

function onPinnedFiles(msg) {
  pinnedFiles = parsePinnedFiles(msg);
  const ids = new Set(pinnedFiles.map((p) => p.id));
  let pruned = false;
  for (const id of [...filePinPanes.keys()]) {
    if (!ids.has(id)) pruned = filePinPanes.delete(id);
  }
  if (pruned) saveFilePinPanes();
}

function loadFilePinPanes() {
  let text = null;
  try {
    text = localStorage.getItem(FILE_PIN_PANES_KEY);
  } catch { /* unavailable: a reload forgets which tiles are a pin's */ }
  return parseFilePinPanes(text);
}

export function saveFilePinPanes() {
  try {
    localStorage.setItem(
      FILE_PIN_PANES_KEY,
      JSON.stringify(Object.fromEntries(filePinPanes)),
    );
  } catch { /* storage unavailable */ }
}

/** The pin whose editor pane a tile shows, if any. @param {TileState} tile */
export function filePinOfTile(tile) {
  const ref = tile.ref;
  if (!ref) return null;
  return pinnedFiles.find((p) =>
    p.localFolder === ref.localFolder &&
    filePinPanes.get(p.id) === ref.pane_id
  ) ?? null;
}
