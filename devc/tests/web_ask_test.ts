import { assert, assertEquals } from 'jsr:@std/assert';
import {
  askPrompt,
  resumeAskCommand,
  startAskCommand,
  taskFilePath,
} from '../web/agents.ts';
import { parseClientMessage } from '../web/protocol.ts';
import { VIEW_INTENT_NAMES as SERVER_INTENTS } from '../web/protocol.ts';
import {
  askTargetFields,
  askTargets,
  askText,
  askWhere,
  defaultAskTarget,
  MAX_ASK_SELECTION,
  MAX_ASK_TEXT,
} from '../web/static/lib/ask.js';
import { VIEW_INTENT_NAMES } from '../web/static/lib/view.js';
import { MAX_TASK_TEXT } from '../web/tasks.ts';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const ASK = '33333333-3333-4333-8333-333333333333';

const LABELS = { claude: 'Claude', copilot: 'Copilot', pi: 'Pi' };

Deno.test('askWhere: the path, then its line or lines, and the diff', () => {
  assertEquals(askWhere({ path: 'src/a.ts' }), '`src/a.ts`');
  assertEquals(
    askWhere({ path: 'src/a.ts', selection: { text: 'x', startLine: 4 } }),
    '`src/a.ts`, line 4',
  );
  assertEquals(
    askWhere({
      path: 'src/a.ts',
      selection: { text: 'x', startLine: 4, endLine: 4 },
    }),
    '`src/a.ts`, line 4',
  );
  assertEquals(
    askWhere({
      path: 'src/a.ts',
      selection: { text: 'x', startLine: 4, endLine: 9 },
    }),
    '`src/a.ts`, lines 4–9',
  );
  assertEquals(
    askWhere({ path: 'src/a.ts', selection: { text: 'x' }, diff: true }),
    "`src/a.ts`, in the pull request's diff",
  );
});

Deno.test('askText: the question first, then the file, without a selection', () => {
  assertEquals(
    askText('  What does this do?  \n', { path: 'src/a.ts' }),
    'What does this do?\n\nAbout `src/a.ts`.',
  );
});

Deno.test('askText: a selection is fenced after its lines', () => {
  assertEquals(
    askText('Why?', {
      path: 'src/a.ts',
      selection: { text: 'let x = 1;\n', startLine: 3, endLine: 3 },
    }),
    'Why?\n\nAbout `src/a.ts`, line 3:\n\n```\nlet x = 1;\n```',
  );
});

Deno.test('askText: the fence is longer than any backtick run in the selection', () => {
  const text = askText('Why?', {
    path: 'README.md',
    selection: { text: '```sh\nls\n```' },
  });
  assert(text.endsWith('````\n```sh\nls\n```\n````'), text);
});

Deno.test('askText: includeSelection false leaves the selection and its lines out', () => {
  assertEquals(
    askText(
      'Why?',
      { path: 'a.ts', selection: { text: 'x', startLine: 1, endLine: 2 } },
      false,
    ),
    'Why?\n\nAbout `a.ts`.',
  );
});

Deno.test('askText: a long selection is cut and says so', () => {
  const text = askText('Why?', {
    path: 'a.ts',
    selection: { text: 'x'.repeat(MAX_ASK_SELECTION + 500) },
  });
  assert(text.includes('(the selection, cut short):'));
  assert(text.length < MAX_ASK_SELECTION + 200);
  assertEquals(MAX_ASK_TEXT, MAX_TASK_TEXT);
});

const session = (over: Record<string, unknown>) => ({
  agent: 'claude' as const,
  session: S1,
  title: 'Old work',
  cwd: '/workspaces/app',
  root: '/src/app',
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

Deno.test('askTargets: running agents, then the repo’s other sessions, then new ones', () => {
  const targets = askTargets(
    [
      { pane_id: 'w1:p1', agent: 'claude', label: 'app · Claude Code' },
      { pane_id: 'w1:p2', agent: 'opencode', label: 'app · OpenCode' },
    ],
    [
      session({ pane_id: 'w1:p1', title: 'Live one' }),
      session({ session: S2, agent: 'pi', title: 'Past one' }),
      session({ session: ASK, root: '/src/other', title: 'Elsewhere' }),
    ],
    '/src/app',
    LABELS,
  );
  assertEquals(targets.map((t) => [t.kind, t.key, t.label]), [
    ['pane', 'pane:w1:p1', 'Live one'],
    ['pane', 'pane:w1:p2', 'app · OpenCode'],
    ['session', `session:pi:${S2}`, 'Past one'],
    ['new', 'new:claude', 'New Claude session'],
    ['new', 'new:copilot', 'New Copilot session'],
    ['new', 'new:pi', 'New Pi session'],
  ]);
});

Deno.test('askTargets: a session whose pane is no longer running is offered as a session', () => {
  const targets = askTargets(
    [],
    [session({ pane_id: 'w1:gone' })],
    '/src/app',
    LABELS,
  );
  assertEquals(targets[0].key, `session:claude:${S1}`);
});

Deno.test('defaultAskTarget: the saved one, else the first running agent, else new Claude', () => {
  const targets = askTargets(
    [{ pane_id: 'w1:p1', agent: 'claude', label: 'x' }],
    [session({})],
    '/src/app',
    LABELS,
  );
  assertEquals(defaultAskTarget(targets, 'new:pi')?.key, 'new:pi');
  assertEquals(defaultAskTarget(targets, 'pane:w1:gone')?.key, 'pane:w1:p1');
  assertEquals(defaultAskTarget(targets, null)?.key, 'pane:w1:p1');
  const none = askTargets([], [], '/src/app', LABELS);
  assertEquals(defaultAskTarget(none, undefined)?.key, 'new:claude');
});

Deno.test('askTargetFields: what ask_agent takes for each kind', () => {
  const [pane, past, fresh] = askTargets(
    [{ pane_id: 'w1:p1', agent: 'claude', label: 'x' }],
    [session({ session: S2, agent: 'copilot' })],
    '/src/app',
    LABELS,
  );
  assertEquals(askTargetFields(pane), { pane_id: 'w1:p1' });
  assertEquals(askTargetFields(past), { agent: 'copilot', session: S2 });
  assertEquals(askTargetFields(fresh), { agent: 'claude' });
});

Deno.test('startAskCommand and resumeAskCommand point at the question’s file', () => {
  const prompt = `'${askPrompt(taskFilePath(ASK))}'`;
  assert(!askPrompt(taskFilePath(ASK)).slice(1, -1).includes("'"));
  assertEquals(
    startAskCommand('claude', S1, ASK, 'Why is it slow?'),
    `claude --session-id ${S1} --name 'Why is it slow?' ${prompt}`,
  );
  assertEquals(
    startAskCommand('copilot', S1, ASK),
    `copilot --session-id ${S1} -i ${prompt}`,
  );
  assertEquals(
    startAskCommand('pi', S1, ASK),
    `pi --session-id ${S1} ${prompt}`,
  );
  assertEquals(
    resumeAskCommand('claude', S1, ASK),
    `claude --resume ${S1} ${prompt}`,
  );
  assertEquals(
    resumeAskCommand('copilot', S1, ASK),
    `copilot --resume ${S1} -i ${prompt}`,
  );
  assertEquals(
    resumeAskCommand('pi', S1, ASK),
    `pi --session-id ${S1} ${prompt}`,
  );
});

const parse = (m: Record<string, unknown>) =>
  parseClientMessage(JSON.stringify(m));

const ask = {
  type: 'ask_agent' as const,
  id: 'r1',
  container: 'c1',
  root: '/src/app',
  text: '  Why?  ',
};

Deno.test('parseClientMessage: ask_agent to a pane, a session or a new agent', () => {
  assertEquals(parse({ ...ask, pane_id: 'w1:p1' }), {
    ok: true,
    msg: { ...ask, text: 'Why?', pane_id: 'w1:p1' },
  });
  assertEquals(parse({ ...ask, agent: 'pi', session: S1 }), {
    ok: true,
    msg: { ...ask, text: 'Why?', agent: 'pi', session: S1 },
  });
  assertEquals(parse({ ...ask, agent: 'copilot' }), {
    ok: true,
    msg: { ...ask, text: 'Why?', agent: 'copilot' },
  });
});

Deno.test('parseClientMessage: a bad ask_agent is bad_request', () => {
  for (
    const bad of [
      {},
      { pane_id: 'w1:p1', agent: 'claude' },
      { agent: 'opencode' },
      { session: S1 },
      { agent: 'claude', session: 'not-a-uuid' },
      { agent: 'claude', text: '   ' },
      { agent: 'claude', text: 'x'.repeat(MAX_TASK_TEXT + 1) },
      { agent: 'claude', root: 'relative' },
      { agent: 'claude', container: undefined },
      { pane_id: '' },
    ]
  ) {
    const result = parse({ ...ask, ...bad });
    assertEquals(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assertEquals(result.rejection.code, 'bad_request');
  }
});

Deno.test('askAgent is a view intent on both sides of the relay', () => {
  assert(VIEW_INTENT_NAMES.includes('askAgent'));
  assertEquals([...SERVER_INTENTS], [...VIEW_INTENT_NAMES]);
});
