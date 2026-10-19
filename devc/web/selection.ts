// Copy on select for `devc web`: the browser sends viewport cells (`read_selection`), and Herdr's
// `pane.selection.read` takes absolute content rows (0 = the oldest scrollback line). This module
// is pure — the conversion, and reading the scroll position out of a `pane.get` reply. See
// `.plans/devc-web-copy-on-select.md` for what was measured.

/** A cell in a tile's viewport, zero-based: the same space as the `mouse` message. */
export type Cell = { column: number; row: number };

/** `pane.get`'s `result.pane.scroll`. */
export type PaneScroll = {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
};

/** A point in Herdr's `pane.selection.read` coordinates. */
export type TextPoint = { row: number; col: number };

/** A viewport cell → Herdr's content point: row = max_offset_from_bottom - offset_from_bottom + cell.row. */
export function toTextPoint(scroll: PaneScroll, cell: Cell): TextPoint {
  return {
    row: scroll.max_offset_from_bottom - scroll.offset_from_bottom + cell.row,
    col: cell.column,
  };
}

/** The scroll position in a `pane.get` reply, or `null` when it is missing or malformed. */
export function paneScroll(result: unknown): PaneScroll | null {
  const scroll = (result as { pane?: { scroll?: unknown } } | null)?.pane
    ?.scroll as Record<string, unknown> | undefined;
  if (typeof scroll !== 'object' || scroll === null) return null;
  const n = (k: string) => {
    const v = scroll[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  };
  const offset = n('offset_from_bottom');
  const max = n('max_offset_from_bottom');
  const rows = n('viewport_rows');
  if (offset === null || max === null || rows === null || offset > max) {
    return null;
  }
  return {
    offset_from_bottom: offset,
    max_offset_from_bottom: max,
    viewport_rows: rows,
  };
}
