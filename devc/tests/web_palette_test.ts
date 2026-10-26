import { assertEquals } from 'jsr:@std/assert';
import {
  emptyQueryFiles,
  isPaletteShortcut,
  MAX_RECENT_ROOTS,
  MAX_RECENTS,
  parseRecents,
  rankFiles,
  recordRecent,
} from '../web/static/lib/palette.js';

const key = (code: string, mods: string) => ({
  code,
  metaKey: mods.includes('meta'),
  ctrlKey: mods.includes('ctrl'),
  altKey: mods.includes('alt'),
  shiftKey: mods.includes('shift'),
});

Deno.test('isPaletteShortcut: Cmd+P on a Mac, Ctrl+Alt+P elsewhere', () => {
  assertEquals(isPaletteShortcut(key('KeyP', 'meta'), true), true);
  assertEquals(isPaletteShortcut(key('KeyP', 'meta shift'), true), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'meta ctrl'), true), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'meta alt'), true), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'ctrl alt'), true), false);
  assertEquals(isPaletteShortcut(key('KeyO', 'meta'), true), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'ctrl alt'), false), true);
  // Ctrl+P is the terminals' previous-history.
  assertEquals(isPaletteShortcut(key('KeyP', 'ctrl'), false), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'meta'), false), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'ctrl alt shift'), false), false);
  assertEquals(isPaletteShortcut(key('KeyP', 'ctrl alt meta'), false), false);
});

Deno.test('rankFiles follows the ranking table', () => {
  const order = (query: string, files: string[]) =>
    rankFiles(query, files, 50).map((r) => r.path);
  assertEquals(
    order('server', [
      'web/static/server_util.js',
      'web/server.ts',
      'server',
      'docs/observer.md',
      'servers/x.ts',
    ]),
    [
      'server',
      'web/server.ts',
      'web/static/server_util.js',
      'docs/observer.md',
      'servers/x.ts',
    ],
  );
  assertEquals(
    order('wst', ['web/static/tiles.js', 'west.md', 'a/wast.ts']),
    ['west.md', 'a/wast.ts', 'web/static/tiles.js'],
  );
  assertEquals(
    order('Web/Ser', ['web/sidebar.js', 'devc/web/server.ts']),
    ['devc/web/server.ts', 'web/sidebar.js'],
  );
  assertEquals(rankFiles('s r v', ['web/server.ts'], 50), [
    { path: 'web/server.ts', positions: [4, 6, 7] },
  ]);
  assertEquals(rankFiles('zzz', ['web/server.ts'], 50), []);
});

Deno.test('rankFiles: positions per tier, empty query, limit', () => {
  assertEquals(rankFiles('SERV', ['web/server.ts'], 50)[0].positions, [
    4,
    5,
    6,
    7,
  ]);
  assertEquals(rankFiles('erv', ['web/server.ts'], 50)[0].positions, [5, 6, 7]);
  assertEquals(rankFiles('b/s', ['web/server.ts'], 50)[0].positions, [2, 3, 4]);
  assertEquals(rankFiles('wbs', ['web/server.ts'], 50)[0].positions, [0, 2, 4]);
  assertEquals(rankFiles('  ', ['a'], 50), []);
  assertEquals(rankFiles('a', ['a1', 'a2', 'a3'], 2).map((r) => r.path), [
    'a1',
    'a2',
  ]);
});

Deno.test('emptyQueryFiles: open files most recently focused first, then listed recents', () => {
  const tiles = [
    { kind: 'file', focusSeq: 1, file: { root: '/r', path: 'a.ts' } },
    { kind: 'file', focusSeq: 3, file: { root: '/r', path: 'b.ts' } },
    { kind: 'file', focusSeq: 4, file: { root: '/other', path: 'c.ts' } },
    {
      kind: 'file',
      focusSeq: 5,
      file: { root: '/r', path: '/x/d.ts', container: true },
    },
    { kind: 'pane', focusSeq: 6, file: null },
  ];
  const recent = ['gone.ts', 'a.ts', 'e.ts'];
  assertEquals(
    emptyQueryFiles(tiles, '/r', recent, new Set(['a.ts', 'e.ts']), 50),
    ['b.ts', 'a.ts', 'e.ts'],
  );
  assertEquals(emptyQueryFiles(tiles, '/r', recent, null, 50), [
    'b.ts',
    'a.ts',
    'gone.ts',
    'e.ts',
  ]);
  assertEquals(emptyQueryFiles(tiles, '/r', recent, null, 2), ['b.ts', 'a.ts']);
});

Deno.test('parseRecents drops what is malformed and never throws', () => {
  assertEquals(parseRecents(null), {});
  assertEquals(parseRecents('{'), {});
  assertEquals(parseRecents('[1]'), {});
  assertEquals(parseRecents('"x"'), {});
  assertEquals(
    parseRecents(
      JSON.stringify({ '/a': ['x', 1, null, 'y'], '/b': 'z', '/c': [] }),
    ),
    { '/a': ['x', 'y'] },
  );
});

Deno.test('recordRecent: newest first, capped per root and in roots', () => {
  let r = recordRecent({}, '/a', 'x');
  r = recordRecent(r, '/b', 'y');
  r = recordRecent(r, '/a', 'z');
  r = recordRecent(r, '/a', 'x');
  assertEquals(r, { '/b': ['y'], '/a': ['x', 'z'] });
  assertEquals(Object.keys(r), ['/b', '/a']);
  for (let i = 0; i < MAX_RECENTS + 5; i++) r = recordRecent(r, '/a', `f${i}`);
  assertEquals(r['/a'].length, MAX_RECENTS);
  assertEquals(r['/a'][0], `f${MAX_RECENTS + 4}`);
  for (let i = 0; i < MAX_RECENT_ROOTS; i++) r = recordRecent(r, `/r${i}`, 'p');
  assertEquals(Object.keys(r).length, MAX_RECENT_ROOTS);
  assertEquals('/b' in r, false);
  assertEquals('/a' in r, false);
  assertEquals(Object.keys(r).at(-1), `/r${MAX_RECENT_ROOTS - 1}`);
  // Recorded through JSON and back, the order holds.
  assertEquals(Object.keys(parseRecents(JSON.stringify(r))), Object.keys(r));
});
