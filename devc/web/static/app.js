// The `devc web` page: the WebSocket client for `/ws`, the sidebar tree
// (Container → Workspace → Tab → Pane, single-child levels folded) and the browser-owned tiling area. The protocol is
// specified in `.plans/devc-web.md`; renderer details live in `renderer.js`, and the pure input
// helpers in `lib/input.js`.

import { createRenderer } from './renderer.js';
import {
  decodeBase64,
  encodeInput,
  mouseButton,
  pixelToCell,
  wheelToScroll,
  wrapPaste,
} from './lib/input.js';
import {
  agentStatus,
  containerLabel,
  paneLabel,
  paneTitle,
  tabName,
  topStatus,
} from './lib/sidebar.js';

const LAYOUT_KEY = 'devc-web-layout-v1';
const RESIZE_DEBOUNCE_MS = 100;
const DRAG_INTERVAL_MS = 50;
const RECONNECT_MS = 2000;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, localFolder: string, name: string, state: string, error?: string}} ContainerInfo
 * @typedef {{localFolder: string, pane_id: string}} PaneRef
 * @typedef {{type: 'tile', id: string, pane: PaneRef | null}} TileNode
 * @typedef {{type: 'split', dir: 'row' | 'col', ratio: number, a: LayoutNode, b: LayoutNode}} SplitNode
 * @typedef {TileNode | SplitNode} LayoutNode
 */

/** @type {Map<string, ContainerInfo>} by container id */
const containers = new Map();
/** @type {Map<string, any>} Herdr snapshots, by container id */
const snapshots = new Map();

/** @type {LayoutNode} */
let layout = { type: 'tile', id: newTileId(), pane: null };
/** @type {string} */
let focusedTileId = layout.id;

/**
 * A tile's live view. `openKey` is the `container\npane` it has open on the server, if any.
 *
 * @typedef {object} TileView
 * @property {HTMLElement} el
 * @property {HTMLElement} body
 * @property {HTMLElement} overlay
 * @property {import('./renderer.js').Renderer} renderer
 * @property {string | null} openKey
 * @property {{cols: number, rows: number} | null} size
 * @property {string | null} closedReason
 * @property {number | undefined} resizeTimer
 */

/** @type {Map<string, TileView>} */
const views = new Map();
/** Pending `open` request ids → tile id. */
const pendingOpens = new Map();
/** Pending `request`/`start_session` ids → description, for error toasts. */
const pendingRequests = new Map();

let socket = /** @type {WebSocket | null} */ (null);
let nextRequestId = 0;

const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';

const $tree = /** @type {HTMLElement} */ (document.getElementById('tree'));
const $tiles = /** @type {HTMLElement} */ (document.getElementById('tiles'));
const $menu = /** @type {HTMLElement} */ (document.getElementById('menu'));
const $conn = /** @type {HTMLElement} */ (document.getElementById('conn'));
const $toasts = /** @type {HTMLElement} */ (document.getElementById('toasts'));

function newTileId() {
  return Math.random().toString(36).slice(2, 10);
}

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
    containers.clear();
    snapshots.clear();
    renderTree();
    reconcileTiles();
    setTimeout(connect, RECONNECT_MS);
  };
}

function onMessage(msg) {
  switch (msg.type) {
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
      renderTree();
      reconcileTiles();
      break;
    }
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

function patchPane(containerId, pane, merge) {
  const snap = snapshots.get(containerId);
  if (!snap || !Array.isArray(snap.panes)) return;
  const i = snap.panes.findIndex((p) => p.pane_id === pane.pane_id);
  if (i === -1) return;
  snap.panes[i] = merge ? { ...snap.panes[i], ...pane } : pane;
  renderTree();
  renderTileHeaders();
}

function onFrame(msg) {
  const key = paneKey(msg.container, msg.pane_id);
  const bytes = decodeBase64(msg.bytes);
  for (const view of views.values()) {
    if (view.openKey !== key) continue;
    view.renderer.write(bytes, msg.cols, msg.rows);
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
/** Containers without a usable Herdr; listed together under "Not running". */
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

/** Collapsed containers (by local folder) and whether "Not running" is open, per browser. */
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
    inactiveOpen: saved?.inactiveOpen === true,
  };
}

function saveSidebarState() {
  try {
    localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({
        collapsed: [...sidebarState.collapsed],
        inactiveOpen: sidebarState.inactiveOpen,
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

function toggleInactive() {
  sidebarState.inactiveOpen = !sidebarState.inactiveOpen;
  saveSidebarState();
  renderTree();
}

function chevron() {
  return h('span', { class: 'chevron', 'aria-hidden': 'true' });
}

/**
 * Container → Workspace → Tab → Pane, with every level that has a single child folded away: a
 * workspace row shows only when its container has several, and a tab row only when the tab is
 * split into several panes. What a folded row's menu offered moves to the row that remains.
 * Containers without a usable Herdr are listed last, under a collapsed "Not running" group.
 */
function renderTree() {
  const scroll = $tree.scrollTop;
  const rows = [];
  if (containers.size === 0) {
    rows.push(
      h(
        'div',
        { class: 'empty' },
        socket ? 'No running dev containers.' : 'Waiting for devc web…',
      ),
    );
  }
  const inactive = [];
  for (const c of containers.values()) {
    if (INACTIVE_STATES.has(c.state)) inactive.push(c);
    else rows.push(...containerRows(c));
  }
  if (inactive.length > 0) rows.push(...inactiveRows(inactive));
  $tree.replaceChildren(...rows);
  $tree.scrollTop = scroll;
}

function newTabItem(c, ws) {
  return ['New tab', () =>
    request(
      c.id,
      'tab.create',
      { workspace_id: ws.workspace_id },
      'New tab',
    )];
}

function renameTabItem(c, tab, text = 'Rename') {
  return [text, () => {
    const label = prompt('Tab name', tab.label ?? '');
    if (label) {
      request(
        c.id,
        'tab.rename',
        { tab_id: tab.tab_id, label },
        'Rename tab',
      );
    }
  }];
}

function containerRows(c) {
  const snap = c.state === 'connected' ? snapshots.get(c.id) : undefined;
  const workspaces = list(snap?.workspaces).sort(byNumber);
  const tabs = list(snap?.tabs);
  const panes = list(snap?.panes);
  const collapsed = sidebarState.collapsed.has(c.localFolder);
  const only = workspaces.length === 1 ? workspaces[0] : null;
  const rows = [
    h(
      'div',
      {
        class: 'row container',
        style: '--depth: 0',
        title: c.localFolder,
        'aria-expanded': String(!collapsed),
        onclick: () => toggleContainer(c),
        oncontextmenu: only
          ? (e) => openMenu(e, [newTabItem(c, only)])
          : undefined,
      },
      h('span', { class: 'label' }, chevron(), displayName(c)),
      c.state !== 'connected'
        ? h(
          'span',
          { class: 'state', 'data-state': c.state },
          STATE_TEXT[c.state] ?? c.state,
        )
        // Expanded, each agent's own badge is right below.
        : collapsed
        ? rollupBadge(panes)
        : '',
    ),
  ];
  if (collapsed) return rows;
  for (const ws of workspaces) {
    let depth = 1;
    if (!only) {
      rows.push(
        h(
          'div',
          {
            class: 'row workspace',
            style: `--depth: ${depth}`,
            oncontextmenu: (e) => openMenu(e, [newTabItem(c, ws)]),
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
    const wsTabs = tabs.filter((t) => t.workspace_id === ws.workspace_id)
      .sort(byNumber);
    for (const tab of wsTabs) {
      const tabPanes = panes.filter((p) => p.tab_id === tab.tab_id);
      if (tabPanes.length < 2) {
        for (const pane of tabPanes) {
          rows.push(
            paneRow(c, pane, depth, [renameTabItem(c, tab, 'Rename tab')]),
          );
        }
        continue;
      }
      rows.push(
        h(
          'div',
          {
            class: 'row tab',
            style: `--depth: ${depth}`,
            oncontextmenu: (e) =>
              openMenu(e, [
                renameTabItem(c, tab),
                ['Close', () => {
                  if (
                    confirm(`Close ${tabName(tab)} and its panes?`)
                  ) {
                    request(
                      c.id,
                      'tab.close',
                      { tab_id: tab.tab_id },
                      'Close tab',
                    );
                  }
                }, true],
              ]),
          },
          h('span', { class: 'label' }, tabName(tab)),
        ),
      );
      for (const pane of tabPanes) rows.push(paneRow(c, pane, depth + 1));
    }
  }
  return rows;
}

function inactiveRows(inactive) {
  const errors = inactive.filter((c) => c.state !== 'no-session').length;
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
        `Not running (${inactive.length})`,
      ),
      errors > 0
        ? h(
          'span',
          { class: 'state', 'data-state': 'error' },
          `${errors} with errors`,
        )
        : '',
    ),
  ];
  if (!sidebarState.inactiveOpen) return rows;
  for (const c of inactive) {
    rows.push(
      h(
        'div',
        {
          class: 'row inactive',
          style: '--depth: 1',
          title: c.error ? `${c.localFolder}\n${c.error}` : c.localFolder,
        },
        h('span', { class: 'label' }, displayName(c)),
        h(
          'span',
          { class: 'row-actions' },
          h(
            'span',
            { class: 'state', 'data-state': c.state },
            STATE_TEXT[c.state] ?? c.state,
          ),
          c.state === 'no-session'
            ? h('button', {
              title: 'Start a Herdr server for this session',
              onclick: () => startSession(c.id),
            }, 'Start')
            : '',
          h('button', {
            onclick: () => send({ type: 'retry', container: c.id }),
          }, 'Retry'),
        ),
      ),
    );
  }
  return rows;
}

function paneRow(c, pane, depth, extraItems = []) {
  return h(
    'div',
    {
      class: 'row pane',
      style: `--depth: ${depth}`,
      title: pane.foreground_cwd || pane.cwd || '',
      onclick: () => openInFocusedTile(c, pane.pane_id),
      oncontextmenu: (e) =>
        openMenu(e, [
          ['Split right', () =>
            request(c.id, 'pane.split', {
              target_pane_id: pane.pane_id,
              direction: 'right',
            }, 'Split')],
          ['Split down', () =>
            request(c.id, 'pane.split', {
              target_pane_id: pane.pane_id,
              direction: 'down',
            }, 'Split')],
          ['Rename', () => {
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
          ...extraItems,
          ['Close', () => {
            if (confirm(`Close pane "${paneLabel(c, pane)}"?`)) {
              request(
                c.id,
                'pane.close',
                { pane_id: pane.pane_id },
                'Close pane',
              );
            }
          }, true],
        ]),
    },
    h('span', { class: 'label' }, paneLabel(c, pane)),
    badge(pane),
  );
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

document.addEventListener('mousedown', (e) => {
  if (!$menu.hidden && !$menu.contains(/** @type {Node} */ (e.target))) {
    closeMenu();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// ---------------------------------------------------------------------------------------------
// Layout persistence
// ---------------------------------------------------------------------------------------------

function saveLayout() {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ layout, focused: focusedTileId }),
    );
  } catch { /* storage unavailable: the layout just won't survive a reload */ }
}

/** @returns {LayoutNode | null} */
function validNode(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.type === 'tile') {
    const pane = n.pane && typeof n.pane.localFolder === 'string' &&
        typeof n.pane.pane_id === 'string'
      ? { localFolder: n.pane.localFolder, pane_id: n.pane.pane_id }
      : null;
    return {
      type: 'tile',
      id: typeof n.id === 'string' ? n.id : newTileId(),
      pane,
    };
  }
  if (n.type === 'split' && (n.dir === 'row' || n.dir === 'col')) {
    const a = validNode(n.a);
    const b = validNode(n.b);
    if (!a || !b) return a ?? b;
    const ratio =
      typeof n.ratio === 'number' && n.ratio > 0.05 && n.ratio < 0.95
        ? n.ratio
        : 0.5;
    return { type: 'split', dir: n.dir, ratio, a, b };
  }
  return null;
}

function loadLayout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
  } catch { /* unavailable or corrupt: start fresh */ }
  const node = validNode(saved?.layout);
  if (!node) return;
  layout = node;
  const ids = tileIds(layout);
  focusedTileId = ids.includes(saved.focused) ? saved.focused : ids[0];
}

/** @param {LayoutNode} n @returns {string[]} */
function tileIds(n) {
  return n.type === 'tile' ? [n.id] : [...tileIds(n.a), ...tileIds(n.b)];
}

/** @param {string} id @returns {TileNode | null} */
function findTile(id, n = layout) {
  if (n.type === 'tile') return n.id === id ? n : null;
  return findTile(id, n.a) ?? findTile(id, n.b);
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
  const size = view.renderer.resize() ?? { cols: 80, rows: 24 };
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

function openInFocusedTile(c, paneId) {
  const tile = findTile(focusedTileId) ?? findTile(tileIds(layout)[0]);
  if (!tile) return;
  closeTilePane(tile.id);
  tile.pane = { localFolder: c.localFolder, pane_id: paneId };
  saveLayout();
  reconcileTiles();
  views.get(tile.id)?.renderer.focus();
}

/**
 * Brings every tile's server-side open state in line with the containers and snapshots: open
 * what is reachable and not yet open, close what vanished, and refresh each overlay.
 */
function reconcileTiles() {
  for (const id of tileIds(layout)) {
    const tile = findTile(id);
    const view = views.get(id);
    if (!tile || !view) continue;
    const c = tile.pane ? containerByFolder(tile.pane.localFolder) : null;
    const reachable = c && c.state === 'connected' &&
      findPane(c.id, tile.pane.pane_id);
    if (!reachable) {
      // Disconnected or gone: the server already dropped (or will drop) the controller.
      if (view.openKey !== null && c && c.state === 'connected') {
        closeTilePane(id);
      }
      view.openKey = null;
    } else if (view.openKey === null && view.closedReason === null) {
      openTilePane(id, c.id, tile.pane.pane_id);
    } else if (
      view.openKey !== null && view.openKey !== paneKey(c.id, tile.pane.pane_id)
    ) {
      // The container restarted under a new id.
      closeTilePane(id);
      openTilePane(id, c.id, tile.pane.pane_id);
    }
    updateOverlay(id);
  }
  renderTileHeaders();
}

function updateOverlay(tileId) {
  const tile = findTile(tileId);
  const view = views.get(tileId);
  if (!tile || !view) return;
  let message = '';
  let action = null;
  if (!tile.pane) {
    message = 'Click a pane in the sidebar to open it here.';
  } else {
    const c = containerByFolder(tile.pane.localFolder);
    if (!socket) message = 'Disconnected from devc web.';
    else if (!c) message = `${basename(tile.pane.localFolder)} is not running.`;
    else if (c.state !== 'connected') {
      message = `${displayName(c)}: ${c.state}`;
    } else if (!findPane(c.id, tile.pane.pane_id)) message = 'Pane gone';
    else if (view.closedReason !== null) {
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

function renderTileHeaders() {
  for (const id of tileIds(layout)) {
    const tile = findTile(id);
    const view = views.get(id);
    if (!tile || !view) continue;
    const header = view.el.querySelector('.tile-header');
    const where = header.querySelector('.where');
    const title = header.querySelector('.title');
    const badgeSlot = header.querySelector('.badge-slot');
    if (!tile.pane) {
      where.textContent = '';
      title.textContent = 'empty';
      badgeSlot.replaceChildren();
      continue;
    }
    const c = containerByFolder(tile.pane.localFolder);
    const pane = c ? findPane(c.id, tile.pane.pane_id) : null;
    where.textContent = c ? displayName(c) : basename(tile.pane.localFolder);
    title.textContent = pane ? paneTitle(pane) : tile.pane.pane_id;
    const b = badge(pane);
    badgeSlot.replaceChildren(...(b ? [b] : []));
  }
}

function focusTile(tileId) {
  if (focusedTileId === tileId) return;
  focusedTileId = tileId;
  for (const [id, view] of views) {
    view.el.classList.toggle('focused', id === focusedTileId);
  }
  saveLayout();
}

/** Creates the live view (element + renderer) for a tile. */
function createView(tileId) {
  const termEl = h('div', { class: 'term' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, termEl, overlay);
  const header = h(
    'div',
    { class: 'tile-header' },
    h('span', { class: 'where' }),
    h('span', { class: 'title' }),
    h('span', { class: 'badge-slot' }),
    h(
      'span',
      { class: 'buttons' },
      h('button', {
        title: 'Split tile right',
        onclick: () => splitTile(tileId, 'row'),
      }, '⇥'),
      h('button', {
        title: 'Split tile down',
        onclick: () => splitTile(tileId, 'col'),
      }, '⇣'),
      h(
        'button',
        { title: 'Close tile', onclick: () => closeTile(tileId) },
        '✕',
      ),
    ),
  );
  const el = h('div', { class: 'tile' }, header, body);
  el.addEventListener('mousedown', () => focusTile(tileId), true);

  const renderer = createRenderer(termEl);
  /** @type {TileView} */
  const view = {
    el,
    body,
    overlay,
    renderer,
    openKey: null,
    size: null,
    closedReason: null,
    resizeTimer: undefined,
  };
  views.set(tileId, view);

  const target = () => {
    if (view.openKey === null) return null;
    const [container, pane_id] = view.openKey.split('\n');
    return { container, pane_id };
  };

  renderer.onData((data) => {
    const t = target();
    if (t) send({ type: 'input', ...t, bytes: encodeInput(data) });
  });

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

  new ResizeObserver(() => {
    clearTimeout(view.resizeTimer);
    view.resizeTimer = setTimeout(() => {
      const size = renderer.resize();
      if (!size) return;
      if (
        view.size && size.cols === view.size.cols &&
        size.rows === view.size.rows
      ) return;
      view.size = size;
      const t = target();
      if (t) send({ type: 'resize', ...t, ...size });
    }, RESIZE_DEBOUNCE_MS);
  }).observe(body);

  return view;
}

/**
 * Plain mouse down/drag/up over the terminal go to Herdr as cells (the browser does not
 * select); Shift+drag is left to xterm.js for a local selection, copied on mouseup.
 */
function attachMouse(view, termEl, target) {
  termEl.addEventListener('contextmenu', (ev) => ev.preventDefault());
  termEl.addEventListener('mousedown', (ev) => {
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
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);
}

/** @param {string} tileId @param {'row' | 'col'} dir */
function splitTile(tileId, dir) {
  const fresh = { type: 'tile', id: newTileId(), pane: null };
  layout = replaceNode(layout, tileId, (tile) => ({
    type: 'split',
    dir,
    ratio: 0.5,
    a: tile,
    b: fresh,
  }));
  focusedTileId = fresh.id;
  saveLayout();
  renderLayout();
}

function closeTile(tileId) {
  closeTilePane(tileId);
  const ids = tileIds(layout);
  if (ids.length === 1) {
    const tile = findTile(tileId);
    if (tile) tile.pane = null;
    views.get(tileId)?.renderer.dispose();
    views.delete(tileId);
  } else {
    layout = removeTile(layout, tileId) ?? layout;
    views.get(tileId)?.renderer.dispose();
    views.delete(tileId);
    if (focusedTileId === tileId) focusedTileId = tileIds(layout)[0];
  }
  saveLayout();
  renderLayout();
}

/** @param {LayoutNode} n @returns {LayoutNode} */
function replaceNode(n, tileId, fn) {
  if (n.type === 'tile') return n.id === tileId ? fn(n) : n;
  return {
    ...n,
    a: replaceNode(n.a, tileId, fn),
    b: replaceNode(n.b, tileId, fn),
  };
}

/** @param {LayoutNode} n @returns {LayoutNode | null} */
function removeTile(n, tileId) {
  if (n.type === 'tile') return n.id === tileId ? null : n;
  const a = removeTile(n.a, tileId);
  const b = removeTile(n.b, tileId);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

/** Rebuilds the tiling DOM. Tile elements (and their renderers) are reused, only re-parented. */
function renderLayout() {
  const build = (n) => {
    if (n.type === 'tile') {
      const view = views.get(n.id) ?? createView(n.id);
      view.el.classList.toggle('focused', n.id === focusedTileId);
      return view.el;
    }
    const slotA = h('div', { class: 'slot' }, build(n.a));
    const slotB = h('div', { class: 'slot' }, build(n.b));
    const divider = h('div', { class: 'divider' });
    const split = h(
      'div',
      { class: 'split', 'data-dir': n.dir },
      slotA,
      divider,
      slotB,
    );
    const apply = () => {
      slotA.style.flex = `${n.ratio} 1 0`;
      slotB.style.flex = `${1 - n.ratio} 1 0`;
    };
    apply();
    divider.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      divider.classList.add('dragging');
      const rect = split.getBoundingClientRect();
      const onMove = (e) => {
        const pos = n.dir === 'row'
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
        n.ratio = Math.min(0.9, Math.max(0.1, pos));
        apply();
      };
      const onUp = () => {
        divider.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        saveLayout();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    return split;
  };
  // Drop views whose tiles left the layout.
  const ids = new Set(tileIds(layout));
  for (const [id, view] of views) {
    if (!ids.has(id)) {
      closeTilePane(id);
      view.renderer.dispose();
      views.delete(id);
    }
  }
  $tiles.replaceChildren(build(layout));
  reconcileTiles();
}

loadLayout();
renderLayout();
renderTree();
connect();
