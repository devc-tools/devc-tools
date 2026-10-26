import { assertEquals } from 'jsr:@std/assert';
import {
  changedRanges,
  diffTexts,
  ignoreWhitespace,
  lineMap,
  markRanges,
  MAX_DIFF_LINES,
  newColumn,
  parsePatch,
  placeThreads,
  splitRows,
  threadRows,
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

Deno.test('threadRows: a line, or a block with the deleted rows inside it', () => {
  const parsed = parsePatch([
    '@@ -1,4 +1,4 @@',
    ' a',
    '+b',
    '-c',
    '+d',
    ' e',
    '@@ -20 +20 @@',
    ' z',
  ].join('\n'));
  assertEquals(threadRows(parsed, { line: 2 }), ['0:1']);
  assertEquals(threadRows(parsed, { line: 3, startLine: 2 }), [
    '0:1',
    '0:2',
    '0:3',
  ]);
  // Across hunks: only the rows the patch shows.
  assertEquals(threadRows(parsed, { line: 20, startLine: 4 }), ['0:4', '1:0']);
  assertEquals(threadRows(parsed, { line: null }), []);
  assertEquals(threadRows(parsed, { line: 9 }), []);
  assertEquals(threadRows(null, { line: 2 }), []);
});

Deno.test('placeThreads: a LEFT thread by its old-file line, a FILE thread in File threads', () => {
  const parsed = parsePatch(PATCH);
  const { rows, file } = placeThreads(parsed, [
    { id: 'del', line: 11, diffSide: 'LEFT' },
    { id: 'add', line: 11, diffSide: 'RIGHT' },
    { id: 'ctx-old', line: 12, diffSide: 'LEFT' },
    { id: 'hunk2-old', line: 20, diffSide: 'LEFT' },
    // Old line 21 is in no hunk: the new file's 21 is not it.
    { id: 'left-unmatched', line: 21, diffSide: 'LEFT' },
    { id: 'file', line: 11, subjectType: 'FILE' },
  ]);
  assertEquals(
    [...rows].map(([k, v]) => [k, v.map((x) => x.id)]),
    [['0:2', ['del']], ['0:1', ['add']], ['0:3', ['ctx-old']], [
      '1:0',
      ['hunk2-old'],
    ]],
  );
  assertEquals(file.map((x) => x.id), ['left-unmatched', 'file']);
});

Deno.test('threadRows: LEFT lines and blocks, a block across sides, and a file comment', () => {
  const parsed = parsePatch([
    '@@ -1,4 +1,4 @@',
    ' a',
    '+b',
    '-c',
    '+d',
    ' e',
  ].join('\n'));
  // Old numbers: a 1, c 2, e 3. New: a 1, b 2, d 3, e 4.
  assertEquals(threadRows(parsed, { line: 2, diffSide: 'LEFT' }), ['0:2']);
  assertEquals(
    threadRows(parsed, { line: 3, startLine: 1, diffSide: 'LEFT' }),
    ['0:0', '0:1', '0:2', '0:3', '0:4'],
  );
  // From old line 2 (c) to new line 3 (d).
  assertEquals(
    threadRows(parsed, {
      line: 3,
      startLine: 2,
      diffSide: 'RIGHT',
      startDiffSide: 'LEFT',
    }),
    ['0:2', '0:3'],
  );
  assertEquals(
    threadRows(parsed, { line: 2, diffSide: 'LEFT', subjectType: 'FILE' }),
    [],
  );
});

const lines = (...ls: string[]) => ls.map((l) => l + '\n').join('');
const shape = (p: ReturnType<typeof diffTexts>) =>
  p!.hunks.map((h) => [
    h.header,
    ...h.rows.map((r) =>
      ({ context: ' ', add: '+', del: '-', note: '\\' })[r.kind] + r.text
    ),
  ]);

Deno.test('diffTexts: identical, insert, delete and change', () => {
  assertEquals(diffTexts(lines('a', 'b'), lines('a', 'b')), {
    hunks: [],
    rest: null,
  });
  assertEquals(diffTexts('', ''), { hunks: [], rest: null });
  assertEquals(shape(diffTexts(lines('a', 'c'), lines('a', 'b', 'c'))), [
    ['@@ -1,2 +1,3 @@', ' a', '+b', ' c'],
  ]);
  assertEquals(shape(diffTexts(lines('a', 'b', 'c'), lines('a', 'c'))), [
    ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'],
  ]);
  assertEquals(shape(diffTexts(lines('a', 'b', 'c'), lines('a', 'B', 'c'))), [
    ['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'],
  ]);
  // A side with no lines starts at the line before, as diff writes it.
  assertEquals(shape(diffTexts('', lines('x'))), [['@@ -0,0 +1,1 @@', '+x']]);
  assertEquals(shape(diffTexts(lines('x'), ''))[0][0], '@@ -1,1 +0,0 @@');
  const p = diffTexts(lines('a', 'b'), lines('a', 'c'))!;
  assertEquals(p.rest, null);
  assertEquals(
    p.hunks[0].rows.map((r) => [r.kind, r.old, r.new]),
    [['context', 1, 1], ['del', 2, null], ['add', null, 2]],
  );
  assertEquals(
    [p.hunks[0].oldStart, p.hunks[0].oldCount, p.hunks[0].section],
    [1, 2, ''],
  );
});

Deno.test('diffTexts: context around changes, hunks merged when their context touches', () => {
  const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const far = [...old];
  far[1] = 'X';
  far[25] = 'Y';
  assertEquals(shape(diffTexts(lines(...old), lines(...far))), [
    ['@@ -1,5 +1,5 @@', ' l1', '-l2', '+X', ' l3', ' l4', ' l5'],
    [
      '@@ -23,7 +23,7 @@',
      ' l23',
      ' l24',
      ' l25',
      '-l26',
      '+Y',
      ' l27',
      ' l28',
      ' l29',
    ],
  ]);
  // Six unchanged lines between: the two contexts touch, so one hunk.
  const near = [...old];
  near[9] = 'X';
  near[16] = 'Y';
  const merged = shape(diffTexts(lines(...old), lines(...near)));
  assertEquals(merged.length, 1);
  assertEquals(merged[0][0], '@@ -7,14 +7,14 @@');
  // Seven: two hunks.
  const apart = [...old];
  apart[9] = 'X';
  apart[17] = 'Y';
  assertEquals(shape(diffTexts(lines(...old), lines(...apart))).length, 2);
  assertEquals(
    shape(diffTexts(lines(...old), lines(...far), 0)).map((h) => h[0]),
    ['@@ -2,1 +2,1 @@', '@@ -26,1 +26,1 @@'],
  );
});

Deno.test('diffTexts: CRLF and a missing final newline are not changes', () => {
  assertEquals(diffTexts('a\r\nb\r\n', 'a\nb\n')!.hunks, []);
  assertEquals(diffTexts('a\nb', 'a\nb\n')!.hunks, []);
  const p = diffTexts('a\r\nb\r\n', 'a\r\nc\r\n')!;
  assertEquals(p.hunks[0].rows.map((r) => r.text), ['a', 'b', 'c']);
});

Deno.test('diffTexts: past MAX_DIFF_LINES on either side, null', () => {
  const big = 'x\n'.repeat(MAX_DIFF_LINES + 1);
  const max = 'x\n'.repeat(MAX_DIFF_LINES);
  assertEquals(diffTexts(big, 'x\n'), null);
  assertEquals(diffTexts('x\n', big), null);
  assertEquals(diffTexts(max, max)!.hunks, []);
});

Deno.test('newColumn: a displayed offset back to the row text, past invisible-character markers', () => {
  assertEquals(newColumn('abc', 2), 2);
  // A surrogate pair is two UTF-16 units, displayed as they are.
  assertEquals(newColumn('😀x', 2), 2);
  // U+200B is displayed as `⟨U+200B⟩`, 8 units: after `a` and the marker is text offset 2.
  assertEquals(newColumn('a\u200Bb', 9), 2);
  assertEquals(newColumn('a\u200Bb', 3), 1, 'inside a marker: its character');
  assertEquals(newColumn('ab', 99), 2);
});

Deno.test('lineMap: unchanged lines map across inserted, deleted and changed ones', () => {
  const head = 'a\nb\nc\nd\ne\n';
  const local = 'new\na\nc\nD\ne\n';
  const map = lineMap(head, local);
  assertEquals(map(0), 1, 'a moved down by the inserted line');
  assertEquals(map(1), null, 'b was deleted');
  assertEquals(map(2), 2);
  assertEquals(map(3), null, 'd was changed');
  assertEquals(map(4), 4);
  assertEquals(
    lineMap(head, head)(3),
    3,
    'identical texts: every line is itself',
  );
});
