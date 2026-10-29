import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  addProject,
  loadProjects,
  type ProjectEntry,
  removeProject,
  setEnvironment,
  updateProjects,
} from '../projects.ts';

Deno.test('addProject adds a new folder at the end and leaves a listed one alone', () => {
  const list: ProjectEntry[] = [{ localFolder: '/a', environment: 'host' }];
  assertEquals(addProject(list, '/b'), [...list, { localFolder: '/b' }]);
  assertEquals(addProject(list, '/a'), list);
});

Deno.test('addProject with an environment sets it, on a new or a listed folder', () => {
  const list: ProjectEntry[] = [{ localFolder: '/a' }];
  assertEquals(addProject(list, '/b', 'host'), [
    { localFolder: '/a' },
    { localFolder: '/b', environment: 'host' },
  ]);
  assertEquals(addProject(list, '/a', 'container'), [
    { localFolder: '/a', environment: 'container' },
  ]);
});

Deno.test('removeProject drops the folder', () => {
  const list: ProjectEntry[] = [{ localFolder: '/a' }, { localFolder: '/b' }];
  assertEquals(removeProject(list, '/a'), [list[1]]);
  assertEquals(removeProject(list, '/x'), list);
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
          // An older devc's entries: pinned or not, every one is kept.
          { localFolder: '/a', pinned: true, lastUsed: null, extra: 1 },
          { localFolder: 'relative', pinned: false, lastUsed: null },
          { localFolder: 3 },
          { localFolder: '/a', pinned: false, lastUsed: null },
          { localFolder: '/c', pinned: false, lastUsed: '2026-01-01' },
          { localFolder: '/d' },
        ],
      }),
    );
    assertEquals(await loadProjects(path), [
      { localFolder: '/a' },
      { localFolder: '/c' },
      { localFolder: '/d' },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('updateProjects writes the file, with the fields an older devc needs', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, 'nested', 'projects.json');
    await updateProjects((l) => addProject(l, '/a'), path);
    await updateProjects((l) => addProject(l, '/b', 'host'), path);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      version: 1,
      projects: [
        { localFolder: '/a', pinned: true, lastUsed: null },
        {
          localFolder: '/b',
          pinned: true,
          lastUsed: null,
          environment: 'host',
        },
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
      () => [{ localFolder: '/h', environment: 'host' }, { localFolder: '/c' }],
      path,
    );
    const raw = JSON.parse(await Deno.readTextFile(path));
    assertEquals(raw.projects[0].environment, 'host');
    assertEquals('environment' in raw.projects[1], false);
    assertEquals(await loadProjects(path), [
      { localFolder: '/h', environment: 'host' },
      { localFolder: '/c' },
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
    assertEquals(await loadProjects(path), [{ localFolder: '/x' }]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('addProject keeps environment; setEnvironment sets it or adds the folder', () => {
  const list: ProjectEntry[] = [{ localFolder: '/h', environment: 'host' }];
  assertEquals(addProject(list, '/h'), list);
  assertEquals(
    setEnvironment(list, '/h', 'container')[0].environment,
    'container',
  );
  assertEquals(setEnvironment(list, '/new', 'host')[1], {
    localFolder: '/new',
    environment: 'host',
  });
});
