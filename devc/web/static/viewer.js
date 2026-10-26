// The `devc web` file viewer and editor: a CodeMirror 6 view of one file, with line numbers,
// syntax highlighting by file name, code folding, bracket matching and search, editable when
// app.js says the file can be saved (undo, Tab indents; app.js saves on Ctrl/Cmd-S). The only
// module that imports CodeMirror (as `renderer.js` is for xterm.js and `layout.js` for Golden
// Layout), so app.js talks to it through `createViewer` alone, and diff tiles colour their rows
// through `highlightLines`, with the same parsers and colours. An editable view can also take a
// language server's completion, hover, signature help, definitions, references, formatting and
// diagnostics (`createLanguageClient`, `Viewer.attachLanguage`), relayed by `lsp.js`. See
// `.plans/devc-web-file-viewer.md`, `.plans/devc-web-editable-viewer.md` and
// `.plans/devc-web-lsp-core.md`.

import {
  bracketMatching,
  Compartment,
  css,
  defaultKeymap,
  dockerFile,
  drawSelection,
  EditorState,
  EditorView,
  findReferencesKeymap,
  foldGutter,
  foldKeymap,
  formatKeymap,
  go,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSelectionMatches,
  highlightSpecialChars,
  HighlightStyle,
  highlightTree,
  history,
  historyKeymap,
  hoverTooltips,
  html,
  indentOnInput,
  indentWithTab,
  java,
  javascript,
  json,
  jumpToDefinitionKeymap,
  keymap,
  lineNumbers,
  LSPClient,
  LSPPlugin,
  markdown,
  marked,
  python,
  rust,
  search,
  searchKeymap,
  serverCompletion,
  serverDiagnostics,
  setDiagnostics,
  shell,
  signatureHelp,
  sql,
  StreamLanguage,
  StyleModule,
  syntaxHighlighting,
  tags,
  toml,
  Workspace,
  yaml,
} from './vendor/codemirror/codemirror.mjs';
import { languageFor as pickLanguage } from './lib/languages.js';

/** @typedef {import('./lib/layout_state.js').FileRef} FileRef */

/**
 * @typedef {object} Viewer
 * @property {(text: string) => void} setText
 *   replaces the content with what is on disk (so it is clean), keeping the scroll position when it can
 * @property {(on: boolean) => void} setEditable
 * @property {() => string} getText  the content, with the file's own line breaks
 * @property {() => void} markClean  the content is what is on disk now (after a save)
 * @property {boolean} dirty         the content differs from what is on disk
 * @property {(line: number, column?: number) => void} revealLine
 *   puts the cursor at a 1-based line and column (clamped to the file) and scrolls it to the middle
 * @property {() => {text: string, startLine: number, endLine: number} | null} selection
 *   the main selection's text and the 1-based lines it spans; null while nothing is selected
 * @property {() => void} focus
 * @property {() => void} destroy
 * @property {(lsp: {client: any, uri: string, languageId: string}) => boolean} attachLanguage
 *   gives the view a language server's features for the file at `uri`; false (and nothing
 *   changes) when another view on the client already has that URI
 * @property {() => void} detachLanguage  takes them away again (and their diagnostics)
 * @property {string | null} languageUri  the URI attached, or null
 * @property {EditorView} view            the CodeMirror view, for the language client's jumps
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
  java: () => java(),
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
    fontSize: 'var(--code-font-size)',
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
  // A language server's hover and completion docs, and its references panel.
  '.cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-completionInfo': {
    maxWidth: 'min(60em, 90vw)',
    maxHeight: '20em',
    overflow: 'auto',
  },
  '.cm-lsp-documentation pre, .cm-lsp-documentation code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    whiteSpace: 'pre-wrap',
  },
  '.cm-lsp-documentation a': { color: 'var(--accent)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    color: 'var(--text)',
  },
  '.cm-lsp-reference-panel .cm-lsp-reference[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
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

/** Past this many characters a diff side is shown unhighlighted, so a huge patch stays quick. */
const HIGHLIGHT_LIMIT = 500_000;

/** Each language's parser, made on first use. @type {Map<string, any>} */
const parsers = new Map();
let highlightMounted = false;

/**
 * `lines` (consecutive lines of a file named `name`, as a diff tile has them) cut into runs, each
 * with the class names `highlight` gives its syntax (`''` for none). The lines are parsed as one
 * text, so a construct spanning lines (a block comment, a template string) is coloured across
 * them; what comes before the first line is unknown, so one opened above it is not. A file with
 * no known language, or more than {@link HIGHLIGHT_LIMIT} characters, gives one plain run per
 * line.
 *
 * @param {string} name
 * @param {string[]} lines
 * @returns {import('./lib/diff.js').Span[][]}
 */
export function highlightLines(name, lines) {
  const lang = languageFor(name);
  const text = lines.join('\n');
  if (!lang || text.length > HIGHLIGHT_LIMIT) {
    return lines.map((line) => [{ text: line, cls: '' }]);
  }
  if (!highlightMounted && highlight.module) {
    // No EditorView mounts it for a diff tile.
    StyleModule.mount(document, highlight.module);
    highlightMounted = true;
  }
  let parser = parsers.get(lang);
  if (!parser) {
    const support = LANGUAGES[lang]();
    // A LanguageSupport carries its Language; StreamLanguage.define returns the Language.
    parser = (support.language ?? support).parser;
    parsers.set(lang, parser);
  }
  /** @type {[number, number, string][]} */
  const styled = [];
  highlightTree(
    parser.parse(text),
    highlight,
    (from, to, cls) => styled.push([from, to, cls]),
  );
  /** @type {import('./lib/diff.js').Span[][]} */
  const out = [];
  let k = 0;
  let start = 0;
  for (const line of lines) {
    const end = start + line.length;
    /** @type {import('./lib/diff.js').Span[]} */
    const spans = [];
    let at = start;
    while (k < styled.length && styled[k][1] <= start) k++;
    // A run may span lines: it is clipped to each, and stays for the next.
    for (let j = k; j < styled.length && styled[j][0] < end; j++) {
      const from = Math.max(styled[j][0], start);
      const to = Math.min(styled[j][1], end);
      if (from > at) spans.push({ text: text.slice(at, from), cls: '' });
      if (to > from) {
        spans.push({ text: text.slice(from, to), cls: styled[j][2] });
      }
      at = Math.max(at, to);
    }
    if (end > at) spans.push({ text: text.slice(at, end), cls: '' });
    if (spans.length === 0) spans.push({ text: '', cls: '' });
    out.push(spans);
    start = end + 1;
  }
  return out;
}

/**
 * Mounts a view of `text` into `el`, highlighted for `name` (a file name: its extension, or the
 * whole name for `Dockerfile`, `Makefile` and dotfiles like `.bashrc`, picks the language;
 * unknown gives plain text). Read-only unless `editable`. A file whose first line break is CRLF
 * keeps CRLF in {@link Viewer.getText}.
 *
 * @param {HTMLElement} el
 * @param {{name: string, text: string, editable?: boolean,
 *   onChange?: (dirty: boolean) => void}} opts
 *   `onChange` follows every edit. Saving is app.js's: its own Ctrl/Cmd-S listener
 * @returns {Viewer}
 */
export function createViewer(
  el,
  { name, text, editable = false, onChange },
) {
  const lang = languageFor(name);
  const access = new Compartment();
  /** A language server's extensions, while one is attached (see `attachLanguage`). */
  const language = new Compartment();
  /** @type {string | null} */
  let languageUri = null;
  /** @param {boolean} on */
  const accessFor = (on) => [
    EditorState.readOnly.of(!on),
    EditorView.editable.of(on),
  ];
  const crlf = /\r\n|\r|\n/.exec(text)?.[0] === '\r\n';
  const view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: text,
      extensions: [
        crlf ? EditorState.lineSeparator.of('\r\n') : [],
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        highlightActiveLine(),
        bracketMatching(),
        highlightSelectionMatches(),
        search({ top: true }),
        // Ahead of the keymap below, so its keys (F12, Shift-F12, Shift-Alt-F, Escape on the
        // references panel) win.
        language.of([]),
        keymap.of([
          ...searchKeymap,
          ...foldKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        access.of(accessFor(editable)),
        // Not editable means not focusable: a tabindex lets the view take focus, so the
        // keymap (Ctrl/Cmd-F, folding, selection) still works.
        EditorView.contentAttributes.of({ tabindex: '0' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange?.(!u.state.doc.eq(clean));
        }),
        theme,
        syntaxHighlighting(highlight),
        lang ? LANGUAGES[lang]() : [],
      ],
    }),
  });
  /** The doc as it is on disk. */
  let clean = view.state.doc;

  return {
    setText(next) {
      const doc = view.state.doc.toString();
      // In doc terms: line breaks as the doc splits them, joined with `\n`.
      next = view.state.toText(next).toString();
      if (next === doc) {
        clean = view.state.doc;
        onChange?.(false);
        return;
      }
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
      // Set first, so the update listener sees the new text as clean.
      clean = view.state.toText(next);
      view.dispatch({
        changes: {
          from: start,
          to: doc.length - end,
          insert: next.slice(start, next.length - end),
        },
      });
      view.scrollDOM.scrollTop = scrollTop;
    },
    setEditable(on) {
      view.dispatch({ effects: access.reconfigure(accessFor(on)) });
    },
    getText() {
      return view.state.sliceDoc();
    },
    markClean() {
      clean = view.state.doc;
      onChange?.(false);
    },
    get dirty() {
      return !view.state.doc.eq(clean);
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
    selection() {
      const { from, to } = view.state.selection.main;
      if (from === to) return null;
      const doc = view.state.doc;
      const startLine = doc.lineAt(from).number;
      const last = doc.lineAt(to);
      // A selection of whole lines ends at the start of the next one: that line is not in it.
      const endLine = to === last.from && last.number > startLine
        ? last.number - 1
        : last.number;
      return { text: view.state.sliceDoc(from, to), startLine, endLine };
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
    attachLanguage({ client, uri, languageId }) {
      if (languageUri === uri) return true;
      if (client.workspace.getFile(uri)) return false;
      if (languageUri !== null) this.detachLanguage();
      view.dispatch({
        effects: language.reconfigure([
          client.plugin(uri, languageId),
          serverCompletion(),
          hoverTooltips(),
          signatureHelp(),
          // No renameKeymap: a rename would reach open files only.
          keymap.of([
            ...jumpToDefinitionKeymap,
            ...findReferencesKeymap,
            ...formatKeymap,
          ]),
        ]),
      });
      languageUri = uri;
      return true;
    },
    detachLanguage() {
      if (languageUri === null) return;
      languageUri = null;
      view.dispatch({ effects: language.reconfigure([]) });
      view.dispatch(setDiagnostics(view.state, []));
    },
    get languageUri() {
      return languageUri;
    },
    view,
  };
}

// ---------------------------------------------------------------------------------------------
// Language servers: the client half (`@codemirror/lsp-client`), one client per session per page
// ---------------------------------------------------------------------------------------------

/**
 * A language server's Markdown, as HTML safe to put in the page: only plain formatting tags
 * survive, with no attributes but a link's http(s) `href` and a code block's `class`. A doc
 * comment in a repo reaches the hover tooltip through the server, and this page holds shells in
 * every container.
 *
 * @param {string} html
 */
export function sanitizeLspHtml(html) {
  const ALLOWED = new Set([
    'A',
    'B',
    'BLOCKQUOTE',
    'BR',
    'CODE',
    'DEL',
    'DIV',
    'EM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HR',
    'I',
    'LI',
    'OL',
    'P',
    'PRE',
    'S',
    'SPAN',
    'STRONG',
    'SUB',
    'SUP',
    'TABLE',
    'TBODY',
    'TD',
    'TH',
    'THEAD',
    'TR',
    'UL',
  ]);
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    'text/html',
  );
  /** @param {Element} el */
  const clean = (el) => {
    for (const child of [...el.children]) {
      if (!ALLOWED.has(child.tagName)) {
        // Unknown elements keep their text; scripts, styles and frames go whole.
        if (
          /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|TEMPLATE|NOSCRIPT)$/.test(
            child.tagName,
          )
        ) {
          child.remove();
        } else {
          clean(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const attr of [...child.attributes]) {
        const keep = (child.tagName === 'A' && attr.name === 'href' &&
          /^https?:/i.test(attr.value)) ||
          (attr.name === 'class' && /^(CODE|SPAN|PRE)$/.test(child.tagName));
        if (!keep) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
      clean(child);
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

/** `<`, `>`, `&` and quotes as entities. */
function escapeHtml(/** @type {string} */ s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A `textDocument/hover` result's `contents` as HTML safe to put in the page (a diff tile's hover,
 * which has no editor to render through): `MarkupContent` Markdown through lsp-client's own
 * `marked`, plaintext escaped in a `<pre>`; a legacy `MarkedString` or array of them as Markdown,
 * `{language, value}` as a fenced code block. '' when there is nothing to show.
 *
 * @param {unknown} contents
 */
export function lspHoverHtml(contents) {
  /** @param {unknown} c @returns {string} Markdown, or '' */
  const markedString = (c) => {
    if (typeof c === 'string') return c;
    const o = /** @type {any} */ (c);
    if (o && typeof o.value === 'string' && typeof o.language === 'string') {
      return o.value === ''
        ? ''
        : '```' + o.language + '\n' + o.value + '\n```';
    }
    return '';
  };
  const o = /** @type {any} */ (contents);
  let html = '';
  if (o && typeof o.kind === 'string' && typeof o.value === 'string') {
    if (o.value.trim() === '') return '';
    html = o.kind === 'plaintext'
      ? `<pre>${escapeHtml(o.value)}</pre>`
      : String(marked.parse(o.value, { async: false }));
  } else {
    const md = (Array.isArray(o) ? o : [o]).map(markedString)
      .filter((s) => s.trim() !== '').join('\n\n');
    if (md === '') return '';
    html = String(marked.parse(md, { async: false }));
  }
  return sanitizeLspHtml(html);
}

/**
 * The client's workspace: one file per URI, each with the one view attached to it. Jumps to
 * another file go to `hooks.displayFile`. References list the open files' only: lsp-client 6.3.0's
 * panel maps every position through the workspace, and throws for a file not in it.
 */
class DevcWorkspace extends Workspace {
  /**
   * @param {any} client
   * @param {{displayFile: (uri: string) => Promise<EditorView | null>}} hooks
   */
  constructor(client, hooks) {
    super(client);
    this.hooks = hooks;
    /** @type {{uri: string, languageId: string, version: number, doc: any, view: EditorView, getView: () => EditorView}[]} */
    this.files = [];
  }

  syncFiles() {
    const result = [];
    for (const file of this.files) {
      const plugin = LSPPlugin.get(file.view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      result.push({ changes, file, prevDoc: file.doc });
      file.doc = file.view.state.doc;
      file.version++;
      plugin.clear();
    }
    return result;
  }

  /** @param {string} uri @param {string} languageId @param {EditorView} view */
  openFile(uri, languageId, view) {
    if (this.getFile(uri)) return;
    const file = {
      uri,
      languageId,
      version: 0,
      doc: view.state.doc,
      view,
      getView: () => view,
    };
    this.files.push(file);
    this.client.didOpen(file);
  }

  /** @param {string} uri @param {EditorView} view */
  closeFile(uri, view) {
    const file = this.getFile(uri);
    if (!file || /** @type {any} */ (file).view !== view) return;
    this.files = this.files.filter((f) => f !== file);
    this.client.didClose(uri);
  }

  /** @param {string} uri */
  displayFile(uri) {
    return this.hooks.displayFile(uri);
  }
}

/**
 * A language client for one session: connected to `transport` (lsp.js's, over the page's
 * socket), with a workspace whose jumps open tiles through `hooks`. Its `attach` gives a viewer
 * the session's features for a file (see {@link Viewer.attachLanguage}).
 *
 * @param {{send: (message: string) => void, subscribe: (fn: (message: string) => void) => void,
 *   unsubscribe: (fn: (message: string) => void) => void}} transport
 * @param {{displayFile: (uri: string) => Promise<EditorView | null>}} hooks
 */
export function createLanguageClient(transport, hooks) {
  const client = new LSPClient({
    // The default 3 s is too short for a cold server's first completion.
    timeout: 20000,
    workspace: (/** @type {any} */ c) => new DevcWorkspace(c, hooks),
    // Push diagnostics: the host turns a pull server's into these.
    extensions: [serverDiagnostics()],
    sanitizeHTML: sanitizeLspHtml,
  });
  client.connect(transport);
  return {
    client,
    /** @param {Viewer} viewer @param {string} uri @param {string} languageId */
    attach: (viewer, uri, languageId) =>
      viewer.attachLanguage({ client, uri, languageId }),
  };
}
