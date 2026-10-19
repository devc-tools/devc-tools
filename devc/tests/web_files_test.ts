import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { dirname, join } from 'jsr:@std/path';
import {
  confine,
  editorCommand,
  FilesError,
  listHostDir,
  listProjectDir,
  MAX_READ_BYTES,
  pickerRoots,
  readProjectFile,
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

Deno.test('listProjectDir lists a sibling repo root and confines paths to it', async () => {
  const { base } = await fixture();
  try {
    const lib = join(base, 'lib');
    await Deno.mkdir(join(lib, 'pkg'), { recursive: true });
    await Deno.writeTextFile(join(lib, 'pkg', 'b.ts'), 'y');
    const { path, entries } = await listProjectDir(lib, 'pkg');
    assertEquals(path, join(lib, 'pkg'));
    assertEquals(entries, [{ name: 'b.ts', kind: 'file', size: 1 }]);
    for (const rel of ['../project', '../outside', 'pkg/../../outside']) {
      const err = await assertRejects(
        () => listProjectDir(lib, rel),
        FilesError,
      );
      assertEquals(err.code, 'forbidden');
    }
    assertEquals(await confine(lib, '../project/README.md'), null);
    assertEquals(await confine(lib, 'pkg/b.ts'), join(lib, 'pkg/b.ts'));
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

Deno.test('editorCommand single-quotes the path and execs EDITOR, else micro, nano or vi', () => {
  assertEquals(
    editorCommand('/w/src/a.ts'),
    `exec "\${EDITOR:-\$(command -v micro || command -v nano || echo vi)}" -- '/w/src/a.ts'\n`,
  );
  assertEquals(
    editorCommand("/w/it's $(rm).txt"),
    `exec "\${EDITOR:-\$(command -v micro || command -v nano || echo vi)}" -- '/w/it'\\''s $(rm).txt'\n`,
  );
});

Deno.test('readProjectFile reads a file with its size and mtime', async () => {
  const { project } = await fixture();
  try {
    const got = await readProjectFile(project, 'README.md');
    assertEquals([got.text, got.size], ['hello', 5]);
    const info = await Deno.stat(join(project, 'README.md'));
    assertEquals(got.mtimeMs, info.mtime?.getTime());
  } finally {
    await Deno.remove(dirname(project), { recursive: true });
  }
});

Deno.test('readProjectFile refuses .., an escaping symlink, a directory and a missing file', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.symlink(
      join(base, 'outside', 'secret'),
      join(project, 'leak'),
    );
    const code = async (rel: string) =>
      (await assertRejects(() => readProjectFile(project, rel), FilesError))
        .code;
    assertEquals(await code('../outside/secret'), 'forbidden');
    assertEquals(await code('/etc/passwd'), 'forbidden');
    assertEquals(await code('leak'), 'forbidden');
    assertEquals(await code('src'), 'bad_request');
    assertEquals(await code('nope.txt'), 'not_found');
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('readProjectFile refuses a file just over the cap, reads one at it', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.writeFile(
      join(project, 'at'),
      new Uint8Array(MAX_READ_BYTES).fill(0x61),
    );
    await Deno.writeFile(
      join(project, 'over'),
      new Uint8Array(MAX_READ_BYTES + 1).fill(0x61),
    );
    assertEquals((await readProjectFile(project, 'at')).size, MAX_READ_BYTES);
    const err = await assertRejects(
      () => readProjectFile(project, 'over'),
      FilesError,
    );
    assertEquals(err.code, 'too_large');
    assertEquals(err.message.includes(String(MAX_READ_BYTES + 1)), true);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('readProjectFile calls a file with a NUL byte binary', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.writeFile(
      join(project, 'bin'),
      new Uint8Array([0x7f, 0x45, 0, 1]),
    );
    const err = await assertRejects(
      () => readProjectFile(project, 'bin'),
      FilesError,
    );
    assertEquals(err.code, 'binary');
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test('readProjectFile decodes invalid UTF-8 with replacement characters', async () => {
  const { base, project } = await fixture();
  try {
    await Deno.writeFile(
      join(project, 'latin1'),
      new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
    const got = await readProjectFile(project, 'latin1');
    assertEquals(got.text, 'caf�\n');
    assertEquals(got.size, 5);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
