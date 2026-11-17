import { assertEquals } from 'jsr:@std/assert';
import {
  findLinks,
  linkAt,
  placedLinkAt,
  placeLinks,
  resolvePath,
} from '../web/static/lib/links.js';

/** The links' texts, as they appear in `text`. */
const spans = (text: string) =>
  findLinks(text).map((l) => text.slice(l.start, l.end));

Deno.test('findLinks finds URLs without trailing punctuation', () => {
  assertEquals(findLinks('see https://example.com/a?b=1.'), [
    {
      kind: 'url',
      url: 'https://example.com/a?b=1',
      start: 4,
      end: 29,
    },
  ]);
  assertEquals(spans('(http://localhost:5173/)'), ['http://localhost:5173/']);
  // A parenthesis that belongs to the URL stays.
  assertEquals(spans('https://en.wikipedia.org/wiki/Foo_(bar) ok'), [
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  ]);
});

Deno.test('findLinks finds paths with a line and column', () => {
  assertEquals(findLinks('  at run (src/main.ts:12:5)'), [
    {
      kind: 'file',
      path: 'src/main.ts',
      line: 12,
      column: 5,
      start: 10,
      end: 26,
    },
  ]);
  assertEquals(findLinks('/workspaces/app/a.go:7: bad')[0], {
    kind: 'file',
    path: '/workspaces/app/a.go',
    line: 7,
    start: 0,
    end: 22,
  });
  assertEquals(spans('edited ./x/y and ../up/z.md, and README.md.'), [
    './x/y',
    '../up/z.md',
    'README.md',
  ]);
});

Deno.test('findLinks skips words, versions, home paths and URL insides', () => {
  assertEquals(spans('version 6.0.0 is e.g. fine'), []);
  assertEquals(spans('cd ~/code'), []);
  assertEquals(spans('https://example.com/src/a.ts'), [
    'https://example.com/src/a.ts',
  ]);
});

Deno.test('linkAt picks the link under an offset', () => {
  const links = findLinks('a.ts b.ts');
  assertEquals(linkAt(links, 0)?.start, 0);
  assertEquals(linkAt(links, 4), null);
  assertEquals(linkAt(links, 8)?.start, 5);
});

Deno.test('resolvePath takes relative paths from the cwd and normalizes', () => {
  assertEquals(
    resolvePath('/workspaces/app', 'src/a.ts'),
    '/workspaces/app/src/a.ts',
  );
  assertEquals(
    resolvePath('/workspaces/app/x', '../b.ts'),
    '/workspaces/app/b.ts',
  );
  assertEquals(
    resolvePath('/workspaces/app', './c/./d'),
    '/workspaces/app/c/d',
  );
  assertEquals(resolvePath('', '/etc/hosts'), '/etc/hosts');
  assertEquals(resolvePath('/a', '../../..'), '/');
  assertEquals(resolvePath('', 'a.ts'), null);
});

/** A screen of `cols` columns from its rows' texts, one cell per character. */
const screen = (cols: number, ...texts: string[]) =>
  texts.map((t) => {
    const text = t.padEnd(cols);
    return { text, cells: [...text].map((_, i) => i) };
  });

Deno.test('placeLinks carries a URL that fills its row on to the next ones', () => {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&state=abc';
  const rows = screen(
    20,
    `visit: ${url.slice(0, 13)}`,
    url.slice(13, 33),
    url.slice(33, 53),
    `${url.slice(53)} then`,
    'next line',
  );
  const placed = placeLinks(rows, 20);
  assertEquals(placed.map((p) => [p.link, p.from, p.to]), [[
    { kind: 'url', url, start: 7, end: 7 + url.length },
    { row: 0, column: 7 },
    { row: 3, column: url.length - 54 },
  ]]);
  // Any cell of it, on any of its rows, is the whole URL.
  for (
    const cell of [{ row: 0, column: 8 }, { row: 2, column: 0 }, {
      row: 3,
      column: 0,
    }]
  ) {
    assertEquals(placedLinkAt(placed, cell)?.link.kind, 'url');
  }
  assertEquals(placedLinkAt(placed, { row: 3, column: 10 }), null);
  assertEquals(placedLinkAt(placed, { row: 4, column: 0 }), null);
});

Deno.test('placeLinks keeps rows apart that do not wrap', () => {
  // The first row ends short of the last column: the next row is its own line.
  const placed = placeLinks(
    screen(30, 'see https://example.com/a', 'b/c.ts:3 more'),
    30,
  );
  assertEquals(placed.map((p) => [p.link.kind, p.from, p.to]), [
    ['url', { row: 0, column: 4 }, { row: 0, column: 24 }],
    ['file', { row: 1, column: 0 }, { row: 1, column: 7 }],
  ]);
  // A row that wraps into one starting with a blank is not carried on.
  assertEquals(
    placeLinks(screen(10, 'http://a.b', ' /x'), 10).map((p) => p.link.kind),
    ['url', 'file'],
  );
});
