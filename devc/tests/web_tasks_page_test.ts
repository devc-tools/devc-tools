import { assert, assertEquals } from 'jsr:@std/assert';
import {
  parseTasks,
  savedTaskAgent,
  sentTaskTooltip,
  TASK_AGENT_IDS,
  taskTitle,
} from '../web/static/lib/tasks.js';
import { taskTitle as serverTaskTitle } from '../web/tasks.ts';
import { isSessionAgentId } from '../web/agents.ts';

const task = {
  id: 't1',
  text: 'Retry gh-push\n\nonce a day',
  createdAt: '2026-10-19T10:00:00.000Z',
  localFolder: '/src/app',
  root: '/src/app',
};

const sent = {
  id: 's1',
  text: 'Dark mode',
  createdAt: '2026-10-18T10:00:00.000Z',
  action: 'plan' as const,
  agent: 'pi' as const,
  sentAt: '2026-10-19T11:00:00.000Z',
  localFolder: '/src/app',
  root: '/src/lib',
  cwd: '/workspaces/lib',
  sessionId: '0f0e0d0c-0b0a-4908-8706-050403020100',
};

Deno.test('parseTasks keeps well-formed entries in order', () => {
  const { localFolder: _, root: __, ...unrouted } = task;
  assertEquals(
    parseTasks({
      type: 'tasks',
      tasks: [
        task,
        { ...unrouted, id: 't2' },
        { ...unrouted, id: 't3', localFolder: '/half' }, // half a route: not routed
        { ...task, id: '' },
        { ...task, id: 't4', text: 3 },
        null,
      ],
      sent: [
        sent,
        { ...sent, id: 's2', agent: 'opencode' },
        { ...sent, id: 's3', action: 'review' },
        { ...sent, id: 's4', sessionId: '' },
        'x',
      ],
    }),
    {
      tasks: [task, { ...unrouted, id: 't2' }, { ...unrouted, id: 't3' }],
      sent: [sent],
    },
  );
  assertEquals(parseTasks(null), { tasks: [], sent: [] });
  assertEquals(parseTasks({ tasks: 3, sent: {} }), { tasks: [], sent: [] });
});

Deno.test('taskTitle matches the server, which names the pane with it', () => {
  for (
    const text of ['a', '\n  First \nsecond', 'y'.repeat(100), 'z'.repeat(80)]
  ) {
    assertEquals(taskTitle(text), serverTaskTitle(text), text);
  }
});

Deno.test('the page offers exactly the agents the server can send a task to', () => {
  assertEquals([...TASK_AGENT_IDS], ['claude', 'copilot', 'pi']);
  for (const id of TASK_AGENT_IDS) assert(isSessionAgentId(id));
});

Deno.test('savedTaskAgent: a saved session agent, else Claude', () => {
  assertEquals(savedTaskAgent('pi'), 'pi');
  assertEquals(savedTaskAgent('copilot'), 'copilot');
  for (const v of [null, '', 'opencode', 'toString']) {
    assertEquals(savedTaskAgent(v), 'claude', String(v));
  }
});

Deno.test('sentTaskTooltip names the action, agent and folder', () => {
  const tip = sentTaskTooltip(sent, 'Pi').split('\n');
  assertEquals(tip[0], 'Dark mode');
  assert(tip[2].startsWith('Plan · Pi · '), tip[2]);
  assertEquals(tip[3], '/workspaces/lib');
  assertEquals(
    sentTaskTooltip({ ...sent, action: 'implement', sentAt: 'garbage' }, 'Pi')
      .split('\n')[2],
    'Implement · Pi · garbage',
  );
});
