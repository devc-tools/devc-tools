import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type { ContainerInfo } from '@devc-tools/core/container.ts';
import {
  createArgv,
  createContainerEntry,
  createError,
  deleteArgv,
  deleteContainerEntry,
  type DockerRun,
  listContainerDir,
  parseListing,
  readContainerFile,
  renameArgv,
  renameContainerEntry,
  writeArgv,
  writeContainerFile,
} from '../web/container_files.ts';
import { FilesError, MAX_READ_BYTES } from '../web/files.ts';

const info: ContainerInfo = {
  containerId: 'c0ffee',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/app',
  remoteEnv: { LANG: 'C.UTF-8' },
};

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
    const result = await listContainerDir(info, dir, localRun(calls));
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
      info,
      join(dir, 'to-dir'),
      localRun(),
    );
    assertEquals(entries, []);
    await Deno.writeTextFile(join(dir, 'src', 'b.ts'), 'x');
    assertEquals(
      (await listContainerDir(info, join(dir, 'to-dir'), localRun())).entries,
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
      () => listContainerDir(info, join(dir, 'nope'), localRun()),
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
    () => listContainerDir(info, '/', run),
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

Deno.test('readContainerFile reads a file, through a link too', async () => {
  const dir = await fixture();
  try {
    assertEquals(
      await readContainerFile(info, join(dir, 'a.txt'), localRun()),
      { text: 'hello', size: 5 },
    );
    assertEquals(
      await readContainerFile(info, join(dir, 'to-file'), localRun()),
      { text: 'hello', size: 5 },
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
        () => readContainerFile(info, join(dir, name), localRun()),
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
      await readContainerFile(info, join(dir, name), localRun([], dir)),
      { text: 'ok', size: 2 },
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
      await createContainerEntry(info, file, 'file', localRun(calls)),
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
      await createContainerEntry(info, sub, 'dir', localRun()),
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
        () => createContainerEntry(info, join(dir, name), kind, localRun()),
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
          () => createContainerEntry(info, path, kind, localRun()),
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
          createContainerEntry(info, join(dir, 'src', 'x'), kind, localRun()),
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
        info,
        join(dir, 'a.txt'),
        join(dir, 'b.txt'),
        localRun(),
      ),
      { path: join(dir, 'b.txt') },
    );
    assertEquals(await Deno.readTextFile(join(dir, 'b.txt')), 'hello');
    await renameContainerEntry(
      info,
      join(dir, 'src'),
      join(dir, 'lib'),
      localRun(),
    );
    assertEquals((await Deno.stat(join(dir, 'lib'))).isDirectory, true);
    await renameContainerEntry(
      info,
      join(dir, 'broken'),
      join(dir, 'still-broken'),
      localRun(),
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
            info,
            join(dir, 'a.txt'),
            join(dir, to),
            localRun(),
          ),
        FilesError,
      );
      assertEquals(e.code, 'exists', to);
    }
    assertEquals(await Deno.readTextFile(join(dir, 'a.txt')), 'hello');
    const gone = await assertRejects(
      () =>
        renameContainerEntry(
          info,
          join(dir, 'nope'),
          join(dir, 'x'),
          localRun(),
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
      await deleteContainerEntry(info, join(dir, 'to-dir'), localRun()),
      {},
    );
    assertEquals((await Deno.stat(join(dir, 'src', 'inner.ts'))).isFile, true);
    await deleteContainerEntry(info, join(dir, 'a.txt'), localRun());
    await deleteContainerEntry(info, join(dir, 'src'), localRun());
    for (const name of ['to-dir', 'a.txt', 'src']) {
      assertEquals(
        await Deno.lstat(join(dir, name)).then(() => true, () => false),
        false,
        name,
      );
    }
    const e = await assertRejects(
      () => deleteContainerEntry(info, join(dir, 'nope'), localRun()),
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
      info,
      sub,
      file,
      'Fix $(rm -rf /) `now`\n',
      async (args, input) => {
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
      },
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
        info,
        '/tmp/x',
        '/tmp/x/a.md',
        'a',
        () =>
          Promise.resolve({
            code: 1,
            stdout: new Uint8Array(),
            stderr:
              'Error response from daemon: container c0ffee is not running',
          }),
      ),
    FilesError,
  );
  assertEquals(err.code, 'not_running');
});
