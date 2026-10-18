import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import {
  BridgeError,
  ContainerSession,
  herdrArgv,
  isHerdrLaunch,
  isNoSessionError,
  isStructuralEvent,
  normalizeEventName,
  paneAtFolder,
  serverLogTail,
  snapshotPaneIds,
} from '../web/herdr_bridge.ts';
import { spawnLines, splitLines } from '../web/proc.ts';

Deno.test('normalizeEventName turns the first underscore into a dot', () => {
  assertEquals(normalizeEventName('pane_created'), 'pane.created');
  assertEquals(
    normalizeEventName('workspace_metadata_updated'),
    'workspace.metadata_updated',
  );
  assertEquals(
    normalizeEventName('pane_agent_detected'),
    'pane.agent_detected',
  );
});

Deno.test('normalizeEventName leaves dotted names alone', () => {
  assertEquals(
    normalizeEventName('pane.agent_status_changed'),
    'pane.agent_status_changed',
  );
});

Deno.test('isStructuralEvent: tree changes yes, pane updates and status no', () => {
  for (
    const name of [
      'workspace.created',
      'workspace.metadata_updated',
      'tab.renamed',
      'worktree.opened',
      'layout.updated',
      'pane.created',
      'pane.closed',
      'pane.moved',
      'pane.exited',
    ]
  ) {
    assert(isStructuralEvent(name), name);
  }
  for (
    const name of [
      'pane.updated',
      'pane.focused',
      'pane.agent_detected',
      'pane.agent_status_changed',
    ]
  ) {
    assert(!isStructuralEvent(name), name);
  }
});

Deno.test('isNoSessionError recognizes the bridge NotFound failure', () => {
  assert(isNoSessionError(
    'Error: Custom { kind: NotFound, error: "failed to connect to remote Herdr API socket /home/u/.config/herdr/sessions/devc/herdr.sock: No such file or directory (os error 2)" }',
  ));
  assert(!isNoSessionError('Error: permission denied'));
});

Deno.test('herdrArgv uses docker exec -i, never -t, and the absolute herdr path', () => {
  const argv = herdrArgv({
    containerId: 'c1',
    user: 'vscode',
    herdrPath: '/home/vscode/.local/bin/herdr',
    session: 'devc',
  }, ['remote-api-bridge']);
  assertEquals(argv, [
    'exec',
    '-i',
    '-u',
    'vscode',
    'c1',
    '/home/vscode/.local/bin/herdr',
    '--session',
    'devc',
    'remote-api-bridge',
  ]);
  assert(!argv.includes('-t') && !argv.includes('-it'));
});

Deno.test('snapshotPaneIds reads arrays and maps', () => {
  assertEquals(
    snapshotPaneIds({ panes: [{ pane_id: 'w1:p1' }, { pane_id: 'w1:p2' }] }),
    ['w1:p1', 'w1:p2'],
  );
  assertEquals(snapshotPaneIds({ panes: { a: { pane_id: 'w2:p1' } } }), [
    'w2:p1',
  ]);
  assertEquals(snapshotPaneIds({}), []);
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield p;
}

Deno.test('splitLines reassembles lines split across chunks', async () => {
  const out: string[] = [];
  for await (
    const line of splitLines(chunks('{"a":', '1}\n{"b"', ':2}\r\n\n', 'tail'))
  ) out.push(line);
  assertEquals(out, ['{"a":1}', '{"b":2}', '', 'tail']);
});

Deno.test('spawnLines: a reader that stops early leaves stdout undestroyed and drained', async () => {
  // Like bridgeRequest returning on its answer while the child still has output to write.
  const proc = spawnLines('sh', [
    '-c',
    'echo first; head -c 1000000 /dev/zero | tr "\\0" x; echo; echo last',
  ]);
  for await (const line of proc.lines) {
    assertEquals(line, 'first');
    break;
  }
  // Undrained, the child blocks on a full pipe and never exits.
  assertEquals(await proc.status, { code: 0 });
});

Deno.test("isHerdrLaunch: herdr runs yes, devc web's own bridge execs no", () => {
  for (
    const cmd of [
      'herdr',
      '/home/vscode/.local/bin/herdr --session devc server',
      `/bin/bash -lc clear; printf '\\033[3J'; exec "$0" "$@" herdr --session devc`,
    ]
  ) {
    assert(isHerdrLaunch(cmd), cmd);
  }
  for (
    const cmd of [
      '/home/vscode/.local/bin/herdr --session devc remote-api-bridge',
      '/home/vscode/.local/bin/herdr --session devc remote-api-bridge --check',
      '/bin/bash -l',
      'sh -c herdr-ish',
    ]
  ) {
    assert(!isHerdrLaunch(cmd), cmd);
  }
});

const shell = (pane_id: string, tab_id: string, cwd: string, extra = {}) => ({
  pane_id,
  tab_id,
  workspace_id: tab_id.split(':')[0],
  cwd,
  foreground_cwd: cwd,
  ...extra,
});

Deno.test('paneAtFolder: no snapshot, no match', () => {
  assertEquals(paneAtFolder(null, '/w/a'), null);
  assertEquals(
    paneAtFolder({ panes: [shell('w1:p1', 'w1:t1', '/w/b')] }, '/w/a'),
    null,
  );
});

Deno.test('paneAtFolder: a trailing slash on either side still matches', () => {
  const snap = { panes: [shell('w1:p1', 'w1:t1', '/w/a/')] };
  assertEquals(paneAtFolder(snap, '/w/a'), {
    pane_id: 'w1:p1',
    tab_id: 'w1:t1',
  });
  assertEquals(
    paneAtFolder({ panes: [shell('w1:p1', 'w1:t1', '/w/a')] }, '/w/a/'),
    { pane_id: 'w1:p1', tab_id: 'w1:t1' },
  );
});

Deno.test('paneAtFolder: of two matches, the lowest-numbered tab wins', () => {
  const snap = {
    workspaces: [{ workspace_id: 'w1', number: 1 }],
    tabs: [
      { tab_id: 'w1:t5', workspace_id: 'w1', number: 3 },
      { tab_id: 'w1:t2', workspace_id: 'w1', number: 2 },
    ],
    panes: [shell('w1:p5', 'w1:t5', '/w/a'), shell('w1:p2', 'w1:t2', '/w/a')],
  };
  assertEquals(paneAtFolder(snap, '/w/a'), {
    pane_id: 'w1:p2',
    tab_id: 'w1:t2',
  });
});

Deno.test("paneAtFolder: a foreground process's folder does not count", () => {
  const snap = {
    panes: [
      shell('w1:p1', 'w1:t1', '/tmp', { foreground_cwd: '/w/a' }),
    ],
  };
  assertEquals(paneAtFolder(snap, '/w/a'), null);
  assertEquals(paneAtFolder(snap, '/tmp'), {
    pane_id: 'w1:p1',
    tab_id: 'w1:t1',
  });
});

Deno.test('paneAtFolder: an agent pane at the folder never counts', () => {
  const agent = shell('w1:p1', 'w1:t1', '/w/a', { agent: 'claude' });
  assertEquals(paneAtFolder({ panes: [agent] }, '/w/a'), null);
  assertEquals(
    paneAtFolder({ panes: [agent, shell('w1:p2', 'w1:t2', '/w/a')] }, '/w/a'),
    { pane_id: 'w1:p2', tab_id: 'w1:t2' },
  );
});

type RunText = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * A session whose lifecycle finds a server only once `up` (else no session), with `runText`
 * stubbed, recording each state it is in.
 */
class NoServerSession extends ContainerSession {
  runs = 0;
  up = false;
  override run(): Promise<void> {
    this.runs++;
    this.state = this.up ? 'connected' : 'no-session';
    return Promise.resolve();
  }
}

const hooks = {
  onState() {},
  onSnapshot() {},
  onPaneUpdated() {},
  onAgentStatus() {},
  onTeardown() {},
};

const target = {
  containerId: 'c1',
  user: 'vscode',
  herdrPath: '/usr/local/bin/herdr',
  session: 'devc',
};

Deno.test("startSession throws no_session with the server log's tail", async () => {
  const calls: string[][] = [];
  const run: RunText = (_cmd, args) => {
    calls.push(args);
    return Promise.resolve(
      args.includes(
          'tail -n 10 "$HOME/.config/herdr/sessions/$1/herdr-server.log"',
        )
        ? { code: 0, stdout: 'line 1\npanic: boom\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
  };
  const s = new NoServerSession(
    { id: 'c1' } as ConstructorParameters<typeof ContainerSession>[0],
    'devc',
    hooks,
    {
      runText: run,
      startTries: 3,
      startWaitMs: 1,
      serverUp: () => Promise.resolve(false),
    },
  );
  s.target = target;
  s.state = 'no-session';
  const err = await assertRejects(() => s.startSession(), BridgeError);
  assertEquals(err.code, 'no_session');
  assertEquals(err.message, "Herdr didn't come up in 0s.\nline 1\npanic: boom");
  // Only probed: the lifecycle never ran, so the state never left `no-session`.
  assertEquals(s.runs, 0);
  assertEquals(calls[0], [
    'exec',
    '-d',
    '-u',
    'vscode',
    'c1',
    '/bin/bash',
    '-lc',
    'export SHELL; exec "$0" "$@"',
    '/usr/local/bin/herdr',
    '--session',
    'devc',
    'server',
  ]);
  assertEquals(calls[1].slice(-2), ['_', 'devc']);
});

Deno.test('herdrLaunched runs the lifecycle once, when the server answers', async () => {
  let probes = 0;
  const s: NoServerSession = new NoServerSession(
    { id: 'c1' } as ConstructorParameters<typeof ContainerSession>[0],
    'devc',
    hooks,
    {
      startTries: 5,
      startWaitMs: 1,
      serverUp: (): Promise<boolean> => {
        s.up = ++probes >= 3;
        return Promise.resolve(s.up);
      },
    },
  );
  s.target = target;
  s.state = 'no-session';
  await s.herdrLaunched();
  assertEquals([probes, s.runs, s.state], [3, 1, 'connected']);
});

Deno.test('herdrLaunched never runs the lifecycle while there is no server', async () => {
  let probes = 0;
  const s = new NoServerSession(
    { id: 'c1' } as ConstructorParameters<typeof ContainerSession>[0],
    'devc',
    hooks,
    {
      startTries: 4,
      startWaitMs: 1,
      serverUp: () => Promise.resolve(++probes < 0),
    },
  );
  s.target = target;
  s.state = 'no-session';
  await s.herdrLaunched();
  assertEquals([probes, s.runs, s.state], [4, 0, 'no-session']);
});

Deno.test('serverLogTail is empty when the log is unreadable', async () => {
  assertEquals(
    await serverLogTail(
      target,
      () => Promise.resolve({ code: 1, stdout: '', stderr: 'no such file' }),
    ),
    '',
  );
  assertEquals(
    await serverLogTail(target, () => Promise.reject(new Error('no docker'))),
    '',
  );
});
