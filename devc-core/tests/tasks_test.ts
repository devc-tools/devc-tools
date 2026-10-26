// The task store's agent half: `source` on a task, the lock both writers take, and
// `appendAgentTask`, which devc-bridge's `task-add` writes through. The rest of the store is
// tested with devc web (`devc/tests/web_tasks_test.ts`).

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { join } from 'jsr:@std/path@^1';
import {
  AgentTaskCapError,
  appendAgentTask,
  queueTasks,
  readTasks,
  type Task,
  updateTask,
  withTasksLock,
  writeTasks,
} from '../tasks.ts';

const agentTask: Task = {
  id: 't1',
  text: 'Fix the flaky test',
  createdAt: '2026-10-26T10:00:00.000Z',
  localFolder: '/host/app',
  root: '/host/app',
  source: { kind: 'agent', key: 'app-1a2b3c4d' },
};

async function withDir(fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'devc-tasks-' });
  try {
    await fn(join(dir, 'tasks', 'tasks.json'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const route = { localFolder: '/host/app', root: '/host/app' };

const append = (path: string, key = 'app-1a2b3c4d', text = 'x') =>
  appendAgentTask({ text, ...route, key }, path);

Deno.test('a task with a valid source round-trips', async () => {
  await withDir(async (path) => {
    await writeTasks({ tasks: [agentTask], sent: [] }, path);
    assertEquals((await readTasks(path)).tasks, [agentTask]);
  });
});

Deno.test('an invalid source is dropped and the task kept', async () => {
  await withDir(async (path) => {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    const bad = (source: unknown) => ({ ...agentTask, source });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          { ...bad({ kind: 'human' }), id: 'a' },
          { ...bad({ kind: 'agent', key: '' }), id: 'b' },
          { ...bad('agent'), id: 'c' },
        ],
        sent: [],
      }),
    );
    const { source: _, ...plain } = agentTask;
    assertEquals((await readTasks(path)).tasks, [
      { ...plain, id: 'a' },
      { ...plain, id: 'b' },
      { ...plain, id: 'c' },
    ]);
  });
});

Deno.test('updateTask and queueTasks keep source', () => {
  const state = { tasks: [agentTask], sent: [] };
  const updated = updateTask(state, 't1', { text: 'Edited', route });
  assertEquals(updated?.tasks[0].source, agentTask.source);
  const unrouted = updateTask(state, 't1', { text: 'Edited' });
  assertEquals(unrouted?.tasks[0].source, agentTask.source);
  const queued = queueTasks(
    state,
    ['t1'],
    { action: 'implement', agent: 'claude' },
    new Date(),
  );
  assertEquals(queued?.tasks[0].source, agentTask.source);
});

Deno.test('appendAgentTask on a missing file creates the list', async () => {
  await withDir(async (path) => {
    const id = await append(path, 'app-1a2b3c4d', 'Fix it');
    const file = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(file), ['version', 'tasks', 'sent']);
    assertEquals(file.version, 1);
    assertEquals(file.sent, []);
    assertEquals(file.tasks.length, 1);
    const [t] = file.tasks;
    assertEquals(t.id, id);
    assertEquals(t.text, 'Fix it');
    assertEquals(t.localFolder, '/host/app');
    assertEquals(t.root, '/host/app');
    assertEquals(t.source, { kind: 'agent', key: 'app-1a2b3c4d' });
    assert(!isNaN(Date.parse(t.createdAt)));
    // What it wrote reads back.
    assertEquals((await readTasks(path)).tasks[0].id, id);
    // And no lock is left behind.
    await assertRejects(() => Deno.stat(`${path}.lock`), Deno.errors.NotFound);
  });
});

Deno.test('appendAgentTask keeps fields and keys it does not know', async () => {
  await withDir(async (path) => {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    const future = { ...agentTask, id: 'f', colour: 'teal' };
    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 1, tasks: [future], sent: [], later: [1] }),
    );
    await append(path);
    const file = JSON.parse(await Deno.readTextFile(path));
    assertEquals(file.later, [1]);
    assertEquals(file.tasks[0], future);
    assertEquals(file.tasks.length, 2);
  });
});

Deno.test('appendAgentTask throws on a file it cannot read and leaves it alone', async () => {
  await withDir(async (path) => {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    for (const text of ['{not json', '[]', '{"tasks": {}}']) {
      await Deno.writeTextFile(path, text);
      await assertRejects(() => append(path));
      assertEquals(await Deno.readTextFile(path), text);
    }
  });
});

Deno.test('the 21st task from one key hits the cap; another key still adds', async () => {
  await withDir(async (path) => {
    for (let i = 0; i < 20; i++) await append(path);
    await assertRejects(
      () => append(path),
      AgentTaskCapError,
      '20 tasks from this container are waiting; ask the user to send or delete some',
    );
    await append(path, 'lib-5e6f7a8b');
    assertEquals((await readTasks(path)).tasks.length, 21);
  });
});

Deno.test('concurrent appends all land', async () => {
  await withDir(async (path) => {
    const ids = await Promise.all([
      append(path, 'a-1', 'one'),
      append(path, 'b-2', 'two'),
      append(path, 'c-3', 'three'),
    ]);
    const tasks = (await readTasks(path)).tasks;
    assertEquals(tasks.map((t) => t.id).sort(), [...ids].sort());
  });
});

Deno.test('a lock older than 10 s is taken over; a fresh one is waited for', async () => {
  await withDir(async (path) => {
    await Deno.mkdir(join(path, '..'), { recursive: true });
    const lock = `${path}.lock`;
    await Deno.writeTextFile(lock, '');
    const old = new Date(Date.now() - 11_000);
    await Deno.utime(lock, old, old);
    assertEquals(await withTasksLock(() => Promise.resolve(7), path), 7);
    await assertRejects(() => Deno.stat(lock), Deno.errors.NotFound);

    // A live lock: the second waits until the first lets go.
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => release = r);
    const first = withTasksLock(async () => {
      order.push('first');
      await held;
      order.push('first done');
    }, path);
    await new Promise((r) => setTimeout(r, 30));
    const second = withTasksLock(() => {
      order.push('second');
      return Promise.resolve();
    }, path);
    await new Promise((r) => setTimeout(r, 60));
    release();
    await Promise.all([first, second]);
    assertEquals(order, ['first', 'first done', 'second']);
  });
});
