import { assertEquals } from 'jsr:@std/assert';
import { languageFor } from '../web/static/lib/languages.js';

Deno.test('languageFor picks a language by extension, case-insensitively', () => {
  const cases: [string, string | null][] = [
    ['app.js', 'javascript'],
    ['vite.config.mjs', 'javascript'],
    ['App.jsx', 'jsx'],
    ['main.ts', 'typescript'],
    ['View.TSX', 'tsx'],
    ['deno.json', 'json'],
    ['deno.jsonc', 'json'],
    ['README.md', 'markdown'],
    ['style.css', 'css'],
    ['index.html', 'html'],
    ['tool.py', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['compose.yml', 'yaml'],
    ['ci.yaml', 'yaml'],
    ['schema.sql', 'sql'],
    ['install.sh', 'shell'],
    ['Cargo.toml', 'toml'],
    ['notes.txt', null],
    ['LICENSE', null],
    ['archive.tar.gz', null],
  ];
  for (const [name, lang] of cases) assertEquals(languageFor(name), lang, name);
});

Deno.test('languageFor uses the whole name for Dockerfile, Makefile and dotfiles', () => {
  assertEquals(languageFor('Dockerfile'), 'dockerfile');
  assertEquals(languageFor('Dockerfile.dev'), 'dockerfile');
  assertEquals(languageFor('api.dockerfile'), 'dockerfile');
  assertEquals(languageFor('Containerfile'), 'dockerfile');
  assertEquals(languageFor('Makefile'), 'shell');
  assertEquals(languageFor('.bashrc'), 'shell');
  assertEquals(languageFor('.zshrc'), 'shell');
  assertEquals(languageFor('.gitignore'), null);
  assertEquals(languageFor('.devcontainer/Dockerfile'), 'dockerfile');
  assertEquals(languageFor('src/web/app.ts'), 'typescript');
  assertEquals(languageFor(''), null);
});
