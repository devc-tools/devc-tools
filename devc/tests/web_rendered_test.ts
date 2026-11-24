import { assertEquals } from 'jsr:@std/assert';
import {
  blockLines,
  blockMarks,
  changeMarks,
  renderedKind,
  slug,
} from '../web/static/lib/rendered.js';
import { parsePatch } from '../web/static/lib/diff.js';

Deno.test('renderedKind: Markdown only', () => {
  assertEquals(renderedKind('README.md'), 'markdown');
  assertEquals(renderedKind('docs/a.Markdown'), 'markdown');
  assertEquals(renderedKind('index.html'), null);
  assertEquals(renderedKind('a.png'), null);
  assertEquals(renderedKind('a.ts'), null);
});

Deno.test('blockLines: line ranges, gaps null, trailing block without newline', () => {
  // "# T\n\npara one\npara two\n\n\n- a\n- b" as marked's top-level raws.
  assertEquals(
    blockLines(['# T\n', '\n', 'para one\npara two\n', '\n\n', '- a\n- b']),
    [
      { from: 1, to: 1 },
      null,
      { from: 3, to: 4 },
      null,
      { from: 7, to: 8 },
    ],
  );
  // A raw that holds its trailing blank lines, and one that starts with them.
  assertEquals(blockLines(['p\n\n\n', '\n\nq\n']), [
    { from: 1, to: 1 },
    { from: 6, to: 6 },
  ]);
  assertEquals(blockLines([]), []);
});

Deno.test('changeMarks: added lines and pure deletions', () => {
  const parsed = parsePatch(
    [
      '@@ -1,6 +1,6 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '-d',
      ' e',
      '+f',
      ' g',
    ].join('\n'),
  );
  const m = changeMarks(parsed);
  assertEquals([...m.added].sort(), [2, 5]);
  // `d` was deleted before new line 4 (`e`).
  assertEquals([...m.deleted], [[4, 1]]);
});

Deno.test('changeMarks: a deletion at the end and a hunk with no new lines', () => {
  const end = changeMarks(parsePatch('@@ -3,3 +3,1 @@\n x\n-y\n-z\n'));
  assertEquals([...end.added], []);
  assertEquals([...end.deleted], [[4, 2]]);
  const none = changeMarks(parsePatch('@@ -5,2 +4,0 @@\n-p\n-q\n'));
  assertEquals([...none.deleted], [[5, 2]]);
  const notes = changeMarks(
    parsePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n'),
  );
  assertEquals([...notes.added], [1]);
  assertEquals([...notes.deleted], []);
});

Deno.test('blockMarks: adds, deletions into the next block or the end', () => {
  const blocks = [{ from: 1, to: 1 }, null, { from: 3, to: 4 }, {
    from: 6,
    to: 6,
  }];
  const r = blockMarks(blocks, {
    added: new Set([4]),
    deleted: new Map([[2, 1], [5, 3], [9, 2]]),
  });
  assertEquals(r.blocks, [
    { add: false, deleted: 0 },
    { add: false, deleted: 0 },
    { add: true, deleted: 1 },
    { add: false, deleted: 3 },
  ]);
  assertEquals(r.end, 2);
});

Deno.test('slug: GitHub anchors with repeats', () => {
  const seen = new Map();
  assertEquals(slug('Hello, World!', seen), 'hello-world');
  assertEquals(slug('Hello World', seen), 'hello-world-1');
  assertEquals(slug('Hello World', seen), 'hello-world-2');
  assertEquals(slug('  Größe & `code`_x ', seen), 'größe--code_x');
});
