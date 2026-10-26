// The native `task-add` built-in, end to end through the server: a temp policy dir and tasks
// file, and an injected container list in place of `docker ps`.

import { assert, assertEquals, assertMatch } from '@std/assert';
import { join } from '@std/path';
import { projectKey } from '@devc-tools/core/merged_config.ts';
import { type RunningServer, startServer } from '../core.ts';
import { resetToken } from '../token.ts';

/** The host folder of the caller's container: its key is the caller's. */
const FOLDER = '/host/app';

interface Env {
  port: number;
  shared: string;
  token: string;
  key: string;
  tasksPath: string;
  server: RunningServer;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** A server whose one keyed container is {@link FOLDER}'s, its policy `policy`. */
async function withServer(
  policy: string,
  fn: (env: Env) => Promise<void>,
  folders: string[] = ['/host/other', FOLDER],
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-bridge-task-add-' });
  const key = await projectKey(FOLDER);
  const keysDir = join(dir, 'keys');
  const policyDir = join(dir, 'policy');
  const builtinDir = join(dir, 'builtin');
  const commandsDir = join(dir, 'commands');
  for (const d of [join(keysDir, key), policyDir, builtinDir, commandsDir]) {
    await Deno.mkdir(d, { recursive: true });
  }
  await Deno.writeTextFile(join(policyDir, `${key}.conf`), policy);
  const tasksPath = join(dir, 'tasks', 'tasks.json');
  const port = freePort();
  const shared = await resetToken(join(dir, 'run', 'token'));
  const server = await startServer({
    hostname: '127.0.0.1',
    port,
    token: shared,
    keysDir,
    commandsDir,
    builtinDir,
    stateDir: join(dir, 'state'),
    policyDir,
    log: () => {},
    taskAdd: {
      tasksPath,
      listContainerFolders: () => Promise.resolve(folders),
    },
  });
  try {
    const token = (await Deno.readTextFile(join(keysDir, key, 'token'))).trim();
    await fn({ port, shared, token, key, tasksPath, server });
  } finally {
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

type Resp = {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

async function call(
  port: number,
  token: string,
  args: string[],
): Promise<Resp> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    await conn.write(
      new TextEncoder().encode(
        JSON.stringify({ token, command: 'task-add', args }) + '\n',
      ),
    );
    const buf = new Uint8Array(65536);
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n')) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += decoder.decode(buf.subarray(0, n), { stream: true });
    }
    return JSON.parse(text);
  } finally {
    conn.close();
  }
}

const line = (repo: string, grants: string, target: string) =>
  `${repo}\tgit@github.com:o/r.git\tfeat\t${grants}\t${target}\n`;

const failed = (exitCode: number, message: string): Resp => ({
  ok: true,
  exitCode,
  stdout: '',
  stderr: `task-add: ${message}\n`,
});

async function tasksOf(path: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await Deno.readTextFile(path)).tasks;
}

Deno.test('task-add prints the new id and writes the task, routed and marked', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token, key, tasksPath }) => {
      const resp = await call(port, token, ['Fix the flaky test\n\nDetails…']);
      assertEquals(resp.exitCode, 0, resp.stderr);
      assertMatch(
        resp.stdout!,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/,
      );
      const [task, ...rest] = await tasksOf(tasksPath);
      assertEquals(rest, []);
      assertEquals(task.id, resp.stdout!.trim());
      assertEquals(task.text, 'Fix the flaky test\n\nDetails…');
      assertEquals(task.localFolder, FOLDER);
      assertEquals(task.root, '/host/app');
      assertEquals(task.source, { kind: 'agent', key });
      assert(!('queued' in task));
    },
  );
});

Deno.test('task-add: --repo picks the line, trailing slashes dropped', async () => {
  const policy = line('/host/app', 'task-add', '/workspaces/app') +
    line('/host/lib', 'task-add', '/workspaces/lib');
  await withServer(policy, async ({ port, token, tasksPath }) => {
    assertEquals(
      await call(port, token, ['x']),
      failed(
        2,
        'this container has 2 pinned repos — pass --repo <path>, one of: /workspaces/app, /workspaces/lib',
      ),
    );
    const resp = await call(port, token, ['--repo', '/workspaces/lib/', 'x']);
    assertEquals(resp.exitCode, 0, resp.stderr);
    assertEquals((await tasksOf(tasksPath))[0].root, '/host/lib');
    assertEquals(
      await call(port, token, ['--repo', '/workspaces/nope', 'x']),
      failed(
        2,
        'no pinned repo at /workspaces/nope — pinned: /workspaces/app, /workspaces/lib',
      ),
    );
  });
});

Deno.test('task-add: the selected line must grant it, naming its target among several', async () => {
  const policy = line('/host/app', 'task-add', '/workspaces/app') +
    line('/host/lib', 'gh-push', '/workspaces/lib');
  await withServer(policy, async ({ port, token }) => {
    assertEquals(
      await call(port, token, ['--repo', '/workspaces/lib', 'x']),
      failed(2, 'this container was not granted task-add for /workspaces/lib'),
    );
  });
});

Deno.test('task-add: wrong arguments exit 2 with the usage line', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token }) => {
      const usage = failed(2, 'usage: task-add [--repo <path>] <text>');
      assertEquals(await call(port, token, []), usage);
      assertEquals(await call(port, token, ['a', 'b']), usage);
      assertEquals(await call(port, token, ['--repo']), usage);
      assertEquals(
        await call(port, token, ['--repo', '/workspaces/app']),
        usage,
      );
      // --repo only as the first argument, in the space form.
      assertEquals(
        await call(port, token, ['--repo=/workspaces/app', 'x']),
        usage,
      );
    },
  );
});

Deno.test('task-add: text to fix exits 3', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token, tasksPath }) => {
      assertEquals((await call(port, token, ['  \n '])).exitCode, 3);
      assertEquals((await call(port, token, ['ring \x07'])).exitCode, 3);
      assertEquals((await call(port, token, ['a\r\nb'])).exitCode, 3);
      assertEquals(
        (await call(port, token, ['x'.repeat(20_001)])).exitCode,
        3,
      );
      // Tabs and line breaks are fine.
      assertEquals((await call(port, token, ['a\tb\nc'])).exitCode, 0);
      assertEquals((await tasksOf(tasksPath)).length, 1);
    },
  );
});

Deno.test('task-add: the 21st waiting task from a container exits 3', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token }) => {
      for (let i = 0; i < 20; i++) {
        assertEquals((await call(port, token, [`t${i}`])).exitCode, 0);
      }
      assertEquals(
        await call(port, token, ['one more']),
        failed(
          3,
          '20 tasks from this container are waiting; ask the user to send or delete some',
        ),
      );
    },
  );
});

Deno.test('task-add: no container for the caller exits 4', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token, key }) => {
      assertEquals(
        await call(port, token, ['x']),
        failed(4, `no devc container for workspace ${key}`),
      );
    },
    ['/host/other'],
  );
});

Deno.test('task-add: an unreadable tasks file exits 4 and is left alone', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, token, tasksPath }) => {
      await Deno.mkdir(join(tasksPath, '..'), { recursive: true });
      await Deno.writeTextFile(tasksPath, '{not json');
      assertEquals((await call(port, token, ['x'])).exitCode, 4);
      assertEquals(await Deno.readTextFile(tasksPath), '{not json');
    },
  );
});

Deno.test('task-add: the shared token is refused with exit 1', async () => {
  await withServer(
    line('/host/app', 'task-add', '/workspaces/app'),
    async ({ port, shared }) => {
      assertEquals(
        await call(port, shared, ['x']),
        {
          ok: true,
          exitCode: 1,
          stdout: '',
          stderr:
            'devc-bridge: task-add needs a per-container token — the shared token has no capabilities\n',
        },
      );
    },
  );
});
