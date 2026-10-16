// The terminal renderer behind every tile. The only module that imports xterm.js, so swapping
// in another renderer (ghostty-web, say) is a change to this file alone.
//
// Herdr's frames are complete screen paints with no terminal modes in them, so this is a plain
// screen painter: no scrollback (Herdr owns it), DOM renderer (browsers cap WebGL contexts at
// about 16 per page, and a page may have more tiles than that).

import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/xterm/addon-fit.mjs';

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
 */

/**
 * Mounts a renderer into `element`.
 *
 * @param {HTMLElement} element
 * @returns {Renderer}
 */
export function createRenderer(element) {
  const term = new Terminal({
    scrollback: 0,
    cursorBlink: false,
    allowProposedApi: false,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
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
  };
}
