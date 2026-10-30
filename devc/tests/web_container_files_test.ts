import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type {
  ContainerInfo,
  ContainerMount,
} from '@devc-tools/core/container.ts';
import {
  containerHome,
  createArgv,
  createContainerEntry,
  createError,
  deleteArgv,
  deleteContainerEntry,
  listContainerDir,
  parseListing,
  readContainerFile,
  renameArgv,
  renameContainerEntry,
  withHostPaths,
  writeArgv,
  writeContainerFile,
  writeContainerImage,
  writeContainerText,
  writeImageArgv,
} from '../web/container_files.ts';
import { contentHash, FilesError, MAX_READ_BYTES } from '../web/files.ts';
import {
  ContainerEnvironment,
  type DockerRun,
  type DockerRunInput,
} from '../web/containers.ts';

const info: ContainerInfo = {
  containerId: 'c0ffee',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/app',
  remoteEnv: { LANG: 'C.UTF-8' },
};

/** The container `info` reaches, its docker runs stubbed. */
function envOf(run?: DockerRun, runInput?: DockerRunInput) {
  return new ContainerEnvironment(
    { id: info.containerId, localFolder: '/src/app' },
    'devc',
    {
      resolve: () => Promise.resolve(info),
      ...(run ? { run } : {}),
      ...(runInput ? { runInput } : {}),
    },
  );
}

/**
 * Runs what would follow `docker exec … <container>` here instead, so the real `find` and `sh`
 * commands are exercised. Records each docker argv.
 */
function localRun(calls: string[][] = [], cwd?: string): DockerRun {
  return async (args) => {
    calls.push(args);
    const cmd = args.slice(args.indexOf(info.containerId) + 1);
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    return {
      code: out.code,
      stdout: out.stdout,
      stderr: new TextDecoder().decode(out.stderr),
    };
  };
}

/** A temp dir with a folder, files (one with a newline in its name), and good and broken links. */
async function fixture(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  await Deno.mkdir(join(dir, 'src'));
  await Deno.writeTextFile(join(dir, 'a.txt'), 'hello');
  await Deno.writeTextFile(join(dir, 'odd\nname'), '');
  await Deno.symlink(join(dir, 'src'), join(dir, 'to-dir'));
  await Deno.symlink(join(dir, 'a.txt'), join(dir, 'to-file'));
  await Deno.symlink(join(dir, 'gone'), join(dir, 'broken'));
  return dir;
}

Deno.test('listContainerDir lists one directory as the remote user, dirs first', async () => {
  const dir = await fixture();
  try {
    const calls: string[][] = [];
    const result = await listContainerDir(envOf(localRun(calls)), dir);
    assertEquals(result, {
      truncated: false,
      entries: [
        { name: 'src', kind: 'dir' },
        { name: 'to-dir', kind: 'symlink', to: 'dir' },
        { name: 'a.txt', kind: 'file', size: 5 },
        { name: 'broken', kind: 'symlink' },
        { name: 'odd\nname', kind: 'file', size: 0 },
        { name: 'to-file', kind: 'symlink', to: 'file' },
      ],
    });
    const args = calls[0];
    assertEquals(args.slice(0, 2), ['exec', '-e']);
    assertEquals(args.slice(args.indexOf('-u'), args.indexOf('-u') + 4), [
      '-u',
      'vscode',
      '-w',
      '/',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('listContainerDir follows a linked directory it is asked for', async () => {
  const dir = await fixture();
  try {
    const { entries } = await listContainerDir(
      envOf(localRun()),
      join(dir, 'to-dir'),
    );
    assertEquals(entries, []);
    await Deno.writeTextFile(join(dir, 'src', 'b.ts'), 'x');
    assertEquals(
      (await listContainerDir(envOf(localRun()), join(dir, 'to-dir'))).entries,
      [{ name: 'b.ts', kind: 'file', size: 1 }],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('listContainerDir names a missing directory', async () => {
  const dir = await fixture();
  try {
    const e = await assertRejects(
      () => listContainerDir(envOf(localRun()), join(dir, 'nope')),
      FilesError,
    );
    assertEquals(e.code, 'not_found');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('listContainerDir passes on an unrecognised failure with its stderr', async () => {
  const run: DockerRun = () =>
    Promise.resolve({
      code: 1,
      stdout: new Uint8Array(),
      stderr: 'find: unrecognized: -printf\n',
    });
  await assertRejects(
    () => listContainerDir(envOf(run), '/'),
    Error,
    'find: unrecognized: -printf',
  );
});

Deno.test('parseListing keeps sockets and devices as files that do not open', () => {
  const out = new TextEncoder().encode('s\0s\x000\0sock\0c\0c\x000\0null\0');
  assertEquals(parseListing(out), [
    { name: 'sock', kind: 'file' },
    { name: 'null', kind: 'file' },
  ]);
});

/** `sha256sum` of `hello`. */
const HELLO_HASH =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

Deno.test('readContainerFile reads a file, through a link too', async () => {
  const dir = await fixture();
  try {
    assertEquals(
      await readContainerFile(envOf(localRun()), join(dir, 'a.txt')),
      { text: 'hello', size: 5, hash: HELLO_HASH },
    );
    assertEquals(
      await readContainerFile(envOf(localRun()), join(dir, 'to-file')),
      { text: 'hello', size: 5, hash: HELLO_HASH },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readContainerFile refuses missing, non-file, large and binary files', async () => {
  const dir = await fixture();
  try {
    await Deno.writeFile(
      join(dir, 'big'),
      new Uint8Array(MAX_READ_BYTES + 1).fill(97),
    );
    await Deno.writeFile(join(dir, 'bin'), new Uint8Array([1, 0, 2]));
    const cases: [string, string][] = [
      ['nope', 'not_found'],
      ['broken', 'not_found'],
      ['src', 'bad_request'],
      ['big', 'too_large'],
      ['bin', 'binary'],
    ];
    for (const [name, code] of cases) {
      const e = await assertRejects(
        () => readContainerFile(envOf(localRun()), join(dir, name)),
        FilesError,
      );
      assertEquals(e.code, code, name);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('readContainerFile passes a path to the script as an argument, never as script', async () => {
  const dir = await fixture();
  try {
    const name = `$(touch pwned)'"; x`;
    await Deno.writeTextFile(join(dir, name), 'ok');
    assertEquals(
      await readContainerFile(envOf(localRun([], dir)), join(dir, name)),
      {
        text: 'ok',
        size: 2,
        hash: await contentHash(new TextEncoder().encode('ok')),
      },
    );
    assertEquals(
      await Deno.stat(join(dir, 'pwned')).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('createArgv: a noclobber file or a plain mkdir, the path an argument', () => {
  const path = `/w/$(touch pwned)'"; x`;
  assertEquals(createArgv(path, 'file'), [
    'sh',
    '-c',
    'set -C; : > "$1"',
    'sh',
    path,
  ]);
  assertEquals(createArgv(path, 'dir'), ['mkdir', '--', path]);
});

Deno.test('createContainerEntry creates a file and a folder as the remote user', async () => {
  const dir = await fixture();
  try {
    const calls: string[][] = [];
    const file = join(dir, 'src', 'new.ts');
    assertEquals(
      await createContainerEntry(envOf(localRun(calls)), file, 'file'),
      { path: file },
    );
    assertEquals(await Deno.readTextFile(file), '');
    const args = calls[0];
    assertEquals(args.slice(args.indexOf('-u'), args.indexOf('-u') + 2), [
      '-u',
      'vscode',
    ]);
    const sub = join(dir, 'src', 'sub');
    assertEquals(
      await createContainerEntry(envOf(localRun()), sub, 'dir'),
      { path: sub },
    );
    assertEquals((await Deno.stat(sub)).isDirectory, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('createContainerEntry never replaces what is there', async () => {
  const dir = await fixture();
  try {
    for (
      const [name, kind] of [
        ['a.txt', 'file'],
        ['src', 'file'],
        ['to-file', 'file'],
        ['broken', 'file'],
        ['a.txt', 'dir'],
        ['src', 'dir'],
      ] as const
    ) {
      const e = await assertRejects(
        () => createContainerEntry(envOf(localRun()), join(dir, name), kind),
        FilesError,
      );
      assertEquals(e.code, 'exists', `${kind} ${name}`);
    }
    assertEquals(await Deno.readTextFile(join(dir, 'a.txt')), 'hello');
    assertEquals(
      await Deno.lstat(join(dir, 'gone')).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('createContainerEntry names a missing or unwritable folder', async () => {
  const dir = await fixture();
  try {
    for (const kind of ['file', 'dir'] as const) {
      for (const path of [join(dir, 'nope', 'x'), join(dir, 'a.txt', 'x')]) {
        const e = await assertRejects(
          () => createContainerEntry(envOf(localRun()), path, kind),
          FilesError,
        );
        assertEquals(e.code, 'not_found', `${kind} ${path}`);
      }
    }
    await Deno.chmod(join(dir, 'src'), 0o555);
    // Root writes through a read-only folder: nothing to check then.
    const writable = await Deno.writeTextFile(join(dir, 'src', 'probe'), '')
      .then(() => true, () => false);
    for (const kind of writable ? [] : ['file', 'dir'] as const) {
      const e = await assertRejects(
        () =>
          createContainerEntry(envOf(localRun()), join(dir, 'src', 'x'), kind),
        FilesError,
      );
      assertEquals(e.code, 'forbidden', kind);
    }
    await Deno.chmod(join(dir, 'src'), 0o755);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('createError maps docker and shell failures to codes', () => {
  const err = (stderr: string, code = 1) =>
    createError('/w/x', { code, stdout: new Uint8Array(), stderr });
  const codeOf = (e: Error) => e instanceof FilesError ? e.code : e.message;
  assertEquals(
    codeOf(err('sh: 1: cannot create /w/x: File exists\n')),
    'exists',
  );
  assertEquals(
    codeOf(err('sh: line 1: /w/x: cannot overwrite existing file\n')),
    'exists',
  );
  assertEquals(
    codeOf(err("mkdir: cannot create directory '/w/x': File exists\n")),
    'exists',
  );
  assertEquals(
    codeOf(err('sh: 1: cannot create /w/x: Is a directory\n', 2)),
    'exists',
  );
  assertEquals(
    codeOf(err('sh: 1: cannot create /w/x: Directory nonexistent\n', 2)),
    'not_found',
  );
  assertEquals(
    codeOf(
      err("mkdir: cannot create directory '/w/x': No such file or directory\n"),
    ),
    'not_found',
  );
  assertEquals(
    codeOf(err('sh: 1: cannot create /w/x: Permission denied\n', 2)),
    'forbidden',
  );
  assertEquals(
    codeOf(
      err('Error response from daemon: container c0ffee is not running\n'),
    ),
    'not_running',
  );
  assertEquals(
    codeOf(err('Error response from daemon: No such container: c0ffee\n')),
    'not_running',
  );
  assertEquals(codeOf(err('something else\n')), 'something else');
  assertEquals(codeOf(err('')), 'creating failed');
});

Deno.test('renameArgv and deleteArgv: the paths are arguments, never script', () => {
  const from = `/w/$(touch pwned)'"; x`;
  const to = '/w/b; rm -rf /';
  const argv = renameArgv(from, to);
  assertEquals(argv.slice(-2), [from, to]);
  assertEquals(argv[2].includes(from) || argv[2].includes(to), false);
  assertEquals(deleteArgv(from), ['rm', '-r', '--', from]);
});

Deno.test('renameContainerEntry renames a file, a folder and a link itself', async () => {
  const dir = await fixture();
  try {
    assertEquals(
      await renameContainerEntry(
        envOf(localRun()),
        join(dir, 'a.txt'),
        join(dir, 'b.txt'),
      ),
      { path: join(dir, 'b.txt') },
    );
    assertEquals(await Deno.readTextFile(join(dir, 'b.txt')), 'hello');
    await renameContainerEntry(
      envOf(localRun()),
      join(dir, 'src'),
      join(dir, 'lib'),
    );
    assertEquals((await Deno.stat(join(dir, 'lib'))).isDirectory, true);
    await renameContainerEntry(
      envOf(localRun()),
      join(dir, 'broken'),
      join(dir, 'still-broken'),
    );
    assertEquals(
      (await Deno.lstat(join(dir, 'still-broken'))).isSymlink,
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('renameContainerEntry never replaces what is there', async () => {
  const dir = await fixture();
  try {
    for (const to of ['src', 'to-file', 'broken']) {
      const e = await assertRejects(
        () =>
          renameContainerEntry(
            envOf(localRun()),
            join(dir, 'a.txt'),
            join(dir, to),
          ),
        FilesError,
      );
      assertEquals(e.code, 'exists', to);
    }
    assertEquals(await Deno.readTextFile(join(dir, 'a.txt')), 'hello');
    const gone = await assertRejects(
      () =>
        renameContainerEntry(
          envOf(localRun()),
          join(dir, 'nope'),
          join(dir, 'x'),
        ),
      FilesError,
    );
    assertEquals(gone.code, 'not_found');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('deleteContainerEntry deletes a file, a link (not its target) and a folder', async () => {
  const dir = await fixture();
  try {
    await Deno.writeTextFile(join(dir, 'src', 'inner.ts'), '');
    assertEquals(
      await deleteContainerEntry(envOf(localRun()), join(dir, 'to-dir')),
      {},
    );
    assertEquals((await Deno.stat(join(dir, 'src', 'inner.ts'))).isFile, true);
    await deleteContainerEntry(envOf(localRun()), join(dir, 'a.txt'));
    await deleteContainerEntry(envOf(localRun()), join(dir, 'src'));
    for (const name of ['to-dir', 'a.txt', 'src']) {
      assertEquals(
        await Deno.lstat(join(dir, name)).then(() => true, () => false),
        false,
        name,
      );
    }
    const e = await assertRejects(
      () => deleteContainerEntry(envOf(localRun()), join(dir, 'nope')),
      FilesError,
    );
    assertEquals(e.code, 'not_found');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerFile pipes the text to sh as the remote user, making the folder', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const calls: string[][] = [];
    const sub = join(dir, 'devc-tasks');
    const file = join(sub, "it's.md");
    await writeContainerFile(
      envOf(undefined, async (args, input) => {
        calls.push(args);
        const cmd = args.slice(args.indexOf(info.containerId) + 1);
        const child = new Deno.Command(cmd[0], {
          args: cmd.slice(1),
          stdin: 'piped',
          stdout: 'piped',
          stderr: 'piped',
        }).spawn();
        const w = child.stdin.getWriter();
        await w.write(input);
        await w.close();
        const out = await child.output();
        return {
          code: out.code,
          stdout: out.stdout,
          stderr: new TextDecoder().decode(out.stderr),
        };
      }),
      sub,
      file,
      'Fix $(rm -rf /) `now`\n',
    );
    assertEquals(await Deno.readTextFile(file), 'Fix $(rm -rf /) `now`\n');
    const args = calls[0];
    assertEquals(args[1], '-i');
    assertEquals(args.slice(args.indexOf(info.containerId) + 1), [
      ...writeArgv(sub, file),
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerFile: a stopped container is not_running', async () => {
  const err = await assertRejects(
    () =>
      writeContainerFile(
        envOf(undefined, () =>
          Promise.resolve({
            code: 1,
            stdout: new Uint8Array(),
            stderr:
              'Error response from daemon: container c0ffee is not running',
          })),
        '/tmp/x',
        '/tmp/x/a.md',
        'a',
      ),
    FilesError,
  );
  assertEquals(err.code, 'not_running');
});

Deno.test('containerHome reads $HOME as the remote user, an absolute path or null', async () => {
  const fake =
    (code: number, stdout: string, calls: string[][] = []): DockerRun =>
    async (args) => {
      calls.push(args);
      return { code, stdout: new TextEncoder().encode(stdout), stderr: '' };
    };
  const calls: string[][] = [];
  assertEquals(
    await containerHome(envOf(fake(0, '/home/vscode', calls))),
    '/home/vscode',
  );
  assertEquals(calls[0].slice(-8), [
    '-u',
    'vscode',
    '-w',
    '/',
    'c0ffee',
    'sh',
    '-c',
    'printf %s "$HOME"',
  ]);
  assertEquals(await containerHome(envOf(fake(0, '/root'))), '/root');
  assertEquals(await containerHome(envOf(fake(1, '/home/vscode'))), null);
  assertEquals(await containerHome(envOf(fake(0, ''))), null);
  assertEquals(await containerHome(envOf(fake(0, 'home/vscode'))), null);
  assertEquals(await containerHome(envOf(fake(0, '/a\n/b'))), null);
  assertEquals(
    await containerHome(envOf(() => Promise.reject(new Error('no docker')))),
    null,
  );
});

Deno.test("withHostPaths: the folder's host path, else each mounted entry's", () => {
  const mounts: ContainerMount[] = [
    {
      type: 'bind',
      source: '/Users/me/code/app',
      destination: '/workspaces/app',
      rw: true,
    },
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/x/_data',
      destination: '/workspaces/cache',
      rw: true,
    },
  ];
  const entry = (name: string) => ({ name, kind: 'dir' as const });
  const listing = (...names: string[]) => ({
    entries: names.map(entry),
    truncated: false,
  });
  assertEquals(
    withHostPaths(listing('src'), '/workspaces/app', mounts),
    { ...listing('src'), hostPath: '/Users/me/code/app' },
  );
  assertEquals(
    withHostPaths(listing('src'), '/workspaces/app/src', mounts),
    { ...listing('src'), hostPath: '/Users/me/code/app/src' },
  );
  assertEquals(
    withHostPaths(listing('app', 'cache', 'x'), '/workspaces', mounts),
    { ...listing('app', 'cache', 'x'), mounted: { app: '/Users/me/code/app' } },
  );
  assertEquals(
    withHostPaths(listing('workspaces', 'etc'), '/', mounts),
    listing('workspaces', 'etc'),
  );
});

/** Runs what follows `docker exec … <container>` here, with `input` on its stdin. */
async function localRunInput(args: string[], input: Uint8Array) {
  const cmd = args.slice(args.indexOf(info.containerId) + 1);
  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(input);
  await w.close();
  const out = await child.output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test('readContainerFile: hash is the SHA-256 of the bytes read', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const file = join(dir, 'a.txt');
    await Deno.writeTextFile(file, 'héllo\r\n');
    const read = await readContainerFile(envOf(localRun()), file);
    assertEquals(read.text, 'héllo\r\n');
    assertEquals(
      read.hash,
      await contentHash(new TextEncoder().encode('héllo\r\n')),
    );
    assertEquals(read.hash.length, 64);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerText saves in place when the file still has the read hash', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const file = join(dir, "it's.txt");
    await Deno.writeTextFile(file, 'old\n');
    await Deno.chmod(file, 0o640);
    const ino = (await Deno.stat(file)).ino;
    const { hash } = await readContainerFile(envOf(localRun()), file);
    const result = await writeContainerText(
      envOf(localRun(), localRunInput),
      file,
      'new $(x) `y`\n',
      hash,
    );
    assertEquals(await Deno.readTextFile(file), 'new $(x) `y`\n');
    assertEquals(result, {
      hash: await contentHash(new TextEncoder().encode('new $(x) `y`\n')),
      size: 13,
    });
    const after = await Deno.stat(file);
    assertEquals(after.ino, ino);
    assertEquals(after.mode! & 0o777, 0o640);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerText: a file changed since it was read is a conflict, and kept', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const file = join(dir, 'a.txt');
    await Deno.writeTextFile(file, 'one\n');
    const { hash } = await readContainerFile(envOf(localRun()), file);
    await Deno.writeTextFile(file, 'two\n');
    const e = await assertRejects(
      () =>
        writeContainerText(
          envOf(localRun(), localRunInput),
          file,
          'mine\n',
          hash,
        ),
      FilesError,
    );
    assertEquals(e.code, 'conflict');
    assertEquals(await Deno.readTextFile(file), 'two\n');
    // No base: overwritten as asked.
    await writeContainerText(
      envOf(localRun(), localRunInput),
      file,
      'mine\n',
      undefined,
    );
    assertEquals(await Deno.readTextFile(file), 'mine\n');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerText: a deleted file is a conflict', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const file = join(dir, 'gone.txt');
    const e = await assertRejects(
      () =>
        writeContainerText(
          envOf(localRun(), localRunInput),
          file,
          'x',
          '0'.repeat(64),
        ),
      FilesError,
    );
    assertEquals(e.code, 'conflict');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerText: too large, and a stopped container', async () => {
  const big = await assertRejects(
    () =>
      writeContainerText(
        envOf(),
        '/tmp/a',
        'x'.repeat(MAX_READ_BYTES + 1),
        undefined,
      ),
    FilesError,
  );
  assertEquals(big.code, 'too_large');
  const stopped = await assertRejects(
    () =>
      writeContainerText(
        envOf(localRun(), () =>
          Promise.resolve({
            code: 1,
            stdout: new Uint8Array(),
            stderr:
              'Error response from daemon: container c0ffee is not running',
          })),
        '/tmp/a',
        'a',
        undefined,
      ),
    FilesError,
  );
  assertEquals(stopped.code, 'not_running');
});

Deno.test('writeContainerImage writes a private file in a private folder and prunes old images', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const images = join(dir, '.cache', 'devc', 'images');
    await Deno.mkdir(images, { recursive: true });
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const stale = join(images, 'paste-20261020-101010-aaaaaa.png');
    const fresh = join(images, 'drop-20261023-101010-bbbbbb.png');
    const notOurs = join(images, 'notes.png');
    for (
      const [path, at] of [[stale, old], [fresh, recent], [
        notOurs,
        old,
      ]] as const
    ) {
      await Deno.writeFile(path, new Uint8Array([1]));
      await Deno.utime(path, at, at);
    }
    const calls: string[][] = [];
    const file = join(images, 'paste-20261029-150405-a1b2c3.png');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    await writeContainerImage(
      envOf(undefined, (args, input) => {
        calls.push(args);
        return localRunInput(args, input);
      }),
      images,
      file,
      png,
    );
    assertEquals(await Deno.readFile(file), png);
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(images)).mode! & 0o777, 0o700);
    assertEquals(
      [stale, fresh, notOurs].map((p) => {
        try {
          Deno.statSync(p);
          return true;
        } catch {
          return false;
        }
      }),
      [false, true, true],
    );
    // The paths ride in as arguments, never inside the script.
    const args = calls[0];
    assertEquals(args.slice(args.indexOf(info.containerId) + 1), [
      ...writeImageArgv(images, file),
    ]);
    const argv = writeImageArgv('/d/$(x)', "/d/it's.png");
    assertEquals(argv.slice(-2), ['/d/$(x)', "/d/it's.png"]);
    assert(!argv[2].includes('/d/'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('writeContainerImage: permission denied is forbidden, a stopped container not_running', async () => {
  for (
    const [stderr, code] of [
      ["sh: can't create /x/a.png: Permission denied", 'forbidden'],
      [
        'Error response from daemon: container c0ffee is not running',
        'not_running',
      ],
    ]
  ) {
    const err = await assertRejects(
      () =>
        writeContainerImage(
          envOf(undefined, () =>
            Promise.resolve({ code: 1, stdout: new Uint8Array(), stderr })),
          '/x',
          '/x/a.png',
          new Uint8Array([1]),
        ),
      FilesError,
    );
    assertEquals(err.code, code);
  }
});
