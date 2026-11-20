// The `devc web` sidebar's Outline section: the tests and top-level declarations of the file tile
// focused last, from the view state's `outline` (made by `tiles.js` with `lib/outline.js`). A
// row's click moves that tile's cursor to the item (`ViewIntents.revealLine`); the row holding the
// cursor is marked current and kept in sight. It reaches the tiling area only through the
// `TileArea` it is given, so it works on `/sidebar` as on `/`. `mountOutlineZone` gives it a zone
// and the draggable divider above it, below Projects wherever Projects is drawn: `sidebar.js`'s
// bottom zone, or devc-desktop's Containers pane (which then has `/sidebar` draw none). See
// `.plans/archived/devc-web-outline.md`.

import { MAX_OUTLINE_ITEMS } from './lib/outline.js';
import { outlineZoneHeight } from './lib/sidebar.js';
import {
  chevron,
  errorToast,
  h,
  hoverActions,
  iconButton,
  LABELS,
  openMenu,
  rowTrail,
  toast,
} from './ui.js';
import { saveSidebarState, sectionRow, sidebarState } from './cards.js';

/** @typedef {import('./lib/view.js').TileArea} TileArea */
/** @typedef {import('./lib/view.js').OutlineState} OutlineState */
/** @typedef {import('./lib/outline.js').OutlineItem} OutlineItem */

/** Each kind's marker and the word its tooltip uses. */
const KINDS = {
  suite: ['◆', 'Suite'],
  test: ['●', 'Test'],
  function: ['ƒ', 'Function'],
  class: ['C', 'Class'],
  method: ['m', 'Method'],
  interface: ['I', 'Interface'],
  type: ['T', 'Type'],
  enum: ['E', 'Enum'],
};

/**
 * Mounts the Outline into `zone`. `open` and `setOpen` are the section's fold, kept with the
 * sidebar's state; `changed` runs after a draw that may change the zone's height.
 *
 * @param {HTMLElement} zone
 * @param {{tileArea: TileArea, open: () => boolean, setOpen: (open: boolean) => void,
 *   changed?: () => void}} opts
 * @returns {{draw: (outline: OutlineState | null | undefined) => void}}
 */
export function mountOutline(zone, { tileArea, open, setOpen, changed }) {
  /** The outline drawn last, as JSON: an unchanged one is not drawn again. */
  let drawnJson = '';
  /** @type {OutlineState | null} */
  let shown = null;
  /** The current item drawn last, by tile, to tell when it moved. */
  let shownCurrent = '';
  /** Folded items, by {@link itemKey}; kept for the page's life, not saved. */
  const folded = new Set();

  const redraw = () => {
    drawnJson = '';
    draw(shown);
  };

  /** @param {OutlineState | null | undefined} outline */
  function draw(outline) {
    outline = outline ?? null;
    const json = JSON.stringify([outline, open()]);
    if (json === drawnJson) return;
    drawnJson = json;
    shown = outline;
    const isOpen = open();
    const rows = [heading(outline, isOpen)];
    if (isOpen) rows.push(...bodyRows(outline));
    const scroll = zone.scrollTop;
    zone.replaceChildren(...rows);
    zone.scrollTop = scroll;
    const current = outline && outline.current !== null
      ? `${outline.tile}\n${outline.current}`
      : '';
    if (current !== shownCurrent) {
      shownCurrent = current;
      zone.querySelector('.outline-row[data-current]')?.scrollIntoView({
        block: 'nearest',
      });
    }
    changed?.();
  }

  /** @param {OutlineState | null} outline @param {boolean} isOpen */
  function heading(outline, isOpen) {
    return sectionRow(
      h(
        'span',
        {},
        'Outline',
        outline
          ? h('span', { class: 'pane-title outline-file' }, outline.title)
          : '',
      ),
      isOpen,
      () => {
        setOpen(!open());
        redraw();
      },
      rowTrail(
        hoverActions(
          iconButton('collapseAll', LABELS.collapseAll, collapseAll),
        ),
      ),
    );
  }

  /** Folds every item with children in the outline shown. */
  function collapseAll() {
    if (!shown) return;
    const items = shown.items;
    eachItem(shown, (item, i, key) => {
      if (items[i + 1]?.depth > item.depth) folded.add(key);
    });
    redraw();
  }

  /** @param {OutlineState | null} outline @returns {HTMLElement[]} */
  function bodyRows(outline) {
    if (!outline) return [empty('No file open')];
    if (!outline.supported) return [empty(`No outline for ${outline.title}`)];
    if (outline.items.length === 0) {
      return [empty(outline.partial ? 'Loading…' : 'Nothing to outline')];
    }
    /** @type {HTMLElement[]} */
    const rows = [];
    const items = outline.items;
    /** The depth below which items are hidden by a folded parent; Infinity for none. */
    let hiddenBelow = Infinity;
    eachItem(outline, (item, i, key) => {
      if (item.depth > hiddenBelow) return;
      hiddenBelow = Infinity;
      const parent = items[i + 1]?.depth > item.depth;
      const isFolded = parent && folded.has(key);
      if (isFolded) hiddenBelow = item.depth;
      rows.push(itemRow(outline, item, i, key, parent, isFolded));
    });
    if (outline.truncated) {
      rows.push(empty(`First ${MAX_OUTLINE_ITEMS} items shown`));
    }
    return rows;
  }

  /**
   * @param {OutlineState} outline @param {OutlineItem} item @param {number} i
   * @param {string} key @param {boolean} parent @param {boolean} isFolded
   */
  function itemRow(outline, item, i, key, parent, isFolded) {
    const [marker, word] = KINDS[item.kind] ?? ['·', item.kind];
    const fold = chevron();
    if (parent) {
      // Titled, so it takes the pointer: a titled row's insides do not (style.css `.row[title] *`).
      fold.title = isFolded ? 'Unfold' : 'Fold';
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        if (folded.has(key)) folded.delete(key);
        else folded.add(key);
        redraw();
      });
    }
    return h(
      'div',
      {
        class: 'row outline-row',
        style: `--depth: ${item.depth + 1}`,
        'aria-expanded': parent ? String(!isFolded) : undefined,
        'data-current': i === outline.current ? '' : undefined,
        title: `${word} ${item.name}\nLine ${item.line}`,
        onclick: () =>
          tileArea.revealLine(outline.tile, item.line, item.endLine),
        oncontextmenu: (/** @type {MouseEvent} */ e) =>
          openMenu(e, [['Copy name', () => copyName(item.name)]]),
      },
      h(
        'span',
        { class: 'label' },
        fold,
        h(
          'span',
          {
            class: `outline-kind outline-kind-${item.kind}`,
            'aria-hidden': 'true',
          },
          marker,
        ),
        h('span', { class: 'outline-name' }, item.name),
      ),
      item.modifiers.length
        ? rowTrail(
          ...item.modifiers.map((m) => h('span', { class: 'outline-tag' }, m)),
        )
        : '',
    );
  }

  return { draw };
}

/**
 * The Outline's zone and the divider above it, for the page to place below Projects: the section
 * (its fold kept as `outlineOpen` in the sidebar's state) and its height. Open, the zone is
 * `outlineZoneHeight` of `avail()` (its dragged share, `outlineSize`, else the default), or all
 * that is left while `setFill(true)` (Projects folded in devc-desktop's pane); folded, its heading.
 * `changed` runs when its height may have changed (a draw, a fold, a drag), for the page to lay
 * its zones out again (calling `applySize`); `reset` is a divider's double-click (by default, the
 * Outline's own size back to its default).
 *
 * @param {{tileArea: TileArea, avail: () => number, changed: () => void, reset?: () => void}} opts
 */
export function mountOutlineZone({ tileArea, avail, changed, reset }) {
  const zone = h('div', { class: 'zone zone-outline' });
  const divider = h('div', {
    class: 'zone-divider',
    role: 'separator',
    'aria-orientation': 'horizontal',
    title: 'Drag to resize, double-click to reset',
  });
  let fill = false;
  const section = mountOutline(zone, {
    tileArea,
    open: () => sidebarState.outlineOpen,
    setOpen: (open) => {
      sidebarState.outlineOpen = open;
      saveSidebarState();
    },
    changed,
  });

  function applySize() {
    const open = sidebarState.outlineOpen;
    divider.dataset.inert = String(!open || fill);
    if (!open) {
      zone.style.flex = '0 0 auto';
      return;
    }
    if (fill) {
      zone.style.flex = '1 1 0';
      return;
    }
    const space = avail();
    if (space <= 0) return;
    zone.style.flex = `0 0 ${
      outlineZoneHeight(space, sidebarState.outlineSize)
    }px`;
  }

  // Dragged with pointer capture, as the sidebar's other dividers: the zone's top edge follows
  // the pointer, within `outlineZoneHeight`'s limits.
  divider.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || divider.dataset.inert === 'true') return;
    ev.preventDefault();
    ev.stopPropagation();
    divider.setPointerCapture(ev.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing-zones');
    const bottom = zone.getBoundingClientRect().bottom;
    const grab = ev.clientY - divider.getBoundingClientRect().top;
    const space = avail();
    let moved = false;
    const onMove = (/** @type {PointerEvent} */ e) => {
      if (space <= 0) return;
      moved = true;
      const want = bottom - (e.clientY - grab) - divider.offsetHeight;
      sidebarState.outlineSize = outlineZoneHeight(space, want / space) /
        space;
      changed();
    };
    const onEnd = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('lostpointercapture', onEnd);
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing-zones');
      if (moved) saveSidebarState();
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('lostpointercapture', onEnd);
  });
  divider.addEventListener('dblclick', () => {
    if (divider.dataset.inert === 'true') return;
    if (reset) {
      reset();
      return;
    }
    sidebarState.outlineSize = null;
    saveSidebarState();
    changed();
  });

  return {
    zone,
    divider,
    draw: section.draw,
    applySize,
    /** Whether the section is open (not folded to its heading). */
    isOpen: () => sidebarState.outlineOpen,
    /** @param {boolean} on */
    setFill(on) {
      fill = on;
      applySize();
    },
  };
}

/**
 * Calls `fn` with each item, its index and its fold key: the outline's tile and the names of the
 * item and its ancestors.
 *
 * @param {OutlineState} outline
 * @param {(item: OutlineItem, i: number, key: string) => void} fn
 */
function eachItem(outline, fn) {
  /** @type {string[]} */
  const path = [];
  outline.items.forEach((item, i) => {
    path.length = item.depth;
    path.push(item.name);
    fn(item, i, [outline.tile, ...path].join('\n'));
  });
}

/** @param {string} text */
function empty(text) {
  return h('div', { class: 'empty' }, text);
}

/** @param {string} name */
function copyName(name) {
  navigator.clipboard?.writeText(name).then(
    () => toast('Copied name'),
    (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
  );
}
