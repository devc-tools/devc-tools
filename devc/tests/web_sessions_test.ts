import { assertEquals } from 'jsr:@std/assert';
import { join } from 'jsr:@std/path';
import type { ContainerInfo } from '@devc-tools/core/container.ts';
import { ContainerEnvironment, type DockerRun } from '../web/containers.ts';
import {
  claudeDirPrefix,
  listAgentSessions,
  markRunning,
  MAX_SESSIONS,
  parseRunningOutput,
  parseSessionsOutput,
  pickSessions,
  piDirPrefix,
  type RawSession,
  RUNNING_SCRIPT,
  runningPane,
  SESSIONS_SCRIPT,
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

/** The container `info` reaches, its docker runs stubbed. */
function envOf(run: DockerRun) {
  return new ContainerEnvironment(
    { id: info.containerId, localFolder: '/src/app' },
    'devc',
    { resolve: () => Promise.resolve(info), run },
  );
}

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

Deno.test('parseSessionsOutput dates a Claude session by its last timestamp, else its mtime', () => {
  const out = [
    `S claude 900 /p/${U1}.jsonl`,
    'C "cwd":"/w"',
    'L "timestamp":"1970-01-01T00:01:40.900Z"',
    `S claude 800 /p/${U2}.jsonl`,
    'C "cwd":"/w"',
    'L "timestamp":"not a date"',
    `S claude 700 /p/${U3}.jsonl`,
    'C "cwd":"/w"',
  ].join('\n');
  assertEquals(parseSessionsOutput(out).map((s) => s.mtime), [100, 800, 700]);
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

Deno.test('pickSessions caps each repo at MAX_SESSIONS across agents; a busy repo leaves the others theirs', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    raw(
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      '/w',
      100 + i,
      i % 2 ? 'pi' : 'claude',
    ));
  const picked = pickSessions([...many, raw(U1, '/v', 1)], [
    { folder: '/h', containerFolder: '/w' },
    { folder: '/g', containerFolder: '/v' },
  ]);
  const busy = picked.filter((s) => s.root === '/h');
  assertEquals(busy.length, MAX_SESSIONS);
  assertEquals(busy[0].updatedAt, new Date(129_000).toISOString());
  assertEquals(busy.at(-1)!.updatedAt, new Date(110_000).toISOString());
  assertEquals(
    picked.filter((s) => s.root === '/g').map((s) => s.session),
    [U1],
  );
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
    {
      type: 'user',
      cwd: '/workspaces/app',
      message: { content: 'hi' },
      timestamp: '1970-01-01T00:13:20.000Z',
    },
    {
      type: 'user',
      cwd: '/workspaces/app/sub',
      timestamp: '1970-01-01T00:16:40.500Z',
    },
    { type: 'ai-title', aiTitle: 'Old title' },
    { type: 'custom-title', customTitle: 'My "named" session' },
    { type: 'ai-title', aiTitle: 'Newer ai title' },
    // Claude appends untimed lines to an old session, touching the file long after its last turn.
    { type: 'system', subtype: 'away_summary', content: 'later' },
  ], 9000);
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
      const sessions = await listAgentSessions(envOf(run), [
        { folder: '/host/app', containerFolder: '/workspaces/app' },
        { folder: '/host/nowhere', containerFolder: null },
      ], 'devc');
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
      assertEquals(sessions[3].updatedAt, new Date(1_000_000).toISOString());
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

Deno.test({
  name:
    'SESSIONS_SCRIPT caps candidates per folder, so a busy one leaves the others theirs',
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const home = await homeFixture();
    try {
      // The cap is 1; `app` has newer sessions than `other` in every agent.
      const out = await new Deno.Command('sh', {
        args: [
          '-c',
          SESSIONS_SCRIPT,
          'sh',
          '1',
          '-workspaces-app',
          '-workspaces-other',
          ':',
          '--workspaces-app',
        ],
        clearEnv: true,
        env: { HOME: home, PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin' },
        stdout: 'piped',
      }).output();
      const heads = new TextDecoder().decode(out.stdout).split('\n')
        .filter((l) => l.startsWith('S '))
        .map((l) => l.split(' ').slice(1, 3).join(' '));
      // Claude: app's newest file (U1, 9000) and other's one; `app` also prefixes `app2` and
      // `app-sub`, so they share its one. pi: one for its one folder. Copilot: 1 × 2 folders.
      assertEquals(heads, [
        'claude 9000',
        'claude 5000',
        'pi 2000',
        'copilot 7000',
        'copilot 4000',
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
    await listAgentSessions(envOf(failing), [{
      folder: '/h',
      containerFolder: null,
    }], 'devc'),
    [],
  );
  assertEquals(ran, 0);
  let message = '';
  try {
    await listAgentSessions(envOf(failing), [{
      folder: '/h',
      containerFolder: '/w',
    }], 'devc');
  } catch (e) {
    message = (e as Error).message;
  }
  assertEquals(message, 'exec failed');
});

Deno.test('parseRunningOutput reads R lines anywhere and drops malformed ones', () => {
  const out = [
    `S claude 5 /h/.claude/projects/-w/${U1}.jsonl`,
    `R ${U1} devc w1:pG`,
    `R not-a-uuid devc w1:p2`,
    `R ${U2} devc w1:p 2`,
    `R ${U3} other w2:p7`,
    'R',
  ].join('\n');
  assertEquals(parseRunningOutput(out), [
    { session: U1, herdrSession: 'devc', paneId: 'w1:pG' },
    { session: U3, herdrSession: 'other', paneId: 'w2:p7' },
  ]);
  // The listing ignores them: an R line is no session line of the block before it.
  assertEquals(
    parseSessionsOutput(`${out}\nC "cwd":"/w"`).map((s) => s.session),
    [U1],
  );
});

Deno.test('markRunning sets pane_id on Claude sessions running in this Herdr session only', () => {
  const base = {
    title: 't',
    cwd: '/w',
    root: '/h',
    updatedAt: '2026-10-21T00:00:00.000Z',
  };
  const sessions = [
    { ...base, agent: 'claude' as const, session: U1 },
    { ...base, agent: 'claude' as const, session: U2 },
    { ...base, agent: 'pi' as const, session: U3 },
  ];
  assertEquals(
    markRunning(sessions, [
      { session: U1, herdrSession: 'devc', paneId: 'w1:pA' },
      { session: U1, herdrSession: 'devc', paneId: 'w1:pB' },
      { session: U2, herdrSession: 'other', paneId: 'w1:pC' },
      { session: U3, herdrSession: 'devc', paneId: 'w1:pD' },
    ], 'devc'),
    [{ ...sessions[0], pane_id: 'w1:pA' }, sessions[1], sessions[2]],
  );
});

Deno.test({
  name:
    'RUNNING_SCRIPT finds a live process by its record, and not a stale record',
  // `/proc` is Linux's.
  ignore: Deno.build.os !== 'linux',
  fn: async () => {
    const home = await Deno.realPath(await Deno.makeTempDir());
    const child = new Deno.Command('sleep', {
      args: ['30'],
      clearEnv: true,
      env: { HERDR_PANE_ID: 'w1:p9', HERDR_SESSION: 'devc' },
      stdout: 'null',
      stderr: 'null',
    }).spawn();
    try {
      // Through `cat`: Deno's permissions refuse `/proc` reads short of --allow-all.
      const stat = new TextDecoder().decode(
        (await new Deno.Command('cat', { args: [`/proc/${child.pid}/stat`] })
          .output()).stdout,
      );
      const procStart = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
      await Deno.mkdir(join(home, '.claude/sessions'), { recursive: true });
      const record = (pid: number, session: string, start: string) =>
        Deno.writeTextFile(
          join(home, `.claude/sessions/${pid}.json`),
          JSON.stringify({ pid, sessionId: session, procStart: start }),
        );
      await record(child.pid, U1, procStart);
      // Same pid, another start: a reused pid's old record.
      await record(child.pid + 1_000_000, U2, procStart);
      await Deno.writeTextFile(join(home, '.claude/sessions/x.json'), '{}');
      const run: DockerRun = async (args) => {
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
      assertEquals(await runningPane(envOf(run), U1, 'devc'), 'w1:p9');
      assertEquals(await runningPane(envOf(run), U1, 'other'), null);
      assertEquals(await runningPane(envOf(run), U2, 'devc'), null);
      await record(child.pid, U3, `${procStart}0`);
      assertEquals(await runningPane(envOf(run), U3, 'devc'), null);
      assertEquals(RUNNING_SCRIPT.includes('${'), false);
    } finally {
      child.kill();
      await child.status;
      await Deno.remove(home, { recursive: true });
    }
  },
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
