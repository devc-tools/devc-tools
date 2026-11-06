import { test } from 'node:test';
import { deepStrictEqual as assertEquals, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  bridgeRequest,
  bridgeSupported,
  busyFrom,
  controlPane,
  createShell,
  desktopSessionName,
  ensureServer,
  type Frame,
  HerdrError,
  type HerdrTarget,
  loginShellFor,
  readSelection,
  type Spawn,
} from '../src/main/herdr.ts';

/** A fake child process: `answer` gets each stdin line and the process, and may write back. */
function fakeSpawn(
  answer: (
    line: string,
    p: ReturnType<typeof fakeChild>,
    args: string[],
  ) => void,
  calls: string[][] = [],
  onStart?: (p: ReturnType<typeof fakeChild>, args: string[]) => void,
): Spawn {
  return (_cmd, args) => {
    calls.push(args);
    const p = fakeChild();
    let buf = '';
    p.stdin.on('data', (d: Buffer) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        answer(line, p, args);
      }
    });
    onStart?.(p, args);
    return p as unknown as ChildProcessWithoutNullStreams;
  };
}

function fakeChild() {
  const e = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill(): void;
    exit(code: number): void;
  };
  e.stdin = new PassThrough();
  e.stdout = new PassThrough();
  e.stderr = new PassThrough();
  e.kill = () => e.exit(0);
  let gone = false;
  e.exit = (code) => {
    if (gone) return;
    gone = true;
    e.stdout.end();
    e.stderr.end();
    setImmediate(() => e.emit('close', code));
  };
  return e;
}

const target = (spawn: Spawn): HerdrTarget => ({
  herdrPath: '/usr/bin/herdr',
  session: 'devc-desktop-0123456789ab',
  env: {},
  spawn,
});

test('bridgeRequest: one request per connection, its own id, errors as HerdrError', async () => {
  const calls: string[][] = [];
  const t = target(fakeSpawn((line, p) => {
    const { id, method } = JSON.parse(line);
    // Another id first: ignored.
    p.stdout.write(JSON.stringify({ id: 'other', result: 'no' }) + '\n');
    if (method === 'boom') {
      p.stdout.write(
        JSON.stringify({
          id,
          error: { code: 'pane_not_found', message: 'x' },
        }) +
          '\n',
      );
    } else {
      p.stdout.write(JSON.stringify({ id, result: { method } }) + '\n');
    }
  }, calls));
  assertEquals(await bridgeRequest(t, 'pane.list', {}), {
    method: 'pane.list',
  });
  await rejects(
    bridgeRequest(t, 'boom', {}),
    (e) => e instanceof HerdrError && e.code === 'pane_not_found',
  );
  assertEquals(calls, [
    ['--session', 'devc-desktop-0123456789ab', 'remote-api-bridge'],
    ['--session', 'devc-desktop-0123456789ab', 'remote-api-bridge'],
  ]);
});

test('bridgeRequest: no server is no_session; any other exit bridge_exited', async () => {
  const exiting = (stderr: string) =>
    target(fakeSpawn((_line, p) => {
      p.stderr.write(stderr);
      p.exit(1);
    }));
  await rejects(
    bridgeRequest(
      exiting('failed to connect to remote Herdr API socket'),
      'x',
      {},
    ),
    (e) => e instanceof HerdrError && e.code === 'no_session',
  );
  await rejects(
    bridgeRequest(exiting('weird'), 'x', {}),
    (e) => e instanceof HerdrError && e.code === 'bridge_exited',
  );
});

test('bridgeSupported: exactly herdr-api-bridge-v1 and exit 0', async () => {
  const with_ = (out: string, code: number) =>
    target(fakeSpawn(() => {}, [], (p) => {
      p.stdout.write(out);
      p.exit(code);
    }));
  assertEquals(await bridgeSupported(with_('herdr-api-bridge-v1\n', 0)), true);
  assertEquals(await bridgeSupported(with_('herdr-api-bridge-v2\n', 0)), false);
  assertEquals(await bridgeSupported(with_('herdr-api-bridge-v1\n', 1)), false);
});

test('createShell: tab.create, then workspace.create on a session with no workspace', async () => {
  const methods: string[] = [];
  const t = target(fakeSpawn((line, p) => {
    const { id, method, params } = JSON.parse(line);
    methods.push(method);
    assertEquals(params, { cwd: '/home/me', focus: false });
    const reply = method === 'tab.create'
      ? { id, error: { code: 'workspace_not_found', message: 'none' } }
      : { id, result: { root_pane: { pane_id: 'w1:p1' } } };
    p.stdout.write(JSON.stringify(reply) + '\n');
  }));
  assertEquals(await createShell(t, '/home/me'), 'w1:p1');
  assertEquals(methods, ['tab.create', 'workspace.create']);
});

test('busyFrom: idle when the shell leads the foreground group, else the program', () => {
  const info = (group: number, name: string) => ({
    process_info: {
      shell_pid: 10,
      foreground_process_group_id: group,
      foreground_processes: [{ name }],
    },
  });
  assertEquals(busyFrom(info(10, 'bash')), null);
  assertEquals(busyFrom(info(42, 'vi')), 'vi');
  assertEquals(busyFrom({}), null);
  assertEquals(busyFrom(null), null);
});

test('readSelection: pane.get scroll, then content points', async () => {
  const seen: unknown[] = [];
  const t = target(fakeSpawn((line, p) => {
    const { id, method, params } = JSON.parse(line);
    seen.push([method, params]);
    const result = method === 'pane.get'
      ? {
        pane: {
          scroll: {
            offset_from_bottom: 2,
            max_offset_from_bottom: 10,
            viewport_rows: 20,
          },
        },
      }
      : { text: 'hello' };
    p.stdout.write(JSON.stringify({ id, result }) + '\n');
  }));
  assertEquals(
    await readSelection(t, 'w1:p1', { column: 1, row: 0 }, {
      column: 5,
      row: 3,
    }),
    'hello',
  );
  assertEquals(seen[1], ['pane.selection.read', {
    pane_id: 'w1:p1',
    anchor: { row: 8, col: 1 },
    cursor: { row: 11, col: 5 },
  }]);
});

test('controlPane: frames out, commands in, release ends it quietly', async () => {
  const written: unknown[] = [];
  let child!: ReturnType<typeof fakeChild>;
  const t = target(
    fakeSpawn((line) => written.push(JSON.parse(line)), [], (p, args) => {
      child = p;
      assertEquals(args.slice(2), [
        'terminal',
        'session',
        'control',
        'w1:p1',
        '--takeover',
        '--cols',
        '80',
        '--rows',
        '24',
      ]);
    }),
  );
  const frames: Frame[] = [];
  const closed: string[] = [];
  const ctl = controlPane(t, 'w1:p1', 80, 24, {
    frame: (f) => frames.push(f),
    closed: (r) => closed.push(r),
  });
  child.stdout.write(
    JSON.stringify({
      type: 'terminal.frame',
      seq: 1,
      full: true,
      width: 80,
      height: 24,
      encoding: 'base64',
      bytes: 'aGk=',
    }) + '\n',
  );
  ctl.send({ type: 'terminal.input', bytes: 'eA==' });
  await new Promise((r) => setImmediate(r));
  assertEquals(frames, [{
    seq: 1,
    full: true,
    cols: 80,
    rows: 24,
    bytes: 'aGk=',
  }]);
  ctl.release();
  ctl.send({ type: 'terminal.input', bytes: 'eQ==' });
  child.exit(0);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(written, [
    { type: 'terminal.input', bytes: 'eA==' },
    { type: 'terminal.release' },
  ]);
  assertEquals(closed, []);
});

test('controlPane: Herdr closing it is reported with its reason', async () => {
  let child!: ReturnType<typeof fakeChild>;
  const t = target(fakeSpawn(() => {}, [], (p) => child = p));
  const closed: string[] = [];
  controlPane(t, 'w1:p1', 80, 24, {
    frame: () => {},
    closed: (r) => closed.push(r),
  });
  child.stdout.write(
    JSON.stringify({ type: 'terminal.closed', reason: 'pane_closed' }) + '\n',
  );
  await new Promise((r) => setImmediate(r));
  child.exit(0);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(closed, ['pane_closed']);
});

test('ensureServer: a running session is left alone; else started detached, in a login shell', async () => {
  let running = false;
  const listing = () =>
    JSON.stringify({
      sessions: [{ name: 'devc-desktop-0123456789ab', running }],
    });
  const t = target(fakeSpawn(() => {}, [], (p) => {
    p.stdout.write(listing());
    p.exit(0);
  }));
  const started: [string, string[], string][] = [];
  running = true;
  await ensureServer(t, '/bin/zsh', '/home/me', {
    detachedSpawn: (c, a, d) => started.push([c, a, d]),
    wait: async () => {},
  });
  assertEquals(started.length, 0);
  running = false;
  await ensureServer(t, '/usr/bin/fish', '/home/me', {
    detachedSpawn: (c, a, d) => {
      started.push([c, a, d]);
      running = true;
    },
    wait: async () => {},
  });
  assertEquals(started, [[
    '/bin/sh',
    [
      '-lc',
      'export SHELL; exec "$0" "$@"',
      '/usr/bin/herdr',
      '--session',
      'devc-desktop-0123456789ab',
      'server',
    ],
    '/home/me',
  ]]);
});

test('loginShellFor: POSIX shells as they are, anything else /bin/sh', () => {
  assertEquals(loginShellFor('/bin/zsh'), '/bin/zsh');
  assertEquals(
    loginShellFor('/opt/homebrew/bin/bash'),
    '/opt/homebrew/bin/bash',
  );
  assertEquals(loginShellFor('/usr/bin/fish'), '/bin/sh');
});

test('desktopSessionName: devc-desktop- and 12 hex of its userData, never a hostSessionName', () => {
  const a = desktopSessionName('/Users/a/Library/Application Support/devcd');
  assertEquals(/^devc-desktop-[0-9a-f]{12}$/.test(a), true);
  assertEquals(
    desktopSessionName('/Users/a/Library/Application Support/devcd'),
    a,
  );
  assertEquals(desktopSessionName('/home/a/.config/devcd') === a, false);
  // devc web's host sessions have '-' here (web_host_env_test.ts).
  assertEquals(a.at(-9) === '-', false);
});
