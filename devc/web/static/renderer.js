// The terminal renderer behind every tile. The only module that imports xterm.js, so swapping
// in another renderer (ghostty-web, say) is a change to this file alone.
//
// Herdr's frames are complete screen paints with no terminal modes in them, so this is a plain
// screen painter: no scrollback (Herdr owns it), DOM renderer (browsers cap WebGL contexts at
// about 16 per page, and a page may have more tiles than that).

import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';
import { selectionSpan } from './lib/input.js';
import { findLinks, linkAt } from './lib/links.js';

/**
 * @typedef {object} Renderer
 * @property {(bytes: Uint8Array, cols?: number, rows?: number) => void} write
 *   Paints a frame. `cols`/`rows` are the frame's size; the grid follows it when they differ.
 * @property {() => {cols: number, rows: number} | null} resize
 *   Fits the grid to the element and returns its size, or `null` when it is not laid out.
 * @property {(cb: (data: string) => void) => void} onData  Keyboard input, as a string.
 * @property {(cb: (ev: WheelEvent) => void) => void} onWheel
 *   Wheel events; the renderer's own scrolling is suppressed.
 * @property {() => void} focus
 * @property {() => void} dispose
 * @property {() => {left: number, top: number, cellWidth: number, cellHeight: number, cols: number, rows: number} | null} metrics
 *   The screen's client rect origin and cell size, for pixel→cell conversion.
 * @property {() => string} selection  The current local selection's text ('' for none).
 * @property {(anchor: {column: number, row: number}, cursor: {column: number, row: number}) => void} highlight
 *   Paints the inclusive range between two viewport cells (either order) as selected.
 * @property {() => void} clearHighlight
 * @property {(cell: {column: number, row: number}) => import('./lib/links.js').Link | null} linkAt
 *   The URL or file path drawn over a viewport cell, if any.
 */

/**
 * The page's custom property `name` (style.css's `:root`) in px, or `fallback` when it is unset
 * or not a px length.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function cssPx(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(
    name,
  ).trim();
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return px ? Number(px[1]) : fallback;
}

/**
 * Mounts a renderer into `element`. Links (see `lib/links.js`) are underlined under the pointer,
 * with `linkHint` as their tooltip, and get a pointer cursor while `linkModifier` says the key
 * that opens them is held; opening one is the caller's (clicks never reach xterm.js).
 *
 * @param {HTMLElement} element
 * @param {{linkHint?: string,
 *   linkModifier?: (ev: MouseEvent | KeyboardEvent) => boolean}} [opts]
 * @returns {Renderer}
 */
export function createRenderer(
  element,
  { linkHint = '', linkModifier = () => false } = {},
) {
  const term = new Terminal({
    scrollback: 0,
    cursorBlink: false,
    allowProposedApi: false,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: cssPx('--code-font-size', 13),
    theme: { background: '#11131a' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(element);

  /** @type {(ev: WheelEvent) => void} */
  let wheel = () => {};
  term.attachCustomWheelEventHandler((ev) => {
    ev.preventDefault();
    wheel(ev);
    return false;
  });

  /**
   * Row `y`'s text, the cell each of its characters starts in, and its links. No scrollback, so
   * buffer rows are viewport rows.
   */
  const lineLinks = (y) => {
    const line = term.buffer.active.getLine(y);
    let text = '';
    /** @type {number[]} */
    const cells = [];
    for (let x = 0; line && x < line.length; x++) {
      const cell = line.getCell(x);
      // The right half of a wide character has no text of its own.
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let i = 0; i < chars.length; i++) cells.push(x);
      text += chars;
    }
    return { cells, links: findLinks(text) };
  };

  // The pointer cursor needs both: the pointer over a link, and the modifier down. Keys are
  // watched on the window, so pressing or releasing it over a link updates the cursor.
  let overLink = false;
  let modifierDown = false;
  const updateCursor = () => {
    term.element?.classList.toggle(
      'xterm-cursor-pointer',
      overLink && modifierDown,
    );
  };
  /** @param {MouseEvent | KeyboardEvent} ev */
  const onModifier = (ev) => {
    modifierDown = linkModifier(ev);
    updateCursor();
  };
  const onBlur = () => {
    modifierDown = false;
    updateCursor();
  };
  window.addEventListener('keydown', onModifier, true);
  window.addEventListener('keyup', onModifier, true);
  window.addEventListener('blur', onBlur);
  element.addEventListener('mousemove', onModifier);

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const { cells, links } = lineLinks(y - 1);
      callback(links.map((link) => ({
        range: {
          start: { x: cells[link.start] + 1, y },
          end: { x: cells[link.end - 1] + 1, y },
        },
        text: link.kind === 'url' ? link.url : link.path,
        decorations: { underline: true, pointerCursor: false },
        activate() {},
        hover(ev) {
          if (linkHint) element.title = linkHint;
          overLink = true;
          onModifier(ev);
        },
        leave() {
          element.removeAttribute('title');
          overLink = false;
          updateCursor();
        },
      })));
    },
  });

  const screen = () => /** @type {HTMLElement | null} */ (element.querySelector(
    '.xterm-screen',
  ));

  return {
    write(bytes, cols, rows) {
      if (
        cols && rows && cols > 0 && rows > 0 &&
        (cols !== term.cols || rows !== term.rows)
      ) {
        term.resize(cols, rows);
      }
      term.write(bytes);
    },
    resize() {
      const dims = fit.proposeDimensions();
      if (!dims || !dims.cols || !dims.rows || !isFinite(dims.cols)) {
        return null;
      }
      const cols = Math.max(2, dims.cols);
      const rows = Math.max(1, dims.rows);
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      return { cols, rows };
    },
    onData(cb) {
      term.onData(cb);
    },
    onWheel(cb) {
      wheel = cb;
    },
    focus() {
      term.focus();
    },
    dispose() {
      window.removeEventListener('keydown', onModifier, true);
      window.removeEventListener('keyup', onModifier, true);
      window.removeEventListener('blur', onBlur);
      term.dispose();
    },
    metrics() {
      const el = screen();
      if (!el || term.cols === 0 || term.rows === 0) return null;
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        cellWidth: rect.width / term.cols,
        cellHeight: rect.height / term.rows,
        cols: term.cols,
        rows: term.rows,
      };
    },
    selection() {
      return term.hasSelection() ? term.getSelection() : '';
    },
    // No scrollback, so the buffer's rows are the viewport's.
    highlight(anchor, cursor) {
      const span = selectionSpan(anchor, cursor, term.cols);
      term.select(span.column, span.row, span.length);
    },
    clearHighlight() {
      term.clearSelection();
    },
    linkAt({ column, row }) {
      const { cells, links } = lineLinks(row);
      const index = cells.indexOf(column);
      return index < 0 ? null : linkAt(links, index);
    },
  };
}
