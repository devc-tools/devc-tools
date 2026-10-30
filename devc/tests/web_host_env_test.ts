import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import { hostEnvironmentId, hostSessionName } from '../web/environment.ts';
import {
  hostFiles,
  loginShellFor,
  parseProbe,
  parseSessionList,
  parseWorktreeList,
} from '../web/env_host.ts';
import { contentHash, FilesError } from '../web/files.ts';
import {
  parseRunningOutput,
  parseSessionsOutput,
  RUNNING_PROBE,
  SESSIONS_SCRIPT,
  sessionsArgs,
} from '../web/sessions.ts';
import { parseClientMessage } from '../web/protocol.ts';

const U1 = '11111111-1111-4111-8111-111111111111';

Deno.test('host environment id and session name: stable, per folder, slugged', () => {
  const id = hostEnvironmentId('/home/me/src/My App!');
  assert(/^host-[0-9a-f]{16}$/.test(id));
  assertEquals(hostEnvironmentId('/home/me/src/My App!'), id);
  assert(hostEnvironmentId('/home/me/src/other') !== id);

  const name = hostSessionName('devc', '/home/me/src/My App!');
  assert(/^devc-my-app-[0-9a-f]{8}$/.test(name), name);
  assertEquals(name.slice(-8), id.slice(5, 13));
  assertEquals(hostSessionName('devc', '/home/me/src/My App!'), name);

  // An empty slug drops its segment.
  assert(/^devc-[0-9a-f]{8}$/.test(hostSessionName('devc', '/')));
  assert(/^x-[0-9a-f]{8}$/.test(hostSessionName('x', '/src/!!!')));

  // A long basename: at most 24 chars, no trailing `-`.
  const long = hostSessionName('devc', `/src/${'abcdefghi-'.repeat(4)}`);
  const slug = long.slice('devc-'.length, -9);
  assert(slug.length <= 24 && !slug.endsWith('-'), slug);
  assertEquals(slug, 'abcdefghi-abcdefghi-abcd');
  const cut = hostSessionName('devc', `/src/${'a'.repeat(23)}-b`);
  assertEquals(cut.slice('devc-'.length, -9), 'a'.repeat(23));
});

Deno.test('parseSessionList: running, stopped, missing; malformed is null', () => {
  const list = parseSessionList(JSON.stringify({
    sessions: [
      {
        default: true,
        name: 'default',
        running: false,
        session_dir: '/h/.config/herdr',
      },
      {
        name: 'devc-app-1a2b3c4d',
        running: true,
        session_dir: '/h/.config/herdr/sessions/devc-app-1a2b3c4d',
      },
      { name: 'bad', running: 'yes' },
    ],
  }));
  assert(list !== null);
  assertEquals(list.get('devc-app-1a2b3c4d'), {
    name: 'devc-app-1a2b3c4d',
    running: true,
    sessionDir: '/h/.config/herdr/sessions/devc-app-1a2b3c4d',
  });
  assertEquals(list.get('default')?.running, false);
  assertEquals(list.get('missing'), undefined);
  assertEquals(list.has('bad'), false);
  assertEquals(parseSessionList('not json'), null);
  assertEquals(parseSessionList('{"sessions":3}'), null);
  assertEquals(parseSessionList('null'), null);
});

Deno.test('the login shell: POSIX shells kept, anything else /bin/sh; the probe parsed', () => {
  assertEquals(loginShellFor('/bin/zsh'), '/bin/zsh');
  assertEquals(loginShellFor('/usr/local/bin/bash'), '/usr/local/bin/bash');
  assertEquals(loginShellFor('/opt/homebrew/bin/fish'), '/bin/sh');
  assertEquals(loginShellFor(undefined), '/bin/sh');
  assertEquals(loginShellFor('zsh'), '/bin/sh');
  assertEquals(
    parseProbe(
      '/usr/bin:/home/me/.local/bin\n/home/me/.local/bin/herdr\n',
      '/x',
    ),
    {
      path: '/usr/bin:/home/me/.local/bin',
      herdrPath: '/home/me/.local/bin/herdr',
    },
  );
  assertEquals(parseProbe('/usr/bin\n', '/x'), {
    path: '/usr/bin',
    herdrPath: '',
  });
  assertEquals(parseProbe('', '/x'), { path: '/x', herdrPath: '' });
});

Deno.test('parseWorktreeList: every worktree after the main one', () => {
  assertEquals(
    parseWorktreeList(
      'worktree /src/app\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /src/app-wt\nHEAD def\nbranch refs/heads/feat\n\n' +
        'worktree /src/app wt2\nHEAD 123\ndetached\n',
    ),
    ['/src/app-wt', '/src/app wt2'],
  );
  assertEquals(parseWorktreeList(''), []);
});

/** A temp dir with a folder, a file, and good and broken links. */
async function fixture(): Promise<string> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  await Deno.mkdir(join(dir, 'src'));
  await Deno.writeTextFile(join(dir, 'a.txt'), 'hello');
  await Deno.symlink(join(dir, 'src'), join(dir, 'to-dir'));
  await Deno.symlink(join(dir, 'gone'), join(dir, 'broken'));
  return dir;
}

Deno.test('host files: list (file, dir, link to a dir, broken link)', async () => {
  const dir = await fixture();
  try {
    const { entries, truncated } = await hostFiles().list(dir);
    assertEquals(truncated, false);
    assertEquals(entries, [
      { name: 'src', kind: 'dir' },
      { name: 'to-dir', kind: 'symlink', to: 'dir' },
      { name: 'a.txt', kind: 'file', size: 5 },
      { name: 'broken', kind: 'symlink' },
    ]);
    const err = await assertRejects(
      () => hostFiles().list(join(dir, 'nope')),
      FilesError,
    );
    assertEquals(err.code, 'not_found');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('host files: read refuses a missing path, a folder and an unreadable file', async () => {
  const dir = await fixture();
  try {
    const files = hostFiles();
    assertEquals((await files.read(join(dir, 'a.txt'))).text, 'hello');
    const code = async (path: string) =>
      (await assertRejects(() => files.read(path), FilesError)).code;
    assertEquals(await code(join(dir, 'nope')), 'not_found');
    assertEquals(await code(join(dir, 'src')), 'bad_request');
    await Deno.writeTextFile(join(dir, 'secret'), 'x');
    await Deno.chmod(join(dir, 'secret'), 0o000);
    // Root reads it anyway: skipped there.
    if (
      !(await Deno.readFile(join(dir, 'secret')).then(() => true, () => false))
    ) {
      assertEquals(await code(join(dir, 'secret')), 'forbidden');
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('host files: create, rename onto a taken name, delete a folder', async () => {
  const dir = await fixture();
  try {
    const files = hostFiles();
    assertEquals(await files.create(join(dir, 'new.txt'), 'file'), {
      path: join(dir, 'new.txt'),
    });
    assertEquals(await Deno.readTextFile(join(dir, 'new.txt')), '');
    const code = async (p: Promise<unknown>) =>
      (await assertRejects(() => p, FilesError)).code;
    assertEquals(
      await code(files.create(join(dir, 'a.txt'), 'file')),
      'exists',
    );
    assertEquals(await code(files.create(join(dir, 'src'), 'dir')), 'exists');
    assertEquals(
      await code(files.create(join(dir, 'nope', 'x'), 'dir')),
      'not_found',
    );
    // A broken link is still in the way.
    assertEquals(
      await code(files.rename(join(dir, 'a.txt'), join(dir, 'broken'))),
      'exists',
    );
    assertEquals(
      await code(files.rename(join(dir, 'a.txt'), join(dir, 'src'))),
      'exists',
    );
    await files.rename(join(dir, 'a.txt'), join(dir, 'b.txt'));
    assertEquals(await Deno.readTextFile(join(dir, 'b.txt')), 'hello');
    await Deno.writeTextFile(join(dir, 'src', 'inner'), 'x');
    // A link is deleted itself, never what it points to.
    await files.delete(join(dir, 'to-dir'));
    assert((await Deno.stat(join(dir, 'src', 'inner'))).isFile);
    await files.delete(join(dir, 'src'));
    assertEquals(await Deno.stat(join(dir, 'src')).catch(() => null), null);
    assertEquals(await code(files.delete(join(dir, 'src'))), 'not_found');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('host files: writeImage writes a private file in a private folder and prunes old images', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const images = join(dir, 'images');
    await Deno.mkdir(images, { mode: 0o755 });
    await Deno.chmod(images, 0o755);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
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
    const file = join(images, 'paste-20261029-150405-a1b2c3.png');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    await hostFiles().writeImage(images, file, png);
    assertEquals(await Deno.readFile(file), png);
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(images)).mode! & 0o777, 0o700);
    const exists = async (p: string) =>
      await Deno.stat(p).then(() => true, () => false);
    assertEquals(
      [await exists(stale), await exists(fresh), await exists(notOurs)],
      [false, true, true],
    );
    // A new folder is made too, and an existing file is never overwritten.
    const nested = join(dir, 'a', 'b');
    await hostFiles().writeImage(nested, join(nested, 'x.png'), png);
    assertEquals((await Deno.stat(nested)).mode! & 0o777, 0o700);
    const err = await assertRejects(
      () => hostFiles().writeImage(nested, join(nested, 'x.png'), png),
      FilesError,
    );
    assertEquals(err.code, 'exists');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('host files: writeText checks the base hash and saves in place', async () => {
  const dir = await fixture();
  try {
    const files = hostFiles();
    const path = join(dir, 'a.txt');
    await Deno.chmod(path, 0o640);
    const before = await Deno.stat(path);
    const { hash } = await files.read(path);
    const saved = await files.writeText(path, 'hi there', hash);
    assertEquals(saved, {
      hash: await contentHash(new TextEncoder().encode('hi there')),
      size: 8,
    });
    const after = await Deno.stat(path);
    assertEquals([after.ino, after.mode], [before.ino, before.mode]);
    assertEquals(await Deno.readTextFile(path), 'hi there');
    const err = await assertRejects(
      () => files.writeText(path, 'again', hash),
      FilesError,
    );
    assertEquals(err.code, 'conflict');
    await files.write(join(dir, 'tasks'), join(dir, 'tasks', 't.md'), 'do\n');
    assertEquals(await Deno.readTextFile(join(dir, 'tasks', 't.md')), 'do\n');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    'SESSIONS_SCRIPT runs under sh here, against a fake $HOME, and lists a Claude session',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const home = await Deno.realPath(await Deno.makeTempDir());
    try {
      const folder = '/home/me/src/app';
      const file = join(
        home,
        '.claude/projects/-home-me-src-app',
        `${U1}.jsonl`,
      );
      await Deno.mkdir(join(file, '..'), { recursive: true });
      await Deno.writeTextFile(
        file,
        JSON.stringify({ type: 'user', cwd: folder }) + '\n' +
          JSON.stringify({ type: 'last-prompt', lastPrompt: 'hello' }) + '\n',
      );
      const out = await new Deno.Command('sh', {
        args: ['-c', SESSIONS_SCRIPT, 'sh', ...sessionsArgs([folder])],
        clearEnv: true,
        env: { HOME: home, PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin' },
        stdout: 'piped',
        stderr: 'piped',
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      const sessions = parseSessionsOutput(
        new TextDecoder().decode(out.stdout),
      );
      assertEquals(
        sessions.map((s) => [s.agent, s.session, s.title, s.cwd]),
        [['claude', U1, 'hello', folder]],
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});

Deno.test('the macOS probe: M lines carry ps -E output, the last HERDR_* tokens win', () => {
  const ps =
    `/usr/local/bin/claude --resume HERDR_PANE_ID=forged TERM=xterm-256color ` +
    `HERDR_SESSION=devc-app-1a2b3c4d HERDR_PANE_ID=w1:p3 HOME=/Users/me`;
  assertEquals(parseRunningOutput(`M ${U1} ${ps}\n`), [
    { session: U1, herdrSession: 'devc-app-1a2b3c4d', paneId: 'w1:p3' },
  ]);
  // No pane, no session, or a bad id: skipped.
  assertEquals(
    parseRunningOutput(
      [
        `M ${U1} claude HERDR_SESSION=devc`,
        `M ${U1} claude HERDR_PANE_ID=w1:p1`,
        `M not-a-uuid claude HERDR_SESSION=devc HERDR_PANE_ID=w1:p1`,
        `M ${U1} claude HERDR_SESSION=devc HERDR_PANE_ID=`,
      ].join('\n'),
    ),
    [],
  );
  // The probe picks its flavor by `uname -s`, and has no `${…}` in it.
  assert(RUNNING_PROBE.includes('"$(uname -s)" = Darwin'));
  assert(RUNNING_PROBE.includes('ps -E -ww -o command= -p'));
  assert(RUNNING_PROBE.includes('LC_ALL=C TZ=UTC ps -o lstart= -p'));
  assertEquals(RUNNING_PROBE.includes('${'), false);
});

Deno.test('parseClientMessage: set_project_environment and add_project.environment', () => {
  const parse = (m: Record<string, unknown>) =>
    parseClientMessage(JSON.stringify(m));
  const base = {
    type: 'set_project_environment',
    id: 'r1',
    localFolder: '/src/app',
  };
  assertEquals(parse({ ...base, environment: 'host' }), {
    ok: true,
    msg: { ...base, environment: 'host' },
  } as unknown as ReturnType<typeof parse>);
  for (const bad of [{ environment: 'ssh' }, { environment: 1 }, {}]) {
    const r = parse({ ...base, ...bad });
    assert(!r.ok, JSON.stringify(bad));
    assertEquals(r.rejection.code, 'bad_request');
  }
  const noFolder = parse({
    type: 'set_project_environment',
    id: 'r1',
    environment: 'host',
  });
  assert(!noFolder.ok);
  assertEquals(noFolder.rejection.code, 'bad_request');

  const add = { type: 'add_project', id: 'r2', localFolder: '/src/app' };
  assertEquals(parse(add), {
    ok: true,
    msg: add,
  } as unknown as ReturnType<typeof parse>);
  assertEquals(parse({ ...add, environment: 'container' }), {
    ok: true,
    msg: { ...add, environment: 'container' },
  } as unknown as ReturnType<typeof parse>);
  assert(!parse({ ...add, environment: 'vm' }).ok);
});
