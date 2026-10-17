// The `devc web` page: the WebSocket client for `/ws`, the sidebar and the browser-owned tiling
// area. The sidebar has two sections: Layout, a live mirror of the Golden Layout tree (where things
// are on screen, and the layout actions), and Projects, every Herdr pane by container (what is
// running, and the process actions). The browser owns all layout: it never splits a Herdr pane or
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
  tileTitle,
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
  containerLabel,
  gitRollup,
  gitSync,
  paneLabel,
  paneTitle,
  SIDEBAR_DEFAULT_WIDTH,
  topStatus,
} from './lib/sidebar.js';
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
  opensAsDir,
  opensAsFile,
  parentDir,
} from './lib/files.js';

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
 * it says "Pane gone": `new_shell` answers before Herdr's next snapshot arrives.
 */
const NEW_PANE_GRACE_MS = 5000;
/** Served from the last-good snapshot (`/safe/`): no reloads, no `client_ready`. */
const SAFE_MODE = location.pathname.startsWith('/safe/');

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, localFolder: string, name: string, state: string, error?: string}} ContainerInfo
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
 * not. `seq` numbers the reads, so only the latest one's answer lands.
 *
 * @typedef {object} FileView
 * @property {Tile} tile
 * @property {HTMLElement} host      where the viewer mounts
 * @property {HTMLElement} overlay
 * @property {import('./viewer.js').Viewer | null} viewer
 * @property {'loading' | 'ok' | 'error'} state
 * @property {string} error          the message shown while `state` is 'error'
 * @property {number} seq
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

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  $toasts.append(el);
  setTimeout(() => el.remove(), 6000);
}

/** Releases `boot.js`'s guard: from here on, errors are toasts, not its overlay. */
function markBooted() {
  if (booted) return;
  booted = true;
  /** @type {any} */ (window).__devcBooted?.();
}

window.addEventListener('error', (e) => {
  if (booted && e.message) toast(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (booted) toast(String(e.reason?.message ?? e.reason));
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
    toast(
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

/** A pane's agent status as a dot and a word; the agent's name is in the tooltip. */
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
    status,
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
    top.count > 1 ? `${top.count} ${top.status}` : top.status,
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
        reposOpen: [...sidebarState.reposOpen],
        inactiveOpen: sidebarState.inactiveOpen,
        projectsOpen: [...sidebarState.projectsOpen],
        // Not `filesOpen`: entries saved under that name were keyed by project, not by repo.
        rootsOpen: sidebarState.filesOpen,
        layoutOpen: sidebarState.layoutOpen,
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

/** Opens or closes a container's Repos row (by its local folder). */
function toggleRepos(localFolder) {
  if (!sidebarState.reposOpen.delete(localFolder)) {
    sidebarState.reposOpen.add(localFolder);
  }
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
 * The sidebar: the Layout section (the Golden Layout tree, single-child levels folded), then
 * Projects (Container → Workspace → Pane, a workspace row only when its container has several).
 * Herdr tabs group nothing here: a pane the Herdr TUI split into a shared tab is just another pane.
 * Every running container is listed, Herdr or not; projects without one are listed last, under a
 * collapsed "Not running" group.
 */
function renderTree() {
  const generation = ++renderGeneration;
  const scroll = $tree.scrollTop;
  const focusKey = focusedTreeKey($tree);
  const rows = [
    ...layoutRows(),
    sectionRow(
      'Projects',
      undefined,
      undefined,
      projectStarts
        ? rowTrail(hoverActions(iconButton('plus', 'Add project…', addProject)))
        : '',
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
  refocusTreeKey($tree, focusKey);
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
          ? `${t.file.localFolder}\n${t.file.root}\n${t.file.path}`
          : t.ref
          ? `${t.ref.localFolder}\n${t.ref.pane_id}`
          : ''
      }`
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

function refTitle(ref) {
  if (!ref) return 'empty';
  const { c, pane } = resolveRef(ref);
  return tileTitle(
    c ? displayName(c) : basename(ref.localFolder),
    pane ? paneTitle(pane) : ref.pane_id,
  );
}

function layoutTileRow(tile, active, depth) {
  if (tile.kind === 'file') return layoutFileTileRow(tile, active, depth);
  const { c, pane } = resolveRef(tile.ref);
  return h(
    'div',
    {
      class: active
        ? 'row layout-node tile'
        : 'row layout-node tile background',
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      'data-pane-key': c && tile.ref
        ? paneKey(c.id, tile.ref.pane_id)
        : undefined,
      title: active ? undefined : 'Background tab',
      onclick: () => revealTile(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h('span', { class: 'label' }, refTitle(tile.ref)),
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
      class: active
        ? 'row layout-node tile'
        : 'row layout-node tile background',
      style: `--depth: ${depth}`,
      'data-tile': tile.id,
      title: [
        tile.file ? fileHostPath(tile.file) : '',
        active ? '' : 'Background tab',
      ].filter((s) => s).join('\n') || undefined,
      onclick: () => revealTile(tile.id),
      oncontextmenu: (e) => openMenu(e, tileMenuItems(tile)),
    },
    h('span', { class: 'label' }, fileTileTitle(tile.file)),
    rowTrail(
      hoverActions(
        iconButton('close', 'Close tile', () => tiling?.close(tile.id)),
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
  project: 'M8 2.5l5 2.75v5.5L8 13.5l-5-2.75v-5.5zM3 5.25L8 8l5-2.75M8 8v5.5',
};

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

/** Marks the focused tile's Layout row and its pane's Projects row(s). */
function updateCurrent() {
  const tile = targetTile();
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
 * {@link NEW_PANE_GRACE_MS} instead of saying "Pane gone".
 *
 * @param {ContainerInfo} c
 * @param {{workspace_id?: string, cwd?: string}} opts
 * @param {(ref: PaneRef) => Tile} place
 */
function newShell(c, opts, place) {
  return createPane(c, { type: 'new_shell', ...opts }, place, 'New shell');
}

/**
 * Sends `msg` (`new_shell` or `open_file`: a message that answers with a new pane) for container
 * `c`, then places the pane as {@link newShell} does. A failure is a toast naming `what`.
 *
 * @param {ContainerInfo} c
 * @param {Record<string, unknown> & {type: string}} msg
 * @param {(ref: PaneRef) => Tile} place
 * @param {string} what
 */
async function createPane(c, msg, place, what) {
  const id = `n${++nextRequestId}`;
  /** @type {Promise<{pane_id: string}>} */
  const created = new Promise((resolve, reject) =>
    pendingShells.set(id, { resolve, reject })
  );
  send({ ...msg, id, container: c.id });
  let result;
  try {
    result = await created;
  } catch (e) {
    toast(`${what} failed: ${e?.message ?? e}`);
    return;
  }
  if (!tiling) return;
  const ref = { localFolder: c.localFolder, pane_id: result.pane_id };
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

/** Ends a pane's process (and closes its Herdr tab), after asking. */
function killPane(c, pane) {
  if (confirm(`Kill pane "${paneLabel(c, pane)}"? Its process ends.`)) {
    request(c.id, 'pane.close', { pane_id: pane.pane_id }, 'Kill pane');
  }
}

function killPaneItem(c, pane) {
  return ['Kill pane…', () => killPane(c, pane), true];
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
        'Split pane vertically',
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'right')),
      ],
      [
        'Split pane horizontally',
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'below')),
      ],
      [
        'New pane in this stack',
        () =>
          newShell(c, opts, (ref) => tiling.addBeside(tile.id, ref, 'stack')),
      ],
    );
  }
  if (c && pane) {
    items.push(['Reveal in Projects', () => revealInProjects(c, pane)]);
  }
  items.push(['Close', () => tiling?.close(tile.id)]);
  if (c && pane) items.push(killPaneItem(c, pane));
  return items;
}

/** A stack, row or column's menu. */
function nodeMenuItems(node, tiles) {
  const origin = shellOrigin(tiles);
  const items = [];
  if (origin) {
    const opts = shellOptsNear(origin.c, origin.pane);
    items.push([
      node.kind === 'stack' ? 'New pane in this stack' : 'New pane at end',
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

/** Expands the pane's container and scrolls its Projects row into view, briefly flashed. */
function revealInProjects(c, pane) {
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
// Sidebar: Projects section
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

function newShellItem(c, workspaceId) {
  return ['New shell', () =>
    newShell(
      c,
      workspaceId ? { workspace_id: workspaceId } : {},
      placeInFocusedStack,
    )];
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
        oncontextmenu: (e) =>
          openMenu(e, [
            ...(c.state === 'connected'
              ? [newShellItem(c, only?.workspace_id)]
              : []),
            ...projectMenuItems(c.localFolder),
          ]),
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
        : c.state !== 'connected'
        ? stateText
        // Expanded, each agent's own badge is right below.
        : collapsed
        ? rollupBadge(panes)
        : '',
    ),
  ];
  if (collapsed) return rows;
  rows.push(...repoRows(c.localFolder));
  const listed = new Set();
  for (const ws of workspaces) {
    let depth = 1;
    if (!only) {
      rows.push(
        h(
          'div',
          {
            class: 'row workspace',
            style: `--depth: ${depth}`,
            oncontextmenu: (e) =>
              openMenu(e, [newShellItem(c, ws.workspace_id)]),
          },
          h(
            'span',
            { class: 'label' },
            ws.label || `workspace ${ws.number ?? ''}`,
          ),
        ),
      );
      depth++;
    }
    for (const pane of workspacePanes(ws, tabs, panes)) {
      listed.add(pane.pane_id);
      rows.push(paneRow(c, pane, depth));
    }
  }
  // Anything the snapshot didn't place in a workspace's tab still gets a row.
  for (const pane of panes) {
    if (!listed.has(pane.pane_id)) rows.push(paneRow(c, pane, 1));
  }
  return rows;
}

/** A Herdr-less container's hover buttons: Start Herdr (no session only) and Retry. */
function herdrActions(c) {
  return hoverActions(
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
 * project folder always gets a row; a later folder that turned out to be no repo (`git: null`)
 * gets none.
 */
function repoRows(localFolder) {
  const repos = projectRepos(localFolder).filter((r, i) =>
    i === 0 || r.git !== null
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
          title: r.folder,
          onclick: () => tree.toggle(''),
          oncontextmenu: (e) => openMenu(e, dirMenuItems(fr, '')),
        },
        r.name,
        gitMark(gitSync(r.git)),
      ),
    ];
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
  if (repos.length === 1) return repoRow(repos[0], 1);
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

function startProject(localFolder) {
  projectOutput.set(localFolder, []);
  projectRequest('start_project', localFolder, 'Start container');
}

function stopProject(p) {
  if (
    confirm(
      `Stop the container for ${p.name}? Its panes end with it.`,
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

function refocusTreeKey(container, key) {
  if (key === null) return;
  for (const el of container.querySelectorAll('[data-tree-key]')) {
    const row = /** @type {HTMLElement} */ (el);
    if (row.dataset.treeKey === key) {
      row.focus({ preventScroll: true });
      return;
    }
  }
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
 * `localFolder`. Paths in a tree are relative to `root`; `localFolder` finds the container.
 *
 * @typedef {{localFolder: string, root: string}} FileRoot
 */

/** A file root's key: a repo mounted by two projects has a tree in each (container paths differ). */
function treeId(fr) {
  return `${fr.localFolder}\n${fr.root}`;
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
    list: (path) => call({ type: 'list_dir', localFolder, root, path }),
    onChange: () => onFilesChange(fr),
  });
  fileTrees.set(id, { fr: { localFolder, root }, tree });
  filesListedFor.set(id, containerByFolder(localFolder)?.id ?? null);
  const saved = byDepth(sidebarState.filesOpen[root] ?? []);
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
  if (open.length) sidebarState.filesOpen[fr.root] = open;
  else delete sidebarState.filesOpen[fr.root];
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

/** `path`'s container path, from the nearest listed folder at or above it; null if none knows. */
function containerPathOf(fr, path) {
  if (!containerByFolder(fr.localFolder)) return null;
  const tree = fileTree(fr);
  const parts = path === '' ? [] : path.split('/');
  for (let n = parts.length; n >= 0; n--) {
    const l = tree.listing(parts.slice(0, n).join('/'));
    if (l?.state === 'ok' && typeof l.containerPath === 'string') {
      return parts.slice(n).reduce(childPath, l.containerPath);
    }
  }
  return null;
}

/** Copies a repo path: where the running container sees it, else the host path. */
function copyPath(fr, path) {
  const text = containerPathOf(fr, path) ??
    (path === '' ? fr.root : childPath(fr.root, path));
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${text}`),
    (e) => toast(`Copy failed: ${e?.message ?? e}`),
  );
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
    { type: 'open_file', root: fr.root, path },
    where === 'right'
      ? (ref) => tiling.addBeside(targetTile()?.id ?? null, ref, 'right')
      : placeInFocusedStack,
    'Open in editor',
  );
}

/** A folder's menu: the root itself (`path` '', its repo row) or a directory under it. */
function dirMenuItems(fr, path) {
  const c = containerByFolder(fr.localFolder);
  const cwd = containerPathOf(fr, path);
  const items = [];
  if (c?.state === 'connected' && cwd) {
    items.push([
      'New shell here',
      () => newShell(c, { cwd }, placeInFocusedStack),
    ]);
  }
  items.push(
    ['Refresh', () => fileTree(fr).refresh(path)],
    ['Copy path', () => copyPath(fr, path)],
  );
  return items;
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
    ['Copy path', () => copyPath(fr, path)],
  ];
}

/** The folders and files of an open root, at `depth`. */
function rootEntryRows(fr, depth) {
  const tree = fileTree(fr);
  return treeRows(tree, '', depth, (item) => fileEntryRow(fr, tree, item));
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
        childPath(fr.root, path),
        entry.size !== undefined ? formatSize(entry.size) : '',
        entry.kind === 'symlink'
          ? entry.to ? 'Symbolic link' : 'Broken symbolic link'
          : '',
      ].filter((s) => s).join('\n'),
      onclick: dir
        ? () => tree.toggle(path)
        : file
        ? () => openFileTile(fr, path, 'stack')
        : undefined,
      oncontextmenu: (e) =>
        openMenu(
          e,
          dir
            ? dirMenuItems(fr, path)
            : file
            ? fileMenuItems(fr, path)
            : [['Copy path', () => copyPath(fr, path)]],
        ),
    },
    entry.name,
    entry.kind === 'symlink' ? h('span', { class: 'link-mark' }, '→') : '',
  );
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
    const ref = { localFolder: fr.localFolder, root: fr.root, path };
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

/** A file's host path. */
function fileHostPath(file) {
  return childPath(file.root, file.path);
}

/** A file tile's title: the file's name. */
function fileTileTitle(file) {
  return file ? basename(file.path) : 'unknown file';
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
 * Opens a repo file in a file tile: in the focused stack (`'stack'`; a tile already showing the
 * file is brought forward instead), or split to the right of the focused tile. Works whether or
 * not the container runs: the server reads the host side of the mount.
 *
 * @param {FileRoot} fr @param {string} path @param {'stack' | 'right'} where
 */
function openFileTile(fr, path, where) {
  if (!tiling) return;
  const file = { localFolder: fr.localFolder, root: fr.root, path };
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

/** A file tile's menu (its tab, its Layout row, and a right-click in it). */
function fileTileMenuItems(tile) {
  const items = [];
  const file = tile.file;
  const view = fileViews.get(tile.id);
  if (file) {
    const fr = { localFolder: file.localFolder, root: file.root };
    if (view) items.push(['Reload', () => loadFile(view)]);
    items.push(
      ['Open in editor', () => openInEditor(fr, file.path, 'stack')],
      ['Copy path', () => copyPath(fr, file.path)],
    );
  }
  items.push(['Close', () => tiling?.close(tile.id)]);
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
    tile.setTitle(fileTileTitle(tile.file));
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
  let result;
  try {
    result = await call({
      type: 'read_file',
      localFolder: file.localFolder,
      root: file.root,
      path: file.path,
    });
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
  if (view.viewer) view.viewer.setText(text);
  else {
    view.viewer = createViewer(view.host, {
      name: basename(file.path),
      text,
    });
  }
  view.state = 'ok';
  view.error = '';
  updateFileOverlay(view);
}

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
        onclick: () =>
          openInEditor(
            { localFolder: file.localFolder, root: file.root },
            file.path,
            'stack',
          ),
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
      toast(`Add project failed: ${e?.message ?? e}`);
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
    ['Rename…', () => {
      const label = prompt('Pane name', paneTitle(pane));
      if (label) {
        request(
          c.id,
          'pane.rename',
          { pane_id: pane.pane_id, label },
          'Rename pane',
        );
      }
    }],
    killPaneItem(c, pane),
  );
  return items;
}

/** Click: show the pane where it already is, else open it in the focused tile. */
function onPaneClick(rec, e) {
  if (e.ctrlKey || e.metaKey) {
    openInNewTile(rec.c, rec.pane.pane_id);
    return;
  }
  const tile = tileShowing(rec.c, rec.pane);
  if (tile) revealTile(tile.id);
  else openInFocusedTile(rec.c, rec.pane.pane_id);
}

/** A pane's sidebar row: the kept one for this pane (see {@link paneRows}), brought up to date. */
function paneRow(c, pane, depth) {
  const key = paneKey(c.id, pane.pane_id);
  let rec = paneRows.get(key);
  if (!rec) {
    const row = h('div', {
      class: 'row pane',
      onclick: (e) => onPaneClick(rec, e),
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
      () => tileTitle(displayName(r.c), paneTitle(r.pane)),
    );
  }
  const { row } = rec;
  const visible = isVisible(c, pane);
  row.style.setProperty('--depth', String(depth));
  row.dataset.paneKey = key;
  row.classList.toggle('visible', visible);
  // The children ignore the pointer, so the badge's tooltip lives here.
  row.title = [
    pane.foreground_cwd || pane.cwd || '',
    pane.agent ? `${pane.agent}: ${agentStatus(pane)}` : '',
    visible ? 'Shown in a tile' : '',
  ].filter((s) => s).join('\n');
  row.replaceChildren(
    h(
      'span',
      { class: 'label' },
      visible ? h('span', { class: 'shown-mark', 'aria-label': 'shown' }) : '',
      paneLabel(c, pane),
    ),
    rowTrail(
      badge(pane),
      hoverActions(
        iconButton('trash', 'Kill pane…', () => killPane(rec.c, rec.pane)),
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
  $menu.replaceChildren(
    ...items.map(([label, action, danger]) =>
      h('button', {
        class: danger ? 'danger' : undefined,
        onclick: () => {
          closeMenu();
          action();
        },
      }, label)
    ),
  );
  $menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = $menu.getBoundingClientRect();
  $menu.style.left = `${Math.min(e.clientX, innerWidth - rect.width - 4)}px`;
  $menu.style.top = `${Math.min(e.clientY, innerHeight - rect.height - 4)}px`;
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

function openInFocusedTile(c, paneId) {
  if (!tiling) return;
  const ref = { localFolder: c.localFolder, pane_id: paneId };
  let tile = targetTile();
  if (tile?.kind === 'file') {
    // A file tile can't show a pane: the pane opens beside it, in its stack.
    tile = placeInFocusedStack(ref);
  } else if (tile) {
    closeTilePane(tile.id);
    views.get(tile.id).closedReason = null;
    tile.setRef(ref);
  } else {
    tile = tiling.add(ref);
  }
  focusedTileId = tile.id;
  reconcileTiles();
  layoutChanged();
  views.get(tile.id)?.renderer.focus();
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
    message = 'Click a pane in the sidebar to open it here.';
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
      message = isNewPane(ref) ? '' : 'Pane gone';
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

/** Each tile's tab: `<container> · <pane title>`, and the pane's agent badge. */
function renderTileTitles() {
  for (const view of views.values()) {
    const ref = view.tile.ref;
    if (!ref) {
      view.tile.setTitle('empty');
      view.tile.setBadge(null);
      continue;
    }
    view.tile.setTitle(refTitle(ref));
    view.tile.setBadge(badge(resolveRef(ref).pane) || null);
  }
}

/** Shown over the tiling area while it has no tiles. */
const $placeholder = h(
  'div',
  { class: 'tiles-placeholder', hidden: true },
  'Drag a pane here, or click one in the sidebar.',
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

  const renderer = createRenderer(termEl);
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
    if (t) send({ type: 'input', ...t, bytes: encodeInput(data) });
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
  writeClipboard(text).catch((e) => toast(`Copy failed: ${e?.message ?? e}`));
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

/**
 * Plain mouse down/drag/up over the terminal go to Herdr as cells (the browser does not
 * select); a plain left-drag's text is copied from Herdr, and flashed here unless the app redrew
 * during the drag (it draws its own selection). Shift+drag
 * is left to xterm.js for a local selection, copied on mouseup. A right-click opens the tile's
 * menu (the same as its tab's) and is not sent to the app.
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
    const cell = (e) => {
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
    };
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
});
if (SAFE_MODE) showSafeBanner();
applySidebarLayout();
restoreLayout();
reconcileTiles();
renderTree();
connect();
