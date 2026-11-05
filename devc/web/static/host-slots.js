// Host tiles: places in `/main`'s layout that devc-desktop covers with a host terminal of its own
// (`.plans/archived/devc-desktop-host-tiles.md`). This page draws only the tab and a placeholder, and says
// where the placeholder is: devc-desktop puts its view there. It never sees the terminal, its
// shell or its color; in a browser, or once the app's shell is gone, the placeholder is all there
// is.
//
// The page tells the app with console lines, as it does of its dialogs (`client.js`):
//   devc-desktop:slot <id> <x> <y> <width> <height>   the placeholder's viewport rectangle
//   devc-desktop:slot <id> hidden                     not on screen (another tab, covered, gone)
//   devc-desktop:drag start | end                     a tile or sidebar row is being dragged
//   devc-desktop:overlay open | closed                a menu or a tab list is open
// In a browser they are debug lines no one sees.

import { h } from './ui.js';

/** @typedef {import('./layout.js').Tile} Tile */

/**
 * @typedef {object} HostTile
 * @property {Tile} tile
 * @property {HTMLElement} el  the placeholder
 * @property {boolean} visible  its stack shows it (Golden Layout's show/hide)
 * @property {string} last  the last line said for it
 */

/** @type {Map<string, HostTile>} by Tile.id */
const hostTiles = new Map();
let frame = 0;
let dragging = false;
let overlay = false;

/** @param {string} line */
const tell = (line) => console.debug(`devc-desktop:${line}`);

/** Builds a host tile's placeholder and starts saying where it is. */
export function mountHostTile(/** @type {Tile} */ tile) {
  const el = h(
    'div',
    { class: 'host-slot' },
    h('div', { class: 'host-slot-title' }, 'Host terminal — not running here'),
    h('div', { class: 'host-slot-hint' }, 'Close this tab'),
  );
  tile.element.append(el);
  tile.setTitle('host');
  hostTiles.set(tile.id, { tile, el, visible: true, last: '' });
  if (frame === 0) frame = requestAnimationFrame(report);
}

/** The tile is going: the app hides its view (the shell keeps running). */
export function unmountHostTile(/** @type {Tile} */ tile) {
  const entry = hostTiles.get(tile.id);
  if (!entry) return;
  hostTiles.delete(tile.id);
  if (entry.tile.host) tell(`slot ${entry.tile.host} hidden`);
  if (hostTiles.size === 0) {
    cancelAnimationFrame(frame);
    frame = 0;
    setDragging(false);
    setOverlay(false);
  }
}

/** Its stack shows it, or another tab. */
export function hostTileVisibility(
  /** @type {Tile} */ tile,
  /** @type {boolean} */ visible,
) {
  const entry = hostTiles.get(tile.id);
  if (entry) entry.visible = visible;
}

/** The host tile showing slot `id`, if any. @param {string} id */
export function hostTileWithSlot(id) {
  for (const entry of hostTiles.values()) {
    if (entry.tile.host === id) return entry.tile;
  }
  return null;
}

function setDragging(/** @type {boolean} */ on) {
  if (on === dragging) return;
  dragging = on;
  tell(`drag ${on ? 'start' : 'end'}`);
}

function setOverlay(/** @type {boolean} */ on) {
  if (on === overlay) return;
  overlay = on;
  tell(`overlay ${on ? 'open' : 'closed'}`);
}

/** Whether a menu, or a stack's list of the tabs it has no room for, is open. */
function overlayOpen() {
  const menu = document.getElementById('menu');
  if (menu && !menu.hidden) return true;
  for (const list of document.querySelectorAll('.lm_tabdropdown_list')) {
    if (/** @type {HTMLElement} */ (list).offsetParent !== null) return true;
  }
  return false;
}

/**
 * Whether the placeholder is what shows at its centre: not when another stack is maximised over
 * it (zen mode), nor under anything else this page draws there. (Menus are said apart, with the
 * overlay lines.)
 *
 * @param {HTMLElement} el @param {DOMRect} r
 */
function uncovered(el, r) {
  const top = document.elementFromPoint(
    r.left + r.width / 2,
    r.top + r.height / 2,
  );
  return top !== null && el.contains(top);
}

/**
 * The page's own controls that float over the tiles' corners (zen mode's toggle, the corner
 * toggle that shows devc-desktop's column again): the app's view would cover them, so a host
 * tile's rectangle starts below any that overlaps it.
 */
const FLOATING = '.zen-toggle, .sidebar-corner';

/** @param {DOMRect} r @returns {{left: number, top: number, width: number, height: number}} */
function clearOfControls(r) {
  let top = r.top;
  for (const el of document.querySelectorAll(FLOATING)) {
    const f = /** @type {HTMLElement} */ (el).getBoundingClientRect();
    if (f.width === 0 || f.height === 0) continue;
    if (f.right <= r.left || f.left >= r.right) continue;
    if (f.bottom <= top || f.top >= r.bottom) continue;
    top = Math.max(top, f.bottom);
  }
  return { left: r.left, top, width: r.width, height: r.bottom - top };
}

/** One frame: each host tile's line, when it changed, and the drag and overlay lines. */
function report() {
  frame = hostTiles.size > 0 ? requestAnimationFrame(report) : 0;
  setDragging(document.querySelector('.lm_dragProxy') !== null);
  setOverlay(overlayOpen());
  for (const entry of hostTiles.values()) {
    const id = entry.tile.host;
    if (!id) continue;
    const r = entry.el.getBoundingClientRect();
    const shown = entry.visible && entry.el.isConnected &&
      entry.el.closest('.lm_dragProxy') === null && r.width >= 1 &&
      r.height >= 1 && uncovered(entry.el, r);
    const c = clearOfControls(r);
    const line = shown && c.height >= 1
      ? `slot ${id} ${Math.round(c.left)} ${Math.round(c.top)} ${
        Math.round(c.width)
      } ${Math.round(c.height)}`
      : `slot ${id} hidden`;
    if (line === entry.last) continue;
    entry.last = line;
    tell(line);
  }
}
