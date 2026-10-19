import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import {
  isSessionAgentId,
  resumeTaskCommand,
  startTaskCommand,
  taskFilePath,
} from '../web/agents.ts';
import { reusablePinnedPane } from '../web/pinned_files.ts';
import { parseClientMessage } from '../web/protocol.ts';
import {
  addTask,
  deleteTask,
  markSent,
  MAX_SENT,
  readTasks,
  restoreTask,
  type SentTask,
  type Task,
  tasksMessage,
  type TaskState,
  taskText,
  taskTitle,
  updateTask,
  withSentPane,
  writeTasks,
} from '../web/tasks.ts';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

const task: Task = {
  id: 't1',
  text: 'Retry gh-push on 502\n\nIt fails once a day.',
  createdAt: '2026-10-19T10:00:00.000Z',
  localFolder: '/src/app',
  root: '/src/app',
};

const sent: SentTask = {
  id: 's1',
  text: 'Dark mode',
  createdAt: '2026-10-18T10:00:00.000Z',
  action: 'implement',
  agent: 'claude',
  sentAt: '2026-10-19T11:00:00.000Z',
  localFolder: '/src/app',
  root: '/src/lib',
  cwd: '/workspaces/lib',
  sessionId: ID,
  last: { containerId: 'c1', paneId: 'p1' },
};

async function inTemp(fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(join(dir, 'tasks.json'));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('readTasks: a missing or corrupt file is no tasks', async () => {
  await inTemp(async (path) => {
    assertEquals(await readTasks(path), { tasks: [], sent: [] });
    for (const text of ['{not json', 'null', '[]', '{"tasks": 3}']) {
      await Deno.writeTextFile(path, text);
      assertEquals(await readTasks(path), { tasks: [], sent: [] }, text);
    }
  });
});

Deno.test('readTasks: drops malformed and repeated entries, keeps the rest', async () => {
  await inTemp(async (path) => {
    const { localFolder: _, root: __, ...unrouted } = task;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          { ...task, extra: 1 },
          { ...unrouted, id: 't2' },
          { ...unrouted, id: 't3', localFolder: '/src/app' }, // half a route
          { ...task, id: 't4', root: 'relative' },
          { ...task, id: 't5', text: '' },
          { ...task, text: 'the same id again' },
        ],
        sent: [
          sent,
          { ...sent, id: 't2' }, // an id already in tasks
          { ...sent, id: 's2', agent: 'opencode' },
          { ...sent, id: 's3', action: 'review' },
          { ...sent, id: 's4', last: { containerId: 'c1' } },
          { ...sent, id: 's5', cwd: 'relative' },
        ],
      }),
    );
    assertEquals(await readTasks(path), {
      tasks: [task, { ...unrouted, id: 't2' }],
      sent: [sent],
    });
  });
});

Deno.test('writeTasks: atomic, readable back, sent cut to the newest', async () => {
  await inTemp(async (path) => {
    const many = Array.from({ length: MAX_SENT + 5 }, (_, i) => ({
      ...sent,
      id: `s${i}`,
      sentAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    await writeTasks({ tasks: [task], sent: many }, path);
    const back = await readTasks(path);
    assertEquals(back.tasks, [task]);
    assertEquals(back.sent.length, MAX_SENT);
    assertEquals(back.sent[0].id, `s${MAX_SENT + 4}`);
    assertEquals(back.sent.at(-1)!.id, 's5');
    const left = [...Deno.readDirSync(join(path, '..'))].map((e) => e.name);
    assertEquals(left, ['tasks.json']);
    assertEquals(JSON.parse(await Deno.readTextFile(path)).version, 1);
  });
});

Deno.test('taskText and taskTitle', () => {
  assertEquals(taskText('  a\n '), 'a');
  assertEquals(taskText(' \n '), null);
  assertEquals(taskText('x'.repeat(20_000)), 'x'.repeat(20_000));
  assertEquals(taskText('x'.repeat(20_001)), null);
  assertEquals(taskTitle('\n  First line \nsecond'), 'First line');
  const long = taskTitle('y'.repeat(100));
  assertEquals(long.length, 80);
  assert(long.endsWith('…'));
});

Deno.test('add, update, delete, send and restore', () => {
  let state: TaskState = { tasks: [], sent: [] };
  const added = addTask(
    state,
    { text: 'a', route: { localFolder: '/p', root: '/p' } },
    new Date('2026-10-19T00:00:00Z'),
    () => 'n1',
  );
  state = added.state;
  assertEquals(added.id, 'n1');
  assertEquals(state.tasks, [{
    id: 'n1',
    text: 'a',
    createdAt: '2026-10-19T00:00:00.000Z',
    localFolder: '/p',
    root: '/p',
  }]);
  state = updateTask(state, 'n1', { text: 'b' })!;
  assertEquals(state.tasks[0], {
    id: 'n1',
    text: 'b',
    createdAt: '2026-10-19T00:00:00.000Z',
  });
  assertEquals(updateTask(state, 'nope', { text: 'b' }), null);
  const { id: _, text: __, createdAt: ___, ...how } = sent;
  state = markSent(state, 'n1', how)!;
  assertEquals(state.tasks, []);
  assertEquals(state.sent[0], {
    ...how,
    id: 'n1',
    text: 'b',
    createdAt: '2026-10-19T00:00:00.000Z',
  });
  assertEquals(markSent(state, 'n1', how), null);
  state = withSentPane(state, 'n1', { containerId: 'c2', paneId: 'p2' })!;
  assertEquals(state.sent[0].last, { containerId: 'c2', paneId: 'p2' });
  state = restoreTask(state, 'n1')!;
  assertEquals(state, {
    tasks: [{
      id: 'n1',
      text: 'b',
      createdAt: '2026-10-19T00:00:00.000Z',
      localFolder: sent.localFolder,
      root: sent.root,
    }],
    sent: [],
  });
  assertEquals(restoreTask(state, 'n1'), null);
  assertEquals(deleteTask(state, 'n1'), { tasks: [], sent: [] });
  assertEquals(deleteTask({ tasks: [], sent: [sent] }, 's1'), {
    tasks: [],
    sent: [],
  });
  assertEquals(deleteTask(state, 'nope'), null);
});

Deno.test("tasksMessage never carries a sent task's pane", () => {
  const { last: _, ...shown } = sent;
  assertEquals(tasksMessage({ tasks: [task], sent: [sent] }), {
    type: 'tasks',
    tasks: [task],
    sent: [shown],
  });
});

Deno.test('start and resume commands, exactly', () => {
  const file = `/tmp/devc-tasks/${ID}.md`;
  assertEquals(taskFilePath(ID), file);
  const implement = `'Implement the task described in ${file}.'`;
  const plan =
    `'Write an implementation plan for the task described in ${file}, ` +
    `following the conventions this project uses for plans (a .plans/ doc if the project ` +
    `has a .plans/ folder). Do not implement it yet.'`;
  assertEquals(
    startTaskCommand('claude', ID, 'implement'),
    `claude --session-id ${ID} ${implement}`,
  );
  assertEquals(
    startTaskCommand('claude', ID, 'plan'),
    `claude --session-id ${ID} ${plan}`,
  );
  assertEquals(
    startTaskCommand('copilot', ID, 'implement'),
    `copilot --session-id ${ID} -i ${implement}`,
  );
  assertEquals(
    startTaskCommand('copilot', ID, 'plan'),
    `copilot --session-id ${ID} -i ${plan}`,
  );
  assertEquals(
    startTaskCommand('pi', ID, 'implement'),
    `pi --session-id ${ID} ${implement}`,
  );
  assertEquals(
    startTaskCommand('pi', ID, 'plan'),
    `pi --session-id ${ID} ${plan}`,
  );
  assertEquals(resumeTaskCommand('claude', ID), `claude --resume ${ID}`);
  assertEquals(resumeTaskCommand('copilot', ID), `copilot --resume ${ID}`);
  assertEquals(resumeTaskCommand('pi', ID), `pi --session-id ${ID}`);
});

Deno.test('the single-quoted prompts hold no quote, and only a uuid names the file', () => {
  for (const agent of ['claude', 'copilot', 'pi'] as const) {
    for (const action of ['plan', 'implement'] as const) {
      const cmd = startTaskCommand(agent, ID, action);
      const quoted = cmd.slice(cmd.indexOf("'") + 1, -1);
      assert(!quoted.includes("'"), cmd);
      assert(cmd.endsWith("'"), cmd);
    }
  }
  for (const bad of ['', 'x', `${ID}; rm -rf /`, ID.toUpperCase(), '../a']) {
    assertThrows(() => taskFilePath(bad));
    assertThrows(() => startTaskCommand('claude', bad, 'plan'));
    assertThrows(() => resumeTaskCommand('pi', bad));
  }
});

Deno.test('isSessionAgentId: claude, copilot and pi, never opencode', () => {
  for (const id of ['claude', 'copilot', 'pi']) assert(isSessionAgentId(id));
  for (const id of ['opencode', 'codex', '', 'toString', null, 1]) {
    assert(!isSessionAgentId(id), String(id));
  }
});

Deno.test('a sent task reuses its pane only while it is in that container', () => {
  const panes = [{ pane_id: 'p1', tab_id: 't1' }];
  assertEquals(reusablePinnedPane(sent.last, 'c1', panes), {
    pane_id: 'p1',
    tab_id: 't1',
  });
  assertEquals(reusablePinnedPane(sent.last, 'c1', []), null);
  assertEquals(reusablePinnedPane(sent.last, 'c2', panes), null);
  assertEquals(reusablePinnedPane(undefined, 'c1', panes), null);
});

const parse = (m: Record<string, unknown>) =>
  parseClientMessage(JSON.stringify(m));

Deno.test('parseClientMessage: add_task and update_task', () => {
  assertEquals(parse({ type: 'add_task', id: 'r1', text: '  Do it \n' }), {
    ok: true,
    msg: { type: 'add_task', id: 'r1', text: 'Do it' },
  });
  assertEquals(
    parse({
      type: 'update_task',
      id: 'r1',
      task: 't1',
      text: 'x',
      localFolder: '/p',
      root: '/p/lib',
    }),
    {
      ok: true,
      msg: {
        type: 'update_task',
        id: 'r1',
        task: 't1',
        text: 'x',
        localFolder: '/p',
        root: '/p/lib',
      },
    },
  );
  for (
    const bad of [
      { text: '' },
      { text: '   ' },
      { text: 3 },
      { text: 'x'.repeat(20_001) },
      { text: 'x', localFolder: '/p' },
      { text: 'x', root: '/p' },
      { text: 'x', localFolder: 'p', root: '/p' },
    ]
  ) {
    const r = parse({ type: 'add_task', id: 'r1', ...bad });
    assert(!r.ok, JSON.stringify(bad));
    assertEquals(r.rejection.code, 'bad_request');
  }
  assert(!parse({ type: 'update_task', id: 'r1', text: 'x' }).ok);
});

Deno.test('parseClientMessage: send_task takes a session agent and an action', () => {
  const base = {
    type: 'send_task' as const,
    id: 'r1',
    task: 't1',
    localFolder: '/p',
    root: '/p',
    agent: 'pi' as const,
    action: 'plan' as const,
  };
  assertEquals(parse(base), { ok: true, msg: base });
  for (
    const bad of [
      { agent: 'opencode' },
      { agent: 'codex' },
      { agent: undefined },
      { action: 'review' },
      { action: undefined },
      { root: undefined },
      { localFolder: 'p' },
      { task: '' },
    ]
  ) {
    const r = parse({ ...base, ...bad });
    assert(!r.ok, JSON.stringify(bad));
    assertEquals(r.rejection.code, 'bad_request');
  }
});

Deno.test('parseClientMessage: delete_task, restore_task and open_sent name a task', () => {
  for (const type of ['delete_task', 'restore_task', 'open_sent'] as const) {
    assertEquals(parse({ type, id: 'r1', task: 't1' }), {
      ok: true,
      msg: { type, id: 'r1', task: 't1' },
    });
    assert(!parse({ type, id: 'r1' }).ok, type);
  }
});
