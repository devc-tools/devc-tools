// The `devc web` page at `/`: the sidebar (`sidebar.js`) and the tiling area (`tiles.js`) side
// by side over one server connection (`client.js`), each reaching the other only through the
// contracts of `lib/view.js`. What only the combined page has is here: the sidebar's resizer,
// its hide button and Cmd+B, and the host status strip across the foot of the page.

import {
  clampSidebarWidth,
  isSidebarToggleShortcut,
  SIDEBAR_DEFAULT_WIDTH,
} from './lib/sidebar.js';
import { bridgeStatusItems, usageItems } from './lib/host_status.js';
import { h, IS_MAC } from './ui.js';
import {
  connect,
  hostBridgeStatus,
  hostUsage,
  onServerMessage,
  SAFE_MODE,
  showSafeBanner,
} from './client.js';
import { mountTiles } from './tiles.js';
import { mountSidebar, SIDEBAR_KEY } from './sidebar.js';

// ---------------------------------------------------------------------------------------------
// The sidebar's width and visibility
// ---------------------------------------------------------------------------------------------

const $app = /** @type {HTMLElement} */ (document.querySelector('.app'));
const $resizer = /** @type {HTMLElement} */ (document.getElementById(
  'sidebar-resizer',
));
const $sidebarToggle = /** @type {HTMLElement} */ (document.getElementById(
  'sidebar-toggle',
));

/**
 * The sidebar's width and hidden state, per browser: the page's, saved under the sidebar's key
 * (`SIDEBAR_KEY`) beside the sidebar's own state, which saving keeps as it is.
 */
const sidebarLayout = loadSidebarLayout();

function loadSidebarLayout() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null');
  } catch { /* unavailable or corrupt: the default width, shown */ }
  return {
    width: Number.isFinite(saved?.width) ? saved.width : SIDEBAR_DEFAULT_WIDTH,
    hidden: saved?.hidden === true,
  };
}

function saveSidebarLayout() {
  try {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? 'null');
    } catch { /* corrupt: replaced */ }
    localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({
        ...(saved && typeof saved === 'object' ? saved : {}),
        width: sidebarLayout.width,
        hidden: sidebarLayout.hidden,
      }),
    );
  } catch { /* storage unavailable: the width just won't survive a reload */ }
}

/**
 * Applies the sidebar's width and hidden state. The width is clamped to the window as it is
 * now; the saved one stays as chosen, so it comes back when the window grows again.
 */
function applySidebarLayout() {
  $app.dataset.sidebar = sidebarLayout.hidden ? 'hidden' : 'shown';
  const toggleLabel = sidebarLayout.hidden ? 'Show sidebar' : 'Hide sidebar';
  $sidebarToggle.setAttribute('aria-label', toggleLabel);
  $sidebarToggle.title = toggleLabel;
  $app.style.setProperty(
    '--sidebar-width',
    `${clampSidebarWidth(sidebarLayout.width, innerWidth)}px`,
  );
}

function toggleSidebarHidden() {
  sidebarLayout.hidden = !sidebarLayout.hidden;
  saveSidebarLayout();
  applySidebarLayout();
}

$sidebarToggle.addEventListener('click', toggleSidebarHidden);
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
    sidebarLayout.width = clampSidebarWidth(e.clientX - left, innerWidth);
    applySidebarLayout();
  };
  const onEnd = () => {
    $resizer.removeEventListener('pointermove', onMove);
    $resizer.removeEventListener('lostpointercapture', onEnd);
    $resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-sidebar');
    saveSidebarLayout();
  };
  $resizer.addEventListener('pointermove', onMove);
  $resizer.addEventListener('lostpointercapture', onEnd);
});
$resizer.addEventListener('dblclick', () => {
  sidebarLayout.width = SIDEBAR_DEFAULT_WIDTH;
  saveSidebarLayout();
  applySidebarLayout();
});

// Cmd+B (Mac only) shows or hides the sidebar, in the capture phase for the same reason.
document.addEventListener('keydown', (e) => {
  if (!isSidebarToggleShortcut(e, IS_MAC)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) toggleSidebarHidden();
}, true);

// ---------------------------------------------------------------------------------------------
// Host status
// ---------------------------------------------------------------------------------------------

/**
 * The host status strip across the foot of the page, under the sidebar and the tiles alike:
 * host-level indicators, the account-wide
 * agent usage limits (`usage`) then devc-bridge's (`bridge_status`). Hidden while it has nothing
 * to show.
 */
const $hostStatus = h('footer', {
  class: 'host-status',
  id: 'host-status',
  'aria-label': 'Host status',
  hidden: true,
});
$app.append($hostStatus);
// Usage windows reset and observations age with no server traffic: re-evaluate every minute.
setInterval(() => {
  if (hostUsage?.length) renderHostStatus();
}, 60_000);
onServerMessage((msg) => {
  if (msg.type === 'bridge_status' || msg.type === 'usage') renderHostStatus();
});

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

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

if (SAFE_MODE) showSafeBanner();
applySidebarLayout();
/** The sidebar, once mounted: the tiling area's way to it until then goes nowhere. */
let sidebar = /** @type {ReturnType<typeof mountSidebar> | null} */ (null);
const tileArea = mountTiles(
  /** @type {HTMLElement} */ (document.getElementById('tiles')),
  {
    sidebar: {
      revealInContainers: (ref) => sidebar?.intents.revealInContainers(ref),
      prViewed: (diff, viewed) => sidebar?.intents.prViewed(diff, viewed),
    },
    onViewChange: (state) => sidebar?.onViewState(state),
  },
);
sidebar = mountSidebar(
  /** @type {HTMLElement} */ (document.querySelector('aside.sidebar')),
  { tileArea },
);
connect();
