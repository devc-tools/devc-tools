// The `devc web` page: the WebSocket client for `/ws`, the sidebar tree
// (Container → Workspace → Tab → Pane, single-child levels folded) and the browser-owned tiling area. The protocol is
// specified in `.plans/devc-web.md`; renderer details live in `renderer.js`, window management
// in `layout.js` (Golden Layout), and the pure input helpers in `lib/input.js`.

import { createRenderer } from './renderer.js';
import { createTiling } from './layout.js';
import { parseSavedLayout, tileTitle } from './lib/layout_state.js';
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

const LAYOUT_KEY = 'devc-web-layout-v2';
/** The split-tree layout before Golden Layout: removed on load, not migrated. */
const OLD_LAYOUT_KEY = 'devc-web-layout-v1';
const RESIZE_DEBOUNCE_MS = 100;
const DRAG_INTERVAL_MS = 50;
const RECONNECT_MS = 2000;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{id: string, localFolder: string, name: string, state: string, error?: string}} ContainerInfo
 * @typedef {import('./lib/layout_state.js').PaneRef} PaneRef
 * @typedef {import('./layout.js').Tile} Tile
 */

/** @type {Map<string, ContainerInfo>} by container id */
const containers = new Map();
/** @type {Map<string, any>} Herdr snapshots, by container id */
const snapshots = new Map();

/** @type {ReturnType<typeof createTiling> | null} set once the page has started */
let tiling = null;
/** @type {string | null} */
let focusedTileId = null;
/**
 * Sidebar pane rows by `container\npane`, kept across renders and updated in place. Each is a
 * Golden Layout drag source, and unregistering one tears down the document listeners of a drag
 * in progress — so a row (and its drag source) lives as long as its pane, not one render.
 *
 * @type {Map<string, {row: HTMLElement, c: any, pane: any, extraItems: any[], seen: number, remove: (() => void) | null}>}
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
 * @property {ResizeObserver} observer
 */

/** @type {Map<string, TileView>} by Tile.id */
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
  renderTileTitles();
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
  const generation = ++renderGeneration;
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
  for (const [key, rec] of paneRows) {
    if (rec.seen === generation) continue;
    rec.remove?.();
    paneRows.delete(key);
  }
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

function paneMenu(rec) {
  const { c, pane } = rec;
  return [
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
    ...rec.extraItems,
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
  ];
}

/** A pane's sidebar row: the kept one for this pane (see {@link paneRows}), brought up to date. */
function paneRow(c, pane, depth, extraItems = []) {
  const key = paneKey(c.id, pane.pane_id);
  let rec = paneRows.get(key);
  if (!rec) {
    const row = h('div', {
      class: 'row pane',
      onclick: () => openInFocusedTile(rec.c, rec.pane.pane_id),
      oncontextmenu: (e) => openMenu(e, paneMenu(rec)),
    });
    rec = { row, c, pane, extraItems, seen: 0, remove: null };
    paneRows.set(key, rec);
  }
  Object.assign(rec, { c, pane, extraItems, seen: renderGeneration });
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
  row.style.setProperty('--depth', String(depth));
  // The children ignore the pointer, so the badge's tooltip lives here.
  row.title = [
    pane.foreground_cwd || pane.cwd || '',
    pane.agent ? `${pane.agent}: ${agentStatus(pane)}` : '',
  ].filter((s) => s).join('\n');
  row.replaceChildren(
    h('span', { class: 'label' }, paneLabel(c, pane)),
    badge(pane),
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
  if (tile) {
    closeTilePane(tile.id);
    views.get(tile.id).closedReason = null;
    tile.setRef(ref);
  } else {
    tile = tiling.add(ref);
  }
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
    else if (!c) message = `${basename(ref.localFolder)} is not running.`;
    else if (c.state !== 'connected') {
      message = `${displayName(c)}: ${c.state}`;
    } else if (!findPane(c.id, ref.pane_id)) message = 'Pane gone';
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

/** Each tile's tab: `<container> · <pane title>`, and the pane's agent badge. */
function renderTileTitles() {
  for (const view of views.values()) {
    const ref = view.tile.ref;
    if (!ref) {
      view.tile.setTitle('empty');
      view.tile.setBadge(null);
      continue;
    }
    const c = containerByFolder(ref.localFolder);
    const pane = c ? findPane(c.id, ref.pane_id) : null;
    view.tile.setTitle(
      tileTitle(
        c ? displayName(c) : basename(ref.localFolder),
        pane ? paneTitle(pane) : ref.pane_id,
      ),
    );
    view.tile.setBadge(badge(pane) || null);
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
  const termEl = h('div', { class: 'term' });
  const overlay = h('div', { class: 'overlay' });
  const body = h('div', { class: 'tile-body' }, termEl, overlay);
  tile.element.append(body);
  tile.element.addEventListener('mousedown', () => {
    focusedTileId = tile.id;
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
  const view = views.get(tile.id);
  if (!view) return;
  closeTilePane(tile.id);
  for (const [id, tileId] of pendingOpens) {
    if (tileId === tile.id) pendingOpens.delete(id);
  }
  clearTimeout(view.resizeTimer);
  view.observer.disconnect();
  view.renderer.dispose();
  views.delete(tile.id);
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
    if (tile) focusedTileId = tile.id;
  },
  // A drop is a change too: the dropped tile is placed now, so it may open its pane.
  changed: () => {
    saveLayout();
    reconcileTiles();
  },
});
restoreLayout();
reconcileTiles();
renderTree();
connect();
