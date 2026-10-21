import { assertEquals } from 'jsr:@std/assert';
import { parsePatch, placeThreads } from '../web/static/lib/diff.js';

const PATCH = [
  '@@ -10,3 +10,4 @@ function f() {',
  ' const a = 1;',
  '+const b = 2;',
  '-const c = 3;',
  ' return a;',
  '@@ -20 +21,2 @@',
  '-old',
  '+new',
  '+more',
  '\\ No newline at end of file',
].join('\n');

Deno.test('parsePatch numbers old and new lines per hunk', () => {
  const { hunks, rest } = parsePatch(PATCH + '\n');
  assertEquals(rest, null);
  assertEquals(hunks.length, 2);
  assertEquals(hunks[0].section, 'function f() {');
  assertEquals(
    hunks[0].rows.map((r) => [r.kind, r.old, r.new, r.text]),
    [
      ['context', 10, 10, 'const a = 1;'],
      ['add', null, 11, 'const b = 2;'],
      ['del', 11, null, 'const c = 3;'],
      ['context', 12, 12, 'return a;'],
    ],
  );
  assertEquals([hunks[1].oldStart, hunks[1].oldCount], [20, 1]);
  assertEquals([hunks[1].newStart, hunks[1].newCount], [21, 2]);
  assertEquals(
    hunks[1].rows.map((r) => [r.kind, r.old, r.new]),
    [['del', 20, null], ['add', null, 21], ['add', null, 22], [
      'note',
      null,
      null,
    ]],
  );
  assertEquals(hunks[1].rows[3].text, '\\ No newline at end of file');
});

Deno.test('parsePatch: a line it does not expect ends the parse, the rest raw', () => {
  const { hunks, rest } = parsePatch(
    '@@ -1 +1 @@\n-a\n+b\nGARBAGE\n+not parsed',
  );
  assertEquals(hunks.length, 1);
  assertEquals(hunks[0].rows.length, 2);
  assertEquals(rest, 'GARBAGE\n+not parsed');
  assertEquals(parsePatch('no hunk\n+x'), { hunks: [], rest: 'no hunk\n+x' });
  assertEquals(parsePatch('@@ bad @@\n+x').rest, '@@ bad @@\n+x');
});

Deno.test('placeThreads: after the new-file line, else File threads', () => {
  const parsed = parsePatch(PATCH);
  const t = (id: string, line: number | null) => ({ id, line });
  const { rows, file } = placeThreads(parsed, [
    t('add', 11),
    t('context', 12),
    t('second', 11),
    t('null', null),
    t('unmatched', 99),
    t('hunk2', 22),
  ]);
  assertEquals(
    [...rows].map(([k, v]) => [k, v.map((x) => x.id)]),
    [['0:1', ['add', 'second']], ['0:3', ['context']], ['1:2', ['hunk2']]],
  );
  assertEquals(file.map((x) => x.id), ['null', 'unmatched']);
  assertEquals(placeThreads(null, [t('x', 1)]).file.map((x) => x.id), ['x']);
});
