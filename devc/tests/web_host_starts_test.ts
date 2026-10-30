import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  FOLDER_FILE,
  followStart,
  HEARTBEAT_FILE,
  OUTPUT_FILE,
  paneCommand,
  parseResult,
  RESULT_FILE,
  resumeStart,
  runningStart,
  runningStarts,
  startRunDir,
  startScript,
  WEB_START_SUBCOMMAND,
  webStartArgv,
} from '../web/host_starts.ts';

const SOURCE = {
  execPath: '/usr/bin/deno',
  standalone: false,
  mainModule: 'file:///opt/devc/main.ts',
};
const COMPILED = {
  ...SOURCE,
  execPath: '/usr/local/bin/devc',
  standalone: true,
};

Deno.test('startRunDir: one folder per project under ~/.cache/devc/starts', () => {
  const a = startRunDir('/home/u/', '/src/a');
  assert(/^\/home\/u\/\.cache\/devc\/starts\/[0-9a-f]{16}$/.test(a));
  assertEquals(startRunDir('/home/u', '/src/a'), a);
  assert(startRunDir('/home/u', '/src/b') !== a);
});

Deno.test('webStartArgv: the hidden subcommand, through deno run from source', () => {
  assertEquals(webStartArgv('/src/a', '/run', COMPILED), [
    WEB_START_SUBCOMMAND,
    '/src/a',
    '/run',
  ]);
  const argv = webStartArgv('/src/a', '/run', SOURCE);
  assertEquals(argv[0], 'run');
  assert(argv.includes('--allow-run'));
  assertEquals(argv.slice(-4), [
    '/opt/devc/main.ts',
    WEB_START_SUBCOMMAND,
    '/src/a',
    '/run',
  ]);
});

Deno.test('startScript and paneCommand quote for /bin/sh', () => {
  assertEquals(
    startScript("/src/it's", '/run', COMPILED),
    `#!/bin/sh\nexec '/usr/local/bin/devc' '${WEB_START_SUBCOMMAND}' '/src/it'\\''s' '/run'\n`,
  );
  assertEquals(paneCommand('/h/run'), "exec /bin/sh '/h/run/run.sh'\n");
});

Deno.test('parseResult', () => {
  assertEquals(parseResult('{"ok":true}'), { ok: true });
  assertEquals(parseResult('{"ok":false,"error":"no"}'), {
    ok: false,
    error: 'no',
  });
  assertEquals(parseResult('{"ok":false}'), { ok: false, error: '' });
  assertEquals(parseResult('{}'), null);
  assertEquals(parseResult('{"ok":'), null);
});

Deno.test('runningStart: a fresh heartbeat and no result', async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await runningStart(dir), false);
    await Deno.writeTextFile(join(dir, HEARTBEAT_FILE), '1');
    assertEquals(await runningStart(dir), true);
    assertEquals(await runningStart(dir, Date.now() + 60_000), false);
    await Deno.writeTextFile(join(dir, RESULT_FILE), '{"ok":true}');
    assertEquals(await runningStart(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('followStart: streams the log, then the outcome', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lines: string[] = [];
    const following = followStart(dir, (l) => lines.push(l), { pollMs: 10 });
    await Deno.writeTextFile(join(dir, HEARTBEAT_FILE), '1');
    await Deno.writeTextFile(join(dir, OUTPUT_FILE), 'one\ntw');
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(lines, ['one']);
    await Deno.writeTextFile(join(dir, OUTPUT_FILE), 'o\nlast', {
      append: true,
    });
    await Deno.writeTextFile(join(dir, RESULT_FILE), '{"ok":true}');
    await following;
    assertEquals(lines, ['one', 'two', 'last']);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('followStart: a failed start rejects with its error', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, RESULT_FILE),
      '{"ok":false,"error":"boom"}',
    );
    await assertRejects(() => followStart(dir, () => {}), Error, 'boom');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('followStart: no heartbeat, or a stale one, rejects', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => followStart(dir, () => {}, { beginTimeoutMs: 30, pollMs: 10 }),
      Error,
      'never began',
    );
    await Deno.writeTextFile(join(dir, HEARTBEAT_FILE), '1');
    await assertRejects(
      () => followStart(dir, () => {}, { staleMs: 20, pollMs: 10 }),
      Error,
      'without an outcome',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('runningStarts: the folders of fresh, unfinished run folders', async () => {
  const home = await Deno.makeTempDir();
  try {
    assertEquals(await runningStarts(home), []);
    const run = async (folder: string, result: boolean) => {
      const dir = startRunDir(home, folder);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(join(dir, FOLDER_FILE), folder);
      await Deno.writeTextFile(join(dir, HEARTBEAT_FILE), '1');
      if (result) {
        await Deno.writeTextFile(join(dir, RESULT_FILE), '{"ok":true}');
      }
      return dir;
    };
    await run('/src/running', false);
    await run('/src/done', true);
    // A `folder` file that isn't its run folder's own is ignored.
    const stray = await run('/src/stray', false);
    await Deno.writeTextFile(join(stray, FOLDER_FILE), '/src/other');
    assertEquals(await runningStarts(home), ['/src/running']);
    assertEquals(await resumeStart(home, '/src/nothing', () => {}), false);
    const lines: string[] = [];
    const dir = startRunDir(home, '/src/running');
    await Deno.writeTextFile(join(dir, OUTPUT_FILE), 'hi\n');
    await Deno.writeTextFile(join(dir, RESULT_FILE), '{"ok":true}');
    // Finished between the listing and the follow: nothing to follow.
    assertEquals(
      await resumeStart(home, '/src/running', (l) => lines.push(l)),
      false,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
