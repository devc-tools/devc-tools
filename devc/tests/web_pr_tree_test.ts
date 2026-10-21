import { assertEquals } from 'jsr:@std/assert';
import {
  buildPrTree,
  folderOpenByDefault,
  splitMarkers,
  statusLetter,
} from '../web/static/lib/pr_tree.js';

const file = (path: string, viewed = 'UNVIEWED') => ({
  path,
  previousPath: null,
  status: 'modified',
  additions: 1,
  deletions: 0,
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
