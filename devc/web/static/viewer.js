// The `devc web` file viewer: a read-only CodeMirror 6 view of one file, with line numbers,
// syntax highlighting by file name, code folding, bracket matching and search. The only module
// that imports CodeMirror (as `renderer.js` is for xterm.js and `layout.js` for Golden Layout),
// so app.js talks to it through `createViewer` alone. See `.plans/devc-web-file-viewer.md`.
//
// Editing is a later step: the same view with `readOnly` off.

import {
  bracketMatching,
  css,
  defaultKeymap,
  dockerFile,
  drawSelection,
  EditorState,
  EditorView,
  foldGutter,
  foldKeymap,
  go,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSelectionMatches,
  highlightSpecialChars,
  HighlightStyle,
  html,
  javascript,
  json,
  keymap,
  lineNumbers,
  markdown,
  python,
  rust,
  search,
  searchKeymap,
  shell,
  sql,
  StreamLanguage,
  syntaxHighlighting,
  tags,
  toml,
  yaml,
} from './vendor/codemirror/codemirror.mjs';
import { languageFor as pickLanguage } from './lib/languages.js';

/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */

/**
 * @typedef {object} Viewer
 * @property {(text: string) => void} setText   replaces the content, keeping the scroll position when it can
 * @property {(line: number, column?: number) => void} revealLine
 *   puts the cursor at a 1-based line and column (clamped to the file) and scrolls it to the middle
 * @property {() => void} focus
 * @property {() => void} destroy
 */

/**
 * The language picked for `name`, or null for plain text. Pure; the mapping lives in
 * `lib/languages.js`, where it is tested.
 *
 * @param {string} name
 */
export function languageFor(name) {
  return pickLanguage(name);
}

/** Each language's CodeMirror extension, made on first use. */
const LANGUAGES = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  markdown: () => markdown(),
  css: () => css(),
  html: () => html(),
  python: () => python(),
  go: () => go(),
  rust: () => rust(),
  yaml: () => yaml(),
  sql: () => sql(),
  shell: () => StreamLanguage.define(shell),
  dockerfile: () => StreamLanguage.define(dockerFile),
  toml: () => StreamLanguage.define(toml),
};

/**
 * Colours from the page's own custom properties (style.css), so the viewer matches the rest of
 * the page. No tokens of its own.
 */
const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text)',
    backgroundColor: 'var(--term-bg)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.45',
  },
  '.cm-content': { caretColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--term-bg)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--panel-2) 60%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--panel-2) 60%, transparent)',
    color: 'var(--text)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 15%, transparent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--blocked) 30%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--blocked) 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--blocked) 55%, transparent)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 50%, transparent)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    color: 'var(--danger)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)',
    color: 'var(--muted)',
  },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-panels': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '4px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    font: 'inherit',
    color: 'var(--text)',
    backgroundColor: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search input:focus': {
    outline: 'none',
    borderColor: 'var(--accent)',
  },
  '.cm-panel.cm-search label': { color: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
}, { dark: true });

/** Syntax colours, from the page's palette (style.css) only. */
const highlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.operatorKeyword,
      tags.modifier,
      tags.controlKeyword,
    ],
    color: 'var(--accent)',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.inserted],
    color: 'var(--done)',
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit],
    color: 'var(--blocked)',
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.tagName],
    color: 'var(--unknown)',
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.function(tags.variableName)),
      tags.macroName,
    ],
    color: 'var(--working)',
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.labelName],
    color: 'var(--text)',
  },
  {
    tag: [tags.comment, tags.meta, tags.processingInstruction],
    color: 'var(--muted)',
    fontStyle: 'italic',
  },
  { tag: [tags.invalid, tags.deleted], color: 'var(--danger)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: 'bold' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  {
    tag: [tags.link, tags.url],
    color: 'var(--working)',
    textDecoration: 'underline',
  },
  { tag: tags.monospace, color: 'var(--done)' },
]);

/**
 * Mounts a read-only view of `text` into `el`, highlighted for `name` (a file name: its
 * extension, or the whole name for `Dockerfile`, `Makefile` and dotfiles like `.bashrc`, picks
 * the language; unknown gives plain text).
 *
 * @param {HTMLElement} el
 * @param {{name: string, text: string}} opts
 * @returns {Viewer}
 */
export function createViewer(el, { name, text }) {
  const lang = languageFor(name);
  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        foldGutter(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        // Not editable means not focusable: a tabindex lets the view take focus, so the
        // keymap (Ctrl/Cmd-F, folding, selection) still works.
        EditorView.contentAttributes.of({ tabindex: '0' }),
        theme,
        syntaxHighlighting(highlight),
        lang ? LANGUAGES[lang]() : [],
      ],
    }),
  });

  return {
    setText(next) {
      const doc = view.state.doc.toString();
      if (next === doc) return;
      // Only the changed middle is replaced, so CodeMirror keeps the scroll position and the
      // selection where the text around them is unchanged.
      let start = 0;
      const max = Math.min(doc.length, next.length);
      while (start < max && doc.charCodeAt(start) === next.charCodeAt(start)) {
        start++;
      }
      let end = 0;
      while (
        end < max - start &&
        doc.charCodeAt(doc.length - 1 - end) ===
          next.charCodeAt(next.length - 1 - end)
      ) end++;
      const scrollTop = view.scrollDOM.scrollTop;
      view.dispatch({
        changes: {
          from: start,
          to: doc.length - end,
          insert: next.slice(start, next.length - end),
        },
      });
      view.scrollDOM.scrollTop = scrollTop;
    },
    revealLine(line, column = 1) {
      const doc = view.state.doc;
      const at = doc.line(Math.min(Math.max(line, 1), doc.lines));
      const pos = Math.min(at.from + Math.max(column - 1, 0), at.to);
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
