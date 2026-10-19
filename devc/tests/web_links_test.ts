import { assertEquals } from 'jsr:@std/assert';
import { findLinks, linkAt, resolvePath } from '../web/static/lib/links.js';

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
