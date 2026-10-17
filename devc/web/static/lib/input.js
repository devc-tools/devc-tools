// Pure input helpers for the `devc web` page, shared with the Deno tests
// (`devc/tests/web_input_test.ts`). No DOM access here.
//
// Herdr's frames are its own redraw, so the page never learns the app's terminal modes (see
// `.plans/devc-web.md`). Mouse and wheel go to Herdr as cells, which it encodes in the pane's
// real mode; paste is the one place the page has to guess, and it guesses bracketed paste.

/** The bracketed-paste markers. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/**
 * A multi-line paste, normalized (`\r\n` and `\n` become `\r`) and wrapped in bracketed-paste
 * markers so a shell or agent TUI does not submit each line. A single line is sent unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function wrapPaste(text) {
  if (!/[\r\n]/.test(text)) return text;
  return PASTE_START + text.replace(/\r\n|\n/g, '\r') + PASTE_END;
}

/**
 * A pixel offset inside the terminal screen as a zero-based cell, clamped to the grid.
 *
 * @param {number} x pixels from the screen's left edge
 * @param {number} y pixels from the screen's top edge
 * @param {number} cellWidth
 * @param {number} cellHeight
 * @param {number} cols
 * @param {number} rows
 * @returns {{column: number, row: number}}
 */
export function pixelToCell(x, y, cellWidth, cellHeight, cols, rows) {
  const clamp = (v, max) => Math.min(Math.max(v, 0), Math.max(max - 1, 0));
  const column = cellWidth > 0 ? Math.floor(x / cellWidth) : 0;
  const row = cellHeight > 0 ? Math.floor(y / cellHeight) : 0;
  return { column: clamp(column, cols), row: clamp(row, rows) };
}

/** The most lines one wheel event scrolls. */
export const MAX_WHEEL_LINES = 10;

/**
 * A wheel event as a `scroll`: direction from the sign of `deltaY`, and
 * `lines` = max(1, round(|deltaY| / cell height)), capped at {@link MAX_WHEEL_LINES}. `deltaMode`
 * 1 (lines) uses `deltaY` as lines; 2 (pages) scrolls the cap. `null` when there is no vertical
 * movement.
 *
 * @param {number} deltaY
 * @param {number} cellHeight
 * @param {number} [deltaMode=0]
 * @returns {{direction: 'up' | 'down', lines: number} | null}
 */
export function wheelToScroll(deltaY, cellHeight, deltaMode = 0) {
  if (!deltaY) return null;
  const abs = Math.abs(deltaY);
  const raw = deltaMode === 1
    ? abs
    : deltaMode === 2
    ? MAX_WHEEL_LINES
    : cellHeight > 0
    ? abs / cellHeight
    : 1;
  const lines = Math.min(MAX_WHEEL_LINES, Math.max(1, Math.round(raw)));
  return { direction: deltaY < 0 ? 'up' : 'down', lines };
}

/**
 * A `MouseEvent.button` number as Herdr's button name; `undefined` for any other button.
 *
 * @param {number} button
 * @returns {'left' | 'middle' | 'right' | undefined}
 */
export function mouseButton(button) {
  return button === 0
    ? 'left'
    : button === 1
    ? 'middle'
    : button === 2
    ? 'right'
    : undefined;
}

/**
 * A string as UTF-8, base64-encoded — the `bytes` of an `input` message.
 *
 * @param {string} text
 * @returns {string}
 */
export function encodeInput(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Base64 (a `frame`'s `bytes`) back to raw bytes.
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function decodeBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The inclusive range between two viewport cells (either order) as xterm.js's
 * `select(column, row, length)`: the earlier cell, and a cell count that wraps across rows.
 *
 * @param {{column: number, row: number}} anchor
 * @param {{column: number, row: number}} cursor
 * @param {number} cols  the grid's width
 * @returns {{column: number, row: number, length: number}}
 */
export function selectionSpan(anchor, cursor, cols) {
  const [a, b] = anchor.row < cursor.row ||
      (anchor.row === cursor.row && anchor.column <= cursor.column)
    ? [anchor, cursor]
    : [cursor, anchor];
  return {
    column: a.column,
    row: a.row,
    length: (b.row - a.row) * cols + b.column - a.column + 1,
  };
}
