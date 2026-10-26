import { assertEquals } from 'jsr:@std/assert';
import {
  buildPrFlat,
  buildPrTree,
  folderOpenByDefault,
  isTestPath,
  prFileUrl,
  splitMarkers,
  statusLetter,
  viewedPercent,
  withoutViewed,
} from '../web/static/lib/pr_tree.js';
import { fileUrl } from '../web/pr_review.ts';

const file = (
  path: string,
  viewed = 'UNVIEWED',
  additions = 1,
  deletions = 0,
) => ({
  path,
  previousPath: null,
  status: 'modified',
  additions,
  deletions,
  viewed: viewed as 'VIEWED' | 'UNVIEWED' | 'DISMISSED',
});

/** A tree as nested names: folders as `[name, [...children]]`, files as names. */
// deno-lint-ignore no-explicit-any
function shape(dir: any): unknown[] {
  return [
    ...dir.dirs.map((d: unknown) => [(d as { name: string }).name, shape(d)]),
    ...dir.files.map((f: { name: string }) => f.name),
  ];
}

Deno.test('buildPrTree compacts a chain of single folders', () => {
  const tree = buildPrTree([
    file('a/b/c/x.ts'),
    file('a/b/c/y.ts'),
    file('a/z.ts'),
  ]);
  assertEquals(shape(tree), [['a', [['b/c', ['x.ts', 'y.ts']], 'z.ts']]]);
  assertEquals(tree.dirs[0].dirs[0].path, 'a/b/c');
  // A lone top folder chain compacts too.
  assertEquals(shape(buildPrTree([file('src/web/lib/a.js')])), [
    ['src/web/lib', ['a.js']],
  ]);
});

Deno.test('buildPrTree sorts folders first, then files, by name', () => {
  const tree = buildPrTree([
    file('b.md'),
    file('Z/x'),
    file('a.md'),
    file('a/x'),
    file('A.md'),
  ]);
  assertEquals(shape(tree), [
    ['a', ['x']],
    ['Z', ['x']],
    'a.md',
    'A.md',
    'b.md',
  ]);
});

Deno.test('buildPrTree counts viewed files per folder, DISMISSED as not viewed', () => {
  const tree = buildPrTree([
    file('a/x', 'VIEWED'),
    file('a/y', 'DISMISSED'),
    file('b/x', 'VIEWED'),
    file('c'),
  ]);
  assertEquals([tree.viewed, tree.total], [2, 4]);
  const [a, b] = tree.dirs;
  assertEquals([a.viewed, a.total], [1, 2]);
  assertEquals([b.viewed, b.total], [1, 1]);
  assertEquals(folderOpenByDefault(a), true);
  assertEquals(folderOpenByDefault(b), false);
});

Deno.test('withoutViewed drops Viewed files and fully viewed folders, keeping counts', () => {
  const tree = buildPrTree([
    file('a/x', 'VIEWED'),
    file('a/y', 'DISMISSED'),
    file('b/c/x', 'VIEWED'),
    file('b/d', 'VIEWED'),
    file('e', 'VIEWED'),
    file('f'),
  ]);
  const shown = withoutViewed(tree);
  assertEquals(shape(shown), [['a', ['y']], 'f']);
  assertEquals([shown.viewed, shown.total], [4, 6]);
  assertEquals([shown.dirs[0].viewed, shown.dirs[0].total], [1, 2]);
  // Everything viewed: nothing is left.
  assertEquals(shape(withoutViewed(buildPrTree([file('a/x', 'VIEWED')]))), []);
  // The tree it was given is unchanged.
  assertEquals(shape(tree).length, 4);
});

Deno.test('buildPrFlat lists every file, most changed lines first, then by path', () => {
  const flat = buildPrFlat([
    file('z/small.ts', 'UNVIEWED', 1, 1),
    file('a/b/big.ts', 'VIEWED', 30, 20),
    file('top.md', 'UNVIEWED', 2, 0),
    file('a/also.ts', 'UNVIEWED', 2, 0),
    file('bin.png', 'VIEWED', 0, 0),
  ]);
  assertEquals(flat.dirs, []);
  assertEquals(
    flat.files.map((n) => [n.name, n.dir]),
    [
      ['big.ts', 'a/b'],
      ['also.ts', 'a'],
      ['top.md', ''],
      ['small.ts', 'z'],
      ['bin.png', ''],
    ],
  );
  assertEquals([flat.viewed, flat.total], [2, 5]);
  assertEquals([flat.viewedLines, flat.totalLines], [50, 56]);
  // Fewest first: the reverse by size, still by path among equals.
  assertEquals(
    buildPrFlat([
      file('b', 'UNVIEWED', 5, 0),
      file('c', 'UNVIEWED', 1, 0),
      file('a', 'UNVIEWED', 1, 0),
    ], 'fewest').files.map((n) => n.name),
    ['a', 'c', 'b'],
  );
  // Hide viewed works on a flat list as on a tree.
  assertEquals(withoutViewed(flat).files.map((n) => n.name), [
    'also.ts',
    'top.md',
    'small.ts',
  ]);
});

Deno.test('buildPrTree counts changed lines, Viewed ones apart, per folder', () => {
  const tree = buildPrTree([
    file('a/x', 'VIEWED', 3, 2),
    file('a/y', 'DISMISSED', 4, 0),
    file('b', 'UNVIEWED', 1, 0),
  ]);
  assertEquals([tree.viewedLines, tree.totalLines], [5, 10]);
  assertEquals([tree.dirs[0].viewedLines, tree.dirs[0].totalLines], [5, 9]);
});

Deno.test('viewedPercent weighs by changed lines, rounding down', () => {
  const pct = (...files: ReturnType<typeof file>[]) =>
    viewedPercent(buildPrTree(files));
  assertEquals(
    pct(file('a', 'VIEWED', 90, 0), file('b', 'UNVIEWED', 10, 0)),
    90,
  );
  // 199 of 200 lines is not done.
  assertEquals(
    pct(file('a', 'VIEWED', 199, 0), file('b', 'UNVIEWED', 1, 0)),
    99,
  );
  assertEquals(pct(file('a', 'VIEWED', 2, 2)), 100);
  // No changed lines at all: by files.
  assertEquals(pct(file('a', 'VIEWED', 0, 0), file('b', 'UNVIEWED', 0, 0)), 50);
  assertEquals(pct(), 0);
});

Deno.test('isTestPath: test folders and test file names across languages', () => {
  for (
    const path of [
      'src/a.test.ts',
      'src/a.spec.js',
      'a.test.tsx',
      'devc/tests/web_pr_tree_test.ts',
      'pkg/server_test.go',
      'lib/thing_spec.rb',
      'test/helpers.js',
      'src/__tests__/a.js',
      'pkg/testdata/in.json',
      'tests/fixtures/x.txt',
      'app/test_models.py',
      'conftest.py',
      'src/main/java/FooTest.java',
      'Foo.Tests/BarTests.cs',
      'src/FooSpec.scala',
      'FooTest.kt',
    ]
  ) assertEquals(isTestPath(path), true, path);
  for (
    const path of [
      'src/a.ts',
      'src/latest.ts',
      'src/testing.ts',
      'contest/a.ts',
      'src/Contest.java',
      'docs/spec/design.md',
      'tests.md',
      'src/test.ts',
      'my_test_helpers/a.py',
      'attest/test_x.js',
    ]
  ) assertEquals(isTestPath(path), false, path);
});

Deno.test('statusLetter: A, D, R, C, else M', () => {
  assertEquals(
    ['added', 'removed', 'renamed', 'copied', 'modified', 'changed', 'x'].map(
      statusLetter,
    ),
    ['A', 'D', 'R', 'C', 'M', 'M', 'M'],
  );
});

Deno.test('splitMarkers shows bidi controls and zero-width characters as markers', () => {
  assertEquals(splitMarkers('plain'), ['plain']);
  assertEquals(splitMarkers('a‮b​c'), [
    'a',
    { marker: '⟨U+202E⟩' },
    'b',
    { marker: '⟨U+200B⟩' },
    'c',
  ]);
  assertEquals(splitMarkers('﻿⁦'), [
    { marker: '⟨U+FEFF⟩' },
    { marker: '⟨U+2066⟩' },
  ]);
  assertEquals(splitMarkers(''), []);
});

Deno.test("prFileUrl is the server's fileUrl: GitHub's per-file anchor", async () => {
  const pr = 'https://github.com/o/r/pull/7';
  for (const path of ['a.ts', 'dir/ünï code.md']) {
    assertEquals(await prFileUrl(pr, path), await fileUrl(pr, path));
  }
});
