import { assertEquals } from 'jsr:@std/assert';
import {
  byDepth,
  childPath,
  createDirTree,
  formatSize,
  isHtmlPath,
  isWithin,
  newEntryNameError,
  opensAsDir,
  opensAsFile,
  parentDir,
} from '../web/static/lib/files.js';

Deno.test('childPath joins relative and absolute paths', () => {
  assertEquals(childPath('', 'src'), 'src');
  assertEquals(childPath('src', 'a.ts'), 'src/a.ts');
  assertEquals(childPath('/', 'Users'), '/Users');
  assertEquals(childPath('/Users/me', 'code'), '/Users/me/code');
});

Deno.test('newEntryNameError: one segment, not . or .., no / or NUL', () => {
  for (const name of ['a.ts', '.env', '...', 'name with spaces', 'ü.md']) {
    assertEquals(newEntryNameError(name), null, name);
  }
  assertEquals(newEntryNameError(''), 'Enter a name');
  assertEquals(newEntryNameError('.'), '"." is not a name');
  assertEquals(newEntryNameError('..'), '".." is not a name');
  assertEquals(newEntryNameError('src/a.ts'), 'A name cannot contain /');
  assertEquals(newEntryNameError('a/'), 'A name cannot contain /');
  assertEquals(newEntryNameError('a\0b'), 'A name cannot contain NUL');
});

Deno.test('isWithin: the dir itself and paths under it, not siblings', () => {
  assertEquals(isWithin('', 'src/a'), true);
  assertEquals(isWithin('src', 'src'), true);
  assertEquals(isWithin('src', 'src/a'), true);
  assertEquals(isWithin('src', 'srcx'), false);
  assertEquals(isWithin('/', '/Users'), true);
  assertEquals(isWithin('/a', '/ab'), false);
});

Deno.test('opensAsDir / opensAsFile follow symlink targets', () => {
  assertEquals(opensAsDir({ name: 'l', kind: 'symlink', to: 'dir' }), true);
  assertEquals(opensAsFile({ name: 'l', kind: 'symlink', to: 'file' }), true);
  const broken = { name: 'l', kind: 'symlink' as const };
  assertEquals([opensAsDir(broken), opensAsFile(broken)], [false, false]);
});

Deno.test('byDepth puts parents first and drops duplicates', () => {
  assertEquals(byDepth(['a/b', '', 'a', 'c', 'a']), ['', 'a', 'c', 'a/b']);
});

/** A tree over a fake filesystem whose `list` replies only when told to. */
function fakeTree(fs: Record<string, string[]>) {
  const waiting: { path: string; resolve: () => void }[] = [];
  let changes = 0;
  const tree = createDirTree({
    list: (path: string) =>
      new Promise((resolve, reject) => {
        waiting.push({
          path,
          resolve: () =>
            path in fs
              ? resolve({
                entries: fs[path].map((n) =>
                  n.endsWith('/')
                    ? { name: n.slice(0, -1), kind: 'dir' as const }
                    : { name: n, kind: 'file' as const }
                ),
                truncated: false,
              })
              : reject(new Error(`no ${path}`)),
        });
      }),
    onChange: () => changes++,
  });
  const flush = async () => {
    for (const w of waiting.splice(0)) w.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { tree, flush, waiting, changes: () => changes };
}

const shape = (items: ReturnType<ReturnType<typeof createDirTree>['walk']>) =>
  items.map((i) =>
    i.type === 'entry'
      ? `${'  '.repeat(i.depth)}${i.path}${i.open ? ' (open)' : ''}`
      : `${'  '.repeat(i.depth)}<${i.type}>`
  );

Deno.test('createDirTree loads lazily and walks open directories', async () => {
  const { tree, flush, waiting } = fakeTree({
    '': ['src/', 'README.md'],
    'src': ['lib/', 'a.ts'],
    'src/lib': ['b.ts'],
  });
  tree.expand('');
  assertEquals(shape(tree.walk('', 1)), ['  <loading>']);
  await flush();
  assertEquals(shape(tree.walk('', 1)), ['  src', '  README.md']);
  tree.expand('src');
  await flush();
  tree.expand('src/lib');
  await flush();
  assertEquals(shape(tree.walk('', 1)), [
    '  src (open)',
    '    src/lib (open)',
    '      src/lib/b.ts',
    '    src/a.ts',
    '  README.md',
  ]);
  // A cached listing is not fetched again.
  tree.collapse('src/lib');
  tree.expand('');
  assertEquals(waiting.length, 0);
});

Deno.test('createDirTree: collapse forgets descendants; refresh reloads open ones', async () => {
  const { tree, flush, waiting } = fakeTree({
    '': ['src/'],
    'src': ['a.ts'],
  });
  tree.expand('');
  await flush();
  tree.expand('src');
  await flush();
  tree.refresh('');
  assertEquals(waiting.map((w) => w.path).sort(), ['', 'src']);
  await flush();
  tree.collapse('');
  assertEquals(tree.openPaths(), []);
  tree.expand('');
  assertEquals(waiting.map((w) => w.path), ['']);
  await flush();
  assertEquals(shape(tree.walk('', 1)), ['  src']);
});

Deno.test('createDirTree: a failed listing shows an error and is not reopened', async () => {
  const { tree, flush } = fakeTree({ '': ['gone/'] });
  tree.expand('');
  await flush();
  tree.expand('gone');
  await flush();
  assertEquals(shape(tree.walk('', 1)), ['  gone (open)', '    <error>']);
  assertEquals(tree.openPaths(), ['']);
});

Deno.test('createDirTree drops a reply that arrives after a collapse', async () => {
  const { tree, flush } = fakeTree({ '': ['a'] });
  tree.expand('');
  tree.collapse('');
  await flush();
  assertEquals(tree.listing(''), undefined);
});

Deno.test('parentDir walks up to / and stops there', () => {
  assertEquals(parentDir('/Users/me/code'), '/Users/me');
  assertEquals(parentDir('/Users/me/'), '/Users');
  assertEquals(parentDir('/Users'), '/');
  assertEquals(parentDir('/'), null);
});

Deno.test('formatSize', () => {
  assertEquals(formatSize(5), '5 B');
  assertEquals(formatSize(1536), '1.5 KB');
  assertEquals(formatSize(20 * 1024 * 1024), '20 MB');
});

Deno.test('isHtmlPath: .html, .htm and .xhtml, any case', () => {
  for (const p of ['index.html', 'a/b.HTM', '/srv/page.xhtml', '.html']) {
    assertEquals(isHtmlPath(p), true, p);
  }
  for (const p of ['html', 'a.html.bak', 'a.xhtm', 'notes.md', 'dir.html/x']) {
    assertEquals(isHtmlPath(p), false, p);
  }
});
