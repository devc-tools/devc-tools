import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { fromFileUrl } from 'jsr:@std/path';
import type {
  ContainerInfo,
  ContainerMount,
} from '@devc-tools/core/container.ts';
import {
  launcherArgv,
  type LauncherOutput,
  LspError,
  LspManager,
  type LspTarget,
  type ServeSpawn,
} from '../web/lsp_manager.ts';
import { LspConfigStore } from '../web/lsp_config.ts';
import { type ByteProc, spawnBytes } from '../web/proc.ts';
import type { Peer } from '../web/lsp_session.ts';

type Msg = Record<string, unknown>;

const FAKE = fromFileUrl(
  new URL('./fixtures/fake_lsp_server.ts', import.meta.url),
);
const INFO: ContainerInfo = {
  containerId: 'c1',
  remoteUser: 'dev',
  remoteWorkspaceFolder: '/workspaces/app',
  remoteEnv: {},
};

/** A browser connection that keeps what it was sent. */
class FakePeer implements Peer {
  lsp: Msg[] = [];
  status: Msg[] = [];
  send(text: string) {
    const m = JSON.parse(text);
    if (m.type === 'lsp') this.lsp.push(m.message);
    else this.status.push(m);
  }
}

async function until<T>(
  f: () => T | undefined | null | false,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const describeJson = (root: string, extra: Msg = {}) =>
  JSON.stringify({
    protocol: 1,
    root,
    languageId: 'typescript',
    server: 'fake 1',
    initializationOptions: { enable: true },
    settings: { fake: { mode: 'on' } },
    ...extra,
  });

interface Harness {
  manager: LspManager;
  runs: string[][];
  procs: ByteProc[];
  spawns: string[][];
}

function harness(opts: {
  run?: (args: string[]) => LauncherOutput | Promise<LauncherOutput>;
  serveFlags?: string[];
  idleMs?: number;
  config?: LspConfigStore;
} = {}): Harness {
  const runs: string[][] = [];
  const procs: ByteProc[] = [];
  const spawns: string[][] = [];
  const spawn: ServeSpawn = (_info, _language, args) => {
    spawns.push(args);
    const p = spawnBytes(Deno.execPath(), [
      'run',
      '--quiet',
      FAKE,
      ...(opts.serveFlags ?? []),
    ]);
    procs.push(p);
    return p;
  };
  const manager = new LspManager({
    run: (_info, _language, args) => {
      runs.push(args);
      return Promise.resolve(
        opts.run
          ? opts.run(args)
          : { code: 0, stdout: describeJson('/workspaces/app'), stderr: '' },
      );
    },
    spawn,
    idleMs: opts.idleMs,
    config: opts.config ?? null,
    containerRunning: () => Promise.resolve(true),
    warn: () => {},
  });
  return { manager, runs, procs, spawns };
}

const target = (
  path = '/workspaces/app/src/a.ts',
  mounts: ContainerMount[] = [],
): LspTarget => ({
  info: INFO,
  mounts,
  path,
});

/** Attaches `peer`, initializes like lsp-client, and waits for ready. */
async function attachReady(h: Harness, peer: FakePeer, t = target()) {
  const result = await h.manager.attach(peer, t);
  h.manager.send(peer, result.session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: null, capabilities: {}, rootUri: null },
  });
  await until(() => peer.lsp.find((m) => m.id === 1), 'initialize result');
  h.manager.send(peer, result.session, {
    jsonrpc: '2.0',
    method: 'initialized',
    params: {},
  });
  return result;
}

async function request(
  h: Harness,
  peer: FakePeer,
  session: string,
  id: number,
  method: string,
  params: unknown = {},
) {
  h.manager.send(peer, session, { jsonrpc: '2.0', id, method, params });
  return await until(() => peer.lsp.find((m) => m.id === id), method);
}

Deno.test('launcherArgv: devc-lsp-<language> through a login shell, as the remote user', () => {
  assertEquals(launcherArgv(INFO, 'typescript', ['describe', '/a b.ts']), [
    'exec',
    '-u',
    'dev',
    '-w',
    '/',
    'c1',
    '/bin/bash',
    '-lc',
    'exec "devc-lsp-$0" "$@"',
    'typescript',
    'describe',
    '/a b.ts',
  ]);
  assertEquals(launcherArgv(INFO, 'python', ['serve'], true).slice(0, 2), [
    'exec',
    '-i',
  ]);
});

Deno.test('attach → ready, a completion round trip, and diagnostics routed', async () => {
  const h = harness();
  const peer = new FakePeer();
  const result = await h.manager.attach(peer, target());
  assertEquals(result.uri, 'file:///workspaces/app/src/a.ts');
  assertEquals(result.languageId, 'typescript');
  assertEquals(result.server, 'fake 1');
  assertEquals(result.state, 'starting');
  assertEquals(h.runs, [['describe', '/workspaces/app/src/a.ts']]);
  assertEquals(h.spawns, [['serve', '--root', '/workspaces/app']]);
  h.manager.send(peer, result.session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: null, capabilities: {}, rootUri: null },
  });
  const init = await until(
    () => peer.lsp.find((m) => m.id === 1),
    'initialize',
  );
  assertEquals(
    ((init.result as Msg).capabilities as Msg).textDocumentSync,
    { openClose: true, change: 1 },
  );
  await until(() => peer.status.find((s) => s.state === 'ready'), 'ready');
  const completion = await request(
    h,
    peer,
    result.session,
    2,
    'textDocument/completion',
    {
      textDocument: { uri: result.uri },
      position: { line: 0, character: 0 },
    },
  );
  assertEquals((completion.result as Msg).items, [{ label: 'fakeCompletion' }]);
  h.manager.send(peer, result.session, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: result.uri,
        languageId: 'typescript',
        version: 0,
        text: 'hello',
      },
    },
  });
  const diag = await until(
    () => peer.lsp.find((m) => m.method === 'textDocument/publishDiagnostics'),
    'diagnostics',
  );
  assertEquals((diag.params as Msg).uri, result.uri);
  assertEquals(((diag.params as Msg).diagnostics as Msg[])[0].message, 'hello');
  // The server got the host's initialize, and the describe settings.
  const state = (await request(h, peer, result.session, 3, 'fake/state'))
    .result as Msg;
  assertEquals((state.initialize as Msg).rootUri, 'file:///workspaces/app');
  assertEquals((state.initialize as Msg).initializationOptions, {
    enable: true,
  });
  assertEquals(state.configuration, { fake: { mode: 'on' } });
  // A second attach of the same root reuses the session.
  const other = new FakePeer();
  const again = await h.manager.attach(other, target('/workspaces/app/b.ts'));
  assertEquals(again.session, result.session);
  assertEquals(again.state, 'ready');
  assertEquals(h.spawns.length, 1);
  // A connection that hasn't attached is dropped.
  const stranger = new FakePeer();
  h.manager.send(stranger, result.session, {
    jsonrpc: '2.0',
    id: 9,
    method: 'fake/state',
  });
  await h.manager.shutdown();
  assertEquals(stranger.lsp, []);
});

Deno.test('pull diagnostics through the fake server', async () => {
  const h = harness({ serveFlags: ['--pull'] });
  const peer = new FakePeer();
  const r = await attachReady(h, peer);
  h.manager.send(peer, r.session, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: r.uri,
        languageId: 'typescript',
        version: 0,
        text: 'pulled',
      },
    },
  });
  const diag = await until(
    () => peer.lsp.find((m) => m.method === 'textDocument/publishDiagnostics'),
    'pulled diagnostics',
  );
  assertEquals(
    ((diag.params as Msg).diagnostics as Msg[])[0].message,
    'pulled',
  );
  await h.manager.shutdown();
});

Deno.test('server exit gives exited with the stderr tail; the next attach starts a new one', async () => {
  const h = harness();
  const peer = new FakePeer();
  const r = await attachReady(h, peer);
  h.manager.send(peer, r.session, {
    jsonrpc: '2.0',
    id: 5,
    method: 'fake/crash',
  });
  const exited = await until(
    () => peer.status.find((s) => s.state === 'exited'),
    'exited',
  );
  assertEquals(exited.detail, 'exit code 3: fatal: kaboom');
  assertEquals(h.manager.size, 0);
  const next = await h.manager.attach(peer, target());
  assert(next.session !== r.session);
  assertEquals(h.spawns.length, 2);
  await h.manager.shutdown();
});

Deno.test('junk a login shell prints before the server starts is skipped', async () => {
  const h = harness({
    serveFlags: ['--junk', 'Welcome!\nnvm: now using node\n'],
  });
  const peer = new FakePeer();
  await attachReady(h, peer);
  await h.manager.shutdown();
});

Deno.test('restart: starting, then the page re-initializes a new process', async () => {
  const h = harness();
  const peer = new FakePeer();
  const r = await attachReady(h, peer);
  h.manager.send(peer, r.session, {
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: r.uri,
        languageId: 'typescript',
        version: 0,
        text: 'a',
      },
    },
  });
  await until(
    () => peer.lsp.find((m) => m.method === 'textDocument/publishDiagnostics'),
    'diag',
  );
  const first = h.procs[0];
  peer.status = [];
  await h.manager.restart(r.session);
  assertEquals(
    (await first.status).code,
    0,
    'the old server got shutdown and exit',
  );
  assertEquals(peer.status.at(-1)?.state, 'starting');
  assertEquals(h.spawns.length, 2);
  peer.lsp = [];
  h.manager.send(peer, r.session, {
    jsonrpc: '2.0',
    id: 11,
    method: 'initialize',
    params: {},
  });
  await until(() => peer.lsp.find((m) => m.id === 11), 're-initialize');
  await until(
    () => peer.status.find((s) => s.state === 'ready'),
    'ready again',
  );
  const state = (await request(h, peer, r.session, 12, 'fake/state'))
    .result as Msg;
  assert(state.initialize, 'the new process was initialized');
  assert(
    !(state.notifications as string[]).includes('textDocument/didOpen'),
    'a fresh process',
  );
  await h.manager.shutdown();
});

Deno.test('shutdown sends shutdown then exit: the server exits 0', async () => {
  const h = harness();
  const peer = new FakePeer();
  await attachReady(h, peer);
  await h.manager.shutdown();
  assertEquals((await h.procs[0].status).code, 0);
  assertEquals(peer.status.at(-1)?.state, 'exited');
  assertEquals(peer.status.at(-1)?.detail, 'devc web stopped');
  assertEquals(h.manager.size, 0);
});

Deno.test('idle: a session with no connection stops after the idle time', async () => {
  const h = harness({ idleMs: 100 });
  const peer = new FakePeer();
  const r = await attachReady(h, peer);
  h.manager.detach(peer, r.session);
  assertEquals((await h.procs[0].status).code, 0, 'stopped gracefully');
  await until(() => h.manager.size === 0, 'the session removed');
});

Deno.test('container stopped: exited, container stopped', async () => {
  const h = harness();
  const peer = new FakePeer();
  await attachReady(h, peer);
  h.manager.containerGone('c1');
  assertEquals(peer.status.at(-1), {
    type: 'lsp_status',
    session: peer.status.at(-1)?.session,
    state: 'exited',
    detail: 'container stopped',
  });
  await h.procs[0].status;
  assertEquals(h.manager.size, 0);
});

Deno.test('watched files: a host-side write reaches the server as didChangeWatchedFiles', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const h = harness();
    const peer = new FakePeer();
    const mounts: ContainerMount[] = [
      {
        type: 'bind',
        source: dir,
        destination: '/workspaces/app',
      } as ContainerMount,
    ];
    const r = await attachReady(
      h,
      peer,
      target('/workspaces/app/a.ts', mounts),
    );
    // The fake registers its watcher after `initialized`.
    await new Promise((res) => setTimeout(res, 300));
    await Deno.writeTextFile(`${dir}/changed.ts`, 'export {}\n');
    await Deno.writeTextFile(`${dir}/notes.md`, 'not watched\n');
    const deadline = Date.now() + 10_000;
    let watched: Msg[] = [];
    for (
      let id = 100;
      !watched.some((c) => c.uri === 'file:///workspaces/app/changed.ts');
      id++
    ) {
      if (Date.now() > deadline) throw new Error('no didChangeWatchedFiles');
      await new Promise((res) => setTimeout(res, 100));
      watched =
        ((await request(h, peer, r.session, id, 'fake/state')).result as Msg)
          .watched as Msg[];
    }
    assert(!watched.some((c) => String(c.uri).endsWith('notes.md')));
    await h.manager.shutdown();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a root no mount covers is not watched, and says so', async () => {
  const h = harness();
  const peer = new FakePeer();
  await attachReady(h, peer);
  await until(
    () =>
      peer.status.find((s) =>
        s.detail === 'file changes outside the editor are not seen'
      ),
    'the notice',
  );
  await h.manager.shutdown();
});

Deno.test('describe: refusals and failures', async () => {
  const fails = async (
    out: LauncherOutput | 'throw',
    code: string,
    message?: string,
  ) => {
    const h = harness({
      run: () => {
        if (out === 'throw') {
          throw new DOMException('Signal timed out.', 'TimeoutError');
        }
        return out;
      },
    });
    const e = await assertRejects(
      () => h.manager.attach(new FakePeer(), target()),
      LspError,
    );
    assertEquals(e.code, code);
    if (message !== undefined) assertEquals(e.message, message);
    assertEquals(h.spawns, []);
  };
  await fails(
    'throw',
    'describe_failed',
    'TypeScript language server: describe timed out after 15 s',
  );
  await fails(
    { code: 1, stdout: '', stderr: '' },
    'describe_failed',
    'TypeScript language server: exit code 1',
  );
  await fails(
    { code: 2, stdout: '', stderr: '\n  bad --options: not JSON\nmore\n' },
    'describe_failed',
    'TypeScript language server: bad --options: not JSON',
  );
  await fails({
    code: 127,
    stdout: '',
    stderr: 'bash: devc-lsp-typescript: command not found',
  }, 'no_language_server');
  await fails(
    { code: 3, stdout: '', stderr: 'not a Deno project' },
    'unsupported',
  );
  await fails({ code: 0, stdout: 'hello', stderr: '' }, 'describe_failed');
  await fails({
    code: 0,
    stdout: describeJson('/w', { protocol: 2 }),
    stderr: '',
  }, 'describe_failed');
  // No language for the name: unsupported without running describe.
  const h = harness();
  const e = await assertRejects(
    () => h.manager.attach(new FakePeer(), target('/workspaces/app/README.md')),
    LspError,
  );
  assertEquals(e.code, 'unsupported');
  assertEquals(h.runs, []);
});

Deno.test('lsp_settings_get: options exiting 1, printing non-JSON, or protocol 2 are describe_failed', async () => {
  const optionsOut = (out: LauncherOutput) => (args: string[]) =>
    args[0] === 'options'
      ? out
      : { code: 0, stdout: describeJson('/workspaces/app'), stderr: '' };
  for (
    const [out, message] of [
      [
        { code: 1, stdout: '', stderr: 'boom' },
        'TypeScript language server: boom',
      ],
      [
        { code: 1, stdout: '', stderr: '' },
        'TypeScript language server: exit code 1',
      ],
      [
        { code: 0, stdout: 'not json', stderr: '' },
        'TypeScript language server: options printed no JSON object',
      ],
      [
        {
          code: 0,
          stdout: JSON.stringify({ protocol: 2, options: [] }),
          stderr: '',
        },
        'TypeScript language server: options speaks protocol 2, not 1',
      ],
    ] as [LauncherOutput, string][]
  ) {
    const h = harness({ run: optionsOut(out) });
    const e = await assertRejects(
      () => h.manager.settingsGet(target()),
      LspError,
    );
    assertEquals(e.code, 'describe_failed');
    assertEquals(e.message, message);
  }
  const h127 = harness({
    run: optionsOut({ code: 127, stdout: '', stderr: '' }),
  });
  assertEquals(
    (await assertRejects(() => h127.manager.settingsGet(target()), LspError))
      .code,
    'no_language_server',
  );
  // A container file: detected values, not editable.
  const schema = {
    protocol: 1,
    options: [{ key: 'settings', type: 'json', default: {} }],
  };
  const ok = harness({
    run: (args) =>
      args[0] === 'options'
        ? { code: 0, stdout: JSON.stringify(schema), stderr: '' }
        : { code: 0, stdout: describeJson('/workspaces/app'), stderr: '' },
  });
  assertEquals(await ok.manager.settingsGet(target()), {
    language: 'typescript',
    checkoutRoot: null,
    path: null,
    detected: { root: '/workspaces/app', server: 'fake 1' },
    entry: null,
    schema,
    editable: false,
  });
});

Deno.test('settings: an entry adds --root and --options; saving it restarts the session (settings changed)', async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    const repo = `${dir}/app`;
    await Deno.mkdir(`${repo}/devc/web`, { recursive: true });
    await Deno.writeTextFile(`${repo}/devc/web/server.ts`, '');
    await new Deno.Command('git', { args: ['init', '-q'], cwd: repo }).output();
    let manager: LspManager | null = null;
    const config = new LspConfigStore({
      configDir: `${dir}/config`,
      onChange: (p) => void manager?.settingsChanged(p),
      warn: () => {},
    });
    const h = harness({
      config,
      run: (args) => {
        if (args[0] === 'options') {
          return {
            code: 0,
            stdout: JSON.stringify({ protocol: 1, options: [] }),
            stderr: '',
          };
        }
        const i = args.indexOf('--root');
        return {
          code: 0,
          stdout: describeJson(i === -1 ? '/workspaces/app' : args[i + 1]),
          stderr: '',
        };
      },
    });
    manager = h.manager;
    const t: LspTarget = {
      info: INFO,
      mounts: [
        {
          type: 'bind',
          source: repo,
          destination: '/workspaces/app',
        } as ContainerMount,
      ],
      path: '/workspaces/app/devc/web/server.ts',
      repo: { folder: repo, hostPath: `${repo}/devc/web/server.ts` },
    };
    const peer = new FakePeer();
    const first = await attachReady(h, peer, t);
    assertEquals(h.runs.at(-1), [
      'describe',
      '/workspaces/app/devc/web/server.ts',
    ]);
    const got = await h.manager.settingsGet(t);
    assertEquals(got.checkoutRoot, '/workspaces/app');
    assertEquals(got.path, 'devc/web/server.ts');
    assertEquals(got.editable, true);
    assertEquals(got.entry, null);
    // A root that doesn't contain the file is refused.
    assertEquals(
      (await assertRejects(
        () => h.manager.settingsSet(t, { root: 'docs', options: {} }),
        LspError,
      )).code,
      'bad_request',
    );
    await h.manager.settingsSet(t, {
      root: 'devc',
      options: { settings: { x: 1 } },
    });
    await until(
      () =>
        peer.status.find((s) =>
          s.session === first.session && s.detail === 'settings changed'
        ),
      'settings changed',
    );
    const second = await h.manager.attach(peer, t);
    assert(second.session !== first.session);
    const flags = h.runs.at(-1)!;
    assertEquals(flags.slice(0, 4), [
      'describe',
      '/workspaces/app/devc/web/server.ts',
      '--root',
      '/workspaces/app/devc',
    ]);
    assertEquals(flags[4], '--options');
    assertEquals(h.spawns.at(-1)?.slice(0, 3), [
      'serve',
      '--root',
      '/workspaces/app/devc',
    ]);
    assertEquals(h.spawns.at(-1)?.[3], '--options');
    assertEquals((await h.manager.settingsGet(t)).entry, {
      root: 'devc',
      options: { settings: { x: 1 } },
    });
    // Reset to detected: removed, and restarted again.
    await h.manager.settingsSet(t, null);
    await until(
      () =>
        peer.status.find((s) =>
          s.session === second.session && s.detail === 'settings changed'
        ),
      'settings changed again',
    );
    assertEquals((await h.manager.settingsGet(t)).entry, null);
    await h.manager.shutdown();
    config.stop();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
