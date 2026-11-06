// The mouse over a Herdr terminal, for every terminal that draws Herdr's frames with
// `renderer.js`: devc web's pane tiles (`tiles.js`) and devc-desktop's host terminals, which
// bundle this module at build time. What a press, a drag or a link click *does* is the caller's
// (its hooks); how the mouse is read is here, once. See `.plans/host-terminal-herdr.md` (D4).

import { mouseButton, pixelToCell } from './lib/input.js';

/** Drags go to Herdr at most this often, in ms; the last one always goes. */
export const DRAG_INTERVAL_MS = 50;
/**
 * How long a copied drag's highlight stays, in a pane whose app draws no selection of its own.
 * It marks grid cells, not text, so it would go stale on the app's next redraw: a brief flash
 * confirms what was copied.
 */
export const COPY_FLASH_MS = 500;

/**
 * @typedef {{column: number, row: number}} Cell
 * @typedef {{
 *   mouse(cmd: {action: 'down' | 'up' | 'drag', button: 'left' | 'right' | 'middle',
 *               column: number, row: number}): void,
 *   copyRange(anchor: Cell, cursor: Cell): void,
 *   openLink(link: import('./lib/links.js').Link): void,
 *   contextMenu(ev: MouseEvent): void,
 *   frames(): number,
 *   linkModifier(ev: MouseEvent | KeyboardEvent): boolean,
 *   active(): boolean,
 * }} MouseHooks
 *   `mouse`: a press, drag or release for Herdr, in viewport cells. `copyRange`: copy the text
 *   between two cells, read from Herdr. `frames`: how many frames have been drawn so far.
 *   `active`: whether a pane is attached (nothing goes to Herdr, and no link opens, without one).
 */

/**
 * The terminal cell under a mouse event, or null before the terminal is laid out.
 *
 * @param {import('./renderer.js').Renderer} renderer
 * @param {MouseEvent} e
 * @returns {Cell | null}
 */
export function cellAt(renderer, e) {
  const m = renderer.metrics();
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
 * Plain mouse down/drag/up over the terminal go to Herdr as cells (the browser does not
 * select); a plain left-drag's text is copied from Herdr, and flashed here unless the app redrew
 * during the drag (it draws its own selection). Shift+drag is left to xterm.js for a local
 * selection, copied on mouseup. A right-click opens the caller's menu and is not sent to the app.
 * Cmd+click (Ctrl+click off a Mac: `linkModifier`) on a link opens it, caught in the capture phase
 * so it works while an app has mouse reporting on; anywhere else it is an ordinary click.
 *
 * @param {HTMLElement} termEl
 * @param {import('./renderer.js').Renderer} renderer
 * @param {MouseHooks} hooks
 * @returns {() => void} dispose: clears a pending copy flash
 */
export function attachTerminalMouse(termEl, renderer, hooks) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flashTimer;
  termEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    hooks.contextMenu(ev);
  });
  termEl.addEventListener('mousedown', (ev) => {
    if (ev.button === 2) {
      ev.preventDefault();
      ev.stopPropagation();
      renderer.focus();
      return;
    }
    if (ev.button === 0 && hooks.linkModifier(ev)) {
      const at = cellAt(renderer, ev);
      const link = at && renderer.linkAt(at);
      if (link && hooks.active()) {
        ev.preventDefault();
        ev.stopPropagation();
        hooks.openLink(link);
        return;
      }
    }
    if (ev.shiftKey) {
      const onUp = () => {
        window.removeEventListener('mouseup', onUp, true);
        const text = renderer.selection();
        if (text) navigator.clipboard?.writeText(text).catch(() => {});
      };
      window.addEventListener('mouseup', onUp, true);
      return;
    }
    const button = mouseButton(ev.button);
    ev.preventDefault();
    ev.stopPropagation();
    renderer.focus();
    renderer.clearHighlight();
    if (!button || !hooks.active()) return;
    const cell = (/** @type {MouseEvent} */ e) => cellAt(renderer, e);
    const start = cell(ev);
    if (!start) return;
    hooks.mouse({ action: 'down', button, ...start });
    const framesAtDown = hooks.frames();
    let last = start;
    let lastSent = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let trailing;
    const onMove = (/** @type {MouseEvent} */ e) => {
      const c = cell(e);
      if (!c || (c.column === last.column && c.row === last.row)) return;
      last = c;
      const sendDrag = () => {
        lastSent = Date.now();
        hooks.mouse({ action: 'drag', button, ...last });
      };
      clearTimeout(trailing);
      const wait = DRAG_INTERVAL_MS - (Date.now() - lastSent);
      if (wait <= 0) sendDrag();
      else trailing = setTimeout(sendDrag, wait);
    };
    const onUp = (/** @type {MouseEvent} */ e) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      clearTimeout(trailing);
      const c = cell(e) ?? last;
      hooks.mouse({ action: 'up', button, ...c });
      if (
        button === 'left' && (c.column !== start.column || c.row !== start.row)
      ) {
        // An app that redrew during the drag is drawing its own selection (Claude Code, vim
        // with the mouse on): a second, grid-bound highlight would only contradict it.
        if (hooks.frames() === framesAtDown) {
          renderer.highlight(start, c);
          clearTimeout(flashTimer);
          flashTimer = setTimeout(
            () => renderer.clearHighlight(),
            COPY_FLASH_MS,
          );
        }
        hooks.copyRange(start, c);
      }
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }, true);
  return () => clearTimeout(flashTimer);
}
