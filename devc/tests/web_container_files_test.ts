import { assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type { ContainerInfo } from '@devc-tools/core/container.ts';
import {
  type DockerRun,
  listContainerDir,
  parseListing,
  readContainerFile,
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
