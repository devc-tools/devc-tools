import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  confine,
  editorCommand,
  FilesError,
  listHostDir,
  listProjectDir,
  pickerRoots,
  sortEntries,
} from '../web/files.ts';

/** A temp dir holding `project/` (with `src/a.ts`, `README.md`) and `outside/secret`. */
async function fixture(): Promise<{ base: string; project: string }> {
  const base = await Deno.realPath(await Deno.makeTempDir());
  const project = join(base, 'project');
  await Deno.mkdir(join(project, 'src'), { recursive: true });
  await Deno.writeTextFile(join(project, 'src', 'a.ts'), 'x');
  await Deno.writeTextFile(join(project, 'README.md'), 'hello');
  await Deno.mkdir(join(base, 'outside'));
  await Deno.writeTextFile(join(base, 'outside', 'secret'), 's');
  return { base, project };
}

Deno.test('confine resolves the root itself and paths under it', async () => {
  const { base, project } = await fixture();
  try {
    assertEquals(await confine(project, ''), project);
    assertEquals(await confine(project, 'src/a.ts'), join(project, 'src/a.ts'));
    assertEquals(await confine(project, './src//'), join(project, 'src'));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('confine refuses absolute paths and ..', async () => {
  const { base, project } = await fixture();
  try {
    assertEquals(await confine(project, '/etc'), null);
    assertEquals(await confine(project, '../outside'), null);
    assertEquals(await confine(project, 'src/../../outside'), null);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('confine refuses a symlink out of the root, keeps one inside', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.symlink(join(base, 'outside'), join(project, 'out'));
    await Deno.symlink('src', join(project, 'in'));
    assertEquals(await confine(project, 'out'), null);
    assertEquals(await confine(project, 'out/secret'), null);
    assertEquals(await confine(project, 'in/a.ts'), join(project, 'in/a.ts'));
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('confine throws NotFound for a missing path', async () => {
  const { base, project } = await fixture();
  try {
    await assertRejects(() => confine(project, 'nope'), Deno.errors.NotFound);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('sortEntries puts dirs and links to dirs first, then by name', () => {
  assertEquals(
    sortEntries([
      { name: 'b.txt', kind: 'file' },
      { name: 'Zed', kind: 'dir' },
      { name: 'a.txt', kind: 'file' },
      { name: 'lib', kind: 'symlink', to: 'dir' },
      { name: 'apple', kind: 'dir' },
      { name: 'broken', kind: 'symlink' },
    ]).map((e) => e.name),
    ['apple', 'lib', 'Zed', 'a.txt', 'b.txt', 'broken'],
  );
});

Deno.test('listProjectDir lists, describes and confines', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.symlink('src', join(project, 'in'));
    await Deno.symlink(join(base, 'outside'), join(project, 'out'));
    const { path, entries, truncated } = await listProjectDir(project, '');
    assertEquals([path, truncated], [project, false]);
    assertEquals(entries, [
      { name: 'in', kind: 'symlink', to: 'dir' },
      { name: 'out', kind: 'symlink', to: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: 'README.md', kind: 'file', size: 5 },
    ]);
    const err = await assertRejects(
      () => listProjectDir(project, 'out'),
      FilesError,
    );
    assertEquals(err.code, 'forbidden');
    const missing = await assertRejects(
      () => listProjectDir(project, 'nope'),
      FilesError,
    );
    assertEquals(missing.code, 'not_found');
    const file = await assertRejects(
      () => listProjectDir(project, 'README.md'),
      FilesError,
    );
    assertEquals(file.code, 'not_found');
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('pickerRoots keeps existing code roots, else home', async () => {
  const { base, project } = await fixture();
  try {
    assertEquals(
      await pickerRoots([project, join(base, 'gone'), project], '/home/x'),
      [project],
    );
    assertEquals(await pickerRoots([join(base, 'gone')], '/home/x'), [
      '/home/x',
    ]);
    assertEquals(await pickerRoots([], '/home/x'), ['/home/x']);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('listHostDir lists directories only and marks projects', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.mkdir(join(base, 'withdc', '.devcontainer'), {
      recursive: true,
    });
    await Deno.mkdir(join(base, 'withjson'));
    await Deno.writeTextFile(
      join(base, 'withjson', '.devcontainer.json'),
      '{}',
    );
    await Deno.writeTextFile(join(base, 'file.txt'), '');
    const listing = await listHostDir(base, new Set([project]));
    assertEquals(listing.path, base);
    assertEquals(listing.parent, join(base, '..').replace(/\/$/, ''));
    assertEquals(
      listing.entries.map((e) => [e.name, e.project]),
      [['outside', false], ['project', true], ['withdc', true], [
        'withjson',
        true,
      ]],
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('listHostDir refuses relative paths and .., and has no parent at /', async () => {
  for (const path of ['relative/dir', '/tmp/../etc']) {
    const err = await assertRejects(
      () => listHostDir(path, new Set()),
      FilesError,
    );
    assertEquals(err.code, 'bad_request');
  }
  assertEquals((await listHostDir('/', new Set())).parent, null);
});

Deno.test('editorCommand single-quotes the path and execs the editor', () => {
  assertEquals(
    editorCommand('/w/src/a.ts'),
    `exec "\${EDITOR:-vi}" -- '/w/src/a.ts'\n`,
  );
  assertEquals(
    editorCommand("/w/it's $(rm).txt"),
    `exec "\${EDITOR:-vi}" -- '/w/it'\\''s $(rm).txt'\n`,
  );
});
