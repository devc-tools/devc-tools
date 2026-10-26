// The CodeMirror 6 pieces devc web's viewer.js uses, bundled by scripts/vendor-codemirror.sh into
// devc/web/static/vendor/codemirror/codemirror.mjs. Keep every version exact and in step with
// that directory's VERSIONS. It lives here, not beside the bundle, because `deno compile
// --include web/static` would follow its npm: imports into the devc binary.
export { Compartment, EditorState } from 'npm:@codemirror/state@6.7.6';
export {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from 'npm:@codemirror/view@6.43.14';
export {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from 'npm:@codemirror/language@6.13.1';
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from 'npm:@codemirror/commands@6.11.1';
export {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from 'npm:@codemirror/search@6.7.2';
export { highlightTree, tags } from 'npm:@lezer/highlight@1.2.5';
// Clears a language server's diagnostics from a view when it detaches from it.
export { setDiagnostics } from 'npm:@codemirror/lint@6.9.7';
// The diff tile highlights rows outside an EditorView, so it mounts the HighlightStyle itself.
export { StyleModule } from 'npm:style-mod@4.1.4';
export { javascript } from 'npm:@codemirror/lang-javascript@6.2.5';
export { json } from 'npm:@codemirror/lang-json@6.0.2';
export { markdown } from 'npm:@codemirror/lang-markdown@6.5.2';
export { css } from 'npm:@codemirror/lang-css@6.3.1';
export { html } from 'npm:@codemirror/lang-html@6.4.12';
export { python } from 'npm:@codemirror/lang-python@6.2.1';
export { java } from 'npm:@codemirror/lang-java@6.0.2';
export { go } from 'npm:@codemirror/lang-go@6.0.1';
export { rust } from 'npm:@codemirror/lang-rust@6.0.2';
export { yaml } from 'npm:@codemirror/lang-yaml@6.1.3';
export { sql } from 'npm:@codemirror/lang-sql@6.10.0';
export { shell } from 'npm:@codemirror/legacy-modes@6.5.5/mode/shell';
export { dockerFile } from 'npm:@codemirror/legacy-modes@6.5.5/mode/dockerfile';
export { toml } from 'npm:@codemirror/legacy-modes@6.5.5/mode/toml';
// Language intelligence for the editor (devc web's language servers): the client half. Rename
// (`renameKeymap`) is left out on purpose: a multi-file rename would reach open files only.
export {
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  LSPClient,
  LSPPlugin,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  Workspace,
} from 'npm:@codemirror/lsp-client@6.3.0';
// lsp-client's own Markdown renderer (the version it resolves, so the bundle holds one copy), for
// the diff tile's hover, which has no editor to render through.
export { marked } from 'npm:marked@15.0.12';
