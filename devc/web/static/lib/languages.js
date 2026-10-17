// Which language the `devc web` file viewer highlights a file as, by its name. Pure: no DOM and
// no CodeMirror import, so it is tested from `devc/tests/web_viewer_test.ts`; `viewer.js` maps
// each name to a CodeMirror language.

/**
 * @typedef {'javascript' | 'jsx' | 'typescript' | 'tsx' | 'json' | 'markdown' | 'css' | 'html'
 *   | 'python' | 'go' | 'rust' | 'yaml' | 'sql' | 'shell' | 'dockerfile' | 'toml'} Language
 */

/** @type {Record<string, Language>} by lower-case extension, without the dot */
const BY_EXTENSION = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'json',
  'code-workspace': 'json',
  webmanifest: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  html: 'html',
  htm: 'html',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  mk: 'shell',
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  toml: 'toml',
};

/**
 * @type {Record<string, Language>} by lower-case whole name: names with no extension, and
 * dotfiles (whose "extension" is the whole name)
 */
const BY_NAME = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  // No Makefile mode is bundled; recipes are shell, which is most of a Makefile.
  makefile: 'shell',
  gnumakefile: 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.zshenv': 'shell',
  '.envrc': 'shell',
  'cargo.lock': 'toml',
};

/**
 * The language to highlight a file named `name` as (a base name; a path's last segment is
 * used), or null for plain text. The whole name decides first (`Dockerfile`, `Makefile`,
 * dotfiles like `.bashrc`), then `Dockerfile.<anything>`, then the extension.
 *
 * @param {string} name
 * @returns {Language | null}
 */
export function languageFor(name) {
  const base = String(name).split('/').pop()?.toLowerCase() ?? '';
  if (Object.hasOwn(BY_NAME, base)) return BY_NAME[base];
  if (base.startsWith('dockerfile.') || base.startsWith('containerfile.')) {
    return 'dockerfile';
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1);
  return Object.hasOwn(BY_EXTENSION, ext) ? BY_EXTENSION[ext] : null;
}
