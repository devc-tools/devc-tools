import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  forget,
  loadProjects,
  MAX_RECENT,
  type ProjectEntry,
  recordUse,
  setEnvironment,
  setPinned,
  updateProjects,
} from '../projects.ts';

const at = (iso: string) => new Date(iso);

Deno.test('recordUse adds a new folder unpinned, newest first', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/a', pinned: false, lastUsed: '2026-01-01T00:00:00.000Z' },
  ];
  assertEquals(recordUse(list, '/b', at('2026-02-01T00:00:00.000Z')), [
    { localFolder: '/b', pinned: false, lastUsed: '2026-02-01T00:00:00.000Z' },
    { localFolder: '/a', pinned: false, lastUsed: '2026-01-01T00:00:00.000Z' },
  ]);
});

Deno.test('recordUse bumps an existing folder and keeps its pin', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/b', pinned: false, lastUsed: '2026-02-01T00:00:00.000Z' },
    { localFolder: '/a', pinned: true, lastUsed: '2026-01-01T00:00:00.000Z' },
  ];
  assertEquals(recordUse(list, '/a', at('2026-03-01T00:00:00.000Z')), [
    { localFolder: '/a', pinned: true, lastUsed: '2026-03-01T00:00:00.000Z' },
    { localFolder: '/b', pinned: false, lastUsed: '2026-02-01T00:00:00.000Z' },
  ]);
});

Deno.test('recordUse caps unpinned entries and never drops a pinned one', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/pinned', pinned: true, lastUsed: null },
  ];
  let next = list;
  for (let i = 0; i < MAX_RECENT + 5; i++) {
    const day = String(i + 1).padStart(2, '0');
    next = recordUse(next, `/p${i}`, at(`2026-01-${day}T00:00:00.000Z`));
  }
  const unpinned = next.filter((e) => !e.pinned);
  assertEquals(unpinned.length, MAX_RECENT);
  assertEquals(unpinned[0].localFolder, `/p${MAX_RECENT + 4}`);
  assertEquals(unpinned.some((e) => e.localFolder === '/p0'), false);
  assertEquals(next.some((e) => e.localFolder === '/pinned'), true);
});

Deno.test('setPinned pins, unpins, and adds an unknown folder only when pinning', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/a', pinned: false, lastUsed: '2026-01-01T00:00:00.000Z' },
  ];
  assertEquals(setPinned(list, '/a', true)[0].pinned, true);
  assertEquals(setPinned(list, '/new', true), [
    ...list,
    { localFolder: '/new', pinned: true, lastUsed: null },
  ]);
  assertEquals(setPinned(list, '/new', false), list);
});

Deno.test('forget drops the folder', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/a', pinned: true, lastUsed: null },
    { localFolder: '/b', pinned: false, lastUsed: null },
  ];
  assertEquals(forget(list, '/a'), [list[1]]);
  assertEquals(forget(list, '/x'), list);
});

Deno.test('loadProjects: missing, malformed and partly valid files', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, 'projects.json');
    assertEquals(await loadProjects(path), []);
    await Deno.writeTextFile(path, 'not json');
    assertEquals(await loadProjects(path), []);
    await Deno.writeTextFile(path, '{"projects": 3}');
    assertEquals(await loadProjects(path), []);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        projects: [
          { localFolder: '/a', pinned: true, lastUsed: null, extra: 1 },
          { localFolder: 'relative', pinned: false, lastUsed: null },
          { localFolder: '/b', pinned: 'yes', lastUsed: null },
          { localFolder: '/a', pinned: false, lastUsed: null },
          { localFolder: '/c', pinned: false, lastUsed: '2026-01-01' },
        ],
      }),
    );
    assertEquals(await loadProjects(path), [
      { localFolder: '/a', pinned: true, lastUsed: null },
      { localFolder: '/c', pinned: false, lastUsed: '2026-01-01' },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('updateProjects writes the file and creates its directory', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, 'nested', 'projects.json');
    await updateProjects((l) => setPinned(l, '/a', true), path);
    await updateProjects(
      (l) => recordUse(l, '/b', at('2026-01-01T00:00:00.000Z')),
      path,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      version: 1,
      projects: [
        {
          localFolder: '/b',
          pinned: false,
          lastUsed: '2026-01-01T00:00:00.000Z',
        },
        { localFolder: '/a', pinned: true, lastUsed: null },
      ],
    });
    const leftovers = [...Deno.readDirSync(join(dir, 'nested'))].map((e) =>
      e.name
    );
    assertEquals(leftovers, ['projects.json']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('environment round-trips through the file; an unknown value drops only the field', async () => {
  const dir = await Deno.makeTempDir();
  const path = join(dir, 'projects.json');
  try {
    await updateProjects(
      () => [
        {
          localFolder: '/h',
          pinned: true,
          lastUsed: null,
          environment: 'host',
        },
        { localFolder: '/c', pinned: false, lastUsed: null },
      ],
      path,
    );
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(raw.projects[0].environment, 'host');
    assertEquals('environment' in raw.projects[1], false);
    assertEquals(await loadProjects(path), [
      { localFolder: '/h', pinned: true, lastUsed: null, environment: 'host' },
      { localFolder: '/c', pinned: false, lastUsed: null },
    ]);
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        projects: [{
          localFolder: '/x',
          pinned: false,
          lastUsed: null,
          environment: 'ssh',
        }],
      }),
    );
    assertEquals(await loadProjects(path), [
      { localFolder: '/x', pinned: false, lastUsed: null },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('recordUse and setPinned keep environment; setEnvironment sets it or adds the folder', () => {
  const list: ProjectEntry[] = [
    { localFolder: '/h', pinned: false, lastUsed: null, environment: 'host' },
  ];
  assertEquals(
    recordUse(list, '/h', at('2026-02-01T00:00:00.000Z'))[0].environment,
    'host',
  );
  assertEquals(setPinned(list, '/h', true)[0], {
    localFolder: '/h',
    pinned: true,
    lastUsed: null,
    environment: 'host',
  });
  assertEquals(
    setEnvironment(list, '/h', 'container')[0].environment,
    'container',
  );
  assertEquals(setEnvironment(list, '/new', 'host')[1], {
    localFolder: '/new',
    pinned: false,
    lastUsed: null,
    environment: 'host',
  });
});
