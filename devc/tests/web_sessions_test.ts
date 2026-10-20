import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type { ContainerInfo } from '@devc-tools/core/container.ts';
import type { DockerRun } from '../web/container_files.ts';
import {
  claudeDirPrefix,
  listAgentSessions,
  MAX_SESSIONS,
  parseSessionsOutput,
  pickSessions,
  piDirPrefix,
  type RawSession,
  sessionsArgs,
  UNTITLED,
} from '../web/sessions.ts';
import { parseClientMessage } from '../web/protocol.ts';

const info: ContainerInfo = {
  containerId: 'c0ffee',
  remoteUser: 'vscode',
  remoteWorkspaceFolder: '/workspaces/app',
  remoteEnv: {},
};

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const U4 = '44444444-4444-4444-8444-444444444444';
const U5 = '01a15a9a-1aaa-7272-889b-0875a721b169';
const U6 = '66666666-6666-4666-8666-666666666666';
const U7 = '77777777-7777-4777-8777-777777777777';
const U8 = '88888888-8888-4888-8888-888888888888';

Deno.test('claudeDirPrefix and piDirPrefix name the agents’ session folders', () => {
  assertEquals(
    claudeDirPrefix('/workspaces/deephaven-core.worktrees/x'),
    '-workspaces-deephaven-core-worktrees-x',
  );
  assertEquals(
    claudeDirPrefix('/workspaces/tools/devc-tools'),
    '-workspaces-tools-devc-tools',
  );
  assertEquals(piDirPrefix('/workspaces/devc-dev'), '--workspaces-devc-dev');
  assertEquals(
    piDirPrefix('/workspaces/deephaven-core.worktrees/x'),
    '--workspaces-deephaven-core.worktrees-x',
  );
});

Deno.test('sessionsArgs: the cap, Claude prefixes, `:`, pi prefixes; `/` and repeats dropped', () => {
  assertEquals(sessionsArgs(['/workspaces/a', '/', '/workspaces/a', '/w/b']), [
    String(2 * MAX_SESSIONS),
    '-workspaces-a',
    '-w-b',
    ':',
    '--workspaces-a',
    '--w-b',
  ]);
});

Deno.test('parseSessionsOutput reads each agent, title precedence and escapes', () => {
  const out = [
    `S claude 100 /h/.claude/projects/-w-app/${U1}.jsonl`,
    'C "cwd":"/w/app"',
    'T "aiTitle":"Ai \\"quoted\\""',
    'T "customTitle":"Custom\\nsecond line"',
    'T "lastPrompt":"prompt"',
    `S claude 90 /h/.claude/projects/-w-app/${U2}.jsonl`,
    'C "cwd":"/w/app/sub"',
    'T "lastPrompt":"only a prompt"',
    `S claude 80 /h/.claude/projects/-w-app/${U3}.jsonl`,
    'C "cwd":"/w/app"',
    `S pi 70 /h/.pi/agent/sessions/--w-app--/2026-10-20T18-36-51-243Z_${U5}.jsonl`,
    `H "id":"${U5}"`,
    'H "cwd":"/w/app"',
    'N "name":"Pi name"',
    'U "text":"first message"',
    `S pi 60 /h/.pi/agent/sessions/--w-app--/x_${U6}.jsonl`,
    `H "id":"${U6}"`,
    'H "cwd":"/w/app"',
    'U "text":"\\n\\nLine one\\nline two"',
    `S copilot 50 /h/.copilot/session-state/${U7}`,
    `Y id: ${U7}`,
    'Y cwd: /w/app',
    'Y name: "Quoted: name"',
    'Y summary: ignored',
    `S copilot 40 /h/.copilot/session-state/${U8}`,
    'Y cwd: /w/app',
    "Y summary: 'It''s a summary'",
  ].join('\n');
  assertEquals(parseSessionsOutput(out), [
    {
      agent: 'claude',
      session: U1,
      title: 'Custom',
      cwd: '/w/app',
      mtime: 100,
    },
    {
      agent: 'claude',
      session: U2,
      title: 'only a prompt',
      cwd: '/w/app/sub',
      mtime: 90,
    },
    { agent: 'claude', session: U3, title: UNTITLED, cwd: '/w/app', mtime: 80 },
    { agent: 'pi', session: U5, title: 'Pi name', cwd: '/w/app', mtime: 70 },
    { agent: 'pi', session: U6, title: 'Line one', cwd: '/w/app', mtime: 60 },
    {
      agent: 'copilot',
      session: U7,
      title: 'Quoted: name',
      cwd: '/w/app',
      mtime: 50,
    },
    {
      agent: 'copilot',
      session: U8,
      title: "It's a summary",
      cwd: '/w/app',
      mtime: 40,
    },
  ]);
});

Deno.test('parseSessionsOutput drops bad ids, bad cwds and garbage', () => {
  const out = [
    'garbage',
    'T "aiTitle":"before any session"',
    'S claude 100 /h/.claude/projects/-w-app/notes.jsonl',
    'C "cwd":"/w/app"',
    `S claude 90 /h/.claude/projects/-w-app/${U1}.jsonl`,
    'C "cwd":"relative/path"',
    `S claude 80 /h/.claude/projects/-w-app/${U2}.jsonl`,
    'C "cwd":"/w/app\\nx"',
    `S claude 70 /h/.claude/projects/-w-app/${U3}.jsonl`,
    `S opencode 60 /h/x/${U4}`,
    'Y cwd: /w/app',
    `S pi notanumber /h/p/${U4}.jsonl`,
    `H "id":"${U4}"`,
    'H "cwd":"/w/app"',
    `S pi 50 /h/p/x_${U4}.jsonl`,
    'H "id":"not-a-uuid"',
    'H "cwd":"/w/app"',
    `S claude 40 /h/.claude/projects/-w-app/${U4}.jsonl`,
    'C "cwd":"/w/app"',
    'T "aiTitle":broken',
    '',
  ].join('\n');
  assertEquals(parseSessionsOutput(out), [
    { agent: 'claude', session: U4, title: UNTITLED, cwd: '/w/app', mtime: 40 },
  ]);
});

Deno.test('parseSessionsOutput cuts titles at 80 characters', () => {
  const long = 'x'.repeat(100);
  const [s] = parseSessionsOutput(
    [`S claude 1 /p/${U1}.jsonl`, 'C "cwd":"/w"', `T "aiTitle":"${long}"`]
      .join('\n'),
  );
  assertEquals(s.title, `${'x'.repeat(79)}…`);
});

const raw = (
  session: string,
  cwd: string,
  mtime: number,
  agent: RawSession['agent'] = 'claude',
): RawSession => ({ agent, session, title: 't', cwd, mtime });

Deno.test('pickSessions keeps sessions under a repo, deepest repo wins, newest first', () => {
  const repos = [
    { folder: '/host/app', containerFolder: '/workspaces/app' },
    { folder: '/host/lib', containerFolder: '/workspaces/app/lib' },
    { folder: '/host/gone', containerFolder: null },
  ];
  const picked = pickSessions([
    raw(U1, '/workspaces/app', 10),
    raw(U2, '/workspaces/app/sub', 30),
    raw(U3, '/workspaces/app2', 40),
    raw(U4, '/workspaces/app/lib/x', 20),
    raw(U5, '/workspaces', 50, 'pi'),
    raw(U1, '/workspaces/app', 5),
  ], repos);
  assertEquals(
    picked.map((s) => [s.session, s.root, s.updatedAt]),
    [
      [U2, '/host/app', new Date(30_000).toISOString()],
      [U4, '/host/lib', new Date(20_000).toISOString()],
      [U1, '/host/app', new Date(10_000).toISOString()],
    ],
  );
});

Deno.test('pickSessions caps the list at MAX_SESSIONS across agents', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    raw(
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      '/w',
      i,
      i % 2 ? 'pi' : 'claude',
    ));
  const picked = pickSessions(many, [{ folder: '/h', containerFolder: '/w' }]);
  assertEquals(picked.length, MAX_SESSIONS);
  assertEquals(picked[0].updatedAt, new Date(29_000).toISOString());
  assertEquals(picked.at(-1)!.updatedAt, new Date(10_000).toISOString());
});

/** A scratch `HOME` holding each agent's sessions, with set mtimes. */
async function homeFixture(): Promise<string> {
  const home = await Deno.realPath(await Deno.makeTempDir());
  const write = async (path: string, lines: unknown[], mtime: number) => {
    const file = join(home, path);
    await Deno.mkdir(join(file, '..'), { recursive: true });
    await Deno.writeTextFile(
      file,
      lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join(
        '\n',
      ) + '\n',
    );
    await Deno.utime(file, mtime, mtime);
  };
  const claude = '.claude/projects';
  await write(`${claude}/-workspaces-app/${U1}.jsonl`, [
    { type: 'mode', mode: 'normal', sessionId: U1 },
    {
      type: 'attachment',
      attachment: { text: 'mentions "cwd":"/elsewhere" escaped' },
    },
    { type: 'user', cwd: '/workspaces/app', message: { content: 'hi' } },
    { type: 'user', cwd: '/workspaces/app/sub' },
    { type: 'ai-title', aiTitle: 'Old title' },
    { type: 'custom-title', customTitle: 'My "named" session' },
    { type: 'ai-title', aiTitle: 'Newer ai title' },
  ], 1000);
  await write(`${claude}/-workspaces-app-sub/${U2}.jsonl`, [
    { type: 'user', cwd: '/workspaces/app/sub' },
    { type: 'last-prompt', lastPrompt: 'first\nprompt' },
    { type: 'last-prompt', lastPrompt: 'last prompt' },
  ], 3000);
  await write(`${claude}/-workspaces-other/${U3}.jsonl`, [
    { type: 'user', cwd: '/workspaces/other' },
  ], 5000);
  await write(`${claude}/-workspaces-app2/${U4}.jsonl`, [
    { type: 'user', cwd: '/workspaces/app2' },
  ], 5000);
  await write(`${claude}/-workspaces-app/${U1}/subagents/agent-a.jsonl`, [
    { type: 'user', cwd: '/workspaces/app' },
  ], 6000);
  await write(`${claude}/-workspaces-app/notes.jsonl`, [
    { type: 'user', cwd: '/workspaces/app' },
  ], 6000);
  await write(
    `.pi/agent/sessions/--workspaces-app--/2026-10-20T18-36-51-243Z_${U5}.jsonl`,
    [
      { type: 'session', version: 3, id: U5, cwd: '/workspaces/app' },
      { type: 'session_info', id: 'a', name: 'Pi named' },
      {
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      },
      { type: 'tool', schema: { name: 'not a title' } },
    ],
    2000,
  );
  await write(`.pi/agent/sessions/--workspaces-app--/x_${U6}.jsonl`, [
    { type: 'session', version: 3, id: U6, cwd: '/workspaces/app' },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply OK\nplease' }],
      },
    },
  ], 500);
  await write(`.copilot/session-state/${U7}/workspace.yaml`, [
    `id: ${U7}`,
    'cwd: /workspaces/app',
    'name: Copilot named',
    'user_named: true',
  ], 100);
  await write(`.copilot/session-state/${U7}/events.jsonl`, ['{}'], 4000);
  await write(`.copilot/session-state/${U8}/workspace.yaml`, [
    `id: ${U8}`,
    'cwd: /tmp/elsewhere',
  ], 7000);
  return home;
}

Deno.test({
  name: 'listAgentSessions runs the real script against each agent’s files',
  // `stat -c` is GNU / BusyBox: the containers', not macOS's.
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const home = await homeFixture();
    try {
      const calls: string[][] = [];
      const run: DockerRun = async (args) => {
        calls.push(args);
        const cmd = args.slice(args.indexOf(info.containerId) + 1);
        const out = await new Deno.Command(cmd[0], {
          args: cmd.slice(1),
          clearEnv: true,
          env: { HOME: home, PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin' },
          stdout: 'piped',
          stderr: 'piped',
        }).output();
        return {
          code: out.code,
          stdout: out.stdout,
          stderr: new TextDecoder().decode(out.stderr),
        };
      };
      const sessions = await listAgentSessions(info, [
        { folder: '/host/app', containerFolder: '/workspaces/app' },
        { folder: '/host/nowhere', containerFolder: null },
      ], run);
      assertEquals(
        sessions.map((s) => [s.agent, s.session, s.title, s.cwd, s.root]),
        [
          ['copilot', U7, 'Copilot named', '/workspaces/app', '/host/app'],
          ['claude', U2, 'last prompt', '/workspaces/app/sub', '/host/app'],
          ['pi', U5, 'Pi named', '/workspaces/app', '/host/app'],
          ['claude', U1, 'My "named" session', '/workspaces/app', '/host/app'],
          ['pi', U6, 'Reply OK', '/workspaces/app', '/host/app'],
        ],
      );
      assertEquals(sessions[0].updatedAt, new Date(4_000_000).toISOString());
      assertEquals(calls.length, 1);
      const sh = calls[0].indexOf('sh');
      assertEquals(calls[0].slice(sh, sh + 2), ['sh', '-c']);
      assertEquals(calls[0].slice(sh + 3), [
        'sh',
        String(2 * MAX_SESSIONS),
        '-workspaces-app',
        ':',
        '--workspaces-app',
      ]);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});

Deno.test('listAgentSessions runs nothing when no repo is mounted, throws on a failed exec', async () => {
  let ran = 0;
  const failing: DockerRun = () => {
    ran++;
    return Promise.resolve({
      code: 126,
      stdout: new Uint8Array(),
      stderr: 'exec failed\n',
    });
  };
  assertEquals(
    await listAgentSessions(
      info,
      [{ folder: '/h', containerFolder: null }],
      failing,
    ),
    [],
  );
  assertEquals(ran, 0);
  let message = '';
  try {
    await listAgentSessions(
      info,
      [{ folder: '/h', containerFolder: '/w' }],
      failing,
    );
  } catch (e) {
    message = (e as Error).message;
  }
  assertEquals(message, 'exec failed');
});

const parse = (m: Record<string, unknown>) =>
  parseClientMessage(JSON.stringify(m));

Deno.test('parseClientMessage: list_sessions and resume_session', () => {
  assertEquals(parse({ type: 'list_sessions', id: 'r1', container: 'c1' }), {
    ok: true,
    msg: { type: 'list_sessions', id: 'r1', container: 'c1' },
  });
  assertEquals(parse({ type: 'list_sessions', id: 'r1' }).ok, false);
  assertEquals(
    parse({
      type: 'resume_session',
      id: 'r2',
      container: 'c1',
      agent: 'pi',
      session: U5,
    }),
    {
      ok: true,
      msg: {
        type: 'resume_session',
        id: 'r2',
        container: 'c1',
        agent: 'pi',
        session: U5,
      },
    },
  );
  for (
    const bad of [
      { agent: 'opencode', session: U1 },
      { agent: 'nope', session: U1 },
      { agent: 'claude', session: 'not-a-uuid' },
      { agent: 'claude', session: `${U1}; rm -rf /` },
      { agent: 'claude', session: U5.toUpperCase() },
      { agent: 'claude', session: U1, container: undefined },
    ]
  ) {
    const result = parse({
      type: 'resume_session',
      id: 'r3',
      container: 'c1',
      ...bad,
    });
    assertEquals(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assertEquals(result.rejection.code, 'bad_request');
  }
});
