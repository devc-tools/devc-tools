import { assert, assertEquals } from 'jsr:@std/assert';
import { isLspLanguage, lspLanguageFor } from '../web/lsp_languages.ts';
import { lspLanguageFor as pageLspLanguageFor } from '../web/static/lib/languages.js';

const CASES: [string, string | null][] = [
  ['Main.java', 'java'],
  ['a.ts', 'typescript'],
  ['a.tsx', 'typescript'],
  ['a.mts', 'typescript'],
  ['a.cts', 'typescript'],
  ['a.js', 'typescript'],
  ['a.jsx', 'typescript'],
  ['a.mjs', 'typescript'],
  ['a.cjs', 'typescript'],
  ['tool.py', 'python'],
  ['stubs.pyi', 'python'],
  // Upper-case extensions.
  ['Legacy.JAVA', 'java'],
  ['View.TSX', 'typescript'],
  ['SETUP.PY', 'python'],
  // Paths: the last segment decides.
  ['/workspaces/devc-tools/devc/web/server.ts', 'typescript'],
  ['src.py/notes', null],
  ['dir.ts/', null],
  // Dotfiles: the whole name, never an extension.
  ['.ts', null],
  ['.py', null],
  ['src/.eslintrc.js', 'typescript'],
  // No extension, or one no server takes.
  ['Makefile', null],
  ['LICENSE', null],
  ['', null],
  ['notes.md', null],
  ['deno.json', null],
  ['a.go', null],
  ['a.ts.bak', null],
];

Deno.test('lspLanguageFor: every row of the language table, by lower-cased extension', () => {
  for (const [path, lang] of CASES) {
    assertEquals(lspLanguageFor(path), lang, path);
  }
});

Deno.test("lspLanguageFor: the page's copy agrees on every case", () => {
  for (const [path, lang] of CASES) {
    assertEquals(pageLspLanguageFor(path), lang, path);
  }
});

Deno.test('isLspLanguage: the three launchers only', () => {
  for (const l of ['java', 'typescript', 'python']) assert(isLspLanguage(l));
  for (const l of ['go', '', null, 1, 'Java']) assert(!isLspLanguage(l));
});
