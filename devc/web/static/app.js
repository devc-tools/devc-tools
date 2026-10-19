// The `devc web` page: the WebSocket client for `/ws`, the sidebar and the browser-owned tiling
// area. The sidebar has four sections: Pinned, the pinned files (a click toggles the file's
// editor tile; shown only while something is pinned), Tasks, the to-dos sent to agents, Layout,
// a live mirror of the Golden Layout tree (where things are on screen, and
// the layout actions), and Containers, every Herdr pane by container (what is running, and the
// process actions). The browser owns all layout: it never splits a Herdr pane or
// shows a Herdr tab, and each pane it creates gets its own Herdr tab (`new_shell`). The protocol is
// specified in `.plans/devc-web.md`; renderer details live in `renderer.js`, window management
// in `layout.js` (Golden Layout), the file viewer in `viewer.js` (CodeMirror), and the pure
// input helpers in `lib/input.js`.

import { createRenderer } from './renderer.js';
import { createTiling } from './layout.js';
import { createViewer } from './viewer.js';
import {
  foldTree,
  parseSavedLayout,
  sameFile,
  tilesShowingPane,
  treeSignature,
} from './lib/layout_state.js';
import {
  createWheelAccumulator,
  decodeBase64,
  encodeInput,
  mouseButton,
  pixelToCell,
  wrapPaste,
} from './lib/input.js';
import {
  agentStatus,
  clampSidebarWidth,
  collapseContainersState,
  collapseTasksState,
  containerLabel,
  gitRollup,
  gitSync,
  labelText,
  paneLabel,
  paneTitle,
  repoAt,
  SIDEBAR_DEFAULT_WIDTH,
  statusShort,
  topStatus,
  windowTitle,
} from './lib/sidebar.js';
import { AGENT_IDS, AGENT_MARKS, terminalIconKind } from './lib/agent_icons.js';
import { resolvePath } from './lib/links.js';
import {
  bridgeStatusItems,
  parseBridgeStatus,
  parseUsage,
  usageItems,
} from './lib/host_status.js';
import {
  byDepth,
  childPath,
  createDirTree,
  formatSize,
  isHiddenName,
  isHtmlPath,
  isWithin,
  newEntryNameError,
  opensAsDir,
  opensAsFile,
  parentDir,
} from './lib/files.js';
import {
  defaultNotePath,
  filePinName,
  isFilePinShortcut,
  notePathError,
  parseFilePinPanes,
  parsePinnedFiles,
} from './lib/pinned_files.js';
import {
  groupTasks,
  parseTaskDefault,
  parseTasks,
  savedTaskAgent,
  sentTaskTooltip,
  TASK_AGENT_IDS,
  taskTitle,
} from './lib/tasks.js';

const LAYOUT_KEY = 'devc-web-layout-v2';
/** The split-tree layout before Golden Layout: removed on load, not migrated. */
const OLD_LAYOUT_KEY = 'devc-web-layout-v1';
const RESIZE_DEBOUNCE_MS = 100;
const DRAG_INTERVAL_MS = 50;
/** How long a `read_selection` may go unanswered before its copy is dropped. */
const SELECTION_TIMEOUT_MS = 5000;
/**
 * How long a copied drag's highlight stays, in a pane whose app draws no selection of its own
 * (see `attachMouse`). It marks grid cells, not text, so it would go stale on the app's next
 * redraw: a brief flash confirms what was copied.
 */
const COPY_FLASH_MS = 500;
const RECONNECT_MS = 2000;
/**
 * How long a tile opened on a pane this page just created waits for a snapshot listing it before
 * it says `LABELS.closed`: `new_shell` answers before Herdr's next snapshot arrives.
 */
const NEW_PANE_GRACE_MS = 5000;
/** Served from the last-good snapshot (`/safe/`): no reloads, no `client_ready`. */
const SAFE_MODE = location.pathname.startsWith('/safe/');

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, localFolder: string, name: string, state: string, error?: string,
 *   home?: string}} ContainerInfo
 * @typedef {import('./lib/layout_state.js').PaneRef} PaneRef
 * @typedef {import('./lib/layout_state.js').FileRef} FileRef
 * @typedef {import('./layout.js').Tile} Tile
 */

/** @type {Map<string, ContainerInfo>} by container id */
const containers = new Map();
/** @type {Map<string, any>} Herdr snapshots, by container id */
const snapshots = new Map();
/**
 * @typedef {{localFolder: string, name: string, pinned: boolean, lastUsed: string | null,
 *   container: 'running' | 'stopped' | 'missing', starting: boolean}} ProjectInfo
 */
/** @type {Map<string, ProjectInfo>} devc's projects (the `projects` message), by local folder */
const projects = new Map();
/** Each project's container-start output, its last {@link OUTPUT_LINES} lines. Memory only. */
const projectOutput = new Map();
const OUTPUT_LINES = 500;

/** @type {ReturnType<typeof createTiling> | null} set once the page has started */
let tiling = null;
/** @type {string | null} */
let focusedTileId = null;
/** Tile ids by when they were last focused (higher is later), to pick the one to reveal. */
const focusSeq = new Map();
let nextFocusSeq = 0;
/** `localFolder\npane` of panes from `new_shell`, → when their grace period ends. */
const newPanes = new Map();
/** Whether the server starts containers and adds projects for this page (see `onHello`). */
let projectStarts = true;
/** The Layout section's last rendered tree, as `treeSignature` plus the tiles' refs. */
let layoutSignature = '';
/**
 * Sidebar file rows (each a Golden Layout drag source) by tree key, kept across renders for the
 * same reason as {@link paneRows}.
 *
 * @type {Map<string, {row: HTMLElement, seen: number, remove: () => void}>}
 */
const fileRows = new Map();
/**
 * Sidebar pane rows by `container\npane`, kept across renders and updated in place. Each is a
 * Golden Layout drag source, and unregistering one tears down the document listeners of a drag
 * in progress — so a row (and its drag source) lives as long as its pane, not one render.
 *
 * @type {Map<string, {row: HTMLElement, c: any, pane: any, seen: number, remove: (() => void) | null}>}
 */
const paneRows = new Map();
let renderGeneration = 0;
/**
 * The inline name row of a **New file…** / **New folder…** in progress: under folder `dir` of
 * file root `fr`, kept across renders (so typing survives them) until Enter creates the entry or
 * Escape cancels. A render that no longer shows its folder drops it. For a **Rename…**, `rename`
 * is the entry's path, and the row stands in place of that entry's own.
 *
 * @type {{fr: FileRoot, dir: string, kind: 'file' | 'dir', rename: string | null,
 *   row: HTMLElement, input: HTMLInputElement, error: HTMLElement, busy: boolean,
 *   seen: number} | null}
 */
let newEntry = null;
/** The tree key of a row just created, focused by the first render that shows it. */
let selectTreeKey = null;
/**
 * Pinned files (the `pinned_files` message), in pin order: the Pinned section's rows. Not pinned
 * projects, and not a preview tile's "Keep open".
 *
 * @type {import('./lib/pinned_files.js').FilePin[]}
 */
let pinnedFiles = [];
/** Where {@link filePinPanes} is saved, so a reload still knows which tiles are a pin's. */
const FILE_PIN_PANES_KEY = 'devc-web-file-pin-panes-v1';
/** The task list, as the last `tasks` message gave it. @type {import('./lib/tasks.js').Task[]} */
let tasks = [];
/** Sent tasks, newest first. @type {import('./lib/tasks.js').SentTask[]} */
let sentTasks = [];
/** The agent the task dialog last sent to. */
const TASK_AGENT_KEY = 'devc-web-task-agent-v1';
/** The default route and agent for new tasks, pinned in the task dialog. */
const TASK_DEFAULT_KEY = 'devc-web-task-default-v1';
/** Each pinned file's editor pane (pin id → pane_id), from `open_pinned` replies. */
const filePinPanes = loadFilePinPanes();

/**
 * A tile's live view. `openKey` is the `container\npane` it has open on the server, if any.
 *
 * @typedef {object} TileView
 * @property {Tile} tile
 * @property {HTMLElement} body
 * @property {HTMLElement} overlay
 * @property {import('./renderer.js').Renderer} renderer
 * @property {string | null} openKey
 * @property {{cols: number, rows: number} | null} size
 * @property {string | null} closedReason
 * @property {boolean} hidden  in a background stack tab: no resize is sent
 * @property {ReturnType<typeof setTimeout> | undefined} resizeTimer
 * @property {ReturnType<typeof setTimeout> | undefined} flashTimer  clears the copy highlight
 * @property {number} frames  frames painted so far: whether the app redrew during a drag
 * @property {ResizeObserver} observer
 */

/** @type {Map<string, TileView>} pane tiles' views, by Tile.id */
const views = new Map();

/**
 * A file tile's live view: the viewer once the file has been read, else an overlay saying why
 * not. `seq` numbers the reads, so only the latest one's answer lands. The viewer is an editor
 * while the file's container runs (saves are written in the container); `hash` is what the last
 * read or save left on disk, sent as a save's `base`.
 *
 * @typedef {object} FileView
 * @property {Tile} tile
 * @property {HTMLElement} host      where the viewer mounts
 * @property {HTMLElement} overlay
 * @property {import('./viewer.js').Viewer | null} viewer
 * @property {'loading' | 'ok' | 'error'} state
 * @property {string} error          the message shown while `state` is 'error'
 * @property {boolean} [noContainer] the error is that a container file's container isn't running
 * @property {number} seq
 * @property {string | null} hash
 * @property {boolean} dirty         edited since the last read or save
 * @property {boolean} saving
 */

/** @type {Map<string, FileView>} file tiles' views, by Tile.id */
const fileViews = new Map();
/** Pending `open` request ids → tile id. */
const pendingOpens = new Map();
/** Pending `request`/`start_session` ids → description, for error toasts. */
const pendingRequests = new Map();
/**
 * Pending `read_selection` ids → the copy waiting on the text.
 * @type {Map<string, {resolve: (text: string) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>}>}
 */
const pendingSelections = new Map();
/**
 * Pending `new_shell` ids → the placement waiting on the new pane.
 * @type {Map<string, {resolve: (r: {pane_id: string}) => void, reject: (e: Error) => void}>}
 */
const pendingShells = new Map();
/** Pending {@link call} ids → their promise's settlers. */
const pendingCalls = new Map();

let socket = /** @type {WebSocket | null} */ (null);
let nextRequestId = 0;
/** The static generation this page was loaded from: the first `hello`'s. */
let bootGeneration = /** @type {string | null} */ (null);
/** Set once the first `containers` has rendered: `client_ready` sent, boot guard released. */
let booted = false;

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';

const $tree = /** @type {HTMLElement} */ (document.getElementById('tree'));
const $tiles = /** @type {HTMLElement} */ (document.getElementById('tiles'));
const $menu = /** @type {HTMLElement} */ (document.getElementById('menu'));
const $conn = /** @type {HTMLElement} */ (document.getElementById('conn'));
const $toasts = /** @type {HTMLElement} */ (document.getElementById('toasts'));
const $app = /** @type {HTMLElement} */ (document.querySelector('.app'));
const $resizer = /** @type {HTMLElement} */ (document.getElementById(
  'sidebar-resizer',
));
const $sidebarHide = /** @type {HTMLElement} */ (document.getElementById(
  'sidebar-hide',
));
const $sidebarShow = /** @type {HTMLElement} */ (document.getElementById(
  'sidebar-show',
));

/**
 * The host status strip at the foot of the sidebar: host-level indicators, the account-wide
 * agent usage limits (`usage`) then devc-bridge's (`bridge_status`). Hidden while it has nothing
 * to show.
 */
const $hostStatus = h('footer', {
  class: 'host-status',
  id: 'host-status',
  'aria-label': 'Host status',
  hidden: true,
});
document.querySelector('.sidebar')?.append($hostStatus);
/** @type {{running: boolean, active: string[]} | null} The last `bridge_status`. */
let hostBridgeStatus = null;
/** @type {import('./lib/host_status.js').UsageSource[] | null} The last `usage`. */
let hostUsage = null;
// Usage windows reset and observations age with no server traffic: re-evaluate every minute.
setInterval(() => {
  if (hostUsage?.length) renderHostStatus();
}, 60_000);

function paneKey(containerId, paneId) {
  return `${containerId}\n${paneId}`;
}

function basename(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string)} children */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children);
  return el;
}

/**
 * A message in the corner for a few seconds. With `action`, it carries a button that runs it
 * (and dismisses the toast), and stays a little longer. Returns the toast's element.
 *
 * @param {string} message @param {{label: string, run: () => void}} [action]
 */
function toast(message, action) {
  const el = h('div', { class: 'toast' }, message);
  if (action) {
    el.append(h('button', {
      type: 'button',
      class: 'toast-action',
      onclick: () => {
        el.remove();
        action.run();
      },
    }, action.label));
  }
  $toasts.append(el);
  setTimeout(() => el.remove(), action ? 12000 : 6000);
  return el;
}

/** A {@link toast} for a failure: outlined as an error. @param {string} message */
function errorToast(message) {
  toast(message).classList.add('error');
}

/** Releases `boot.js`'s guard: from here on, errors are toasts, not its overlay. */
function markBooted() {
  if (booted) return;
  booted = true;
  /** @type {any} */ (window).__devcBooted?.();
}

window.addEventListener('error', (e) => {
  if (booted && e.message) errorToast(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (booted) errorToast(String(e.reason?.message ?? e.reason));
});

// ---------------------------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------------------------

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function request(container, method, params, what) {
  const id = `r${++nextRequestId}`;
  pendingRequests.set(id, what);
  send({ type: 'request', id, container, method, params });
}

function connect() {
  if (!token) {
    $conn.dataset.state = 'closed';
    $conn.textContent = 'no token';
    $tree.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        'This page needs the URL devc web printed, including its #token=… part.',
      ),
    );
    markBooted();
    return;
  }
  const ws = new WebSocket(
    `ws://${location.host}/ws?token=${encodeURIComponent(token)}`,
  );
  socket = ws;
  $conn.dataset.state = 'connecting';
  $conn.textContent = 'connecting';
  ws.onopen = () => {
    $conn.dataset.state = 'open';
    $conn.textContent = 'live';
  };
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
    $conn.dataset.state = 'closed';
    $conn.textContent = 'disconnected';
    // The server dropped every controller this connection had; reopen on reconnect.
    for (const view of views.values()) view.openKey = null;
    pendingOpens.clear();
    for (const p of pendingShells.values()) p.reject(new Error('disconnected'));
    pendingShells.clear();
    // Unsettled: the trees waiting on these list again on the next `hello`.
    pendingCalls.clear();
    containers.clear();
    snapshots.clear();
    projects.clear();
    renderTree();
    reconcileTiles();
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
  // Listings and file reads asked for while disconnected never got an answer.
  for (const { tree } of fileTrees.values()) tree.refresh('');
  for (const view of fileViews.values()) {
    if (view.state === 'loading') loadFile(view);
  }
  for (const top of picker?.tops ?? []) picker?.tree.refresh(top);
  if (bootGeneration === null) {
    bootGeneration = msg.generation;
    return;
  }
  // A reconnect to a server whose files changed while the socket was down (a restart, or the
  // fallback to the built-in copy and back).
  if (!SAFE_MODE && msg.generation !== bootGeneration) location.reload();
}

function onStaticChanged(msg) {
  if (SAFE_MODE) return;
  const paths = Array.isArray(msg.paths) ? msg.paths : [];
  if (paths.length === 0 || !paths.every((p) => p.endsWith('.css'))) {
    location.reload();
    return;
  }
  // CSS only: swap each changed stylesheet in place, so the terminals keep their state.
  const base = new URL('./', location.href).pathname;
  const changed = new Set(paths);
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

function showSafeBanner() {
  const back = h(
    'a',
    { href: `/${location.hash}`, class: 'safe-banner-link' },
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

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      onHello(msg);
      break;
    case 'static_changed':
      onStaticChanged(msg);
      break;
    case 'containers': {
      const ids = new Set();
      containers.clear();
      for (const c of msg.containers) {
        containers.set(c.id, c);
        ids.add(c.id);
      }
      for (const id of [...snapshots.keys()]) {
        const c = containers.get(id);
        if (!c || c.state !== 'connected') snapshots.delete(id);
      }
      relistForContainers();
      for (const view of fileViews.values()) {
        if (view.noContainer) loadFile(view);
        else syncFileEditable(view);
      }
      renderTree();
      reconcileTiles();
      if (!booted) {
        if (!SAFE_MODE && bootGeneration !== null) {
          send({ type: 'client_ready', generation: bootGeneration });
        }
        markBooted();
      }
      break;
    }
    case 'projects':
      projects.clear();
      for (const p of msg.projects) projects.set(p.localFolder, p);
      renderTree();
      reconcileTiles();
      break;
    case 'project_output':
      onProjectOutput(msg.localFolder, msg.line);
      break;
    case 'pinned_files':
      onPinnedFiles(msg);
      break;
    case 'tasks': {
      const parsed = parseTasks(msg);
      tasks = parsed.tasks;
      sentTasks = parsed.sent;
      renderTree();
      break;
    }
    case 'bridge_status':
      hostBridgeStatus = parseBridgeStatus(msg);
      renderHostStatus();
      break;
    case 'usage':
      hostUsage = parseUsage(msg);
      renderHostStatus();
      break;
    case 'snapshot':
      snapshots.set(msg.container, msg.snapshot);
      renderTree();
      reconcileTiles();
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
    case 'frame':
      onFrame(msg);
      break;
    case 'pane_closed':
      onPaneClosed(msg.container, msg.pane_id, msg.reason);
      break;
    case 'result':
      onResult(msg);
      break;
  }
}

/**
 * Fills the host status strip from the last usage and devc-bridge status; hides it when neither
 * has anything to show. Marker names and usage labels come from the host's filesystem, so every
 * item is text.
 */
function renderHostStatus() {
  const items = [
    ...(hostUsage ? usageItems(hostUsage, Date.now() / 1000) : []),
    ...(hostBridgeStatus ? bridgeStatusItems(hostBridgeStatus) : []),
  ];
  if (items.length === 0) {
    $hostStatus.hidden = true;
    $hostStatus.replaceChildren();
    return;
  }
  $hostStatus.replaceChildren(
    ...items.map((item) =>
      h('span', {
        class: 'host-status-item',
        'data-state': item.state,
        title: item.title,
      }, item.text)
    ),
  );
  $hostStatus.hidden = false;
}

function patchPane(containerId, pane, merge) {
  const snap = snapshots.get(containerId);
  if (!snap || !Array.isArray(snap.panes)) return;
  const i = snap.panes.findIndex((p) => p.pane_id === pane.pane_id);
  if (i === -1) return;
  snap.panes[i] = merge ? { ...snap.panes[i], ...pane } : pane;
  renderTree();
  renderTileTitles();
}

function onFrame(msg) {
  const key = paneKey(msg.container, msg.pane_id);
  const bytes = decodeBase64(msg.bytes);
  for (const view of views.values()) {
    if (view.openKey !== key) continue;
    view.renderer.write(bytes, msg.cols, msg.rows);
    view.frames++;
  }
}

function onPaneClosed(containerId, paneId, reason) {
  const key = paneKey(containerId, paneId);
  for (const [id, view] of views) {
    if (view.openKey !== key) continue;
    view.openKey = null;
    view.closedReason = reason;
    updateOverlay(id);
  }
}

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
  const selection = pendingSelections.get(msg.id);
  if (selection) {
    pendingSelections.delete(msg.id);
    clearTimeout(selection.timer);
    if (msg.ok) selection.resolve(String(msg.result?.text ?? ''));
    else {
      selection.reject(
        new Error(msg.error?.message ?? msg.error?.code ?? 'failed'),
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
  if (pendingOpens.has(msg.id)) {
    const tileId = pendingOpens.get(msg.id);
    pendingOpens.delete(msg.id);
    const view = views.get(tileId);
    if (view && !msg.ok) {
      view.openKey = null;
      view.closedReason = msg.error?.message ?? 'open failed';
      updateOverlay(tileId);
    }
    return;
  }
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

function list(v) {
  return Array.isArray(v)
    ? v
    : v && typeof v === 'object'
    ? Object.values(v)
    : [];
}

function byNumber(a, b) {
  return (a.number ?? 0) - (b.number ?? 0);
}

function containerByFolder(localFolder) {
  for (const c of containers.values()) {
    if (c.localFolder === localFolder) return c;
  }
  return null;
}

function findPane(containerId, paneId) {
  return list(snapshots.get(containerId)?.panes).find((p) =>
    p.pane_id === paneId
  ) ?? null;
}

/** A pane's agent status as a dot and its short word; the agent's name and full status are in the tooltip. */
function badge(pane) {
  if (!pane?.agent) return '';
  const status = agentStatus(pane);
  return h(
    'span',
    {
      class: 'badge',
      'data-status': status,
      title: `${pane.agent}: ${status}`,
    },
    statusShort(status),
  );
}

/**
 * A collapsed container row's summary of its agents: the status most in need of attention,
 * with how many agents share it when more than one does. Every agent is in the tooltip.
 */
function rollupBadge(panes) {
  const top = topStatus(panes);
  if (!top) return '';
  return h(
    'span',
    {
      class: 'badge',
      'data-status': top.status,
      title: panes.filter((p) => p.agent).map((p) =>
        `${paneTitle(p)}: ${p.agent} ${agentStatus(p)}`
      ).join('\n'),
    },
    top.count > 1
      ? `${top.count} ${statusShort(top.status)}`
      : statusShort(top.status),
  );
}

/** A container's name, told apart from any other container with the same name. */
function displayName(c) {
  return containerLabel(c, containers.values());
}

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

const SIDEBAR_KEY = 'devc-web-sidebar-v1';
/**
 * Containers without a usable Herdr: their rows offer Start Herdr / Retry and list no panes.
 * They are still running, so they stay in the main list.
 */
const INACTIVE_STATES = new Set([
  'no-session',
  'no-herdr',
  'unsupported',
  'error',
]);
/**
 * User-visible names for what the sidebar lists under a container. A *terminal* is a Herdr
 * pane: code and protocol keep saying `pane`, the page says "terminal". Kept here so a rename
 * is one edit.
 */
const LABELS = {
  terminals: 'Terminals',
  files: 'Files',
  newTerminalHere: 'New terminal here',
  newFile: 'New file…',
  newFolder: 'New folder…',
  renameEntry: 'Rename…',
  deleteEntry: 'Delete…',
  copyPath: 'Copy path',
  copyContainerPath: 'Copy container path',
  openInCode: 'Open in Code',
  /** Pinned files; never "pin" alone, which a project and a preview tile also use. */
  pinned: 'Pinned',
  pinFile: 'Pin file',
  unpinFile: 'Unpin file',
  newNote: 'New note…',
  tasks: 'Tasks',
  newTask: 'New task…',
  newTaskHere: 'New task here…',
  pinTaskDefault: 'Make these the default for new tasks',
  unpinTaskDefault: 'Default for new tasks: click to clear',
  collapseAll: 'Collapse all',
  noTasks: 'No tasks',
  sentTasks: 'Sent',
  notRouted: 'not routed',
  notRunning: 'The container is not running',
  plainTerminal: 'Terminal',
  /** The + menu's agents (ids from `lib/agent_icons.js`). */
  agents: {
    claude: 'Claude',
    copilot: 'Copilot',
    pi: 'Pi',
    opencode: 'OpenCode',
  },
  noTerminals: 'No terminals',
  openHere: 'Open terminal here',
  newTerminal: 'New terminal',
  splitRight: 'Split vertically',
  splitBelow: 'Split horizontally',
  newInStack: 'New terminal in this stack',
  newAtEnd: 'New terminal at end',
  close: 'Close terminal…',
  keepOpen: 'Keep open',
  closeRequest: 'Close terminal',
  rename: 'Rename terminal',
  renamePrompt: 'Terminal name',
  closed: 'Terminal closed',
  clickToOpen: 'Click a terminal in the sidebar to open it here.',
  dragHere: 'Drag a terminal here, or click one in the sidebar.',
};

const STATE_TEXT = {
  connecting: 'connecting…',
  'no-session': 'no session',
  'no-herdr': 'no herdr',
  unsupported: 'unsupported',
  error: 'error',
};

/**
 * Collapsed containers (by local folder), containers whose Repos row is open, whether "Not
 * running" is open, which of its projects are expanded, each repo's open folders, and the
 * sidebar's own width and hidden state, per browser.
 */
const sidebarState = loadSidebarState();

function loadSidebarState() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null');
  } catch { /* unavailable or corrupt: everything starts expanded */ }
  return {
    collapsed: new Set(
      Array.isArray(saved?.collapsed)
        ? saved.collapsed.filter((f) => typeof f === 'string')
        : [],
    ),
    /** Containers (by local folder) whose Terminals row is collapsed; new ones start open. */
    terminalsClosed: new Set(
      Array.isArray(saved?.terminalsClosed)
        ? saved.terminalsClosed.filter((f) => typeof f === 'string')
        : [],
    ),
    reposOpen: new Set(
      Array.isArray(saved?.reposOpen)
        ? saved.reposOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    inactiveOpen: saved?.inactiveOpen === true,
    projectsOpen: new Set(
      Array.isArray(saved?.projectsOpen)
        ? saved.projectsOpen.filter((f) => typeof f === 'string')
        : [],
    ),
    /** @type {Record<string, string[]>} repo folder (file root) → open paths ('' is the root) */
    filesOpen: savedFilesOpen(saved?.rootsOpen),
    layoutOpen: saved?.layoutOpen !== false,
    pinnedOpen: saved?.pinnedOpen !== false,
    tasksOpen: saved?.tasksOpen !== false,
    /** Task groups (by `groupTasks` key) that are collapsed; new ones start open. */
    taskGroupsClosed: new Set(
      Array.isArray(saved?.taskGroupsClosed)
        ? saved.taskGroupsClosed.filter((f) => typeof f === 'string')
        : [],
    ),
    sentOpen: saved?.sentOpen === true,
    width: Number.isFinite(saved?.width) ? saved.width : SIDEBAR_DEFAULT_WIDTH,
    hidden: saved?.hidden === true,
  };
}

function savedFilesOpen(v) {
  /** @type {Record<string, string[]>} */
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [folder, paths] of Object.entries(v)) {
    if (!Array.isArray(paths)) continue;
    const kept = paths.filter((p) => typeof p === 'string');
    if (kept.length) out[folder] = kept;
  }
  return out;
}

function saveSidebarState() {
  try {
    localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({
        collapsed: [...sidebarState.collapsed],
        terminalsClosed: [...sidebarState.terminalsClosed],
        reposOpen: [...sidebarState.reposOpen],
        inactiveOpen: sidebarState.inactiveOpen,
        projectsOpen: [...sidebarState.projectsOpen],
        // Not `filesOpen`: entries saved under that name were keyed by project, not by repo.
        rootsOpen: sidebarState.filesOpen,
        layoutOpen: sidebarState.layoutOpen,
        pinnedOpen: sidebarState.pinnedOpen,
        tasksOpen: sidebarState.tasksOpen,
        taskGroupsClosed: [...sidebarState.taskGroupsClosed],
        sentOpen: sidebarState.sentOpen,
        width: sidebarState.width,
        hidden: sidebarState.hidden,
      }),
    );
  } catch { /* storage unavailable: collapsing just won't survive a reload */ }
}

function toggleContainer(c) {
  if (!sidebarState.collapsed.delete(c.localFolder)) {
    sidebarState.collapsed.add(c.localFolder);
  }
  saveSidebarState();
  renderTree();
}

/** Opens or closes a container's Terminals row (by its local folder). */
function toggleTerminals(localFolder) {
  if (!sidebarState.terminalsClosed.delete(localFolder)) {
    sidebarState.terminalsClosed.add(localFolder);
  }
  saveSidebarState();
  renderTree();
}

/** Opens or closes a container's Repos row (by its local folder). */
function toggleRepos(localFolder) {
  if (!sidebarState.reposOpen.delete(localFolder)) {
    sidebarState.reposOpen.add(localFolder);
  }
  saveSidebarState();
  renderTree();
}

function togglePinnedSection() {
  sidebarState.pinnedOpen = !sidebarState.pinnedOpen;
  saveSidebarState();
  renderTree();
}

function toggleTasksSection() {
  sidebarState.tasksOpen = !sidebarState.tasksOpen;
  saveSidebarState();
  renderTree();
}

/** Opens or closes a task group (by its `groupTasks` key). */
function toggleTaskGroup(key) {
  if (!sidebarState.taskGroupsClosed.delete(key)) {
    sidebarState.taskGroupsClosed.add(key);
  }
  saveSidebarState();
  renderTree();
}

function toggleSentTasks() {
  sidebarState.sentOpen = !sidebarState.sentOpen;
  saveSidebarState();
  renderTree();
}

/** The Tasks heading's Collapse all: closes its task groups and Sent; the section stays open. */
function collapseTasks() {
  Object.assign(
    sidebarState,
    collapseTasksState(sidebarState, groupTasks(tasks).map((g) => g.key)),
  );
  saveSidebarState();
  renderTree();
}

/**
 * The Containers heading's Collapse all: closes every row under it, at every level, including the
 * saved folders of file trees not drawn yet. Containers and projects known now stay collapsed
 * when they come back.
 */
function collapseContainers() {
  // Each clear() saves its tree's (now empty) open folders: before the state below, not after.
  for (const { tree } of fileTrees.values()) tree.clear();
  restoringFiles.clear();
  Object.assign(
    sidebarState,
    collapseContainersState(sidebarState, [
      ...[...containers.values()].map((c) => c.localFolder),
      ...projects.keys(),
    ]),
  );
  saveSidebarState();
  renderTree();
}

function toggleLayoutSection() {
  sidebarState.layoutOpen = !sidebarState.layoutOpen;
  saveSidebarState();
  renderTree();
}

function toggleInactive() {
  sidebarState.inactiveOpen = !sidebarState.inactiveOpen;
  saveSidebarState();
  renderTree();
}

/**
 * Applies the sidebar's width and hidden state. The width is clamped to the window as it is
 * now; the saved one stays as chosen, so it comes back when the window grows again.
 */
function applySidebarLayout() {
  $app.dataset.sidebar = sidebarState.hidden ? 'hidden' : 'shown';
  $app.style.setProperty(
    '--sidebar-width',
    `${clampSidebarWidth(sidebarState.width, innerWidth)}px`,
  );
}

function toggleSidebarHidden() {
  sidebarState.hidden = !sidebarState.hidden;
  saveSidebarState();
  applySidebarLayout();
}

$sidebarHide.addEventListener('click', toggleSidebarHidden);
$sidebarShow.addEventListener('click', toggleSidebarHidden);
window.addEventListener('resize', applySidebarLayout);

// The page's URL, token included: devc-desktop's window has no address bar, and a container or
// another browser may need it. The toast names it without showing it, since it is the token.
document.getElementById('copy-url')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(location.href).then(
    () => toast('Copied page URL'),
    (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
  );
});

// The handle drags with pointer capture, so Golden Layout and the terminals never see the move.
$resizer.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  $resizer.setPointerCapture(ev.pointerId);
  $resizer.classList.add('dragging');
  document.body.classList.add('resizing-sidebar');
  const left = $app.getBoundingClientRect().left;
  const onMove = (/** @type {PointerEvent} */ e) => {
    sidebarState.width = clampSidebarWidth(e.clientX - left, innerWidth);
    applySidebarLayout();
  };
  const onEnd = () => {
    $resizer.removeEventListener('pointermove', onMove);
    $resizer.removeEventListener('lostpointercapture', onEnd);
    $resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-sidebar');
    saveSidebarState();
  };
  $resizer.addEventListener('pointermove', onMove);
  $resizer.addEventListener('lostpointercapture', onEnd);
});
$resizer.addEventListener('dblclick', () => {
  sidebarState.width = SIDEBAR_DEFAULT_WIDTH;
  saveSidebarState();
  applySidebarLayout();
});

function chevron() {
  return h('span', { class: 'chevron', 'aria-hidden': 'true' });
}

/**
 * The sidebar: the Pinned section (pinned files, only while something is pinned), the Tasks
 * section, the Layout section (the Golden Layout tree,
 * single-child levels folded), then Containers (Container → Terminals → terminal, Container → Repos → repo → files, and
 * Container → Files → the container's own files from `/`).
 * Herdr tabs group nothing here: a pane the Herdr TUI split into a shared tab is just another pane.
 * Every running container is listed, Herdr or not; projects without one are listed last, under a
 * collapsed "Not running" group.
 */
function renderTree() {
  const generation = ++renderGeneration;
  const scroll = $tree.scrollTop;
  const focusKey = focusedTreeKey($tree);
  // A just-created row takes the focus only from the sidebar, never from a terminal.
  const active = document.activeElement;
  const mayFocus = !active || active === document.body ||
    $tree.contains(active);
  const typing = newEntry !== null && active === newEntry.input;
  const caret = typing
    ? [newEntry.input.selectionStart, newEntry.input.selectionEnd]
    : null;
  const rows = [
    ...pinnedFileRows(),
    ...taskRows(),
    ...layoutRows(),
    sectionRow(
      'Containers',
      undefined,
      undefined,
      rowTrail(
        hoverActions(
          projectStarts ? iconButton('plus', 'Add project…', addProject) : '',
          iconButton('collapseAll', LABELS.collapseAll, collapseContainers),
        ),
      ),
      projectStarts
        ? (e) => openMenu(e, [['Add project…', addProject]])
        : undefined,
    ),
  ];
  // Projects with no running container: stopped, never created, or just pinned.
  const idle = [...projects.values()].filter((p) =>
    p.container !== 'running' && !containerByFolder(p.localFolder)
  ).sort(byPinThenRecent);
  if (containers.size === 0 && idle.length === 0) {
    rows.push(
      h(
        'div',
        { class: 'empty' },
        socket ? 'No running dev containers.' : 'Waiting for devc web…',
      ),
    );
  }
  for (const c of containers.values()) rows.push(...containerRows(c));
  if (idle.length > 0) rows.push(...inactiveRows(idle));
  $tree.replaceChildren(...rows);
  $tree.scrollTop = scroll;
  const created = selectTreeKey === null
    ? null
    : treeRowByKey($tree, selectTreeKey);
  if (created) {
    selectTreeKey = null;
    if (mayFocus) {
      created.focus({ preventScroll: true });
      created.scrollIntoView({ block: 'nearest' });
    }
  } else refocusTreeKey($tree, focusKey);
  if (newEntry !== null && newEntry.seen !== generation) newEntry = null;
  if (typing && newEntry !== null) {
    newEntry.input.focus({ preventScroll: true });
    newEntry.input.setSelectionRange(caret[0], caret[1]);
  }
  for (const [key, rec] of paneRows) {
    if (rec.seen === generation) continue;
    rec.remove?.();
    paneRows.delete(key);
  }
  for (const [key, rec] of fileRows) {
    if (rec.seen === generation) continue;
    rec.remove();
    fileRows.delete(key);
  }
  updateCurrent();
}

/** A section heading; collapsible when `open` is given. */
function sectionRow(title, open, onToggle, trail = '', oncontextmenu) {
  return h(
    'div',
    {
      class: 'row section',
      style: '--depth: 0',
      'aria-expanded': open === undefined ? undefined : String(open),
      onclick: onToggle,
      oncontextmenu,
    },
    h('span', { class: 'label' }, open === undefined ? '' : chevron(), title),
    trail,
  );
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Layout section
// ---------------------------------------------------------------------------------------------

/** The folded layout tree, and a signature that also covers what each tile shows. */
function layoutState() {
  const tree = tiling ? foldTree(tiling.tree()) : null;
  const refs = tiling
    ? tiling.tiles().map((t) =>
      `${t.id}=${
        t.file
          ? fileKey(t.file)
          : t.ref
          ? `${t.ref.localFolder}\n${t.ref.pane_id}`
          : ''
      }${t.preview ? '*' : ''}`
    ).sort().join(';')
    : '';
  return { tree, signature: `${treeSignature(tree)}|${refs}` };
}

/** Re-renders the sidebar when the layout's shape or the tiles' panes changed. */
function layoutChanged() {
  if (layoutState().signature !== layoutSignature) renderTree();
}

function layoutRows() {
  const { tree, signature } = layoutState();
  layoutSignature = signature;
  const rows = [
    sectionRow('Layout', sidebarState.layoutOpen, toggleLayoutSection),
  ];
  if (!sidebarState.layoutOpen) return rows;
  if (!tree) {
    rows.push(h('div', { class: 'empty' }, 'No tiles open'));
    return rows;
  }
  const tilesById = new Map(tiling.tiles().map((t) => [t.id, t]));
  const walk = (node, depth) => {
    if (node.kind === 'tile') {
      const tile = tilesById.get(node.id);
      if (tile) rows.push(layoutTileRow(tile, node.active, depth));
      return;
    }
    rows.push(layoutNodeRow(node, depth, tilesById));
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 1);
  return rows;
}

/** The container and pane a ref points at, when they are known. */
function resolveRef(ref) {
  const c = ref ? containerByFolder(ref.localFolder) : null;
  const pane = c && ref ? findPane(c.id, ref.pane_id) : null;
  return { c, pane };
}

/** A tile's label (see `paneLabel`), the same as its sidebar row's. */
function refLabel(ref) {
  if (!ref) return { name: 'empty', title: '' };
  const { pane } = resolveRef(ref);
  return pane ? paneLabel(pane) : { name: ref.pane_id, title: '' };
}

/** A tile's tooltip lines: its container (which its label leaves out), label and folder. */
function refTooltip(ref) {
  if (!ref) return [];
  const { c, pane } = resolveRef(ref);
  return [
    c ? displayName(c) : basename(ref.localFolder),
    labelText(refLabel(ref)),
    pane?.foreground_cwd || pane?.cwd || '',
  ].filter((s) => s);
}

/** A Layout tile row's classes: `background` behind its stack's front tab, `preview` (italic). */
function tileRowClass(tile, active) {
  return [
    'row layout-node tile',
    active ? '' : 'background',
    tile.preview ? 'preview' : '',
  ].filter((s) => s).join(' ');
}

function layoutTileRow(tile, active, depth) {
  if (tile.kind === 'file') return layoutFileTileRow(tile, active, depth);
  const { c, pane } = resolveRef(tile.ref);
  return h(
    'div',
    {
      class: tileRowClass(tile, active),
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      'data-pane-key': c && tile.ref
        ? paneKey(c.id, tile.ref.pane_id)
        : undefined,
      title: [...refTooltip(tile.ref), active ? '' : 'Background tab']
        .filter((s) => s).join('\n') || undefined,
      onclick: () => revealTile(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ agent: pane?.agent, empty: !tile.ref }),
      ...labelParts(refLabel(tile.ref)),
    ),
    rowTrail(
      badge(pane),
      hoverActions(
        iconButton('close', 'Close tile', () => tiling?.close(tile.id)),
      ),
    ),
  );
}

/** A file tile's Layout row: the file's name, its host path as the tooltip. */
function layoutFileTileRow(tile, active, depth) {
  return h(
    'div',
    {
      class: tileRowClass(tile, active),
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      title: [
        tile.file ? fileHostPath(tile.file) : '',
        active ? '' : 'Background tab',
      ].filter((s) => s).join('\n') || undefined,
      onclick: () => revealTile(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ kind: 'file' }),
      fileTileTitle(tile.file, fileViews.get(tile.id)?.dirty),
    ),
    rowTrail(
      hoverActions(
        iconButton('close', 'Close tile', () => closeTile(tile.id)),
      ),
    ),
  );
}

/** Every tile under a layout node, in order. */
function nodeTiles(node, tilesById) {
  if (node.kind === 'tile') {
    const tile = tilesById.get(node.id);
    return tile ? [tile] : [];
  }
  return node.children.flatMap((child) => nodeTiles(child, tilesById));
}

function layoutNodeRow(node, depth, tilesById) {
  const tiles = nodeTiles(node, tilesById);
  const panes = tiles.map((t) => resolveRef(t.ref).pane).filter((p) => p);
  return h(
    'div',
    {
      class: 'row layout-node',
      style: `--depth: ${depth}`,
      title: node.kind === 'row'
        ? 'Side by side'
        : node.kind === 'column'
        ? 'Stacked vertically'
        : 'Tabs',
      oncontextmenu: (e) => openMenu(e, nodeMenuItems(node, tiles)),
    },
    h(
      'span',
      { class: 'label' },
      h('span', { class: 'node-icon', 'data-kind': node.kind }),
      `${node.kind} · ${tiles.length}`,
    ),
    rowTrail(
      rollupBadge(panes),
      hoverActions(iconButton(
        'close',
        `Close ${
          tiles.length === 1 ? 'its tile' : `its ${tiles.length} tiles`
        }`,
        () => tiling?.close(node.id),
      )),
    ),
  );
}

/** A row's right-hand side: its badge, then buttons shown on hover. */
function rowTrail(...children) {
  return h('span', { class: 'row-trail' }, ...children);
}

/**
 * A row's hover buttons. They show over the row's right end rather than beside its badge, so
 * nothing on the row moves when they appear.
 */
function hoverActions(...buttons) {
  return h('span', { class: 'row-hover' }, ...buttons);
}

const ICON_PATHS = {
  close: 'M4 4l8 8M12 4l-8 8',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
  plus: 'M8 3v10M3 8h10',
  pin: 'M5.5 2.5h5M6.5 2.5v4L4.5 9h7l-2-2.5v-4M8 9v4.5',
  play: 'M5.5 3.5v9l7-4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  project: 'M8 2.5l5 2.75v5.5L8 13.5l-5-2.75v-5.5zM3 5.25L8 8l5-2.75M8 8v5.5',
  // A window with a `>_` prompt: a shell.
  terminal: 'M2 3h12v10H2zM4.5 6.5L6.5 8l-2 1.5M8 10.5h3',
  // A robot head: an agent without a mark of its own.
  agent: 'M3 6h10v7H3zM8 3v3M6 9.5v.01M10 9.5v.01M1.5 9v1.5M14.5 9v1.5',
  // A page with a folded corner: a file tile.
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  // A page of lines: send a task for a plan.
  plan: 'M4 2h8v12H4zM6 5h4M6 7.5h4M6 10h2.5',
  // `</>`: send a task to be implemented.
  implement: 'M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9',
  // A checklist: a new task.
  task: 'M3 4l1.2 1.2L6.5 3M8.5 4.5H13M3 9l1.2 1.2L6.5 8M8.5 9.5H13',
  // Two stacked squares, a minus on the front one: a section's Collapse all (VS Code's).
  collapseAll: 'M5.5 2.5h8v8M2.5 5.5h8v8h-8zM4.5 9.5h4',
};

/**
 * A 14px leading icon for a terminal (its pane's `agent`: that agent's mark, a generic agent
 * glyph, or a shell's) or, with `kind` 'file', for a file tile.
 *
 * @param {{agent?: string | null, kind?: 'file', empty?: boolean}} what
 */
function rowIcon({ agent, kind, empty }) {
  const which = kind ?? terminalIconKind(agent);
  let svg;
  if (which === 'terminal' || which === 'agent' || which === 'file') {
    svg = svgIcon(which);
    svg.setAttribute('data-stroked', '');
  } else {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of AGENT_MARKS[which].paths) {
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      path.setAttribute('d', d);
      svg.append(path);
    }
  }
  return h(
    'span',
    {
      class: 'term-icon',
      'data-kind': which,
      'data-empty': empty || undefined,
    },
    svg,
  );
}

/** @param {keyof ICON_PATHS} icon */
function svgIcon(icon) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[icon]);
  svg.append(path);
  return svg;
}

/**
 * A small icon button for a sidebar row, shown on hover. It stops its clicks (and the
 * mousedown that would start a Golden Layout drag) from reaching the row.
 *
 * @param {keyof ICON_PATHS} icon @param {string} title @param {() => void} action
 */
function iconButton(icon, title, action) {
  const svg = svgIcon(icon);
  const stop = (e) => e.stopPropagation();
  return h('button', {
    type: 'button',
    class: 'icon-btn',
    'data-icon': icon,
    title,
    'aria-label': title,
    onmousedown: stop,
    onpointerdown: stop,
    onclick: (e) => {
      e.stopPropagation();
      action();
    },
  }, svg);
}

/** Brings a tile to the front of its stack and focuses its terminal (or file viewer). */
function revealTile(tileId) {
  tiling?.reveal(tileId);
  focusedTileId = tileId;
  views.get(tileId)?.renderer.focus();
  fileViews.get(tileId)?.viewer?.focus();
}

/** Marks the focused tile's Layout row and its pane's Containers row(s). */
function updateCurrent() {
  const tile = targetTile();
  const { label, branch } = tile ? activeRepo(tile) : {};
  // The title the pane's program sets, as its tab shows it after the name.
  const pane = tile?.ref ? resolveRef(tile.ref).pane : null;
  const title = windowTitle(label, branch, pane ? paneLabel(pane).title : '');
  if (document.title !== title) document.title = title;
  const { c } = resolveRef(tile?.ref ?? null);
  const key = c && tile?.ref ? paneKey(c.id, tile.ref.pane_id) : null;
  for (const row of $tree.querySelectorAll('[data-current]')) {
    row.removeAttribute('data-current');
  }
  if (!tile) return;
  for (const row of $tree.querySelectorAll('.row')) {
    const el = /** @type {HTMLElement} */ (row);
    if (
      el.dataset.tile === tile.id ||
      (key && el.classList.contains('pane') && el.dataset.paneKey === key)
    ) {
      el.setAttribute('data-current', '');
    }
  }
}

/**
 * The repo a tile is in, for the window title: the basename of the repo it belongs to (a
 * worktree's main repo, from `primaryFolder`; else its own folder), and its branch (none while unread, detached or unreadable). That is a repo file's own repo, else the
 * repo whose container folder holds the pane's directory or the container file. Outside every
 * repo, the label is its project's name, as its container row shows it; none for an empty tile.
 */
function activeRepo(tile) {
  const file = tile.kind === 'file' ? tile.file : null;
  const localFolder = file ? file.localFolder : tile.ref?.localFolder;
  if (!localFolder) return {};
  const repos = projectRepos(localFolder);
  let repo;
  if (file && !file.container) {
    repo = repos.find((r) => r.folder === file.root);
  } else if (file) {
    repo = repoAt(repos, fileHostPath(file));
  } else {
    const { pane } = resolveRef(tile.ref);
    repo = repoAt(repos, pane?.foreground_cwd || pane?.cwd || '');
  }
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

// Hovering a pane's row in either section highlights its rows in the other.
$tree.addEventListener('mouseover', (e) => {
  const row = /** @type {HTMLElement} */ (e.target).closest?.(
    '[data-pane-key]',
  );
  const key = row ? /** @type {HTMLElement} */ (row).dataset.paneKey : null;
  for (const el of $tree.querySelectorAll('[data-pane-key]')) {
    el.classList.toggle(
      'linked',
      key !== null && /** @type {HTMLElement} */ (el).dataset.paneKey === key &&
        el !== row,
    );
  }
});
$tree.addEventListener('mouseleave', () => {
  for (const el of $tree.querySelectorAll('.linked')) {
    el.classList.remove('linked');
  }
});

// ---------------------------------------------------------------------------------------------
// Sidebar: menus and actions
// ---------------------------------------------------------------------------------------------

/**
 * Creates a pane in its own Herdr tab and places it with `place`. The tile is placed as soon as
 * the server answers, before Herdr's snapshot lists the pane, so its overlay waits out
 * {@link NEW_PANE_GRACE_MS} instead of saying `LABELS.closed`.
 *
 * @param {ContainerInfo} c
 * @param {{workspace_id?: string, cwd?: string}} opts
 * @param {(ref: PaneRef) => Tile} place
 */
function newShell(c, opts, place) {
  return createPane(
    c,
    { type: 'new_shell', ...opts },
    place,
    LABELS.newTerminal,
  );
}

/**
 * Sends `msg` (`new_shell`, `open_file` or `open_tab`: a message that answers with a pane) for
 * container `c`, then places the pane as {@link newShell} does. A reused pane (`open_tab`'s
 * `reused`) already shown in a tile focuses that tile instead. Placement goes by `c`'s folder
 * only, never its state: an `open_tab` that started Herdr can answer before this page has seen
 * the container connect. A failure is a toast naming `what`.
 *
 * @param {ContainerInfo} c
 * @param {Record<string, unknown> & {type: string}} msg
 * @param {(ref: PaneRef) => Tile} place
 * @param {string} what
 */
async function createPane(c, msg, place, what) {
  const id = `n${++nextRequestId}`;
  /** @type {Promise<{pane_id: string, reused?: boolean}>} */
  const created = new Promise((resolve, reject) =>
    pendingShells.set(id, { resolve, reject })
  );
  send({ ...msg, id, container: c.id });
  let result;
  try {
    result = await created;
  } catch (e) {
    errorToast(`${what} failed: ${e?.message ?? e}`);
    return;
  }
  placePane(c.localFolder, result, place);
}

/**
 * Places a pane a message answered with (see {@link createPane}), in the project at
 * `localFolder`. A reused pane already shown in a tile focuses that tile instead.
 *
 * @param {string} localFolder
 * @param {{pane_id: string, reused?: boolean}} result
 * @param {(ref: PaneRef) => Tile} place
 */
function placePane(localFolder, result, place) {
  if (!tiling) return;
  const ref = { localFolder, pane_id: result.pane_id };
  const shown = result.reused ? tileShowing({ localFolder }, ref) : null;
  if (shown) {
    revealTile(shown.id);
    return;
  }
  newPanes.set(
    `${ref.localFolder}\n${ref.pane_id}`,
    Date.now() + NEW_PANE_GRACE_MS,
  );
  setTimeout(reconcileTiles, NEW_PANE_GRACE_MS + 50);
  const tile = place(ref);
  focusedTileId = tile.id;
  reconcileTiles();
  views.get(tile.id)?.renderer.focus();
}

/** Whether a tile's missing pane is one this page just created and Herdr hasn't listed yet. */
function isNewPane(ref) {
  const key = `${ref.localFolder}\n${ref.pane_id}`;
  const until = newPanes.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  newPanes.delete(key);
  return false;
}

/** The workspace a pane belongs to, through its Herdr tab. */
function paneWorkspace(c, pane) {
  const tab = list(snapshots.get(c.id)?.tabs).find((t) =>
    t.tab_id === pane?.tab_id
  );
  return tab?.workspace_id;
}

/** `new_shell` options for a shell next to `pane`: its workspace, in its current folder. */
function shellOptsNear(c, pane) {
  const opts = {};
  const ws = pane ? paneWorkspace(c, pane) : undefined;
  if (ws) opts.workspace_id = ws;
  const cwd = pane?.foreground_cwd || pane?.cwd;
  if (cwd) opts.cwd = cwd;
  return opts;
}

/** The first tile in `tiles` whose pane is in a connected container, for a new shell's origin. */
function shellOrigin(tiles) {
  for (const tile of tiles) {
    const { c, pane } = resolveRef(tile.ref);
    if (c && c.state === 'connected') return { c, pane };
  }
  return null;
}

/** Places a ref in the focused tile's stack, or in a fresh tile when the layout is empty. */
function placeInFocusedStack(ref) {
  const tile = targetTile();
  return tiling.addBeside(tile?.id ?? null, ref, 'stack');
}

/**
 * Ends a pane's process (and closes its Herdr tab), after asking. Once Herdr confirms, every tile
 * showing the pane closes too, rather than staying behind with "Pane gone".
 */
async function killPane(c, pane) {
  if (
    !await confirmDialog(
      `Close terminal "${paneLabel(pane).name}"? Its process ends.`,
      { okLabel: 'Close terminal', danger: true },
    )
  ) {
    return;
  }
  call({
    type: 'request',
    container: c.id,
    method: 'pane.close',
    params: { pane_id: pane.pane_id },
  }).then(
    () => {
      // Collected first: each close changes `tiling.tiles()`.
      const shown = (tiling?.tiles() ?? []).filter((t) =>
        t.kind !== 'file' && t.ref?.localFolder === c.localFolder &&
        t.ref.pane_id === pane.pane_id
      );
      for (const t of shown) tiling?.close(t.id);
    },
    (err) => errorToast(`${LABELS.closeRequest} failed: ${err.message}`),
  );
}

function killPaneItem(c, pane) {
  return [LABELS.close, () => killPane(c, pane), true];
}

/** @param {Tile} tile @returns {[string, () => void, boolean?][]} */
function tileMenuItems(tile) {
  if (tile.kind === 'file') return fileTileMenuItems(tile);
  const { c, pane } = resolveRef(tile.ref);
  const items = [];
  if (c && c.state === 'connected') {
    const opts = shellOptsNear(c, pane);
    items.push(
      [
        LABELS.splitRight,
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'right')),
      ],
      [
        LABELS.splitBelow,
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'below')),
      ],
      [
        LABELS.newInStack,
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'stack')),
      ],
    );
  }
  if (c && pane) {
    items.push(['Reveal in Containers', () => revealInContainers(c, pane)]);
  }
  const filePin = filePinOfTile(tile);
  if (filePin) {
    items.push([LABELS.unpinFile, () => unpinFile(filePin)]);
  }
  if (tile.preview) items.push(keepOpenItem(tile));
  items.push(['Close', () => tiling?.close(tile.id)]);
  if (c && pane) items.push(killPaneItem(c, pane));
  return items;
}

/** Pins a preview tile: the next sidebar click opens a new preview instead of replacing it. */
function keepOpen(tile) {
  if (!tile?.preview) return;
  tile.setPreview(false);
  layoutChanged();
}

function keepOpenItem(tile) {
  return [LABELS.keepOpen, () => keepOpen(tile)];
}

/** A stack, row or column's menu. */
function nodeMenuItems(node, tiles) {
  const origin = shellOrigin(tiles);
  const items = [];
  if (origin) {
    const opts = shellOptsNear(origin.c, origin.pane);
    items.push([
      node.kind === 'stack' ? LABELS.newInStack : LABELS.newAtEnd,
      () =>
        newShell(
          origin.c,
          opts,
          (ref) => tiling.addBeside(node.id, ref, 'stack'),
        ),
    ]);
  }
  if (node.kind === 'stack') {
    items.push(['Close stack', () => tiling?.close(node.id)]);
  }
  return items;
}

/** A right-click on a stack header's empty area. */
function stackMenu(stackId, e) {
  const { tree } = layoutState();
  const tilesById = new Map((tiling?.tiles() ?? []).map((t) => [t.id, t]));
  // The folded tree has no node for a stack holding one tile: use the raw one.
  const find = (node) => {
    if (!node || node.kind === 'tile') return null;
    if (node.id === stackId) return node;
    for (const child of node.children) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const stack = find(tiling?.tree() ?? null) ?? find(tree);
  if (!stack) return;
  const items = nodeMenuItems(stack, nodeTiles(stack, tilesById));
  if (items.length > 0) openMenu(e, items);
}

/** Expands the pane's container and scrolls its Containers row into view, briefly flashed. */
function revealInContainers(c, pane) {
  if (sidebarState.collapsed.delete(c.localFolder)) {
    saveSidebarState();
    renderTree();
  }
  const row = paneRows.get(paneKey(c.id, pane.pane_id))?.row;
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Containers section
// ---------------------------------------------------------------------------------------------

/** Whether some tile shows the pane. */
function isVisible(c, pane) {
  return (tiling?.tiles() ?? []).some((t) =>
    t.ref?.localFolder === c.localFolder && t.ref.pane_id === pane.pane_id
  );
}

/** The most recently focused tile showing the pane, if any. */
function tileShowing(c, pane) {
  let best = null;
  for (const tile of tiling?.tiles() ?? []) {
    if (
      tile.ref?.localFolder !== c.localFolder ||
      tile.ref.pane_id !== pane.pane_id
    ) continue;
    if (!best || (focusSeq.get(tile.id) ?? 0) > (focusSeq.get(best.id) ?? 0)) {
      best = tile;
    }
  }
  return best;
}

/** A workspace's panes in Herdr's order: by tab number, then as listed within the tab. */
function workspacePanes(ws, tabs, panes) {
  const wsTabs = tabs.filter((t) => t.workspace_id === ws.workspace_id)
    .sort(byNumber);
  return wsTabs.flatMap((tab) => panes.filter((p) => p.tab_id === tab.tab_id));
}

function containerRows(c) {
  const snap = c.state === 'connected' ? snapshots.get(c.id) : undefined;
  const workspaces = list(snap?.workspaces).sort(byNumber);
  const tabs = list(snap?.tabs);
  const panes = list(snap?.panes);
  const collapsed = sidebarState.collapsed.has(c.localFolder);
  const only = workspaces.length === 1 ? workspaces[0] : null;
  const stateText = h(
    'span',
    { class: 'state', 'data-state': c.state },
    STATE_TEXT[c.state] ?? c.state,
  );
  const rows = [
    h(
      'div',
      {
        class: 'row container',
        style: '--depth: 0',
        title: c.error ? `${c.localFolder}\n${c.error}` : c.localFolder,
        'aria-expanded': String(!collapsed),
        onclick: () => toggleContainer(c),
        oncontextmenu: (e) => openMenu(e, projectMenuItems(c.localFolder)),
      },
      h(
        'span',
        { class: 'label' },
        chevron(),
        displayName(c),
        pinMark(c),
        // Expanded, each repo's own marks are right below.
        collapsed ? gitMark(gitRollup(projectRepos(c.localFolder))) : '',
      ),
      INACTIVE_STATES.has(c.state)
        ? h('span', { class: 'row-actions' }, stateText, herdrActions(c))
        : rowTrail(
          c.state !== 'connected'
            ? stateText
            // Expanded, each agent's own badge is right below.
            : collapsed
            ? rollupBadge(panes)
            : '',
          hoverActions(stopButton(c)),
        ),
    ),
  ];
  if (collapsed) return rows;
  rows.push(...terminalRows(c, workspaces, tabs, panes, only));
  rows.push(...repoRows(c.localFolder));
  rows.push(...containerFileRows(c));
  return rows;
}

/**
 * A running container's Terminals row, whatever its Herdr state, and while it is open a row per
 * terminal (Herdr pane) in Herdr's order, space by space. Its + opens a new terminal at the
 * project folder, starting Herdr first when the container has no session (`open_tab`). devc web doesn't manage Herdr spaces (workspaces in the
 * API), so they get no rows of their own; with several, a terminal's tooltip names its space.
 */
function terminalRows(c, workspaces, tabs, panes, only) {
  const open = !sidebarState.terminalsClosed.has(c.localFolder);
  const head = treeRow(
    // No file root is empty, so this never matches a repo's key.
    `${c.localFolder}\n\nterminals`,
    1,
    open,
    { class: 'terminals', onclick: () => toggleTerminals(c.localFolder) },
    LABELS.terminals,
  );
  head.append(
    rowTrail(
      // Open, each agent's own badge is right below.
      open ? '' : rollupBadge(panes),
      newTerminalButton(head, {
        localFolder: c.localFolder,
        root: c.localFolder,
      }, ''),
    ),
  );
  const rows = [head];
  if (!open) return rows;
  const listed = new Set();
  for (const ws of workspaces) {
    const space = only ? '' : ws.label || `space ${ws.number ?? ''}`;
    for (const pane of workspacePanes(ws, tabs, panes)) {
      listed.add(pane.pane_id);
      rows.push(paneRow(c, pane, 2, space));
    }
  }
  // Anything the snapshot didn't place in a workspace's tab still gets a row.
  for (const pane of panes) {
    if (!listed.has(pane.pane_id)) rows.push(paneRow(c, pane, 2));
  }
  if (rows.length === 1) {
    rows.push(
      h(
        'div',
        { class: 'row tree-note', style: '--depth: 2' },
        h('span', { class: 'label' }, LABELS.noTerminals),
      ),
    );
  }
  return rows;
}

/** A container row's Stop button, when its project is known to be running. */
function stopButton(c) {
  const p = projects.get(c.localFolder);
  return p?.container === 'running'
    ? iconButton('stop', 'Stop container…', () => stopProject(p))
    : '';
}

/** A Herdr-less container's hover buttons: Stop, Start Herdr (no session only) and Retry. */
function herdrActions(c) {
  return hoverActions(
    stopButton(c),
    c.state === 'no-session'
      ? iconButton(
        'play',
        'Start Herdr: a Herdr server for this session',
        () => startSession(c.id),
      )
      : '',
    h('button', {
      onclick: (e) => {
        e.stopPropagation();
        send({ type: 'retry', container: c.id });
      },
    }, 'Retry'),
  );
}

/** The "Not running" group: projects without a running container (`idle`). */
function inactiveRows(idle) {
  const rows = [
    h(
      'div',
      {
        class: 'row group',
        style: '--depth: 0',
        'aria-expanded': String(sidebarState.inactiveOpen),
        onclick: toggleInactive,
      },
      h(
        'span',
        { class: 'label' },
        chevron(),
        `Not running (${idle.length})`,
      ),
    ),
  ];
  if (!sidebarState.inactiveOpen) return rows;
  for (const p of idle) {
    rows.push(projectRow(p));
    if (sidebarState.projectsOpen.has(p.localFolder)) {
      // Just its own folder: its files go straight under the project row.
      const fr = { localFolder: p.localFolder, root: p.localFolder };
      const tree = fileTree(fr);
      if (!tree.isOpen('')) tree.expand('');
      rows.push(...rootEntryRows(fr, 2));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Sidebar: projects without a running container
// ---------------------------------------------------------------------------------------------

/** Pinned first, then most recently used, then by name. */
function byPinThenRecent(a, b) {
  return Number(b.pinned) - Number(a.pinned) ||
    (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') ||
    a.name.localeCompare(b.name);
}

/** A pin glyph after a pinned project's name. */
function pinMark(project) {
  if (!projects.get(project.localFolder)?.pinned) return '';
  const mark = h('span', { class: 'pin-mark', title: 'Pinned' });
  mark.append(svgIcon('pin'));
  return mark;
}

/** ↑ push / ↓ pull counts, or a quiet ✓ / •, from `gitSync` or `gitRollup`; nothing for no repo. */
function gitMark(sync) {
  if (!sync) return '';
  return h(
    'span',
    {
      class: 'git-sync',
      title: sync.title,
      'data-diverged': sync.diverged,
    },
    ...sync.marks.map((m) => h('span', { 'data-dir': m.dir }, m.text)),
  );
}

/** A project's repos (its `repos` field), the folder itself first. */
function projectRepos(localFolder) {
  return list(projects.get(localFolder)?.repos);
}

/**
 * An expanded container's repo rows, above its workspaces. With more than one repo they sit under
 * a Repos row (collapsed until opened); with one, its row is directly under the container. A repo
 * row, while expanded, is followed by its worktrees (repo rows of their own), then its files. The
 * project folder always gets a row; a later folder that turned out to be no repo (`git: null`
 * with no `gitProblem`) gets none. One whose status can't be read keeps its row, marked `?`.
 */
function repoRows(localFolder) {
  const repos = projectRepos(localFolder).filter((r, i) =>
    i === 0 || r.git !== null || !!r.gitProblem
  );
  if (repos.length === 0) return [];
  const folders = new Set(repos.map((r) => r.folder));
  // A worktree whose repo has no row of its own is listed as a repo.
  const top = repos.filter((r) => !r.worktreeOf || !folders.has(r.worktreeOf));
  const repoRow = (r, depth) => {
    const fr = { localFolder, root: r.folder };
    const tree = fileTree(fr);
    const rows = [
      treeRow(
        `${treeId(fr)}\n`,
        depth,
        tree.isOpen(''),
        {
          class: 'repo',
          title: r.containerFolder && r.containerFolder !== r.folder
            ? `${r.folder}\n${r.containerFolder}`
            : r.folder,
          onclick: () => tree.toggle(''),
          oncontextmenu: (e) => openMenu(e, dirMenuItems(fr, '')),
        },
        r.name,
        gitMark(gitSync(r.git, r.gitProblem)),
      ),
    ];
    folderTerminalButton(rows[0], fr, '');
    if (tree.isOpen('')) {
      for (const w of repos) {
        if (w !== r && w.worktreeOf === r.folder) {
          rows.push(...repoRow(w, depth + 1));
        }
      }
      rows.push(...rootEntryRows(fr, depth + 1));
    }
    return rows;
  };
  const open = sidebarState.reposOpen.has(localFolder);
  const rows = [
    treeRow(
      // No file root is empty, so this never matches a repo's key.
      `${localFolder}\n\nrepos`,
      1,
      open,
      { class: 'repos', onclick: () => toggleRepos(localFolder) },
      'Repos',
      // Open, each repo's own marks are right below.
      open ? '' : gitMark(gitRollup(repos)),
    ),
  ];
  if (open) {
    for (const r of top) rows.push(...repoRow(r, 2));
  }
  return rows;
}

/**
 * A running container's Files row: its own filesystem from `/`, read with `docker exec` whatever
 * Herdr's state (`list_container_dir`). Collapsed until opened. Open, `/workspaces` and the
 * remote user's home (once the server knows it) come first, each a folder row of its own.
 */
function containerFileRows(c) {
  const fr = containerRoot(c.localFolder);
  const tree = fileTree(fr);
  const rows = [
    treeRow(
      `${treeId(fr)}\n`,
      1,
      tree.isOpen(''),
      {
        class: 'files',
        title: pathTitle(fr, ''),
        onclick: () => tree.toggle(''),
        oncontextmenu: (e) => openMenu(e, dirMenuItems(fr, '')),
      },
      LABELS.files,
    ),
  ];
  if (!tree.isOpen('')) return rows;
  for (const root of containerShortcuts(c)) {
    const sfr = containerRoot(c.localFolder, root);
    const stree = fileTree(sfr);
    rows.push(
      treeRow(
        `${treeId(sfr)}\n`,
        2,
        stree.isOpen(''),
        {
          class: 'files-shortcut',
          title: pathTitle(sfr, ''),
          onclick: () => stree.toggle(''),
          oncontextmenu: (e) => openMenu(e, dirMenuItems(sfr, '')),
        },
        root,
      ),
    );
    if (stree.isOpen('')) rows.push(...rootEntryRows(sfr, 3));
  }
  rows.push(...rootEntryRows(fr, 2));
  return rows;
}

/** The folders a container's Files row lists first: `/workspaces`, then the home when apart. */
function containerShortcuts(c) {
  const home = c.home;
  const apart = typeof home === 'string' && home.startsWith('/') &&
    home !== '/' &&
    !isWithin('/workspaces', home);
  return apart ? ['/workspaces', home] : ['/workspaces'];
}

const PROJECT_STATE_TEXT = {
  starting: 'starting…',
  stopped: 'stopped',
  missing: 'not created',
};

/** Expands or collapses a project under "Not running", which shows its folder's files. */
function toggleProject(localFolder) {
  if (!sidebarState.projectsOpen.delete(localFolder)) {
    sidebarState.projectsOpen.add(localFolder);
  }
  saveSidebarState();
  renderTree();
}

function projectRow(p) {
  const output = projectOutput.get(p.localFolder) ?? [];
  const state = p.starting ? 'starting' : p.container;
  return h(
    'div',
    {
      class: 'row inactive project',
      style: '--depth: 1',
      'data-project': p.localFolder,
      'aria-expanded': String(sidebarState.projectsOpen.has(p.localFolder)),
      title: [p.localFolder, output.at(-1) ?? ''].filter((s) => s).join('\n'),
      onclick: () => toggleProject(p.localFolder),
      oncontextmenu: (e) =>
        openMenu(e, [
          ...projectMenuItems(p.localFolder),
          ...dirMenuItems(
            { localFolder: p.localFolder, root: p.localFolder },
            '',
          ),
        ]),
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      containerLabel(p, projects.values()),
      pinMark(p),
      gitMark(gitRollup(list(p.repos))),
    ),
    h(
      'span',
      { class: 'row-actions' },
      h(
        'span',
        { class: 'state', 'data-state': state },
        p.starting
          ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
          : '',
        PROJECT_STATE_TEXT[state] ?? state,
      ),
      p.starting || !projectStarts ? '' : hoverActions(
        iconButton(
          'play',
          'Start container',
          () => startProject(p.localFolder),
        ),
      ),
    ),
  );
}

/** Container actions for a project (by folder), whichever row its menu is on. */
function projectMenuItems(localFolder) {
  const p = projects.get(localFolder);
  if (!p) return [];
  const items = [];
  if (p.container === 'running') {
    items.push(['Stop container…', () => stopProject(p)]);
  } else if (!p.starting && projectStarts) {
    items.push(['Start container', () => startProject(localFolder)]);
  }
  if (p.pinned || projectStarts) {
    items.push([
      p.pinned ? 'Unpin' : 'Pin',
      () =>
        projectRequest('pin_project', localFolder, 'Pin', {
          pinned: !p.pinned,
        }),
    ]);
  }
  if (!p.pinned && p.container === 'missing' && !p.starting) {
    items.push([
      'Forget',
      () => projectRequest('forget_project', localFolder, 'Forget'),
    ]);
  }
  if (projectOutput.get(localFolder)?.length) {
    items.push(['Show output', () => showOutput(localFolder)]);
  }
  return items;
}

/** Sends a project message; a failure is a toast naming `what`. */
function projectRequest(type, localFolder, what, extra = {}) {
  const id = `r${++nextRequestId}`;
  pendingRequests.set(id, what);
  send({ type, id, localFolder, ...extra });
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/**
 * Asks a yes/no question in a modal `<dialog>`, never the browser's `confirm()`: the desktop app
 * shows devc web with native dialogs turned off, where `confirm()` would answer no unasked.
 * Resolves true on the OK button (or Enter on it), false on Cancel or Escape.
 *
 * @param {string} message
 * @param {{okLabel?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return askDialog(message, null, okLabel, danger).then((v) => v !== null);
}

/**
 * Asks for a line of text in a modal `<dialog>`, never the browser's `prompt()` (see
 * {@link confirmDialog}). Resolves the text on OK or Enter, `null` on Cancel or Escape.
 *
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string | null>}
 */
function promptDialog(message, defaultValue = '') {
  return askDialog(message, defaultValue, 'OK', false);
}

/**
 * The one dialog behind {@link confirmDialog} and {@link promptDialog}: with `value` (a string)
 * it has a text field. Resolves the field's text (`''` without one) on OK, `null` otherwise. The
 * message is text, never markup.
 *
 * @param {string} message @param {string | null} value
 * @param {string} okLabel @param {boolean} danger
 * @returns {Promise<string | null>}
 */
function askDialog(message, value, okLabel, danger) {
  return new Promise((resolve) => {
    let answer = null;
    const $input = value === null ? null : /** @type {HTMLInputElement} */ (h(
      'input',
      {
        type: 'text',
        class: 'ask-input',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': message,
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          ok();
        },
      },
    ));
    if ($input) $input.value = value ?? '';
    const ok = () => {
      answer = $input ? $input.value : '';
      el.close();
    };
    const $ok = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      class: danger ? 'primary danger' : 'primary',
      onclick: ok,
    }, okLabel));
    const el = /** @type {HTMLDialogElement} */ (h(
      'dialog',
      {
        class: 'dialog ask',
        'aria-label': message,
        onclose: () => {
          el.remove();
          resolve(answer);
        },
      },
      h(
        'div',
        { class: 'ask-body' },
        h('p', { class: 'ask-message' }, message),
        $input,
      ),
      h(
        'footer',
        { class: 'dialog-footer ask-footer' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $ok,
      ),
    ));
    document.body.append(el);
    el.showModal();
    if ($input) {
      $input.focus();
      $input.select();
    } else {
      $ok.focus();
    }
  });
}

function startProject(localFolder) {
  projectOutput.set(localFolder, []);
  projectRequest('start_project', localFolder, 'Start container');
}

async function stopProject(p) {
  if (
    await confirmDialog(
      `Stop the container for ${p.name}? Its panes end with it.`,
      { okLabel: 'Stop container', danger: true },
    )
  ) {
    projectRequest('stop_project', p.localFolder, 'Stop container');
  }
}

function addProject() {
  openPicker();
}

/** One line of a container start's output: kept, shown on its row, and in an open dialog. */
function onProjectOutput(localFolder, line) {
  const lines = projectOutput.get(localFolder) ?? [];
  lines.push(line);
  if (lines.length > OUTPUT_LINES) lines.splice(0, lines.length - OUTPUT_LINES);
  projectOutput.set(localFolder, lines);
  for (const row of $tree.querySelectorAll('[data-project]')) {
    const el = /** @type {HTMLElement} */ (row);
    if (el.dataset.project === localFolder) {
      el.title = `${localFolder}\n${line}`;
    }
  }
  if (outputDialog?.localFolder === localFolder) {
    const pre = outputDialog.pre;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    pre.textContent = lines.join('\n');
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  }
}

/** @type {{localFolder: string, pre: HTMLElement, el: HTMLElement} | null} */
let outputDialog = null;

/** A dialog with a project's start output, following it while it runs. */
function showOutput(localFolder) {
  closeOutput();
  const pre = h(
    'pre',
    { class: 'dialog-output' },
    (projectOutput.get(localFolder) ?? []).join('\n'),
  );
  const el = h(
    'div',
    {
      class: 'dialog-backdrop',
      onmousedown: (e) => {
        if (e.target === el) closeOutput();
      },
    },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-label': 'Start output' },
      h(
        'header',
        { class: 'dialog-header' },
        h('span', {}, `Start output · ${basename(localFolder)}`),
        h('button', { type: 'button', onclick: closeOutput }, 'Close'),
      ),
      pre,
    ),
  );
  document.body.append(el);
  pre.scrollTop = pre.scrollHeight;
  outputDialog = { localFolder, pre, el };
}

function closeOutput() {
  outputDialog?.el.remove();
  outputDialog = null;
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Pinned section (pinned files)
// ---------------------------------------------------------------------------------------------

/**
 * A pin's row toggles its file's editor tile. Closing closes the tile only: the editor pane keeps
 * running in Herdr, so the next open (`open_pinned`, which reuses it) brings back the same buffer
 * and unsaved edits. Pins are kept by the server (`~/.config/devc/pinned-files.json`), so every
 * devc web window shows the same ones.
 */
function pinnedFileRows() {
  if (pinnedFiles.length === 0) return [];
  const rows = [
    sectionRow(
      LABELS.pinned,
      sidebarState.pinnedOpen,
      togglePinnedSection,
      rowTrail(hoverActions(iconButton('plus', LABELS.newNote, openNewNote))),
      (e) => openMenu(e, [[LABELS.newNote, openNewNote]]),
    ),
  ];
  if (!sidebarState.pinnedOpen) return rows;
  for (const pin of pinnedFiles) rows.push(filePinRow(pin));
  return rows;
}

/** @param {import('./lib/pinned_files.js').FilePin} pin */
function filePinRow(pin) {
  const open = filePinTiles(pin).length > 0;
  const p = projects.get(pin.localFolder);
  return h(
    'div',
    {
      class: open ? 'row file-pin visible' : 'row file-pin',
      style: '--depth: 1',
      'data-file-pin': pin.id,
      title: [
        childPath(pin.root, pin.path),
        open ? 'Shown in a tile: click to close it' : 'Click to open it',
      ].join('\n'),
      onclick: () => toggleFilePin(pin),
      oncontextmenu: (e) => openMenu(e, filePinMenuItems(pin)),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ kind: 'file' }),
      filePinName(pin),
      h(
        'span',
        { class: 'pane-title' },
        p ? containerLabel(p, projects.values()) : basename(pin.localFolder),
      ),
    ),
    rowTrail(
      open ? h('span', { class: 'file-pin-dot', 'aria-label': 'Open' }) : '',
    ),
  );
}

function onPinnedFiles(msg) {
  pinnedFiles = parsePinnedFiles(msg);
  const ids = new Set(pinnedFiles.map((p) => p.id));
  let pruned = false;
  for (const id of [...filePinPanes.keys()]) {
    if (!ids.has(id)) pruned = filePinPanes.delete(id);
  }
  if (pruned) saveFilePinPanes();
  renderTree();
}

function loadFilePinPanes() {
  let text = null;
  try {
    text = localStorage.getItem(FILE_PIN_PANES_KEY);
  } catch { /* unavailable: a reload forgets which tiles are a pin's */ }
  return parseFilePinPanes(text);
}

function saveFilePinPanes() {
  try {
    localStorage.setItem(
      FILE_PIN_PANES_KEY,
      JSON.stringify(Object.fromEntries(filePinPanes)),
    );
  } catch { /* storage unavailable */ }
}

/**
 * The tiles that are a pin's: those showing its editor pane and, while its project has no running
 * container, file tiles showing its file (the read-only fallback).
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 */
function filePinTiles(pin) {
  const tiles = tiling?.tiles() ?? [];
  const paneId = filePinPanes.get(pin.id);
  const shown = paneId
    ? tilesShowingPane(tiles, { localFolder: pin.localFolder, pane_id: paneId })
    : [];
  if (!containerByFolder(pin.localFolder)) {
    const file = {
      localFolder: pin.localFolder,
      root: pin.root,
      path: pin.path,
    };
    shown.push(...tiles.filter((t) => t.file && sameFile(t.file, file)));
  }
  return shown;
}

/** The pin whose editor pane a tile shows, if any. @param {Tile} tile */
function filePinOfTile(tile) {
  const ref = tile.ref;
  if (!ref) return null;
  return pinnedFiles.find((p) =>
    p.localFolder === ref.localFolder &&
    filePinPanes.get(p.id) === ref.pane_id
  ) ?? null;
}

/**
 * A pin's click: closes the tiles showing it (tiles only, never the pane), else opens it.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 */
function toggleFilePin(pin) {
  const shown = filePinTiles(pin);
  if (shown.length === 0) {
    void openFilePin(pin, 'stack');
    return;
  }
  for (const t of shown) tiling?.close(t.id);
}

/** Pins with an `open_pinned` in flight: a second click waits for the first. */
const openingFilePins = new Set();

/**
 * Opens a pin's file in its editor pane (`open_pinned`: the pane it last had when that is still
 * running, else a new one), in a non-preview tile in the focused stack or to the right. A pane
 * already in a tile is focused there instead. With no running container, the file opens read-only.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 * @param {'stack' | 'right'} where
 */
async function openFilePin(pin, where) {
  if (!tiling || openingFilePins.has(pin.id)) return;
  const c = containerByFolder(pin.localFolder);
  if (!c) {
    openFilePinReadOnly(pin, where);
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  openingFilePins.add(pin.id);
  let result;
  try {
    result = await call({ type: 'open_pinned', pin: pin.id });
  } catch (e) {
    if (e?.code === 'not_running') openFilePinReadOnly(pin, where);
    else errorToast(`Open ${filePinName(pin)} failed: ${e?.message ?? e}`);
    return;
  } finally {
    openingFilePins.delete(pin.id);
  }
  if (typeof result?.pane_id !== 'string') return;
  filePinPanes.set(pin.id, result.pane_id);
  saveFilePinPanes();
  placePane(
    pin.localFolder,
    result,
    where === 'right'
      ? (ref) => tiling.addBeside(targetTile()?.id ?? null, ref, 'right')
      : placeInFocusedStack,
  );
}

/**
 * A pin's file in a file tile (the host-side viewer), for a stopped container: notes stay
 * readable. Offers to start the container.
 *
 * @param {import('./lib/pinned_files.js').FilePin} pin
 * @param {'stack' | 'right'} where
 */
function openFilePinReadOnly(pin, where) {
  openFileTile(
    { localFolder: pin.localFolder, root: pin.root },
    pin.path,
    where,
  );
  const p = projects.get(pin.localFolder);
  toast(
    `${
      filePinName(pin)
    }: the container is not running, so it opened read-only.`,
    projectStarts && p && !p.starting
      ? { label: 'Start', run: () => startProject(pin.localFolder) }
      : undefined,
  );
}

/** A pin's row menu. @param {import('./lib/pinned_files.js').FilePin} pin */
function filePinMenuItems(pin) {
  const fr = { localFolder: pin.localFolder, root: pin.root };
  return [
    ['Open to the right', () => void openFilePin(pin, 'right')],
    ['Open read-only', () => openFileTile(fr, pin.path, 'stack')],
    ['Rename…', () => renameFilePin(pin)],
    ...pathMenuItems(fr, pin.path),
    [LABELS.unpinFile, () => unpinFile(pin)],
  ];
}

/** "Pin file" or "Unpin file" for a repo file's menus. @param {FileRoot} fr @param {string} path */
function filePinItem(fr, path) {
  const pin = pinnedFiles.find((p) => p.root === fr.root && p.path === path);
  return pin
    ? [LABELS.unpinFile, () => unpinFile(pin)]
    : [LABELS.pinFile, () => pinFile(fr, path)];
}

/** @param {FileRoot} fr @param {string} path */
function pinFile(fr, path) {
  call({
    type: 'pin_file',
    localFolder: fr.localFolder,
    root: fr.root,
    path,
  }).then(
    () => {
      if (sidebarState.pinnedOpen) return;
      sidebarState.pinnedOpen = true;
      saveSidebarState();
      renderTree();
    },
    (e) => errorToast(`${LABELS.pinFile} failed: ${e?.message ?? e}`),
  );
}

/** Unpins a file; its editor pane, and any tile showing it, stay. */
function unpinFile(pin) {
  call({ type: 'unpin_file', pin: pin.id }).then(
    () => {
      if (filePinPanes.delete(pin.id)) saveFilePinPanes();
    },
    (e) => errorToast(`${LABELS.unpinFile} failed: ${e?.message ?? e}`),
  );
}

/** Relabels a pin; an empty name, or the file's own, goes back to the file's name. */
async function renameFilePin(pin) {
  const name = await promptDialog('Pinned file name', filePinName(pin));
  if (name === null) return;
  const label = name.trim() === basename(pin.path) ? '' : name.trim();
  call({ type: 'rename_pin', pin: pin.id, label }).catch((e) =>
    errorToast(`Rename failed: ${e?.message ?? e}`)
  );
}

/**
 * The open **New note…** dialog.
 *
 * @type {{el: HTMLDialogElement, $project: HTMLSelectElement, $path: HTMLInputElement,
 *   $error: HTMLElement, $create: HTMLButtonElement, edited: boolean, busy: boolean} | null}
 */
let newNote = null;

/** The repo a project's notes go in: the project folder's own. */
function noteRoot(localFolder) {
  return projectRepos(localFolder)[0]?.folder ?? localFolder;
}

/**
 * **New note…**: a project and a path in its repo (`.plans/notes.md` when the repo has a
 * `.plans/` folder, else `NOTES.md`). Creating makes the file (an existing one is fine) and pins
 * it, then opens it.
 */
function openNewNote() {
  newNote?.el.close();
  const candidates = [...projects.values()].sort(byPinThenRecent);
  if (candidates.length === 0) {
    toast('No projects yet: add one under Containers first');
    return;
  }
  const focused = targetTile();
  const near = focused?.ref?.localFolder ?? focused?.file?.localFolder;
  const initial = (near && projects.has(near) ? near : null) ??
    candidates.find((p) => containerByFolder(p.localFolder))?.localFolder ??
    candidates[0].localFolder;
  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => suggestNotePath(),
    },
    ...candidates.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p.localFolder === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $path = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'picker-path',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Path in the repo',
    oninput: () => {
      if (newNote) newNote.edited = true;
      showNoteError(null);
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void submitNewNote();
    },
  }));
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $create = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void submitNewNote(),
  }, 'Create and pin'));
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note',
      'aria-label': 'New note',
      onclose: () => {
        if (newNote?.el === el) newNote = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, 'New note'),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      h('label', {}, 'Project', $project),
      h('label', {}, "File, in the project's repo", $path),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        'Created if missing (its folder must exist), then pinned',
      ),
      $create,
    ),
  ));
  newNote = {
    el,
    $project,
    $path,
    $error,
    $create,
    edited: false,
    busy: false,
  };
  document.body.append(el);
  el.showModal();
  suggestNotePath();
  $path.focus();
}

/** Fills in the path for the selected project, unless it was typed. */
function suggestNotePath() {
  const nn = newNote;
  if (!nn || nn.edited) return;
  const localFolder = nn.$project.value;
  nn.$path.value = 'NOTES.md';
  showNoteError(null);
  call({ type: 'list_dir', localFolder, root: noteRoot(localFolder), path: '' })
    .then((result) => {
      if (newNote !== nn || nn.edited || nn.$project.value !== localFolder) {
        return;
      }
      nn.$path.value = defaultNotePath(list(result?.entries));
    }, () => {/* NOTES.md stays */});
}

/** Shows `message` under the dialog's fields, or hides it with `null`. */
function showNoteError(message) {
  if (!newNote) return;
  newNote.$error.textContent = message ?? '';
  newNote.$error.hidden = message === null;
}

/**
 * Creates the note (`create_file`, where `exists` is fine: the file is pinned as it is), pins it
 * (`pin_file`) and opens it. A missing folder is reported, not created. With no running
 * container, an existing file is still pinned.
 */
async function submitNewNote() {
  const nn = newNote;
  if (!nn || nn.busy) return;
  const path = nn.$path.value.trim();
  const invalid = notePathError(path);
  if (invalid !== null) {
    showNoteError(invalid);
    return;
  }
  const localFolder = nn.$project.value;
  const root = noteRoot(localFolder);
  const c = containerByFolder(localFolder);
  nn.busy = true;
  nn.$create.disabled = true;
  let pinId;
  try {
    if (c) {
      await call({
        type: 'create_file',
        container: c.id,
        root,
        path,
        kind: 'file',
      })
        .catch((e) => {
          if (e?.code !== 'exists') throw e;
        });
    }
    pinId = (await call({ type: 'pin_file', localFolder, root, path }))?.pin;
  } catch (e) {
    nn.busy = false;
    nn.$create.disabled = false;
    showNoteError(
      !c && e?.code === 'not_found'
        ? `${path} does not exist: start the container to create it`
        : String(e?.message ?? e),
    );
    return;
  }
  nn.el.close();
  if (!sidebarState.pinnedOpen) togglePinnedSection();
  const pin = pinnedFiles.find((p) => p.id === pinId);
  if (!pin) return;
  const shown = filePinTiles(pin);
  if (shown.length) revealTile(shown[0].id);
  else void openFilePin(pin, 'stack');
}

// ---------------------------------------------------------------------------------------------
// Sidebar: Tasks section
// ---------------------------------------------------------------------------------------------

/**
 * The Tasks section: to-dos kept by the server (`~/.config/devc/tasks.json`), each routed to a
 * project's repo or not yet, grouped under a node per route (the unrouted ones last). Sending one
 * starts an agent on it there and moves it under Sent, which reopens that agent's session.
 * Agents never write to the list.
 */
function taskRows() {
  const rows = [
    sectionRow(
      LABELS.tasks,
      sidebarState.tasksOpen,
      toggleTasksSection,
      rowTrail(
        hoverActions(
          iconButton('plus', LABELS.newTask, () => openTaskDialog()),
          iconButton('collapseAll', LABELS.collapseAll, collapseTasks),
        ),
      ),
      (e) => openMenu(e, [[LABELS.newTask, () => openTaskDialog()]]),
    ),
  ];
  if (!sidebarState.tasksOpen) return rows;
  if (tasks.length === 0) {
    rows.push(h('div', { class: 'empty' }, LABELS.noTasks));
  }
  for (const group of groupTasks(tasks)) {
    rows.push(taskGroupRow(group));
    if (!sidebarState.taskGroupsClosed.has(group.key)) {
      for (const task of group.tasks) rows.push(taskRow(task));
    }
  }
  if (sentTasks.length === 0) return rows;
  rows.push(h(
    'div',
    {
      class: 'row sent-tasks',
      style: '--depth: 1',
      'aria-expanded': String(sidebarState.sentOpen),
      onclick: toggleSentTasks,
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      `${LABELS.sentTasks} (${sentTasks.length})`,
    ),
  ));
  if (sidebarState.sentOpen) {
    for (const s of sentTasks) rows.push(sentTaskRow(s));
  }
  return rows;
}

/** The dimmed route after a task's title: its project, and its repo when that is another. */
function taskProjectLabel(localFolder, root) {
  if (localFolder === undefined) return LABELS.notRouted;
  const p = projects.get(localFolder);
  const name = p ? containerLabel(p, projects.values()) : basename(localFolder);
  if (root === undefined || root === localFolder) return name;
  const repo = list(p?.repos).find((r) => r.folder === root);
  return `${name} · ${repo?.name ?? basename(root)}`;
}

/**
 * A task group's node: its route (or `not routed`) and how many tasks it holds. A click opens or
 * closes it; a routed one offers a new task routed there.
 *
 * @param {ReturnType<typeof groupTasks>[number]} group
 */
function taskGroupRow(group) {
  const { key, localFolder, root } = group;
  const route = localFolder === undefined || root === undefined
    ? null
    : { localFolder, root };
  return h(
    'div',
    {
      class: 'row task-group',
      style: '--depth: 1',
      'data-task-group': key,
      'aria-expanded': String(!sidebarState.taskGroupsClosed.has(key)),
      title: route?.root,
      onclick: () => toggleTaskGroup(key),
      oncontextmenu: route
        ? (e) => openMenu(e, [[LABELS.newTaskHere, () => newTaskIn(route)]])
        : undefined,
    },
    h(
      'span',
      { class: 'label' },
      chevron(),
      taskProjectLabel(localFolder, root),
    ),
    rowTrail(
      h('span', { class: 'pane-title' }, String(group.tasks.length)),
      route
        ? hoverActions(
          iconButton('task', LABELS.newTaskHere, () => newTaskIn(route)),
        )
        : '',
    ),
  );
}

/**
 * A task's row, under its group: a click edits it. Its hover buttons send it (to the agent the
 * dialog last sent to) when it is routed, and delete it.
 *
 * @param {import('./lib/tasks.js').Task} task
 */
function taskRow(task) {
  const agentLabel = LABELS.agents[taskSendAgent()];
  return h(
    'div',
    {
      class: 'row task',
      style: '--depth: 2',
      'data-task': task.id,
      title: `${task.text}\n\nClick to edit`,
      onclick: () => openTaskDialog(task),
    },
    h(
      'span',
      { class: 'label' },
      taskTitle(task.text),
    ),
    rowTrail(
      hoverActions(
        ...(task.localFolder === undefined ? [] : [
          iconButton(
            'plan',
            `Send to ${agentLabel}: plan`,
            () => void sendTaskFromRow(task, 'plan'),
          ),
          iconButton(
            'implement',
            `Send to ${agentLabel}: implement`,
            () => void sendTaskFromRow(task, 'implement'),
          ),
        ]),
        iconButton('trash', LABELS.deleteEntry, () => void deleteTask(task)),
      ),
    ),
  );
}

/** The agent the task dialog last sent to, as stored; `null` when there is none. */
function storedTaskAgent() {
  try {
    return localStorage.getItem(TASK_AGENT_KEY);
  } catch {
    return null;
  }
}

/** The default for new tasks pinned in the task dialog; `null` when there is none. */
function storedTaskDefault() {
  try {
    return parseTaskDefault(localStorage.getItem(TASK_DEFAULT_KEY));
  } catch {
    return null;
  }
}

/**
 * Pins `value` as the default for new tasks, or clears it with `null`.
 *
 * @param {import('./lib/tasks.js').TaskDefault | null} value
 */
function storeTaskDefault(value) {
  try {
    if (value === null) localStorage.removeItem(TASK_DEFAULT_KEY);
    else localStorage.setItem(TASK_DEFAULT_KEY, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

/** The agent a task starts on: the pinned default's, else the last one sent to, else Claude. */
function taskSendAgent() {
  return storedTaskDefault()?.agent ?? savedTaskAgent(storedTaskAgent());
}

/** Tasks with a `send_task` from their row in flight: a second click waits for the first. */
const sendingTasks = new Set();

/**
 * Sends a routed task from its row (`send_task`) to the agent the dialog last sent to, and shows
 * the agent's pane in the focused stack.
 *
 * @param {import('./lib/tasks.js').Task} task @param {'plan' | 'implement'} action
 */
async function sendTaskFromRow(task, action) {
  const { localFolder, root } = task;
  if (localFolder === undefined || root === undefined) return;
  if (!tiling || sendingTasks.has(task.id)) return;
  const c = containerByFolder(localFolder);
  if (!c) {
    notRunningToast(localFolder, taskTitle(task.text));
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  sendingTasks.add(task.id);
  let result;
  try {
    result = await call({
      type: 'send_task',
      task: task.id,
      localFolder,
      root,
      agent: taskSendAgent(),
      action,
    });
  } catch (e) {
    if (e?.code === 'not_running') {
      notRunningToast(localFolder, taskTitle(task.text));
    } else errorToast(`Send failed: ${e?.message ?? e}`);
    return;
  } finally {
    sendingTasks.delete(task.id);
  }
  if (typeof result?.pane_id === 'string') {
    placePane(localFolder, result, placeInFocusedStack);
  }
}

/** A new task routed to folder root `fr`'s project and repo. */
function newTaskIn(fr) {
  openTaskDialog(undefined, { localFolder: fr.localFolder, root: fr.root });
}

/** @param {import('./lib/tasks.js').SentTask} s */
function sentTaskRow(s) {
  return h(
    'div',
    {
      class: 'row sent-task',
      style: '--depth: 2',
      'data-sent-task': s.id,
      title: sentTaskTooltip(s, LABELS.agents[s.agent]),
      onclick: () => void openSentTask(s),
      oncontextmenu: (e) =>
        openMenu(e, [
          ['Open session', () => void openSentTask(s)],
          ['Copy task text', () => void copyTaskText(s)],
          ['Back to tasks', () => restoreSentTask(s)],
          ['Remove', () => removeSentTask(s)],
        ]),
    },
    h(
      'span',
      { class: 'label' },
      rowIcon({ agent: s.agent }),
      taskTitle(s.text),
      h(
        'span',
        { class: 'pane-title' },
        taskProjectLabel(s.localFolder, s.root),
      ),
    ),
  );
}

/** @param {import('./lib/tasks.js').Task} task */
async function deleteTask(task) {
  if (
    !await confirmDialog(`Delete the task “${taskTitle(task.text)}”?`, {
      okLabel: 'Delete',
      danger: true,
    })
  ) return;
  call({ type: 'delete_task', task: task.id }).catch((e) =>
    errorToast(`Delete failed: ${e?.message ?? e}`)
  );
}

/** Sent tasks with an `open_sent` in flight: a second click waits for the first. */
const openingSentTasks = new Set();

/**
 * A sent task's session, in the focused stack: its agent's pane while that is still running,
 * else the session resumed in a new tab (`open_sent`). A pane already in a tile is focused.
 *
 * @param {import('./lib/tasks.js').SentTask} s
 */
async function openSentTask(s) {
  if (!tiling || openingSentTasks.has(s.id)) return;
  const c = containerByFolder(s.localFolder);
  if (!c) {
    notRunningToast(s.localFolder, taskTitle(s.text));
    return;
  }
  if (c.state === 'no-session') toast('Starting Herdr…');
  openingSentTasks.add(s.id);
  let result;
  try {
    result = await call({ type: 'open_sent', task: s.id });
  } catch (e) {
    if (e?.code === 'not_running') {
      notRunningToast(s.localFolder, taskTitle(s.text));
    } else errorToast(`Open session failed: ${e?.message ?? e}`);
    return;
  } finally {
    openingSentTasks.delete(s.id);
  }
  if (typeof result?.pane_id !== 'string') return;
  placePane(s.localFolder, result, placeInFocusedStack);
}

/** "`what`: the container is not running", offering to start it. */
function notRunningToast(localFolder, what) {
  const p = projects.get(localFolder);
  toast(
    `${what}: the container is not running.`,
    projectStarts && p && !p.starting
      ? { label: 'Start', run: () => startProject(localFolder) }
      : undefined,
  );
}

/** @param {import('./lib/tasks.js').SentTask} s */
async function copyTaskText(s) {
  try {
    await writeClipboard(s.text);
    toast('Copied');
  } catch (e) {
    errorToast(`Copy failed: ${e?.message ?? e}`);
  }
}

/** @param {import('./lib/tasks.js').SentTask} s */
function restoreSentTask(s) {
  call({ type: 'restore_task', task: s.id }).catch((e) =>
    errorToast(`Back to tasks failed: ${e?.message ?? e}`)
  );
}

/** Forgets a sent task; its agent's pane, if still running, stays. */
function removeSentTask(s) {
  call({ type: 'delete_task', task: s.id }).catch((e) =>
    errorToast(`Remove failed: ${e?.message ?? e}`)
  );
}

/**
 * The open task dialog. `taskId` is the task being edited, or set once a new one is saved.
 *
 * @type {{el: HTMLDialogElement, $text: HTMLTextAreaElement, $project: HTMLSelectElement,
 *   $repo: HTMLSelectElement, $repoLabel: HTMLElement, $agent: HTMLSelectElement,
 *   $error: HTMLElement, $buttons: HTMLButtonElement[], $send: HTMLButtonElement[],
 *   taskId: string | null, busy: boolean} | null}
 */
let taskDialog = null;

/**
 * The task dialog, for a new task or `task`: its text, its route (a project and one of its repos,
 * or none) and an agent. **Save** keeps it on the list; the header's **Send: plan** /
 * **Send: implement** icons save it, then send it (`send_task`) and show the agent's pane.
 *
 * A new task opens routed to `route` when it is given, else to the pinned default's route, else
 * (with no default pinned) to the focused tile's project. The header row's pin makes the
 * dialog's project, repo and agent the default for new tasks, or clears it.
 *
 * @param {import('./lib/tasks.js').Task} [task]
 * @param {{localFolder: string, root: string}} [route]
 */
function openTaskDialog(task, route) {
  taskDialog?.el.close();
  const candidates = [...projects.values()].sort(byPinThenRecent);
  const pinned = storedTaskDefault();
  const pinnedRoute = pinned?.localFolder !== undefined &&
      projects.has(pinned.localFolder)
    ? { localFolder: pinned.localFolder, root: pinned.root ?? null }
    : null;
  const focused = targetTile();
  // A default pinned without a route means "not routed": the focused tile does not count.
  const pinnedUnrouted = pinned !== null && pinned.localFolder === undefined;
  const near = route?.localFolder ?? pinnedRoute?.localFolder ??
    (pinnedUnrouted
      ? undefined
      : focused?.ref?.localFolder ?? focused?.file?.localFolder);
  const initial = task
    ? task.localFolder ?? ''
    : near && projects.has(near)
    ? near
    : '';
  const initialRoot = task ? task.root ?? null : route?.root ??
    (initial === pinnedRoute?.localFolder ? pinnedRoute.root : null);
  const $text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'task-text',
    spellcheck: 'true',
    rows: 8,
    'aria-label': 'Task',
    placeholder: 'What should be done? The first line is its title.',
    oninput: () => showTaskError(null),
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void submitTask(null);
    },
  }));
  $text.value = task?.text ?? '';
  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => {
        fillTaskRepos(null);
        showPinned();
      },
    },
    h('option', { value: '', selected: initial === '' }, '(not routed)'),
    ...candidates.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p.localFolder === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $repo = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'new-note-project',
    'aria-label': 'Repo',
    onchange: () => showPinned(),
  }));
  const $repoLabel = h('label', {}, 'Repo', $repo);
  const $agent = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Agent',
      onchange: () => {
        titleSends();
        showPinned();
      },
    },
    ...TASK_AGENT_IDS.map((id) =>
      h('option', { value: id }, LABELS.agents[id])
    ),
  ));
  $agent.value = taskSendAgent();
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $save = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void submitTask(null),
  }, 'Save'));
  /** @type {['plan', 'implement']} */
  const actions = ['plan', 'implement'];
  const $send = actions.map((
    action,
  ) => /** @type {HTMLButtonElement} */ (iconButton(
    action,
    '',
    () => void submitTask(action),
  )));
  // The icons name the agent they send to, so they follow the Agent dropdown.
  const titleSends = () => {
    const agentLabel = LABELS.agents[$agent.value];
    $send.forEach(($b, i) => {
      const title = `Send to ${agentLabel}: ${actions[i]}`;
      $b.title = title;
      $b.setAttribute('aria-label', title);
    });
  };
  titleSends();
  // The dialog's project, repo and agent, as a default for new tasks would store them.
  const current = () =>
    $project.value === '' ? { agent: /** @type {any} */ ($agent.value) } : {
      localFolder: $project.value,
      root: $repo.value,
      agent: /** @type {any} */ ($agent.value),
    };
  const isPinned = () => {
    const saved = storedTaskDefault();
    const now = current();
    return saved !== null && saved.agent === now.agent &&
      saved.localFolder === now.localFolder && saved.root === now.root;
  };
  const $pin = /** @type {HTMLButtonElement} */ (iconButton('pin', '', () => {
    storeTaskDefault(isPinned() ? null : current());
    showPinned();
    renderTree();
  }));
  // The pin is pressed while the dialog shows the pinned default.
  const showPinned = () => {
    const on = isPinned();
    const title = on ? LABELS.unpinTaskDefault : LABELS.pinTaskDefault;
    $pin.setAttribute('aria-pressed', String(on));
    $pin.title = title;
    $pin.setAttribute('aria-label', title);
  };
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note task-dialog',
      'aria-label': task ? 'Task' : 'New task',
      onclose: () => {
        if (taskDialog?.el === el) taskDialog = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, task ? 'Task' : 'New task'),
      h('span', { class: 'task-send' }, ...$send),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      $text,
      h(
        'div',
        { class: 'task-route' },
        h('label', {}, 'Project', $project),
        $repoLabel,
        h('label', {}, 'Agent', $agent),
        $pin,
      ),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        'Sending starts the agent in the repo',
      ),
      h(
        'span',
        { class: 'task-buttons' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $save,
      ),
    ),
  ));
  taskDialog = {
    el,
    $text,
    $project,
    $repo,
    $repoLabel,
    $agent,
    $error,
    $buttons: [$save, ...$send, $pin],
    $send,
    taskId: task?.id ?? null,
    busy: false,
  };
  document.body.append(el);
  el.showModal();
  fillTaskRepos(initialRoot);
  showPinned();
  $text.focus();
}

/**
 * Lists the selected project's repos (selecting `root` when it is one of them), hides the Repo
 * field when there is no choice, and enables Send only for a routed task.
 */
function fillTaskRepos(root) {
  const td = taskDialog;
  if (!td) return;
  const localFolder = td.$project.value;
  const repos = localFolder === ''
    ? []
    : projectRepos(localFolder).filter((r, i) => i === 0 || r.git !== null);
  if (localFolder !== '' && repos.length === 0) {
    repos.push({ folder: localFolder });
  }
  td.$repo.replaceChildren(
    ...repos.map((r) =>
      h(
        'option',
        { value: r.folder, title: r.folder, selected: r.folder === root },
        r.name ?? basename(r.folder),
      )
    ),
  );
  if (root !== null && repos.some((r) => r.folder === root)) {
    td.$repo.value = root;
  }
  td.$repoLabel.hidden = repos.length < 2;
  for (const b of td.$send) b.disabled = td.busy || localFolder === '';
  showTaskError(null);
}

/** Shows `message` under the task dialog's fields, or hides it with `null`. */
function showTaskError(message) {
  if (!taskDialog) return;
  taskDialog.$error.textContent = message ?? '';
  taskDialog.$error.hidden = message === null;
}

/**
 * Saves the dialog's task (`add_task` or `update_task`), then with `action` sends it
 * (`send_task`) and shows the agent's pane in the focused stack. A failure keeps the dialog open
 * with the error; a task saved before a failed send stays saved, and stays on the list.
 *
 * @param {'plan' | 'implement' | null} action
 */
async function submitTask(action) {
  const td = taskDialog;
  if (!td || td.busy) return;
  const text = td.$text.value.trim();
  if (text === '') {
    showTaskError('Write the task first');
    return;
  }
  const localFolder = td.$project.value;
  const root = td.$repo.value;
  const route = localFolder !== '' && root !== '' ? { localFolder, root } : {};
  if (action !== null && !('localFolder' in route)) {
    showTaskError('Choose a project to send it to');
    return;
  }
  if (action !== null && !containerByFolder(localFolder)) {
    showTaskError('The container is not running: start it first');
    notRunningToast(localFolder, taskTitle(text));
    return;
  }
  const busy = (on) => {
    td.busy = on;
    for (const b of td.$buttons) b.disabled = on;
    if (!on) fillTaskRepos(td.$repo.value);
  };
  busy(true);
  try {
    if (td.taskId === null) {
      td.taskId = (await call({ type: 'add_task', text, ...route }))?.task ??
        null;
    } else {
      await call({ type: 'update_task', task: td.taskId, text, ...route });
    }
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  if (!sidebarState.tasksOpen) toggleTasksSection();
  if (action === null || td.taskId === null) {
    td.el.close();
    return;
  }
  const agent = td.$agent.value;
  try {
    localStorage.setItem(TASK_AGENT_KEY, agent);
  } catch { /* storage unavailable */ }
  const c = containerByFolder(localFolder);
  if (c?.state === 'no-session') toast('Starting Herdr…');
  let result;
  try {
    result = await call({
      type: 'send_task',
      task: td.taskId,
      localFolder,
      root,
      agent,
      action,
    });
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  td.el.close();
  if (typeof result?.pane_id === 'string') {
    placePane(localFolder, result, placeInFocusedStack);
  }
}

// ---------------------------------------------------------------------------------------------
// Directory trees: shared by the repo file trees and the folder picker
// ---------------------------------------------------------------------------------------------

/** Sends `msg` with a fresh id; resolves with its `result`, rejects with its error. */
function call(msg) {
  const id = `c${++nextRequestId}`;
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    send({ ...msg, id });
  });
}

let renderQueued = false;

/** Renders the sidebar once, after everything else that changes in this turn. */
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderTree();
  });
}

/**
 * A tree's rows under `root`: `entryRow` for each entry, and a muted note while a folder loads,
 * when it failed, or when the server cut it short.
 *
 * @param {ReturnType<typeof createDirTree>} tree
 * @param {(item: any) => HTMLElement} entryRow
 */
function treeRows(tree, root, depth, entryRow) {
  return tree.walk(root, depth).map((item) => {
    if (item.type === 'entry') return entryRow(item);
    const text = item.type === 'loading'
      ? 'Loading…'
      : item.type === 'truncated'
      ? '… more not shown'
      : item.message;
    return h(
      'div',
      {
        class: 'row tree-note',
        'data-note': item.type,
        style: `--depth: ${item.depth}`,
      },
      h('span', { class: 'label' }, text),
    );
  });
}

/**
 * A row in a directory tree, focusable for {@link treeKeydown}: a chevron when `expanded` is
 * given, else a gap where it would be.
 *
 * @param {string} key unique within its tree's container
 * @param {number} depth
 * @param {boolean | undefined} expanded
 * @param {Record<string, any>} attrs
 * @param {...(Node|string)} label
 */
function treeRow(key, depth, expanded, attrs, ...label) {
  return h(
    'div',
    {
      ...attrs,
      class: `row tree-row ${attrs.class ?? ''}`,
      style: `--depth: ${depth}`,
      tabindex: '-1',
      'data-tree-key': key,
      'data-depth': depth,
      'aria-expanded': expanded === undefined ? undefined : String(expanded),
    },
    h(
      'span',
      { class: 'label' },
      expanded === undefined
        ? h('span', { class: 'chevron', 'aria-hidden': 'true' })
        : chevron(),
      ...label,
    ),
  );
}

/**
 * Arrow keys and Enter on the tree rows inside `e.currentTarget`: up and down move, right
 * expands (or steps into), left collapses (or steps out), Enter activates.
 *
 * @param {KeyboardEvent} e
 * @param {{activate: (row: HTMLElement) => void, toggle: (row: HTMLElement) => void}} actions
 */
function treeKeydown(e, actions) {
  const row = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (e.target).closest?.('[data-tree-key]')
  );
  if (!row) return;
  const rows = /** @type {HTMLElement[]} */ ([
    ...(/** @type {HTMLElement} */ (e.currentTarget)).querySelectorAll(
      '[data-tree-key]',
    ),
  ]);
  const i = rows.indexOf(row);
  const expanded = row.getAttribute('aria-expanded');
  switch (e.key) {
    case 'ArrowDown':
      rows[i + 1]?.focus();
      break;
    case 'ArrowUp':
      rows[i - 1]?.focus();
      break;
    case 'ArrowRight':
      if (expanded === 'false') actions.toggle(row);
      else if (expanded === 'true') rows[i + 1]?.focus();
      break;
    case 'ArrowLeft': {
      if (expanded === 'true') {
        actions.toggle(row);
        break;
      }
      const depth = Number(row.dataset.depth);
      rows.slice(0, i).reverse().find((r) => Number(r.dataset.depth) < depth)
        ?.focus();
      break;
    }
    case 'Enter':
      actions.activate(row);
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** The tree key of the focused row inside `container`, to focus again after a re-render. */
function focusedTreeKey(container) {
  const el = /** @type {HTMLElement | null} */ (document.activeElement);
  return el && container.contains(el) ? el.dataset.treeKey ?? null : null;
}

/** The row with tree key `key` inside `container`, if there is one. */
function treeRowByKey(container, key) {
  for (const el of container.querySelectorAll('[data-tree-key]')) {
    const row = /** @type {HTMLElement} */ (el);
    if (row.dataset.treeKey === key) return row;
  }
  return null;
}

function refocusTreeKey(container, key) {
  if (key === null) return;
  treeRowByKey(container, key)?.focus({ preventScroll: true });
}

$tree.addEventListener('keydown', (e) =>
  treeKeydown(e, {
    activate: (row) => row.click(),
    toggle: (row) => row.click(),
  }));

// ---------------------------------------------------------------------------------------------
// Sidebar: project files
// ---------------------------------------------------------------------------------------------

/**
 * A file root: `root` is one of the repo folders (`repos[].folder`) of the project at
 * `localFolder`. Paths in a tree are relative to `root`; `localFolder` finds the container. With
 * `container`, `root` is `/` inside that running container (its Files row), not a host folder.
 *
 * @typedef {{localFolder: string, root: string, container?: true}} FileRoot
 */

/**
 * The file root of a project's container's own filesystem: `/` (the Files row), or a folder in it
 * (the `/workspaces` and home rows under it). @returns {FileRoot}
 */
function containerRoot(localFolder, root = '/') {
  return { localFolder, root, container: true };
}

/** `path` under container root `fr` as an absolute container path; the root itself for `''`. */
function containerFilePath(fr, path) {
  return path === '' ? fr.root : childPath(fr.root, path);
}

/**
 * A file root's key: a repo mounted by two projects has a tree in each (container paths differ).
 * A container root's never matches a repo's: those are absolute.
 */
function treeId(fr) {
  if (!fr.container) return `${fr.localFolder}\n${fr.root}`;
  return `${fr.localFolder}\ncontainer${fr.root === '/' ? '' : `:${fr.root}`}`;
}

/** Where a file root's open folders are saved in `sidebarState.filesOpen`. */
function openKey(fr) {
  if (!fr.container) return fr.root;
  return `container:${fr.localFolder}${fr.root === '/' ? '' : `\n${fr.root}`}`;
}

/**
 * A file under `fr`, as a file tile names it. A container file is always under `/`, whichever
 * row it was opened from, so it is one file to tiles and saved layouts. @returns {FileRef}
 */
function fileRefOf(fr, path) {
  if (fr.container) {
    return {
      localFolder: fr.localFolder,
      root: '/',
      path: containerFilePath(fr, path).slice(1),
      container: true,
    };
  }
  return { localFolder: fr.localFolder, root: fr.root, path };
}

/** Each file root's tree, by {@link treeId}: made when its row is first drawn. */
const fileTrees = new Map();
/** Saved open folders of each tree still listing after a reload: one that fails is dropped. */
const restoringFiles = new Map();
/** The container each tree was last listed for, so a container start lists it again. */
const filesListedFor = new Map();

/**
 * @param {FileRoot} fr
 * @returns {ReturnType<typeof createDirTree>}
 */
function fileTree(fr) {
  const id = treeId(fr);
  const entry = fileTrees.get(id);
  if (entry) return entry.tree;
  const { localFolder, root } = fr;
  const tree = createDirTree({
    list: (path) => {
      if (!fr.container) {
        return call({ type: 'list_dir', localFolder, root, path });
      }
      const c = containerByFolder(localFolder);
      return c
        ? call({
          type: 'list_container_dir',
          container: c.id,
          path: containerFilePath(fr, path),
        })
        : Promise.reject(new Error(LABELS.notRunning));
    },
    onChange: () => onFilesChange(fr),
  });
  fileTrees.set(id, { fr: { ...fr }, tree });
  filesListedFor.set(id, containerByFolder(localFolder)?.id ?? null);
  const saved = byDepth(sidebarState.filesOpen[openKey(fr)] ?? []);
  restoringFiles.set(id, new Set(saved));
  for (const p of saved) tree.expand(p);
  return tree;
}

function onFilesChange(fr) {
  const id = treeId(fr);
  const tree = fileTrees.get(id)?.tree;
  if (!tree) return;
  const restoring = restoringFiles.get(id);
  for (const p of [...(restoring ?? [])]) {
    const state = tree.listing(p)?.state;
    if (state === 'loading') continue;
    restoring.delete(p);
    if (state !== 'ok' && tree.isOpen(p)) tree.collapse(p);
  }
  const open = tree.openPaths();
  if (open.length) sidebarState.filesOpen[openKey(fr)] = open;
  else delete sidebarState.filesOpen[openKey(fr)];
  saveSidebarState();
  queueRender();
}

/**
 * Lists a tree again when its project's container came or went: the listing says where each
 * folder is in the container, which only a running one knows.
 */
function relistForContainers() {
  for (const [id, { fr, tree }] of fileTrees) {
    const cid = containerByFolder(fr.localFolder)?.id ?? null;
    if (filesListedFor.get(id) === cid) continue;
    filesListedFor.set(id, cid);
    tree.refresh('');
  }
}

/**
 * `path`'s container path: for a repo, from the nearest listed folder at or above it, else from
 * where the container mounts the repo; null if neither knows.
 */
function containerPathOf(fr, path) {
  if (fr.container) return containerFilePath(fr, path);
  const parts = path === '' ? [] : path.split('/');
  if (containerByFolder(fr.localFolder)) {
    const tree = fileTree(fr);
    for (let n = parts.length; n >= 0; n--) {
      const l = tree.listing(parts.slice(0, n).join('/'));
      if (l?.state === 'ok' && typeof l.containerPath === 'string') {
        return parts.slice(n).reduce(childPath, l.containerPath);
      }
    }
  }
  const mounted = projectRepos(fr.localFolder).find((r) => r.folder === fr.root)
    ?.containerFolder;
  return typeof mounted === 'string' ? parts.reduce(childPath, mounted) : null;
}

/**
 * `path`'s host path: a repo's is under its folder; a container's is known from the nearest
 * listed folder at or above it that a bind mount covers (`hostPath`), or that lists a mount
 * (`mounted`). Null if none does.
 */
function hostPathOf(fr, path) {
  if (!fr.container) return path === '' ? fr.root : childPath(fr.root, path);
  const tree = fileTree(fr);
  const parts = path === '' ? [] : path.split('/');
  for (let n = parts.length; n >= 0; n--) {
    const l = tree.listing(parts.slice(0, n).join('/'));
    if (l?.state !== 'ok') continue;
    if (typeof l.hostPath === 'string') {
      return parts.slice(n).reduce(childPath, l.hostPath);
    }
    const at = n < parts.length ? l.mounted?.[parts[n]] : undefined;
    if (typeof at === 'string') return parts.slice(n + 1).reduce(childPath, at);
  }
  return null;
}

/**
 * A file or folder's tooltip lines for its path: the host path, then for a container's own file
 * its container path (alone when no bind mount covers it).
 */
function pathTitle(fr, path) {
  const host = hostPathOf(fr, path);
  if (!fr.container) return host;
  const inContainer = containerFilePath(fr, path);
  return host === null ? inContainer : `${host}\n${inContainer}`;
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${text}`),
    (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
  );
}

/**
 * **Copy path** (the host path), **Copy container path** and **Open in Code** for a file or
 * folder, each when its path is known. Open in Code needs the host path in one of the project's
 * repos, as the server does.
 */
function pathMenuItems(fr, path) {
  const host = hostPathOf(fr, path);
  const inContainer = containerPathOf(fr, path);
  const inRepo = host !== null &&
    (!fr.container ||
      projectRepos(fr.localFolder).some((r) => isWithin(r.folder, host)));
  return [
    ...(host !== null ? [[LABELS.copyPath, () => copyText(host)]] : []),
    ...(inContainer !== null
      ? [[LABELS.copyContainerPath, () => copyText(inContainer)]]
      : []),
    ...(inRepo ? [[LABELS.openInCode, () => void openInCode(fr, path)]] : []),
  ];
}

/** Opens a file or folder in VS Code on the host (`open_in_code`). */
async function openInCode(fr, path) {
  const c = fr.container ? containerByFolder(fr.localFolder) : null;
  if (fr.container && !c) {
    toast('Start the container first');
    return;
  }
  try {
    await call(
      c
        ? {
          type: 'open_in_code',
          container: c.id,
          path: containerFilePath(fr, path),
        }
        : {
          type: 'open_in_code',
          localFolder: fr.localFolder,
          root: fr.root,
          path,
        },
    );
  } catch (e) {
    errorToast(`Open in Code failed: ${e?.message ?? e}`);
  }
}

/** Opens a repo file in a new pane running the container's editor. */
function openInEditor(fr, path, where) {
  const c = containerByFolder(fr.localFolder);
  if (!c || c.state !== 'connected' || !tiling) {
    toast(
      c ? 'Start Herdr in this container first' : 'Start the container first',
    );
    return;
  }
  createPane(
    c,
    fr.container
      ? { type: 'open_file', path: containerFilePath(fr, path) }
      : { type: 'open_file', root: fr.root, path },
    where === 'right'
      ? (ref) => tiling.addBeside(targetTile()?.id ?? null, ref, 'right')
      : placeInFocusedStack,
    'Open in editor',
  );
}

/**
 * Opens an HTML file in a new browser tab, with the files beside it: the server serves it at a
 * one-off `/preview/…` URL (`preview_file`, `preview_container_file`), sandboxed so the page's own
 * scripts can't reach this one. A container file needs the container running.
 */
async function openInBrowser(fr, path) {
  const c = fr.container ? containerByFolder(fr.localFolder) : null;
  if (fr.container && !c) {
    toast('Start the container first');
    return;
  }
  // Opened now, inside the click, so a popup blocker lets it through; navigated once answered.
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  let result;
  try {
    result = await call(
      c
        ? {
          type: 'preview_container_file',
          container: c.id,
          path: containerFilePath(fr, path),
        }
        : {
          type: 'preview_file',
          localFolder: fr.localFolder,
          root: fr.root,
          path,
        },
    );
  } catch (e) {
    win?.close();
    errorToast(`Open in browser failed: ${e?.message ?? e}`);
    return;
  }
  const url = new URL(String(result?.path ?? ''), location.origin).href;
  if (win) win.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * A Herdr tab at a repo folder (`open_tab`), shown in the focused stack: with `reuse`, a shell
 * already there (its tile focused if it has one), else a new tab. Starts Herdr in a running
 * container that has no session; never starts the container.
 */
function openHerdrTab(fr, path, reuse, agent) {
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast('Start the container first');
    return;
  }
  if (!tiling) return;
  if (c.state === 'no-session') toast('Starting Herdr…');
  createPane(
    c,
    {
      type: 'open_tab',
      root: fr.root,
      path,
      reuse,
      ...(agent ? { agent } : {}),
    },
    placeInFocusedStack,
    agent ? LABELS.agents[agent] : reuse ? LABELS.openHere : LABELS.newTerminal,
  );
}

/**
 * A row's + (the Terminals row, or a folder's in a running container): opens
 * {@link newTerminalMenuItems} for folder `path` under the row's right end. Before it, a button
 * for a new task routed to the folder's project and repo.
 *
 * @param {HTMLElement} row @param {FileRoot} fr @param {string} path
 */
function newTerminalButton(row, fr, path) {
  return hoverActions(
    iconButton('task', LABELS.newTaskHere, () => newTaskIn(fr)),
    iconButton('plus', LABELS.newTerminal, () => {
      // Under the + at the row's right end. The row, not the button: hover buttons can be
      // hidden (zero-sized) by the time the click lands.
      const r = row.getBoundingClientRect();
      openMenuAt(r.right - 20, r.bottom + 2, newTerminalMenuItems(fr, path));
    }),
  );
}

/** Gives a folder's row a {@link newTerminalButton} while its container is running. */
function folderTerminalButton(row, fr, path) {
  if (!fr.container && containerByFolder(fr.localFolder)) {
    row.append(rowTrail(newTerminalButton(row, fr, path)));
  }
}

/**
 * The + menu: a shell or one of the agents, each in a new terminal at folder `path` (`open_tab`,
 * which starts Herdr first when the container has no session).
 */
function newTerminalMenuItems(fr, path) {
  return [
    [
      LABELS.plainTerminal,
      () => openHerdrTab(fr, path, false),
      false,
      rowIcon({}),
    ],
    ...AGENT_IDS.map((id) => [
      LABELS.agents[id],
      () => openHerdrTab(fr, path, false, id),
      false,
      rowIcon({ agent: id }),
    ]),
  ];
}

/** A new terminal at a container folder (`new_shell`), shown in the focused stack. */
function newShellIn(fr, path) {
  const c = containerByFolder(fr.localFolder);
  if (!c || c.state !== 'connected' || !tiling) {
    toast(
      c ? 'Start Herdr in this container first' : 'Start the container first',
    );
    return;
  }
  newShell(c, { cwd: containerFilePath(fr, path) }, placeInFocusedStack);
}

/** A folder's menu: the root itself (`path` '', its repo or Files row) or a directory under it. */
function dirMenuItems(fr, path) {
  return [
    fr.container
      ? [LABELS.newTerminalHere, () => newShellIn(fr, path)]
      : [LABELS.openHere, () => openHerdrTab(fr, path, true)],
    ...(fr.container ? [] : [[LABELS.newTaskHere, () => newTaskIn(fr)]]),
    [LABELS.newFile, () => startNewEntry(fr, path, 'file')],
    [LABELS.newFolder, () => startNewEntry(fr, path, 'dir')],
    ['Refresh', () => fileTree(fr).refresh(path)],
    ...pathMenuItems(fr, path),
    // Not a root: it is the project's repo, or the container's `/`.
    ...(path === '' ? [] : changeEntryItems(fr, path, 'dir')),
  ];
}

/** **Rename…** and **Delete…** for an entry (not a root) of `fr`. */
function changeEntryItems(fr, path, kind) {
  return [
    [LABELS.renameEntry, () => startNewEntry(fr, treeParent(path), kind, path)],
    [LABELS.deleteEntry, () => void deleteEntry(fr, path, kind)],
  ];
}

/** The folder a tree path is in: `''` for the root's own entries. */
function treeParent(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------------------------------------
// Sidebar: new files and folders
// ---------------------------------------------------------------------------------------------

/**
 * Opens the inline name row under folder `path` of `fr`, expanding the folder. Creating needs a
 * running container: the entry is made inside it, as the remote user (`create_file`). With
 * `rename` (an entry of `path`), the row takes that entry's place with its name to edit
 * (`rename_file`).
 *
 * @param {FileRoot} fr @param {string} path @param {'file' | 'dir'} kind
 * @param {string | null} [rename]
 */
function startNewEntry(fr, path, kind, rename = null) {
  if (!containerByFolder(fr.localFolder)) {
    toast('Start the container first');
    return;
  }
  const input = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-entry-input',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': rename !== null
      ? 'New name'
      : kind === 'file'
      ? 'New file name'
      : 'New folder name',
    placeholder: kind === 'file' ? 'File name' : 'Folder name',
  }));
  const oldName = rename === null
    ? ''
    : rename.slice(rename.lastIndexOf('/') + 1);
  input.value = oldName;
  const error = h('div', { class: 'new-entry-error', hidden: '' });
  const row = h(
    'div',
    { class: 'row new-entry', 'data-kind': kind },
    h(
      'span',
      { class: 'label' },
      h('span', { class: 'chevron', 'aria-hidden': 'true' }),
      input,
    ),
    error,
  );
  const entry = {
    fr,
    dir: path,
    kind,
    rename,
    row,
    input,
    error,
    busy: false,
    seen: 0,
  };
  input.addEventListener('keydown', (e) => {
    // The tree's own keys (arrows, Enter) must not act on the rows behind it.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      void submitNewEntry(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelNewEntry(entry);
    }
  });
  input.addEventListener('input', () => showNewEntryError(entry, null));
  newEntry = entry;
  const tree = fileTree(fr);
  if (!tree.isOpen(path)) tree.expand(path);
  renderTree();
  input.focus();
  // A file's name without its extension, ready to retype, as a desktop rename selects it.
  const dot = oldName.lastIndexOf('.');
  input.setSelectionRange(0, kind === 'file' && dot > 0 ? dot : oldName.length);
}

function cancelNewEntry(entry) {
  if (newEntry !== entry) return;
  newEntry = null;
  renderTree();
}

/** Shows `message` under the inline row, or hides it with `null`. */
function showNewEntryError(entry, message) {
  entry.error.textContent = message ?? '';
  entry.error.hidden = message === null;
}

/**
 * Creates the entry named in the inline row. On success the folder is listed again with the new
 * row selected, and a file opens in the editor (as **Open in editor** places it). On failure
 * (`exists` among them) the row stays open with the reason under it.
 */
async function submitNewEntry(entry) {
  if (newEntry !== entry || entry.busy) return;
  const name = entry.input.value;
  const invalid = newEntryNameError(name);
  if (invalid !== null) {
    showNewEntryError(entry, invalid);
    return;
  }
  const { fr, dir, kind } = entry;
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast('Start the container first');
    return;
  }
  const path = childPath(dir, name);
  const where = (p) =>
    fr.container
      ? { path: containerFilePath(fr, p) }
      : { root: fr.root, path: p };
  if (entry.rename === path) {
    cancelNewEntry(entry);
    return;
  }
  entry.busy = true;
  try {
    await call(
      entry.rename !== null
        ? {
          type: 'rename_file',
          container: c.id,
          ...where(entry.rename),
          to: name,
        }
        : { type: 'create_file', container: c.id, ...where(path), kind },
    );
  } catch (e) {
    entry.busy = false;
    showNewEntryError(
      entry,
      e?.code === 'exists' ? `${name} already exists` : String(e?.message ?? e),
    );
    return;
  }
  if (newEntry === entry) newEntry = null;
  selectTreeKey = `${treeId(fr)}\n${path}`;
  fileTree(fr).refresh(dir);
  if (kind === 'file' && entry.rename === null) openInEditor(fr, path, 'stack');
}

/**
 * Deletes an entry of `fr` in the container (`delete_file`), once confirmed: a folder with
 * everything in it. Its folder is listed again; a failure is a toast.
 *
 * @param {FileRoot} fr @param {string} path @param {'file' | 'dir'} kind
 */
async function deleteEntry(fr, path, kind) {
  const c = containerByFolder(fr.localFolder);
  if (!c) {
    toast('Start the container first');
    return;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  const question = kind === 'dir'
    ? `Delete the folder "${name}" and everything in it? This can't be undone.`
    : `Delete "${name}"? This can't be undone.`;
  if (!await confirmDialog(question, { okLabel: 'Delete', danger: true })) {
    return;
  }
  try {
    await call({
      type: 'delete_file',
      container: c.id,
      ...(fr.container
        ? { path: containerFilePath(fr, path) }
        : { root: fr.root, path }),
    });
  } catch (e) {
    errorToast(`Delete failed: ${e?.message ?? e}`);
    return;
  }
  fileTree(fr).refresh(treeParent(path));
}

/**
 * `rows` (a root's entry rows, at `depth`) with the inline name row in place when it belongs to
 * this root: first under its folder's row, or first of all for the root itself.
 *
 * @param {FileRoot} fr @param {number} depth @param {HTMLElement[]} rows
 */
function withNewEntryRow(fr, depth, rows) {
  const entry = newEntry;
  if (entry === null || treeId(entry.fr) !== treeId(fr)) return rows;
  if (!fileTree(fr).isOpen(entry.dir)) return rows;
  if (entry.rename !== null) {
    const key = `${treeId(fr)}\n${entry.rename}`;
    const at = rows.findIndex((r) => r.dataset.treeKey === key);
    if (at === -1) return rows;
    entry.row.style.setProperty(
      '--depth',
      rows[at].dataset.depth ?? String(depth),
    );
    entry.seen = renderGeneration;
    return [...rows.slice(0, at), entry.row, ...rows.slice(at + 1)];
  }
  let at = 0;
  let rowDepth = depth;
  if (entry.dir !== '') {
    const key = `${treeId(fr)}\n${entry.dir}`;
    at = rows.findIndex((r) => r.dataset.treeKey === key) + 1;
    if (at === 0) return rows;
    rowDepth = Number(rows[at - 1].dataset.depth) + 1;
  }
  entry.row.style.setProperty('--depth', String(rowDepth));
  entry.seen = renderGeneration;
  return [...rows.slice(0, at), entry.row, ...rows.slice(at)];
}

function fileMenuItems(fr, path) {
  return [
    ['Open', () => openFileTile(fr, path, 'stack')],
    ['Open to the right', () => openFileTile(fr, path, 'right')],
    ['Open in editor', () => openInEditor(fr, path, 'stack')],
    [
      'Open in editor to the right',
      () => openInEditor(fr, path, 'right'),
    ],
    ...(isHtmlPath(path)
      ? [['Open in browser', () => openInBrowser(fr, path)]]
      : []),
    ...pathMenuItems(fr, path),
    // A repo file only: the container's own files are outside the bind mount.
    ...(fr.container ? [] : [filePinItem(fr, path)]),
    ...changeEntryItems(fr, path, 'file'),
  ];
}

/** The folders and files of an open root, at `depth`, and an inline name row if it has one. */
function rootEntryRows(fr, depth) {
  const tree = fileTree(fr);
  return withNewEntryRow(
    fr,
    depth,
    treeRows(tree, '', depth, (item) => fileEntryRow(fr, tree, item)),
  );
}

function fileEntryRow(fr, tree, item) {
  const { entry, path } = item;
  const dir = opensAsDir(entry);
  const file = opensAsFile(entry);
  const key = `${treeId(fr)}\n${path}`;
  const row = treeRow(
    key,
    item.depth,
    dir ? item.open : undefined,
    {
      class: file && tiling ? 'file-entry file-drag' : 'file-entry',
      'data-kind': entry.kind,
      'data-dim': isHiddenName(entry.name) || (!dir && !file) || undefined,
      title: [
        pathTitle(fr, path),
        entry.size !== undefined ? formatSize(entry.size) : '',
        entry.kind === 'symlink'
          ? entry.to ? 'Symbolic link' : 'Broken symbolic link'
          : '',
      ].filter((s) => s).join('\n'),
      onclick: dir
        ? () => tree.toggle(path)
        : file
        ? () => openFileTile(fr, path, 'preview')
        : undefined,
      ondblclick: file
        ? () => keepOpen(tileShowingFile(fileRefOf(fr, path)))
        : undefined,
      oncontextmenu: (e) =>
        openMenu(
          e,
          dir ? dirMenuItems(fr, path) : file ? fileMenuItems(fr, path) : [
            ...pathMenuItems(fr, path),
            ...changeEntryItems(fr, path, 'file'),
          ],
        ),
    },
    entry.name,
    entry.kind === 'symlink' ? h('span', { class: 'link-mark' }, '→') : '',
  );
  if (dir) folderTerminalButton(row, fr, path);
  return file && tiling ? keptFileRow(key, row, fr, path) : row;
}

/**
 * A file row that is a drag source into the layout (a drop opens a file tile there). The first
 * row made for `key` is kept and brought up to date from `fresh` on each render, so its drag
 * source lives as long as the row is shown (see {@link paneRows}). Its listeners stay the first
 * row's: they act on the same root and path, which is what `key` names.
 *
 * @param {string} key @param {HTMLElement} fresh @param {FileRoot} fr @param {string} path
 */
function keptFileRow(key, fresh, fr, path) {
  const rec = fileRows.get(key);
  if (!rec) {
    const ref = fileRefOf(fr, path);
    fileRows.set(key, {
      row: fresh,
      seen: renderGeneration,
      remove: tiling.dragSource(
        fresh,
        () => ({ file: ref }),
        () => basename(path),
      ),
    });
    return fresh;
  }
  rec.seen = renderGeneration;
  const { row } = rec;
  for (const { name } of [...row.attributes]) {
    if (!fresh.hasAttribute(name)) row.removeAttribute(name);
  }
  for (const { name, value } of [...fresh.attributes]) {
    if (row.getAttribute(name) !== value) row.setAttribute(name, value);
  }
  row.replaceChildren(...fresh.childNodes);
  return row;
}

// ---------------------------------------------------------------------------------------------
// File tiles: a project file in the viewer (viewer.js), read from the host (`read_file`)
// ---------------------------------------------------------------------------------------------

/** A file's host path; a container file's path in the container. */
function fileHostPath(file) {
  return childPath(file.root, file.path);
}

/** The file root a file tile's file is under. @returns {FileRoot} */
function fileRootOf(file) {
  return file.container
    ? containerRoot(file.localFolder)
    : { localFolder: file.localFolder, root: file.root };
}

/** A file tile's title: the file's name, after a dot while it has unsaved edits. */
function fileTileTitle(file, dirty = false) {
  const name = file ? basename(file.path) : 'unknown file';
  return dirty ? `● ${name}` : name;
}

/** The open file tile showing `file`, the most recently focused one if there are several. */
function tileShowingFile(file) {
  let best = null;
  for (const tile of tiling?.tiles() ?? []) {
    if (!tile.file || !sameFile(tile.file, file)) continue;
    if (!best || (focusSeq.get(tile.id) ?? 0) > (focusSeq.get(best.id) ?? 0)) {
      best = tile;
    }
  }
  return best;
}

/**
 * Opens a repo file in a file tile: in the focused stack's preview tile (`'preview'`, a click),
 * in a new tile in the focused stack (`'stack'`), or split to the right of the focused tile. A
 * tile already showing the file is brought forward instead, except for `'right'`. Works whether
 * or not the container runs: the server reads the host side of the mount.
 *
 * @param {FileRoot} fr @param {string} path @param {'preview' | 'stack' | 'right'} where
 */
function openFileTile(fr, path, where) {
  if (!tiling) return;
  const file = fileRefOf(fr, path);
  if (where === 'preview') {
    const shown = tileShowingFile(file);
    if (shown) revealTile(shown.id);
    else openInPreview({ file });
    return;
  }
  if (where === 'stack') {
    const shown = tileShowingFile(file);
    if (shown) {
      revealTile(shown.id);
      return;
    }
  }
  const tile = where === 'right'
    ? tiling.addBeside(targetTile()?.id ?? null, { file }, 'right')
    : placeInFocusedStack({ file });
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  fileViews.get(tile.id)?.viewer?.focus();
}

/**
 * Lines to jump to once a file tile's file has loaded (see {@link openFileAt}), by
 * `localFolder\nroot\npath`. Not part of the tile: the layout saves files, not positions.
 * @type {Map<string, {line: number, column?: number}>}
 */
const pendingLines = new Map();

function fileKey(file) {
  return `${file.localFolder}\n${file.root}\n${file.path}${
    file.container ? '\ncontainer' : ''
  }`;
}

/** Jumps a loaded file tile to the line it was opened at, if any. */
function revealPendingLine(view) {
  const file = view.tile.file;
  const at = file && pendingLines.get(fileKey(file));
  if (!at || !view.viewer) return;
  pendingLines.delete(fileKey(file));
  view.viewer.revealLine(at.line, at.column);
}

/** Opens a repo file in the preview tile, at a 1-based `line` and `column` when given. */
function openFileAt(file, line, column) {
  if (line) pendingLines.set(fileKey(file), { line, column });
  openFileTile(
    { localFolder: file.localFolder, root: file.root },
    file.path,
    'preview',
  );
  const tile = tileShowingFile(file);
  const view = tile && fileViews.get(tile.id);
  if (view) revealPendingLine(view);
}

/** A file tile's menu (its tab, its Layout row, and a right-click in it). */
function fileTileMenuItems(tile) {
  const items = [];
  const file = tile.file;
  const view = fileViews.get(tile.id);
  if (file) {
    const fr = fileRootOf(file);
    if (view?.dirty && fileEditable(view)) {
      items.push(['Save', () => saveFile(view)]);
    }
    if (view) items.push(['Reload', () => reloadFile(view)]);
    items.push(
      ['Open in editor', () => openInEditor(fr, file.path, 'stack')],
    );
    if (isHtmlPath(file.path)) {
      items.push(['Open in browser', () => openInBrowser(fr, file.path)]);
    }
    items.push(...pathMenuItems(fr, file.path));
    if (!file.container) items.push(filePinItem(fr, file.path));
  }
  if (tile.preview) items.push(keepOpenItem(tile));
  items.push(['Close', () => closeTile(tile.id)]);
  return items;
}

/** Builds a file tile's view and reads its file. */
function mountFileTile(tile) {
  const host = h('div', { class: 'file-view' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, host, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);
  body.addEventListener('contextmenu', (e) => {
    // The viewer's own text keeps the browser's menu (copy); the margins get the tile's.
    if (/** @type {HTMLElement} */ (e.target).closest('.cm-content')) return;
    openMenu(e, tileMenuItems(tile));
  });
  // After the factory returns: a title change mid-build would save a half-built layout.
  queueMicrotask(() => {
    if (!fileViews.has(tile.id)) return;
    tile.setTitle(fileTileTitle(tile.file, fileViews.get(tile.id)?.dirty));
    if (tile.file) tile.setTooltip(fileHostPath(tile.file));
  });
  /** @type {FileView} */
  const view = {
    tile,
    host,
    overlay,
    viewer: null,
    state: 'loading',
    error: '',
    seq: 0,
    hash: null,
    dirty: false,
    saving: false,
  };
  fileViews.set(tile.id, view);
  if (tile.file) loadFile(view);
  else {
    view.state = 'error';
    view.error = 'This tile names no file.';
  }
  updateFileOverlay(view);
  queueMicrotask(updatePlaceholder);
}

/**
 * Reads (or re-reads) a file tile's file and shows it. A tile that already shows the file keeps
 * it, scroll position included, while the new read is on its way. Asked while disconnected, the
 * read waits for the next `hello`.
 *
 * @param {FileView} view
 */
async function loadFile(view) {
  const file = view.tile.file;
  if (!file) return;
  const seq = ++view.seq;
  if (!view.viewer) {
    view.state = 'loading';
    updateFileOverlay(view);
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    view.state = 'loading';
    return;
  }
  const c = file.container ? containerByFolder(file.localFolder) : null;
  view.noContainer = file.container === true && !c;
  if (view.noContainer) {
    view.state = 'error';
    view.error = LABELS.notRunning;
    view.viewer?.destroy();
    view.viewer = null;
    updateFileOverlay(view);
    return;
  }
  let result;
  try {
    result = await call(
      c
        ? {
          type: 'read_container_file',
          container: c.id,
          path: childPath('/', file.path),
        }
        : {
          type: 'read_file',
          localFolder: file.localFolder,
          root: file.root,
          path: file.path,
        },
    );
  } catch (e) {
    if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
    view.state = 'error';
    view.error = String(e?.message ?? e);
    view.viewer?.destroy();
    view.viewer = null;
    updateFileOverlay(view);
    return;
  }
  if (seq !== view.seq || !fileViews.has(view.tile.id)) return;
  const text = typeof result?.text === 'string' ? result.text : '';
  view.hash = typeof result?.hash === 'string' ? result.hash : null;
  if (view.viewer) view.viewer.setText(text);
  else {
    view.viewer = createViewer(view.host, {
      name: basename(file.path),
      text,
      onChange: (dirty) => setFileDirty(view, dirty),
      onSave: () => saveFile(view),
    });
  }
  revealPendingLine(view);
  view.state = 'ok';
  view.error = '';
  syncFileEditable(view);
  updateFileOverlay(view);
}

/**
 * Whether a file tile can be edited: its file is shown and its project's container runs, since
 * saves are written in the container as its remote user, never from the host side.
 */
function fileEditable(view) {
  const file = view.tile.file;
  return Boolean(
    file && view.viewer && view.state === 'ok' &&
      containerByFolder(file.localFolder)?.state === 'connected',
  );
}

/** Makes a file tile's viewer editable or read-only to match {@link fileEditable}. */
function syncFileEditable(view) {
  view.viewer?.setEditable(fileEditable(view));
}

/** Marks a file tile edited or not, in its tab and Layout row. A first edit keeps a preview. */
function setFileDirty(view, dirty) {
  if (view.dirty === dirty) return;
  view.dirty = dirty;
  view.tile.setTitle(fileTileTitle(view.tile.file, dirty));
  if (dirty && view.tile.preview) keepOpen(view.tile);
  queueRender();
}

/** Re-reads a file tile's file, after asking when that would drop unsaved edits. */
async function reloadFile(view) {
  if (
    view.dirty &&
    !await confirmDialog(
      `Discard your changes to ${fileTileTitle(view.tile.file)}?`,
      { okLabel: 'Discard', danger: true },
    )
  ) return;
  loadFile(view);
}

/**
 * Saves a file tile's text in the container (`write_file`). Refused because the file changed on
 * disk since it was read, it asks before overwriting; `overwrite` skips that check.
 *
 * @param {FileView} view @param {boolean} [overwrite]
 */
async function saveFile(view, overwrite = false) {
  const file = view.tile.file;
  if (!file || !view.viewer || view.saving || !view.dirty) return;
  const name = fileTileTitle(file);
  const c = containerByFolder(file.localFolder);
  if (!fileEditable(view) || !c) {
    errorToast(`Can't save ${name}: its container is not running`);
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    errorToast(`Can't save ${name}: not connected to devc web`);
    return;
  }
  const text = view.viewer.getText();
  view.saving = true;
  let result;
  try {
    result = await call({
      type: 'write_file',
      container: c.id,
      ...(file.container
        ? { path: childPath('/', file.path) }
        : { root: file.root, path: file.path }),
      text,
      ...(view.hash && !overwrite ? { base: view.hash } : {}),
    });
  } catch (e) {
    view.saving = false;
    if (e?.code !== 'conflict') {
      errorToast(`Couldn't save ${name}: ${e?.message ?? e}`);
      return;
    }
    if (
      fileViews.has(view.tile.id) &&
      await confirmDialog(
        `${name} changed on disk since it was opened. Overwrite it with your changes?`,
        { okLabel: 'Overwrite', danger: true },
      )
    ) saveFile(view, true);
    return;
  }
  view.saving = false;
  view.hash = typeof result?.hash === 'string' ? result.hash : null;
  // Edits typed while the save was on its way stay unsaved.
  if (view.viewer?.getText() === text) view.viewer.markClean();
}

/** Closes a tile, after asking when it is a file tile with unsaved edits. */
async function closeTile(tileId) {
  const view = fileViews.get(tileId);
  if (
    view?.dirty &&
    !await confirmDialog(
      `Close ${fileTileTitle(view.tile.file)} without saving?`,
      { okLabel: 'Close', danger: true },
    )
  ) return;
  tiling?.close(tileId);
}

// Golden Layout closes a tab on its × (and a middle click) with no way to refuse: a file tile
// with unsaved edits asks first. Capture phase, ahead of Golden Layout's own listener.
document.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const tab = /** @type {HTMLElement | null} */ (target.closest?.('.lm_tab'));
  if (!tab || !(target.closest('.lm_close_tab') || e.button === 1)) return;
  const tileId = tab.dataset.tile;
  if (!tileId || !fileViews.get(tileId)?.dirty) return;
  e.preventDefault();
  e.stopPropagation();
  closeTile(tileId);
}, true);

// Leaving the page with unsaved edits: the browser asks.
window.addEventListener('beforeunload', (e) => {
  for (const view of fileViews.values()) {
    if (view.dirty) {
      e.preventDefault();
      return;
    }
  }
});

/** A file tile's overlay: "Loading…", or why the file can't be shown (with "Open in editor"). */
function updateFileOverlay(view) {
  let message = '';
  let action = null;
  if (view.state === 'loading') message = 'Loading…';
  else if (view.state === 'error') {
    message = view.error;
    const file = view.tile.file;
    const c = file ? containerByFolder(file.localFolder) : null;
    if (file && c?.state === 'connected') {
      action = h('button', {
        onclick: () => openInEditor(fileRootOf(file), file.path, 'stack'),
      }, 'Open in editor');
    }
  }
  view.overlay.hidden = message === '';
  view.overlay.replaceChildren(
    h('div', {}, message),
    ...(action ? [action] : []),
  );
}

/** Tears a file tile's view down. */
function unmountFileTile(tile) {
  const view = fileViews.get(tile.id);
  if (!view) return;
  view.seq++;
  view.viewer?.destroy();
  fileViews.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  queueMicrotask(updatePlaceholder);
}

// ---------------------------------------------------------------------------------------------
// "Add project…": the host folder picker
// ---------------------------------------------------------------------------------------------

/**
 * The open picker: its tree of host folders (absolute paths), the folders shown at its top
 * (`null` until the server names the opening roots) and the selected folder.
 *
 * @type {{el: HTMLDialogElement, tree: ReturnType<typeof createDirTree>, $list: HTMLElement,
 *   $path: HTMLInputElement, $pin: HTMLButtonElement, tops: string[] | null,
 *   selected: string | null} | null}
 */
let picker = null;

function openPicker() {
  picker?.el.close();
  const tree = createDirTree({
    list: (path) => call({ type: 'list_host_dir', path }),
    onChange: () => renderPicker(),
  });
  const $list = h('div', {
    class: 'picker-tree',
    role: 'tree',
    'aria-label': 'Host folders',
  });
  $list.addEventListener('keydown', (e) =>
    treeKeydown(e, {
      activate: (row) => pinFolder(row.dataset.path ?? null),
      toggle: (row) => row.dataset.path && tree.toggle(row.dataset.path),
    }));
  const $path = /** @type {HTMLInputElement} */ (h('input', {
    class: 'picker-path',
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    autofocus: true,
    placeholder: 'Pick a folder below, or paste an absolute path',
    'aria-label': 'Folder',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const path = $path.value.trim().replace(/(.)\/+$/, '$1');
      if (path.startsWith('/')) rerootPicker(path);
      else toast('Enter an absolute path');
    },
  }));
  const $pin = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    onclick: () => pinFolder(picker?.selected ?? null),
  }, 'Pin this folder'));
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog picker',
      'aria-label': 'Add project',
      onclose: () => {
        if (picker?.el === el) picker = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, 'Add project'),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h('div', { class: 'picker-body' }, $path, $list),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        h('span', { class: 'project-mark' }, svgIcon('project')),
        'has a dev container config',
      ),
      $pin,
    ),
  ));
  picker = { el, tree, $list, $path, $pin, tops: null, selected: null };
  document.body.append(el);
  el.showModal();
  renderPicker();
  call({ type: 'list_host_dir', path: '' }).then(
    (result) => {
      if (picker?.tree !== tree) return;
      const roots = list(result?.roots).filter((r) => typeof r === 'string');
      picker.tops = roots;
      if (roots.length === 1) tree.expand(roots[0]);
      renderPicker();
    },
    (e) => {
      errorToast(`Add project failed: ${e?.message ?? e}`);
      if (picker?.tree === tree) el.close();
    },
  );
}

/** Shows only `path` at the top of the picker, open and selected. */
function rerootPicker(path) {
  if (!picker) return;
  picker.tops = [path];
  picker.tree.expand(path);
  selectFolder(path);
}

function selectFolder(path) {
  if (!picker) return;
  picker.selected = path;
  if (picker.$path.value !== (path ?? '')) {
    picker.$path.value = path ?? '';
    // The end of a long path is the folder's own name.
    picker.$path.scrollLeft = picker.$path.scrollWidth;
  }
  picker.$pin.disabled = path === null;
  for (const el of picker.$list.querySelectorAll('[data-path]')) {
    const row = /** @type {HTMLElement} */ (el);
    row.toggleAttribute('data-selected', row.dataset.path === path);
    row.setAttribute('aria-selected', String(row.dataset.path === path));
  }
}

/** Pins `path` as a project (`add_project`) and closes the picker. */
function pinFolder(path) {
  if (!picker || !path) return;
  projectRequest('add_project', path, 'Add project');
  // It joins the list as "not created", under "Not running".
  sidebarState.inactiveOpen = true;
  saveSidebarState();
  picker.el.close();
}

/** The top folder the selection is in (else the first): what "Parent folder" goes above. */
function pickerTop() {
  const tops = picker?.tops ?? [];
  const sel = picker?.selected;
  return tops.find((t) =>
    sel && (sel === t || sel.startsWith(t === '/' ? '/' : `${t}/`))
  ) ?? tops[0] ?? null;
}

function renderPicker() {
  if (!picker) return;
  const { tree, $list } = picker;
  const focusKey = focusedTreeKey($list);
  const scroll = $list.scrollTop;
  const rows = [];
  if (picker.tops === null) {
    rows.push(
      h('div', { class: 'row tree-note', style: '--depth: 0' }, 'Loading…'),
    );
  } else {
    const parent = parentDir(pickerTop() ?? '/');
    if (parent !== null) {
      rows.push(
        h(
          'div',
          {
            class: 'row tree-row picker-up',
            style: '--depth: 0',
            title: parent,
            onclick: () => rerootPicker(parent),
          },
          h('span', { class: 'label' }, '↑ Parent folder'),
        ),
      );
    }
    for (const top of picker.tops) {
      rows.push(pickerRow(top, top, 0, tree.isOpen(top), false));
      if (tree.isOpen(top)) {
        rows.push(
          ...treeRows(
            tree,
            top,
            1,
            (item) =>
              pickerRow(
                item.path,
                item.entry.name,
                item.depth,
                item.open,
                item.entry.project === true,
                isHiddenName(item.entry.name),
              ),
          ),
        );
      }
    }
  }
  $list.replaceChildren(...rows);
  $list.scrollTop = scroll;
  selectFolder(picker.selected);
  refocusTreeKey($list, focusKey);
}

function pickerRow(path, name, depth, open, project, hidden = false) {
  return treeRow(
    path,
    depth,
    open,
    {
      class: 'picker-row',
      role: 'treeitem',
      'data-path': path,
      'data-dim': hidden || undefined,
      title: path,
      onfocus: () => selectFolder(path),
      onclick: () => {
        selectFolder(path);
        picker?.tree.toggle(path);
      },
      ondblclick: () => pinFolder(path),
    },
    name,
    project
      ? h('span', {
        class: 'project-mark',
        title: 'Has a dev container config',
      }, svgIcon('project'))
      : '',
  );
}

function paneMenu(rec) {
  const { c, pane } = rec;
  const items = [
    ['Open in new tile', () => openInNewTile(c, pane.pane_id)],
  ];
  const tile = tileShowing(c, pane);
  if (tile) items.push(['Show in layout', () => revealTile(tile.id)]);
  items.push(
    ['Rename…', async () => {
      const label = await promptDialog(LABELS.renamePrompt, paneTitle(pane));
      if (label) {
        request(
          c.id,
          'pane.rename',
          { pane_id: pane.pane_id, label },
          LABELS.rename,
        );
      }
    }],
    killPaneItem(c, pane),
  );
  return items;
}

/**
 * Click: show the pane where it already is, else open it in the focused stack's preview tile.
 * Ctrl/Cmd-click: a new tile that stays.
 */
function onPaneClick(rec, e) {
  if (e.ctrlKey || e.metaKey) {
    openInNewTile(rec.c, rec.pane.pane_id);
    return;
  }
  const tile = tileShowing(rec.c, rec.pane);
  if (tile) revealTile(tile.id);
  else {
    openInPreview({
      localFolder: rec.c.localFolder,
      pane_id: rec.pane.pane_id,
    });
  }
}

/** The preview tile in `anchor`'s stack (`anchor` itself included), or null. */
function previewTileNear(anchor) {
  if (!tiling || !anchor) return null;
  const byId = new Map(tiling.tiles().map((t) => [t.id, t]));
  /** @returns {Tile | null | undefined} undefined: `anchor` isn't under `node` */
  const search = (node) => {
    if (node.kind === 'tile') return undefined;
    if (node.kind === 'stack') {
      if (!node.children.some((ch) => ch.id === anchor.id)) return undefined;
      return node.children.map((ch) => byId.get(ch.id)).find((t) =>
        t?.preview
      ) ?? null;
    }
    for (const child of node.children) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const root = tiling.tree();
  return (root && search(root)) ?? null;
}

/**
 * Shows `ref` (a pane, or `{file}`) in the focused stack's preview tile: in place for a pane
 * replacing a pane, else a new tile in that tile's place; with no preview tile there, an empty
 * focused tile takes it, or a new preview tile joins the stack. The tile is revealed and focused.
 *
 * @param {PaneRef | {file: FileRef}} ref
 */
function openInPreview(ref) {
  if (!tiling) return;
  const anchor = targetTile();
  const preview = previewTileNear(anchor);
  const isFile = 'file' in ref;
  let tile;
  if (preview && !isFile && preview.kind === 'pane') {
    closeTilePane(preview.id);
    views.get(preview.id).closedReason = null;
    preview.setRef(/** @type {PaneRef} */ (ref));
    tiling.reveal(preview.id);
    tile = preview;
  } else if (preview) {
    tile = tiling.replace(preview.id, ref);
  } else if (!isFile && anchor?.kind === 'pane' && !anchor.ref) {
    anchor.setRef(/** @type {PaneRef} */ (ref));
    anchor.setPreview(true);
    tile = anchor;
  } else {
    tile = tiling.addBeside(anchor?.id ?? null, ref, 'stack', {
      preview: true,
    });
  }
  if (!tile) return;
  focusedTileId = tile.id;
  focusSeq.set(tile.id, ++nextFocusSeq);
  reconcileTiles();
  layoutChanged();
  if (isFile) fileViews.get(tile.id)?.viewer?.focus();
  else views.get(tile.id)?.renderer.focus();
}

/** A label's row text (see `paneLabel`): its name, then any agent or command title, muted. */
function labelParts({ name, title }) {
  return title ? [name, h('span', { class: 'pane-title' }, title)] : [name];
}

/**
 * A pane's sidebar row: the kept one for this pane (see {@link paneRows}), brought up to date.
 * `space` names its Herdr space in the tooltip; '' when the container has just one.
 */
function paneRow(c, pane, depth, space = '') {
  const key = paneKey(c.id, pane.pane_id);
  let rec = paneRows.get(key);
  if (!rec) {
    const row = h('div', {
      class: 'row pane',
      onclick: (e) => onPaneClick(rec, e),
      // The two clicks opened it (as a preview); a double-click also keeps it.
      ondblclick: () => keepOpen(tileShowing(rec.c, rec.pane)),
      oncontextmenu: (e) => openMenu(e, paneMenu(rec)),
    });
    rec = { row, c, pane, seen: 0, remove: null };
    paneRows.set(key, rec);
  }
  Object.assign(rec, { c, pane, seen: renderGeneration });
  // Dragging the row into the tiling area opens the pane in a new tile where it lands. Golden
  // Layout only starts a drag on the row itself, so its children ignore the pointer (CSS).
  if (!rec.remove && tiling) {
    const r = rec;
    rec.remove = tiling.dragSource(
      r.row,
      () => ({ localFolder: r.c.localFolder, pane_id: r.pane.pane_id }),
      () => labelText(paneLabel(r.pane)),
    );
  }
  const { row } = rec;
  const visible = isVisible(c, pane);
  row.style.setProperty('--depth', String(depth));
  row.dataset.paneKey = key;
  row.classList.toggle('visible', visible);
  // The children ignore the pointer, so the badge's tooltip lives here.
  row.title = [
    paneTitle(pane),
    pane.foreground_cwd || pane.cwd || '',
    space ? `Space: ${space}` : '',
    pane.agent ? `${pane.agent}: ${agentStatus(pane)}` : '',
    visible ? 'Shown in a tile' : '',
  ].filter((s) => s).join('\n');
  row.replaceChildren(
    h(
      'span',
      { class: 'label' },
      // In the slot a chevron would take, so terminals line up with the tree rows at their depth.
      // Shown in a tile, it turns the accent color (the row's `visible` class).
      rowIcon({ agent: pane.agent }),
      ...labelParts(paneLabel(pane)),
    ),
    rowTrail(
      badge(pane),
      hoverActions(
        iconButton('trash', LABELS.close, () => killPane(rec.c, rec.pane)),
      ),
    ),
  );
  return row;
}

function startSession(containerId) {
  const id = `r${++nextRequestId}`;
  pendingRequests.set(id, 'Start session');
  send({ type: 'start_session', id, container: containerId });
}

/** @param {MouseEvent} e @param {[string, () => void, boolean?][]} items */
function openMenu(e, items) {
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY, items);
}

/**
 * The menu at (`x`, `y`), kept inside the window. An item may carry an icon (a fourth element)
 * shown before its label.
 *
 * @param {number} x @param {number} y
 * @param {[string, () => void, boolean?, Node?][]} items
 */
function openMenuAt(x, y, items) {
  $menu.replaceChildren(
    ...items.map(([label, action, danger, icon]) =>
      h(
        'button',
        {
          class: danger ? 'danger' : undefined,
          onclick: () => {
            closeMenu();
            action();
          },
        },
        icon ?? '',
        label,
      )
    ),
  );
  $menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = $menu.getBoundingClientRect();
  $menu.style.left = `${Math.min(x, innerWidth - rect.width - 4)}px`;
  $menu.style.top = `${Math.min(y, innerHeight - rect.height - 4)}px`;
}

function closeMenu() {
  $menu.hidden = true;
}

// Capture phase: a terminal stops its own mousedowns and keys from bubbling.
document.addEventListener('mousedown', (e) => {
  if (!$menu.hidden && !$menu.contains(/** @type {Node} */ (e.target))) {
    closeMenu();
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    closeOutput();
  }
}, true);

// ---------------------------------------------------------------------------------------------
// Layout persistence
// ---------------------------------------------------------------------------------------------

function saveLayout() {
  if (!tiling) return;
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(tiling.save()));
  } catch { /* storage unavailable: the layout just won't survive a reload */ }
}

function restoreLayout() {
  let text = null;
  try {
    localStorage.removeItem(OLD_LAYOUT_KEY);
    text = localStorage.getItem(LAYOUT_KEY);
  } catch { /* unavailable: start empty */ }
  const saved = parseSavedLayout(text);
  if (saved) tiling?.load(saved);
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/** How many tiles have `key` open — a pane open in several tiles is closed with the last. */
function openCount(key) {
  let n = 0;
  for (const v of views.values()) if (v.openKey === key) n++;
  return n;
}

function closeTilePane(tileId) {
  const view = views.get(tileId);
  if (!view || view.openKey === null) return;
  const key = view.openKey;
  view.openKey = null;
  if (openCount(key) === 0) {
    const [container, pane_id] = key.split('\n');
    send({ type: 'close', container, pane_id });
  }
}

function openTilePane(tileId, containerId, paneId) {
  const view = views.get(tileId);
  if (!view) return;
  const size = (!view.hidden && view.renderer.resize()) ||
    { cols: 80, rows: 24 };
  view.size = size;
  view.openKey = paneKey(containerId, paneId);
  view.closedReason = null;
  const id = `o${++nextRequestId}`;
  pendingOpens.set(id, tileId);
  send({
    type: 'open',
    id,
    container: containerId,
    pane_id: paneId,
    cols: size.cols,
    rows: size.rows,
  });
}

/** The tile a sidebar click opens into: the focused one, else the first. */
function targetTile() {
  if (!tiling) return null;
  const tiles = tiling.tiles();
  return tiling.focusedTile() ?? tiles.find((t) => t.id === focusedTileId) ??
    tiles[0] ?? null;
}

/** Opens a pane in a new tile in the focused tile's stack (or the first tile). */
function openInNewTile(c, paneId) {
  if (!tiling) return;
  const tile = placeInFocusedStack({
    localFolder: c.localFolder,
    pane_id: paneId,
  });
  focusedTileId = tile.id;
  reconcileTiles();
  views.get(tile.id)?.renderer.focus();
}

/**
 * Brings every tile's server-side open state in line with the containers and snapshots: open
 * what is reachable and not yet open, close what vanished, and refresh each overlay.
 */
function reconcileTiles() {
  for (const [id, view] of views) {
    if (!isPlaced(view)) continue;
    const ref = view.tile.ref;
    const c = ref ? containerByFolder(ref.localFolder) : null;
    const reachable = c && c.state === 'connected' &&
      findPane(c.id, ref.pane_id);
    if (!reachable) {
      // Disconnected or gone: the server already dropped (or will drop) the controller.
      if (view.openKey !== null && c && c.state === 'connected') {
        closeTilePane(id);
      }
      view.openKey = null;
    } else if (view.openKey === null && view.closedReason === null) {
      openTilePane(id, c.id, ref.pane_id);
    } else if (
      view.openKey !== null && view.openKey !== paneKey(c.id, ref.pane_id)
    ) {
      // The container restarted under a new id, or the tile was pointed at another pane.
      closeTilePane(id);
      openTilePane(id, c.id, ref.pane_id);
    }
    updateOverlay(id);
  }
  for (const view of fileViews.values()) {
    if (view.state === 'error') updateFileOverlay(view);
  }
  renderTileTitles();
  updatePlaceholder();
}

function updateOverlay(tileId) {
  const view = views.get(tileId);
  if (!view) return;
  const ref = view.tile.ref;
  let message = '';
  let action = null;
  if (!ref) {
    message = LABELS.clickToOpen;
  } else {
    const c = containerByFolder(ref.localFolder);
    if (!socket) message = 'Disconnected from devc web.';
    else if (!c) {
      const p = projects.get(ref.localFolder);
      if (p?.starting) message = 'Starting container…';
      else if (p && p.container !== 'running') {
        message = p.container === 'stopped'
          ? 'Container stopped'
          : 'Container not created';
        if (projectStarts) {
          action = h('button', {
            onclick: () => startProject(ref.localFolder),
          }, 'Start container');
        } else message += ' (start it from a terminal)';
      } else message = `${basename(ref.localFolder)} is not running.`;
    } else if (c.state !== 'connected') {
      message = `${displayName(c)}: ${c.state}`;
    } else if (!findPane(c.id, ref.pane_id)) {
      message = isNewPane(ref) ? '' : LABELS.closed;
    } else if (view.closedReason !== null) {
      message = `Disconnected: ${view.closedReason}`;
      action = h('button', {
        onclick: () => {
          view.closedReason = null;
          reconcileTiles();
        },
      }, 'Reconnect');
    }
  }
  view.overlay.hidden = message === '';
  view.overlay.replaceChildren(
    h('div', {}, message),
    ...(action ? [action] : []),
  );
}

/** Each tile's tab: its label (`refLabel`), and the pane's agent badge. */
function renderTileTitles() {
  for (const view of views.values()) {
    const ref = view.tile.ref;
    if (!ref) {
      view.tile.setTitle('empty');
      view.tile.setBadge(null);
      continue;
    }
    const { name, title } = refLabel(ref);
    view.tile.setTitle(name, title);
    view.tile.setTooltip(refTooltip(ref).join('\n'));
    view.tile.setBadge(badge(resolveRef(ref).pane) || null);
  }
}

/** Shown over the tiling area while it has no tiles. */
const $placeholder = h(
  'div',
  { class: 'tiles-placeholder', hidden: true },
  LABELS.dragHere,
);

function updatePlaceholder() {
  $placeholder.hidden = !tiling || !tiling.isEmpty();
}

/**
 * Whether a tile is placed in the layout. One being dragged — a new one from the sidebar, or a
 * tile whose tab is being moved — sits in Golden Layout's drag preview (or nowhere yet), and its
 * size there means nothing to Herdr: it must not open or resize its pane until it is dropped.
 */
function isPlaced(view) {
  return $layoutRoot.contains(view.body);
}

/** Refits a tile's terminal and tells the server when its size changed. */
function refit(view) {
  if (view.hidden || !isPlaced(view)) return;
  const size = view.renderer.resize();
  if (!size) return;
  if (
    view.size && size.cols === view.size.cols && size.rows === view.size.rows
  ) return;
  view.size = size;
  if (view.openKey !== null) {
    const [container, pane_id] = view.openKey.split('\n');
    send({ type: 'resize', container, pane_id, ...size });
  }
}

/** Builds the live view (renderer, overlay, input handlers) inside a new tile. */
function mountTile(tile) {
  if (tile.kind === 'file') {
    mountFileTile(tile);
    return;
  }
  const termEl = h('div', { class: 'term' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, termEl, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
    focusSeq.set(tile.id, ++nextFocusSeq);
    tile.focus();
  }, true);

  const renderer = createRenderer(termEl, {
    linkHint: LINK_HINT,
    linkModifier: isLinkModifier,
  });
  /** @type {TileView} */
  const view = {
    tile,
    body,
    overlay,
    renderer,
    openKey: null,
    size: null,
    closedReason: null,
    hidden: false,
    resizeTimer: undefined,
    flashTimer: undefined,
    frames: 0,
    observer: new ResizeObserver(() => {
      clearTimeout(view.resizeTimer);
      view.resizeTimer = setTimeout(() => refit(view), RESIZE_DEBOUNCE_MS);
    }),
  };
  views.set(tile.id, view);
  view.observer.observe(body);

  const target = () => {
    if (view.openKey === null) return null;
    const [container, pane_id] = view.openKey.split('\n');
    return { container, pane_id };
  };

  renderer.onData((data) => {
    const t = target();
    if (!t) return;
    // Typing into a preview means using it: it stays.
    keepOpen(tile);
    send({ type: 'input', ...t, bytes: encodeInput(data) });
  });

  const wheelToScroll = createWheelAccumulator();
  renderer.onWheel((ev) => {
    const t = target();
    const m = renderer.metrics();
    if (!t || !m) return;
    const scroll = wheelToScroll(ev.deltaY, m.cellHeight, ev.deltaMode);
    if (scroll) send({ type: 'scroll', ...t, ...scroll });
  });

  // Paste is intercepted before xterm.js sees it: a multi-line paste goes as one bracketed
  // input, because the page cannot know whether the app enabled bracketed paste.
  body.addEventListener('paste', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const t = target();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (t && text) {
      keepOpen(tile);
      send({ type: 'input', ...t, bytes: encodeInput(wrapPaste(text)) });
    }
  }, true);

  attachMouse(view, termEl, target);

  // Golden Layout mounts tiles while it builds or restores the layout; open them once it is done.
  queueMicrotask(reconcileTiles);
}

/** Tears a tile's view down; the pane closes on the server with the last tile showing it. */
function unmountTile(tile) {
  if (tile.kind === 'file') {
    unmountFileTile(tile);
    return;
  }
  const view = views.get(tile.id);
  if (!view) return;
  closeTilePane(tile.id);
  for (const [id, tileId] of pendingOpens) {
    if (tileId === tile.id) pendingOpens.delete(id);
  }
  clearTimeout(view.resizeTimer);
  clearTimeout(view.flashTimer);
  view.observer.disconnect();
  view.renderer.dispose();
  views.delete(tile.id);
  focusSeq.delete(tile.id);
  if (focusedTileId === tile.id) focusedTileId = null;
  queueMicrotask(updatePlaceholder);
}

/** A tile in a background stack tab sends no resize; brought forward, it refits at once. */
function tileVisibility(tile, visible) {
  const view = views.get(tile.id);
  if (!view) return;
  view.hidden = !visible;
  if (visible) requestAnimationFrame(() => refit(view));
}

/**
 * Copies the text between two viewport cells of a pane, read from Herdr's buffer
 * (`read_selection`). Herdr draws no selection and sends no OSC 52 to a control client, so this
 * is the only way its text reaches the clipboard.
 */
function copySelection(t, anchor, cursor) {
  const id = `s${++nextRequestId}`;
  /** @type {Promise<string>} */
  const text = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSelections.delete(id);
      reject(new Error('no reply'));
    }, SELECTION_TIMEOUT_MS);
    pendingSelections.set(id, { resolve, reject, timer });
  });
  send({ type: 'read_selection', id, ...t, anchor, cursor });
  writeClipboard(text).catch((e) =>
    errorToast(`Copy failed: ${e?.message ?? e}`)
  );
}

/**
 * Writes text that is still on its way to the clipboard. The write starts now, inside the
 * mouseup, with a promise-valued `ClipboardItem`: Safari and Firefox would drop the user
 * activation across the wait for the server. Empty text copies nothing.
 *
 * @param {Promise<string>} text
 */
async function writeClipboard(text) {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error('clipboard unavailable');
  if (typeof ClipboardItem === 'undefined') {
    const t = await text;
    if (t) await clipboard.writeText(t);
    return;
  }
  const blob = text.then((t) => {
    if (!t) throw new Error('empty');
    return new Blob([t], { type: 'text/plain' });
  });
  try {
    await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  } catch (e) {
    // The reply's own error wins; an empty selection is not a failure.
    if (await text) throw e;
  }
}

/** Mac's link modifier is Cmd; elsewhere it is Ctrl (as in VS Code's terminal). */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether the key that opens terminal links is down during `ev`. */
function isLinkModifier(ev) {
  return IS_MAC ? ev.metaKey : ev.ctrlKey;
}

// Capture phase, so it works while a terminal has focus: xterm.js never sees the keys (on a Mac,
// Option would type a character). Ctrl+Alt+N (Cmd+Alt+N on a Mac) toggles the first pinned file.
document.addEventListener('keydown', (e) => {
  if (!isFilePinShortcut(e, IS_MAC)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  if (pinnedFiles.length) toggleFilePin(pinnedFiles[0]);
  else openNewNote();
}, true);

/** The tooltip over a terminal link. */
const LINK_HINT = `${IS_MAC ? 'Cmd' : 'Ctrl'}+click to open`;

/** The terminal cell under a mouse event, or null before the terminal is laid out. */
function cellAt(view, e) {
  const m = view.renderer.metrics();
  return m
    ? pixelToCell(
      e.clientX - m.left,
      e.clientY - m.top,
      m.cellWidth,
      m.cellHeight,
      m.cols,
      m.rows,
    )
    : null;
}

/**
 * Opens a link in pane `t`: a URL in a new browser tab, a file in the viewer when it is in one of
 * the container's project repos. Relative paths are from the pane's current folder.
 *
 * @param {{container: string, pane_id: string}} t
 * @param {import('./lib/links.js').Link} link
 */
async function openLink(t, link) {
  if (link.kind === 'url') {
    window.open(link.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const pane = findPane(t.container, t.pane_id);
  const path = resolvePath(pane?.foreground_cwd || pane?.cwd || '', link.path);
  if (!path) {
    errorToast(`Can't open ${link.path}: the terminal's folder is unknown`);
    return;
  }
  try {
    const file = await call({
      type: 'locate_file',
      container: t.container,
      path,
    });
    openFileAt(file, link.line, link.column);
  } catch (e) {
    errorToast(`Can't open ${link.path}: ${e?.message ?? e}`);
  }
}

/**
 * Plain mouse down/drag/up over the terminal go to Herdr as cells (the browser does not
 * select); a plain left-drag's text is copied from Herdr, and flashed here unless the app redrew
 * during the drag (it draws its own selection). Shift+drag
 * is left to xterm.js for a local selection, copied on mouseup. A right-click opens the tile's
 * menu (the same as its tab's) and is not sent to the app. Cmd+click (Ctrl+click off a Mac) on
 * a link opens it ({@link openLink}); anywhere else it is an ordinary click.
 */
function attachMouse(view, termEl, target) {
  termEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openMenu(ev, tileMenuItems(view.tile));
  });
  termEl.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {
      ev.preventDefault();
      ev.stopPropagation();
      view.renderer.focus();
      return;
    }
    if (ev.button === 0 && isLinkModifier(ev)) {
      const at = cellAt(view, ev);
      const link = at && view.renderer.linkAt(at);
      const t = target();
      if (link && t) {
        ev.preventDefault();
        ev.stopPropagation();
        // The file opens in the preview tile, which must not be this terminal.
        keepOpen(view.tile);
        openLink(t, link);
        return;
      }
    }
    if (ev.shiftKey) {
      const onUp = () => {
        window.removeEventListener('mouseup', onUp, true);
        const text = view.renderer.selection();
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      };
      window.addEventListener('mouseup', onUp, true);
      return;
    }
    const button = mouseButton(ev.button);
    const t = target();
    ev.preventDefault();
    ev.stopPropagation();
    view.renderer.focus();
    view.renderer.clearHighlight();
    if (!button || !t) return;
    const cell = (e) => cellAt(view, e);
    const start = cell(ev);
    if (!start) return;
    send({ type: 'mouse', ...t, action: 'down', button, ...start });
    const framesAtDown = view.frames;
    let last = start;
    let lastSent = 0;
    let trailing;
    const onMove = (e) => {
      const c = cell(e);
      if (!c || (c.column === last.column && c.row === last.row)) return;
      last = c;
      const sendDrag = () => {
        lastSent = Date.now();
        send({ type: 'mouse', ...t, action: 'drag', button, ...last });
      };
      clearTimeout(trailing);
      const wait = DRAG_INTERVAL_MS - (Date.now() - lastSent);
      if (wait <= 0) sendDrag();
      else trailing = setTimeout(sendDrag, wait);
    };
    const onUp = (e) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      clearTimeout(trailing);
      const c = cell(e) ?? last;
      send({ type: 'mouse', ...t, action: 'up', button, ...c });
      if (
        button === 'left' && (c.column !== start.column || c.row !== start.row)
      ) {
        // An app that redrew during the drag is drawing its own selection (Claude Code, vim
        // with the mouse on): a second, grid-bound highlight would only contradict it.
        if (view.frames === framesAtDown) {
          view.renderer.highlight(start, c);
          clearTimeout(view.flashTimer);
          view.flashTimer = setTimeout(
            () => view.renderer.clearHighlight(),
            COPY_FLASH_MS,
          );
        }
        copySelection(t, start, c);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

const $layoutRoot = h('div', { class: 'layout-root' });
$tiles.replaceChildren($layoutRoot, $placeholder);
tiling = createTiling($layoutRoot, {
  mount: mountTile,
  unmount: unmountTile,
  visibility: tileVisibility,
  focused: (tile) => {
    if (tile) {
      focusedTileId = tile.id;
      focusSeq.set(tile.id, ++nextFocusSeq);
    }
    updateCurrent();
  },
  // A drop is a change too: the dropped tile is placed now, so it may open its pane.
  changed: () => {
    saveLayout();
    reconcileTiles();
    layoutChanged();
  },
  tileMenu: (tile, e) => openMenu(e, tileMenuItems(tile)),
  stackMenu,
  tabDoubleClick: keepOpen,
});
if (SAFE_MODE) showSafeBanner();
applySidebarLayout();
restoreLayout();
reconcileTiles();
renderTree();
connect();
