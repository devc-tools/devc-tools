import { assertEquals } from 'jsr:@std/assert';
import {
  changedRanges,
  ignoreWhitespace,
  markRanges,
  parsePatch,
  placeThreads,
  splitRows,
} from '../web/static/lib/diff.js';

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

Deno.test('ignoreWhitespace makes whitespace-only pairs context, keeping real changes', () => {
  const parsed = parsePatch([
    '@@ -1,4 +1,5 @@',
    ' a',
    '-if (x) {',
    '-  y();',
    '-}',
    '+if (x)  {',
    '+    y();',
    '+    z();',
    '+}',
  ].join('\n'));
  const shown = ignoreWhitespace(parsed);
  assertEquals(
    shown.hunks[0].rows.map((r) => [r.kind, r.old, r.new, r.text]),
    [
      ['context', 1, 1, 'a'],
      ['context', 2, 2, 'if (x)  {'],
      ['context', 3, 3, '    y();'],
      ['add', null, 4, '    z();'],
      ['context', 4, 5, '}'],
    ],
  );
  assertEquals(shown.hunks[0].whitespaceOnly, undefined);
  // The input is not changed.
  assertEquals(parsed.hunks[0].rows[1].kind, 'del');
});

Deno.test('ignoreWhitespace marks a hunk left with no change', () => {
  const shown = ignoreWhitespace(
    parsePatch('@@ -1 +1 @@\n-a\tb\n+a  b\n\\ No newline at end of file'),
  );
  assertEquals(
    shown.hunks[0].rows.map((r) => r.kind),
    ['context', 'note'],
  );
  assertEquals(shown.hunks[0].whitespaceOnly, true);
});

Deno.test('ignoreWhitespace keeps an added blank line', () => {
  const shown = ignoreWhitespace(parsePatch('@@ -1 +1,2 @@\n a\n+'));
  assertEquals(shown.hunks[0].rows.map((r) => r.kind), ['context', 'add']);
});

Deno.test('splitRows pairs deleted rows with added ones and puts context on both sides', () => {
  const [hunk] = parsePatch([
    '@@ -1,4 +1,4 @@',
    ' a',
    '-b',
    '-c',
    '+B',
    ' d',
    '+e',
    '\\ No newline at end of file',
  ].join('\n')).hunks;
  assertEquals(
    splitRows(hunk).map((r) => [
      r.left?.text ?? null,
      r.leftIndex,
      r.right?.text ?? null,
      r.rightIndex,
    ]),
    [
      ['a', 0, 'a', 0],
      ['b', 1, 'B', 3],
      ['c', 2, null, null],
      ['d', 4, 'd', 4],
      [null, null, 'e', 5],
      [null, null, '\\ No newline at end of file', 6],
    ],
  );
});

Deno.test('changedRanges marks the words that differ between facing rows', () => {
  const [hunk] = parsePatch(
    [
      '@@ -1,3 +1,3 @@',
      '-  return "old";',
      '-x',
      '+    return "new";',
      '+y',
      ' context',
    ].join('\n'),
  ).hunks;
  const ranges = changedRanges(hunk);
  assertEquals(ranges.get(0), [[0, 2], [10, 13]]);
  assertEquals(ranges.get(2), [[0, 4], [12, 15]]);
  // Nothing in common: no ranges, the whole line is the change.
  assertEquals(ranges.has(1), false);
  assertEquals(ranges.has(3), false);
});

Deno.test('markRanges splits highlighted runs at each range', () => {
  assertEquals(
    markRanges([{ text: 'const', cls: 'k' }, { text: ' ab = 1;', cls: '' }], [
      [3, 8],
      [11, 12],
    ]),
    [
      { text: 'con', cls: 'k' },
      { text: 'st', cls: 'k', changed: true },
      { text: ' ab', cls: '', changed: true },
      { text: ' = ', cls: '' },
      { text: '1', cls: '', changed: true },
      { text: ';', cls: '' },
    ],
  );
  assertEquals(markRanges([{ text: 'ab', cls: '' }], [[1, 1]]), [
    { text: 'a', cls: '' },
    { text: 'b', cls: '' },
  ]);
});
