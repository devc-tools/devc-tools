// A language server diagnostic's tags (LSP `DiagnosticTag`): Deprecated (struck through, as VS
// Code draws a deprecated symbol's use) and Unnecessary (faded, as it draws unused code). Pure.
// The file viewer adds `tagClasses` to a diagnostic's range (@codemirror/lint's `markClass`);
// diff tiles paint `tagMarks`' ranges on their new-side rows. style.css draws both.

/** `DiagnosticTag.Unnecessary`. */
export const TAG_UNNECESSARY = 1;
/** `DiagnosticTag.Deprecated`. */
export const TAG_DEPRECATED = 2;

/** The tags the page asks servers for (`publishDiagnostics.tagSupport.valueSet`). */
export const SUPPORTED_TAGS = [TAG_UNNECESSARY, TAG_DEPRECATED];

/**
 * The classes for a diagnostic's `tags`, space-separated, or undefined when it has none the
 * page draws (unknown tags and a missing or malformed `tags` are ignored).
 *
 * @param {unknown} tags
 * @returns {string | undefined}
 */
export function tagClasses(tags) {
  if (!Array.isArray(tags)) return undefined;
  const classes = [];
  if (tags.includes(TAG_DEPRECATED)) classes.push('cm-lsp-deprecated');
  if (tags.includes(TAG_UNNECESSARY)) classes.push('cm-lsp-unnecessary');
  return classes.length ? classes.join(' ') : undefined;
}

/**
 * A tagged mark on one line: `[from, to)` in UTF-16 code units of the line's text (`to` null:
 * to its end), and which tag it draws.
 *
 * @typedef {{from: number, to: number | null, tag: 'deprecated' | 'unnecessary'}} TagMark
 */

/**
 * The marks of `diagnostics` (an LSP `Diagnostic[]`) with a Deprecated or Unnecessary tag, by
 * 0-based line: a range over several lines gives each its part (the first from its start
 * character, the last to its end one). Empty ranges and malformed diagnostics give nothing.
 *
 * @param {unknown} diagnostics
 * @returns {Map<number, TagMark[]>}
 */
export function tagMarks(diagnostics) {
  /** @type {Map<number, TagMark[]>} */
  const out = new Map();
  if (!Array.isArray(diagnostics)) return out;
  for (const d of diagnostics) {
    const tags = Array.isArray(d?.tags) ? d.tags : [];
    /** @type {TagMark['tag'][]} */
    const kinds = [];
    if (tags.includes(TAG_DEPRECATED)) kinds.push('deprecated');
    if (tags.includes(TAG_UNNECESSARY)) kinds.push('unnecessary');
    const start = d?.range?.start;
    const end = d?.range?.end;
    if (!kinds.length || !isPosition(start) || !isPosition(end)) continue;
    if (
      end.line < start.line ||
      (end.line === start.line && end.character <= start.character)
    ) continue;
    for (let line = start.line; line <= end.line; line++) {
      const from = line === start.line ? start.character : 0;
      const to = line === end.line ? end.character : null;
      if (to !== null && to <= from) continue;
      let marks = out.get(line);
      if (!marks) out.set(line, marks = []);
      for (const tag of kinds) marks.push({ from, to, tag });
    }
  }
  return out;
}

/** @param {any} p @returns {p is {line: number, character: number}} */
function isPosition(p) {
  return Number.isInteger(p?.line) && p.line >= 0 &&
    Number.isInteger(p?.character) && p.character >= 0;
}
