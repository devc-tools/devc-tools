// A language server diagnostic's tags (LSP `DiagnosticTag`), as the classes the file viewer adds
// to its range: `cm-lsp-deprecated` (struck through, as VS Code draws a deprecated symbol's use)
// and `cm-lsp-unnecessary` (faded, as it draws unused code). Pure; viewer.js passes the result
// to @codemirror/lint as a diagnostic's `markClass`, and style.css draws them.

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
