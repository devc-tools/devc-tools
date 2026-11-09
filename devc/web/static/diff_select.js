// Where a diff tile's selection is, for Ask agent: the lines its ends are on, each with the side
// (old or new) its number is on, and the columns of its first and last characters. `tiles.js`
// marks each text cell with its row and side; this reads a DOM range against them.

import { newColumn } from './lib/diff.js';

/** @typedef {import('./lib/ask.js').AskSelection} AskSelection */
/** @typedef {{row: import('./lib/diff.js').DiffRow, side: 'old' | 'new'}} DiffTextCell */

/**
 * Where `range` (the selection, whose text is `text`) is in a diff: `cells` are the diff's
 * marked text cells it touches, in document order, and `cellOf` gives a cell's row and side.
 * Columns are left out when it spans whole lines. An end outside the text (a line number, a hunk
 * header) is taken to the nearest of `cells`; with no cells it is the text alone. Ending at the
 * very start of a line (a triple-click, a drag down to the next line) leaves that line out.
 *
 * @param {string} text @param {Range} range @param {Element[]} cells
 * @param {(cell: Element) => DiffTextCell | undefined} cellOf
 * @returns {AskSelection}
 */
export function diffSelectionWhere(text, range, cells, cellOf) {
  if (cells.length === 0) return { text };
  cells = [...cells];
  /**
   * The cell (`node`, `offset`) is in, when it is one of `cells`, and the UTF-16 offset in its
   * row's text it is at (the shown text's whitespace markers undone).
   *
   * @param {Node} node @param {number} offset
   */
  const pointIn = (node, offset) => {
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const cell = /** @type {Element | null} */ (el)?.closest?.('.diff-text');
    const info = cell && cells.includes(cell) ? cellOf(cell) : undefined;
    if (!cell || !info) return null;
    const before = document.createRange();
    before.setStart(cell, 0);
    before.setEnd(node, offset);
    return { cell, at: newColumn(info.row.text, before.toString().length) };
  };
  const start = pointIn(range.startContainer, range.startOffset);
  let end = pointIn(range.endContainer, range.endOffset);
  if (end && end.at === 0 && end.cell !== (start?.cell ?? cells[0])) {
    cells = cells.slice(0, cells.indexOf(end.cell));
    end = null;
  }
  const a = /** @type {DiffTextCell} */ (cellOf(start?.cell ?? cells[0]));
  const b = /** @type {DiffTextCell} */ (cellOf(
    end?.cell ?? cells[cells.length - 1],
  ));
  /** Characters (code points) of `t` before UTF-16 offset `at`. */
  const chars = (/** @type {string} */ t, /** @type {number} */ at) =>
    [...t.slice(0, at)].length;
  const startColumn = chars(a.row.text, start?.at ?? 0) + 1;
  const endColumn = chars(b.row.text, end?.at ?? b.row.text.length);
  /** @type {AskSelection} */
  const out = {
    text,
    startLine: /** @type {number} */ (a.row[a.side]),
    endLine: /** @type {number} */ (b.row[b.side]),
    startSide: a.side,
    endSide: b.side,
  };
  return startColumn === 1 && endColumn === chars(b.row.text, b.row.text.length)
    ? out
    : { ...out, startColumn, endColumn: Math.max(1, endColumn) };
}
