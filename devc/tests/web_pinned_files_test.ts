import { assertEquals, assertStrictEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  addFilePin,
  type FilePin,
  pinnedFilesMessage,
  readPinnedFiles,
  reusablePinnedPane,
  setDashboardPin,
  updateFilePin,
  withLabel,
  writePinnedFiles,
} from '../web/pinned_files.ts';

const notes: FilePin = {
  id: 'p1',
  localFolder: '/src/app',
  root: '/src/app',
  path: '.plans/notes.md',
};

Deno.test('readPinnedFiles: a missing file is no pins', async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await readPinnedFiles(join(dir, 'pinned-files.json')), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readPinnedFiles: a corrupt file is no pins', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'pinned-files.json');
  try {
    for (const text of ['{not json', 'null', '[]', '{"pins": 3}']) {
      await Deno.writeTextFile(path, text);
      assertEquals(await readPinnedFiles(path), [], text);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readPinnedFiles: drops malformed and repeated entries, keeps the rest', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'pinned-files.json');
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        pins: [
          {
            ...notes,
            label: 'Notes',
            last: { containerId: 'c1', paneId: 'p9' },
            extra: 1,
          },
          { ...notes, id: 'p2' }, // the same file again
          { ...notes, id: 'p1', path: 'other.md' }, // the same id again
          { ...notes, id: 'p3', root: 'relative' },
          { ...notes, id: 'p4', path: '' },
          { ...notes, id: 'p5', last: { containerId: 'c1' } },
          { ...notes, id: 'p6', path: 'NOTES.md' },
          'nonsense',
        ],
      }),
    );
    assertEquals(await readPinnedFiles(path), [
      { ...notes, label: 'Notes', last: { containerId: 'c1', paneId: 'p9' } },
      { ...notes, id: 'p6', path: 'NOTES.md' },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writePinnedFiles: writes atomically, makes the folder, leaves no temp file', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'devc', 'pinned-files.json');
  try {
    await writePinnedFiles([notes], path);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      version: 1,
      pins: [notes],
    });
    await writePinnedFiles([], path);
    assertEquals(await readPinnedFiles(path), []);
    const names = [];
    for await (const e of Deno.readDir(join(dir, 'devc'))) names.push(e.name);
    assertEquals(names, ['pinned-files.json']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('addFilePin appends a new pin; pinning the same file again is a no-op', () => {
  const first = addFilePin([], {
    localFolder: '/src/app',
    root: '/src/app',
    path: '.plans/notes.md',
  }, () => 'p1');
  assertEquals(first, { pins: [notes], id: 'p1' });
  const again = addFilePin(first.pins, {
    localFolder: '/src/app',
    root: '/src/app',
    path: '.plans/notes.md',
    label: 'Other',
  }, () => 'p2');
  assertEquals(again, { pins: [notes], id: 'p1' });
  const second = addFilePin(first.pins, {
    localFolder: '/src/app',
    root: '/src/app',
    path: 'NOTES.md',
    label: 'Ideas',
  }, () => 'p2');
  assertEquals(second.id, 'p2');
  assertEquals(second.pins.map((p) => [p.id, p.label]), [
    ['p1', undefined],
    ['p2', 'Ideas'],
  ]);
});

Deno.test('updateFilePin and withLabel: set, clear, unknown id', () => {
  const labelled = updateFilePin([notes], 'p1', (p) => withLabel(p, 'Notes'));
  assertEquals(labelled, [{ ...notes, label: 'Notes' }]);
  assertEquals(updateFilePin(labelled!, 'p1', (p) => withLabel(p, '')), [
    notes,
  ]);
  assertEquals(updateFilePin([notes], 'nope', (p) => p), null);
});

Deno.test('pinnedFilesMessage never sends last', () => {
  assertEquals(
    pinnedFilesMessage([{
      ...notes,
      last: { containerId: 'c1', paneId: 'p9' },
    }]),
    { type: 'pinned_files', pins: [notes] },
  );
});

Deno.test('reusablePinnedPane: last alive, dead, in another container, or unset', () => {
  const last = { containerId: 'c1', paneId: 'w1-3' };
  const panes = [
    { pane_id: 'w1-1', tab_id: 'w1:1' },
    { pane_id: 'w1-3', tab_id: 'w1:3' },
  ];
  assertEquals(reusablePinnedPane(last, 'c1', panes), {
    pane_id: 'w1-3',
    tab_id: 'w1:3',
  });
  assertEquals(reusablePinnedPane(last, 'c1', [panes[0]]), null);
  assertEquals(reusablePinnedPane(last, 'c2', panes), null);
  assertEquals(reusablePinnedPane(undefined, 'c1', panes), null);
});

Deno.test('readPinnedFiles: keeps the first dashboard flag only, and only true', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'pinned-files.json');
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        pins: [
          { ...notes, dashboard: false },
          { ...notes, id: 'p2', path: 'a.html', dashboard: true },
          { ...notes, id: 'p3', path: 'b.html', dashboard: true },
          { ...notes, id: 'p4', path: 'c.html', dashboard: 'yes' },
        ],
      }),
    );
    assertEquals(await readPinnedFiles(path), [
      notes,
      { ...notes, id: 'p2', path: 'a.html', dashboard: true },
      { ...notes, id: 'p3', path: 'b.html' },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('setDashboardPin: marks one, moves it, clears it, unknown id, no change', () => {
  const page: FilePin = { ...notes, id: 'p2', path: 'dashboard.html' };
  const marked = setDashboardPin([notes, page], 'p2');
  assertEquals(marked, [notes, { ...page, dashboard: true }]);
  assertEquals(setDashboardPin(marked!, 'p1'), [
    { ...notes, dashboard: true },
    page,
  ]);
  assertEquals(setDashboardPin(marked!, null), [notes, page]);
  assertEquals(setDashboardPin(marked!, 'nope'), null);
  assertStrictEquals(setDashboardPin(marked!, 'p2'), marked);
  const none = [notes, page];
  assertStrictEquals(setDashboardPin(none, null), none);
});

Deno.test('pinnedFilesMessage sends the dashboard flag', () => {
  const pin: FilePin = { ...notes, dashboard: true };
  assertEquals(pinnedFilesMessage([pin]), {
    type: 'pinned_files',
    pins: [pin],
  });
});
