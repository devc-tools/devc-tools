import { assertEquals } from 'jsr:@std/assert';
import {
  defaultNotePath,
  filePinName,
  isFilePinShortcut,
  notePathError,
  parseFilePinPanes,
  parsePinnedFiles,
} from '../web/static/lib/pinned_files.js';
import { tilesShowingPane } from '../web/static/lib/layout_state.js';

const notes = {
  id: 'p1',
  localFolder: '/src/app',
  root: '/src/app',
  path: '.plans/notes.md',
};

Deno.test('parsePinnedFiles keeps well-formed pins in order', () => {
  assertEquals(
    parsePinnedFiles({
      type: 'pinned_files',
      pins: [
        { ...notes, label: 'Notes' },
        { ...notes, id: '' },
        { ...notes, id: 'p2', path: 3 },
        null,
        { ...notes, id: 'p3', label: '' },
      ],
    }),
    [{ ...notes, label: 'Notes' }, { ...notes, id: 'p3' }],
  );
  assertEquals(parsePinnedFiles({ type: 'pinned_files' }), []);
  assertEquals(parsePinnedFiles(null), []);
});

Deno.test('filePinName: the label, else the basename', () => {
  assertEquals(filePinName(notes), 'notes.md');
  assertEquals(filePinName({ ...notes, label: 'Ideas' }), 'Ideas');
});

Deno.test('notePathError: relative, plain folders, a valid name', () => {
  for (const p of ['NOTES.md', '.plans/notes.md', 'a/b/c.txt', '.env']) {
    assertEquals(notePathError(p), null, p);
  }
  assertEquals(notePathError(''), 'Enter a path');
  assertEquals(notePathError('/etc/x'), 'The path is relative to the repo');
  assertEquals(
    notePathError('../x.md'),
    'Folders in the path must be plain names',
  );
  assertEquals(
    notePathError('a//b.md'),
    'Folders in the path must be plain names',
  );
  assertEquals(notePathError('a/'), 'Enter a name');
  assertEquals(notePathError('a/..'), '".." is not a name');
  assertEquals(notePathError('a\0b'), 'A path cannot contain NUL');
});

Deno.test('defaultNotePath: .plans/notes.md with a .plans folder, else NOTES.md', () => {
  assertEquals(
    defaultNotePath([{ name: '.plans', kind: 'dir' }]),
    '.plans/notes.md',
  );
  assertEquals(
    defaultNotePath([{ name: '.plans', kind: 'symlink', to: 'dir' }]),
    '.plans/notes.md',
  );
  assertEquals(defaultNotePath([{ name: '.plans', kind: 'file' }]), 'NOTES.md');
  assertEquals(defaultNotePath([]), 'NOTES.md');
});

Deno.test('isFilePinShortcut: Ctrl+Alt+N, Cmd+Alt+N on a Mac', () => {
  const key = (mods: Partial<Record<string, boolean>>, code = 'KeyN') => ({
    code,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  assertEquals(
    isFilePinShortcut(key({ ctrlKey: true, altKey: true }), false),
    true,
  );
  assertEquals(
    isFilePinShortcut(key({ metaKey: true, altKey: true }), true),
    true,
  );
  // Not on the other platform's modifier, not without Alt, not with Shift, not another key.
  assertEquals(
    isFilePinShortcut(key({ metaKey: true, altKey: true }), false),
    false,
  );
  assertEquals(
    isFilePinShortcut(key({ ctrlKey: true, altKey: true }), true),
    false,
  );
  assertEquals(isFilePinShortcut(key({ ctrlKey: true }), false), false);
  assertEquals(
    isFilePinShortcut(
      key({ ctrlKey: true, altKey: true, shiftKey: true }),
      false,
    ),
    false,
  );
  assertEquals(
    isFilePinShortcut(key({ ctrlKey: true, altKey: true }, 'KeyM'), false),
    false,
  );
});

Deno.test('parseFilePinPanes keeps string pane ids, drops the rest', () => {
  assertEquals(
    [...parseFilePinPanes('{"p1": "w1-3", "p2": 4, "p3": ""}')],
    [['p1', 'w1-3']],
  );
  assertEquals([...parseFilePinPanes(null)], []);
  assertEquals([...parseFilePinPanes('[1]')], []);
  assertEquals([...parseFilePinPanes('{bad')], []);
});

Deno.test('tilesShowingPane: pane tiles of that pane only', () => {
  const ref = { localFolder: '/src/app', pane_id: 'w1-3' };
  const tiles = [
    { id: 't1', kind: 'pane', ref },
    { id: 't2', kind: 'pane', ref: { ...ref, pane_id: 'w1-4' } },
    { id: 't3', kind: 'pane', ref: { ...ref, localFolder: '/src/other' } },
    { id: 't4', kind: 'file', ref: null },
    { id: 't5', kind: 'pane', ref: null },
    { id: 't6', kind: 'pane', ref },
  ];
  assertEquals(tilesShowingPane(tiles, ref).map((t) => t.id), ['t1', 't6']);
});
