// Which language server a file in `devc web`'s editor attaches to, by its name: the `<language>`
// of the container's `devc-lsp-<language>` launcher (see `.plans/devc-web-lsp-core.md`). Pure.
// The page has its own copy, `lspLanguageFor` in `static/lib/languages.js`, for its menus;
// `tests/web_lsp_languages_test.ts` keeps the two in step.

/** A language a launcher serves: its `devc-lsp-<language>` command's suffix. */
export type LspLanguage = 'java' | 'typescript' | 'python';

/** By lower-case extension, without the dot. */
const BY_EXTENSION: Record<string, LspLanguage> = {
  java: 'java',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  py: 'python',
  pyi: 'python',
};

/** What the status line and messages call each language. */
export const LSP_LANGUAGE_NAMES: Record<LspLanguage, string> = {
  java: 'Java',
  typescript: 'TypeScript',
  python: 'Python',
};

/**
 * The language server `path`'s file attaches to, by the lower-cased extension of its last
 * segment; null for any other extension, none, or a dotfile (whose "extension" is its whole name).
 */
export function lspLanguageFor(path: string): LspLanguage | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1);
  return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null;
}

/** Whether `v` names a language a launcher serves. */
export function isLspLanguage(v: unknown): v is LspLanguage {
  return v === 'java' || v === 'typescript' || v === 'python';
}
