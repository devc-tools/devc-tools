// Pure checks only: the `test` task has no --allow-net, so nothing here opens a socket.
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  activeFolder,
  authorize,
  configEventMatches,
  hostAllowed,
  mintToken,
  originAllowed,
  staticPathAllowed,
  tokenMatches,
} from '../web/server.ts';
import { GLOBAL_CONFIG_PATHS } from '@devc-tools/core/config.ts';
import { parseClientMessage } from '../web/protocol.ts';
import { DEVC_HERDR_SESSION, parseWebArgs } from '../args.ts';

const PORT = 48228;
const TOKEN = 'a'.repeat(64);

function check(
  path: string,
  headers: Record<string, string>,
): 401 | 403 | null {
  return authorize(
    new Headers(headers),
    new URL(`http://127.0.0.1:${PORT}${path}`),
    PORT,
    TOKEN,
  );
}

const wsHeaders = (origin?: string) => ({
  host: `127.0.0.1:${PORT}`,
  upgrade: 'websocket',
  ...(origin !== undefined ? { origin } : {}),
});

Deno.test('hostAllowed accepts 127.0.0.1, localhost and host.docker.internal on our port only', () => {
  assert(hostAllowed(`127.0.0.1:${PORT}`, PORT));
  assert(hostAllowed(`localhost:${PORT}`, PORT));
  assert(hostAllowed(`host.docker.internal:${PORT}`, PORT));
  assert(!hostAllowed(`127.0.0.1:${PORT + 1}`, PORT));
  assert(!hostAllowed(`host.docker.internal:${PORT + 1}`, PORT));
  assert(!hostAllowed(`gateway.docker.internal:${PORT}`, PORT));
  assert(!hostAllowed(`evil.test:${PORT}`, PORT));
  assert(!hostAllowed('127.0.0.1', PORT));
  assert(!hostAllowed(null, PORT));
});

Deno.test('originAllowed accepts this page under any of its names, or no Origin', () => {
  assert(originAllowed(`http://127.0.0.1:${PORT}`, PORT));
  assert(originAllowed(`http://localhost:${PORT}`, PORT));
  assert(originAllowed(`http://host.docker.internal:${PORT}`, PORT));
  assert(originAllowed(null, PORT));
  assert(!originAllowed(`https://example.com`, PORT));
  assert(!originAllowed(`http://localhost:${PORT + 1}`, PORT));
  assert(!originAllowed('null', PORT));
  assert(!originAllowed('', PORT));
});

Deno.test('authorize: static requests need only a good Host', () => {
  assertEquals(check('/', { host: `127.0.0.1:${PORT}` }), null);
  assertEquals(check('/app.js', { host: `localhost:${PORT}` }), null);
  assertEquals(check('/', { host: `host.docker.internal:${PORT}` }), null);
  assertEquals(check('/', { host: `evil.test:${PORT}` }), 403);
  assertEquals(check('/', { host: `127.0.0.1:1234` }), 403);
  assertEquals(check('/', {}), 403);
});

Deno.test('authorize: /ws needs Host, an allowed or absent Origin, and the token', () => {
  const ok = `/ws?token=${TOKEN}`;
  assertEquals(check(ok, wsHeaders(`http://127.0.0.1:${PORT}`)), null);
  assertEquals(check(ok, wsHeaders(`http://localhost:${PORT}`)), null);
  // A client in a container on Docker Desktop: no browser, so no Origin.
  assertEquals(
    check(ok, { ...wsHeaders(), host: `host.docker.internal:${PORT}` }),
    null,
  );
  assertEquals(check(ok, wsHeaders()), null);
  assertEquals(check('/ws', wsHeaders()), 401);
  assertEquals(check(ok, wsHeaders('https://example.com')), 403);
  assertEquals(
    check(ok, {
      ...wsHeaders(`http://127.0.0.1:${PORT}`),
      host: `evil.test:${PORT}`,
    }),
    403,
  );
  assertEquals(check('/ws', wsHeaders(`http://127.0.0.1:${PORT}`)), 401);
  assertEquals(
    check(`/ws?token=${'b'.repeat(64)}`, wsHeaders(`http://127.0.0.1:${PORT}`)),
    401,
  );
});

Deno.test('tokenMatches and mintToken', () => {
  const t = mintToken();
  assert(/^[0-9a-f]{64}$/.test(t));
  assert(tokenMatches(t, t));
  assert(!tokenMatches(t.slice(1), t));
  assert(!tokenMatches(null, t));
  assert(mintToken() !== t);
});

Deno.test('staticPathAllowed refuses traversal and hidden files', () => {
  assert(staticPathAllowed('/index.html'));
  assert(staticPathAllowed('/vendor/xterm/xterm.mjs'));
  assert(!staticPathAllowed('/../server.ts'));
  assert(!staticPathAllowed('/vendor/../../server.ts'));
  assert(!staticPathAllowed('/.hidden'));
  assert(!staticPathAllowed('/a//b.js'));
  assert(!staticPathAllowed('/%2e%2e/server.ts'));
});

function rejected(raw: unknown) {
  const r = parseClientMessage(
    typeof raw === 'string' ? raw : JSON.stringify(raw),
  );
  assert(!r.ok, `expected a rejection for ${JSON.stringify(raw)}`);
  return r.rejection;
}

Deno.test('parseClientMessage rejects an unknown type as bad_request', () => {
  assertEquals(rejected({ type: 'explode', id: 'x1' }).code, 'bad_request');
  assertEquals(rejected({ type: 'explode', id: 'x1' }).id, 'x1');
  assertEquals(rejected({ type: 'explode' }).id, undefined);
  assertEquals(rejected('not json').code, 'bad_request');
  assertEquals(rejected('[1]').code, 'bad_request');
});

Deno.test('parseClientMessage rejects missing and bad fields', () => {
  const open = {
    type: 'open',
    id: 'o1',
    container: 'c',
    pane_id: 'w1:p1',
    cols: 80,
    rows: 24,
  };
  assert(parseClientMessage(JSON.stringify(open)).ok);
  for (const field of ['container', 'pane_id', 'cols', 'rows']) {
    const { [field]: _, ...rest } = open as Record<string, unknown>;
    const r = rejected(rest);
    assertEquals(r.code, 'bad_request', field);
    assertEquals(r.id, 'o1');
  }
  assertEquals(rejected({ ...open, cols: 0 }).code, 'bad_request');
  assertEquals(rejected({ ...open, rows: 1.5 }).code, 'bad_request');
  assertEquals(
    rejected({
      type: 'scroll',
      container: 'c',
      pane_id: 'p',
      direction: 'left',
      lines: 1,
    }).code,
    'bad_request',
  );
  assertEquals(
    rejected({
      type: 'mouse',
      container: 'c',
      pane_id: 'p',
      action: 'down',
      column: 0,
      row: 0,
    }).code,
    'bad_request',
  );
  assert(
    parseClientMessage(JSON.stringify({
      type: 'mouse',
      container: 'c',
      pane_id: 'p',
      action: 'move',
      column: 0,
      row: 0,
    })).ok,
  );
});

Deno.test('parseClientMessage: client_ready needs a non-empty generation', () => {
  assertEquals(
    parseClientMessage(
      JSON.stringify({ type: 'client_ready', generation: '3f9a0c1d2e4b5a69' }),
    ),
    {
      ok: true,
      msg: { type: 'client_ready', generation: '3f9a0c1d2e4b5a69' },
    },
  );
  assertEquals(rejected({ type: 'client_ready' }).code, 'bad_request');
  assertEquals(
    rejected({ type: 'client_ready', generation: '' }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'client_ready', generation: 7 }).code,
    'bad_request',
  );
});

Deno.test('parseClientMessage refuses a request method outside the allowlist', () => {
  const r = rejected({
    type: 'request',
    id: 'r1',
    container: 'c',
    method: 'session.stop',
    params: {},
  });
  assertEquals(r, {
    id: 'r1',
    code: 'method_not_allowed',
    message: "method 'session.stop' is not allowed",
  });
  const ok = parseClientMessage(JSON.stringify({
    type: 'request',
    id: 'r2',
    container: 'c',
    method: 'pane.rename',
    params: { pane_id: 'w1:p1', label: 'logs' },
  }));
  assert(ok.ok);
  // The browser owns all layout: it never splits a Herdr pane or touches Herdr tabs.
  for (
    const method of ['pane.split', 'tab.create', 'tab.rename', 'tab.close']
  ) {
    assertEquals(
      rejected({
        type: 'request',
        id: 'r3',
        container: 'c',
        method,
        params: {},
      })
        .code,
      'method_not_allowed',
    );
  }
});

Deno.test('parseClientMessage accepts new_shell with optional workspace and cwd', () => {
  const bare = parseClientMessage(
    JSON.stringify({ type: 'new_shell', id: 'n1', container: 'c' }),
  );
  assertEquals(bare, {
    ok: true,
    msg: { type: 'new_shell', id: 'n1', container: 'c' },
  });
  const full = parseClientMessage(JSON.stringify({
    type: 'new_shell',
    id: 'n2',
    container: 'c',
    workspace_id: 'w1',
    cwd: '/workspaces/app',
  }));
  assertEquals(full, {
    ok: true,
    msg: {
      type: 'new_shell',
      id: 'n2',
      container: 'c',
      workspace_id: 'w1',
      cwd: '/workspaces/app',
    },
  });
  assertEquals(
    rejected({ type: 'new_shell', id: 'n3', container: 'c', cwd: 7 }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'new_shell', id: 'n4', container: 'c', workspace_id: '' })
      .code,
    'bad_request',
  );
});

Deno.test('parseWebArgs defaults, flags and errors', () => {
  assertEquals(parseWebArgs([]), {
    port: 48228,
    session: DEVC_HERDR_SESSION,
    live: false,
    liveServer: false,
    open: true,
  });
  assertEquals(parseWebArgs(['--port', '9000', '--session', 'work']), {
    port: 9000,
    session: 'work',
    live: false,
    liveServer: false,
    open: true,
  });
  assertEquals(parseWebArgs(['--port=9001']).port, 9001);
  assertThrows(() => parseWebArgs(['--port']));
  assertThrows(() => parseWebArgs(['--port', '0']));
  assertThrows(() => parseWebArgs(['--port', '70000']));
  assertThrows(() => parseWebArgs(['--port', '12ab']));
  assertThrows(() => parseWebArgs(['--bogus']));
  assertThrows(() => parseWebArgs(['path']));
});

Deno.test('parseWebArgs: --live, and --source in both forms implying it', () => {
  assertEquals(parseWebArgs(['--live']).live, true);
  assertEquals(parseWebArgs(['--live']).source, undefined);
  assertThrows(() => parseWebArgs(['--live=x']), Error, 'takes no value');
  assertEquals(parseWebArgs(['--source', '../co/devc']).source, '../co/devc');
  assertEquals(parseWebArgs(['--source=/co/devc']).source, '/co/devc');
  assertEquals(parseWebArgs(['--source', 'd']).live, true);
  assertEquals(parseWebArgs([]).source, undefined);
  assertThrows(() => parseWebArgs(['--source']));
  assertThrows(() => parseWebArgs(['--source=']));
  assertThrows(() => parseWebArgs(['--new-token']), Error, 'unexpected');
  assertEquals(
    parseWebArgs(['--live', '--source', 'd', '--port', '9']),
    {
      port: 9,
      session: DEVC_HERDR_SESSION,
      live: true,
      liveServer: false,
      open: true,
      source: 'd',
    },
  );
  const server = parseWebArgs(['--live-yolo']);
  assertEquals([server.live, server.liveServer], [true, true]);
  assertEquals(parseWebArgs(['--live']).liveServer, false);
  assertEquals(parseWebArgs(['--no-open']).open, false);
  assertThrows(() => parseWebArgs(['--no-open=x']), Error, 'takes no value');
  assertThrows(
    () => parseWebArgs(['--live-yolo=1']),
    Error,
    'takes no value',
  );
});

Deno.test('parseClientMessage: read_selection takes two viewport cells', () => {
  const msg = {
    type: 'read_selection' as const,
    id: 's1',
    container: 'c',
    pane_id: 'w1:p1',
    anchor: { column: 0, row: 3 },
    cursor: { column: 12, row: 1 },
  };
  assertEquals(parseClientMessage(JSON.stringify(msg)), { ok: true, msg });
  for (const field of ['id', 'container', 'pane_id', 'anchor', 'cursor']) {
    const { [field]: _, ...rest } = msg as Record<string, unknown>;
    assertEquals(rejected(rest).code, 'bad_request', field);
  }
  assertEquals(rejected({ ...msg, anchor: [0, 3] }).code, 'bad_request');
  assertEquals(
    rejected({ ...msg, anchor: { column: -1, row: 0 } }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ ...msg, cursor: { column: 65536, row: 0 } }).code,
    'bad_request',
  );
  assertEquals(rejected({ ...msg, cursor: { column: 1 } }).id, 's1');
});

Deno.test('parseClientMessage: project messages name an absolute folder', () => {
  for (
    const type of [
      'start_project',
      'stop_project',
      'down_project',
      'forget_project',
      'add_project',
    ]
  ) {
    assertEquals(
      parseClientMessage(
        JSON.stringify({ type, id: 'p1', localFolder: '/src/app' }),
      ),
      { ok: true, msg: { type, id: 'p1', localFolder: '/src/app' } } as never,
    );
    assertEquals(
      rejected({ type, id: 'p2', localFolder: 'src/app' }).code,
      'bad_request',
    );
    assertEquals(rejected({ type, id: 'p3' }).code, 'bad_request');
  }
  assertEquals(
    parseClientMessage(JSON.stringify({
      type: 'pin_project',
      id: 'p4',
      localFolder: '/src/app',
      pinned: false,
    })),
    {
      ok: true,
      msg: {
        type: 'pin_project',
        id: 'p4',
        localFolder: '/src/app',
        pinned: false,
      },
    },
  );
  assertEquals(
    rejected({ type: 'pin_project', id: 'p5', localFolder: '/a', pinned: 1 })
      .code,
    'bad_request',
  );
});

Deno.test('parseClientMessage: file messages take a root and a path, empty meaning the root', () => {
  const ok = (msg: Record<string, unknown>) =>
    assertEquals(parseClientMessage(JSON.stringify(msg)), {
      ok: true,
      msg,
    } as never);
  ok({
    type: 'list_dir',
    id: 'f1',
    localFolder: '/src/app',
    root: '/src/app',
    path: '',
  });
  ok({
    type: 'list_dir',
    id: 'f2',
    localFolder: '/src/app',
    root: '/src/lib',
    path: 'src/x',
  });
  for (const type of ['read_file', 'preview_file']) {
    ok({
      type,
      id: 'r1',
      localFolder: '/src/app',
      root: '/src/lib',
      path: 'src/a.ts',
    });
    for (
      const bad of [
        { localFolder: 'rel', root: '/a', path: 'x' },
        { localFolder: '/a', root: 'rel', path: 'x' },
        { localFolder: '/a', root: '/a', path: '' },
        { localFolder: '/a', root: '/a' },
      ]
    ) {
      assertEquals(
        rejected({ type, id: 'r2', ...bad }).code,
        'bad_request',
      );
    }
  }
  ok({ type: 'list_host_dir', id: 'f3', path: '' });
  ok({ type: 'list_host_dir', id: 'f4', path: '/Users/me' });
  ok({ type: 'refresh_containers', id: 'f9' });
  assertEquals(rejected({ type: 'refresh_containers' }).code, 'bad_request');
  ok({
    type: 'open_file',
    id: 'f5',
    container: 'c1',
    root: '/src/lib',
    path: 'src/a.ts',
  });
  assertEquals(
    rejected({
      type: 'list_dir',
      id: 'f6',
      localFolder: 'rel',
      root: '/a',
      path: '',
    }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'list_dir', id: 'f7', localFolder: '/a', root: '/a' })
      .code,
    'bad_request',
  );
  for (const root of [undefined, 'rel']) {
    assertEquals(
      rejected({
        type: 'list_dir',
        id: 'f10',
        localFolder: '/a',
        root,
        path: '',
      })
        .code,
      'bad_request',
    );
    assertEquals(
      rejected({
        type: 'open_file',
        id: 'f11',
        container: 'c1',
        root,
        path: 'x',
      })
        .code,
      'bad_request',
    );
  }
  // Without a root, the path is a container path (the Files node).
  ok({ type: 'open_file', id: 'f12', container: 'c1', path: '/etc/hosts' });
  assertEquals(
    rejected({
      type: 'open_file',
      id: 'f13',
      container: 'c1',
      path: '/etc/../root/x',
    }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'list_host_dir', id: 'f8', path: 3 }).code,
    'bad_request',
  );
  assertEquals(
    rejected({
      type: 'open_file',
      id: 'f9',
      container: 'c1',
      root: '/a',
      path: '',
    }).code,
    'bad_request',
  );
});

Deno.test('parseClientMessage: locate_file takes an absolute container path without ..', () => {
  const msg = {
    type: 'locate_file',
    id: 'l1',
    container: 'c1',
    path: '/workspaces/app/src/a.ts',
  };
  assertEquals(
    parseClientMessage(JSON.stringify(msg)),
    { ok: true, msg } as never,
  );
  for (
    const path of [undefined, '', 'src/a.ts', '/workspaces/app/../etc/passwd']
  ) {
    assertEquals(
      rejected({ type: 'locate_file', id: 'l2', container: 'c1', path }).code,
      'bad_request',
    );
  }
});

Deno.test('parseClientMessage: open_in_code takes a repo path or a container path', () => {
  const repo = {
    type: 'open_in_code',
    id: 'o1',
    localFolder: '/a',
    root: '/a',
    path: '',
  };
  assertEquals(
    parseClientMessage(JSON.stringify(repo)),
    { ok: true, msg: repo } as never,
  );
  const inContainer = {
    type: 'open_in_code',
    id: 'o2',
    container: 'c1',
    path: '/workspaces/app/src',
  };
  assertEquals(
    parseClientMessage(JSON.stringify(inContainer)),
    { ok: true, msg: inContainer } as never,
  );
  for (
    const bad of [
      { localFolder: '/a', root: 'a', path: '' },
      { localFolder: '/a', root: '/a' },
      { root: '/a', path: '' },
      { container: 'c1', path: 'src' },
      { container: 'c1', path: '/workspaces/app/../etc' },
      { container: '', path: '/workspaces' },
    ]
  ) {
    assertEquals(
      rejected({ type: 'open_in_code', id: 'o3', ...bad }).code,
      'bad_request',
    );
  }
});

Deno.test('parseClientMessage: reveal_path takes a repo path or a container path', () => {
  const repo = {
    type: 'reveal_path',
    id: 'r1',
    localFolder: '/a',
    root: '/a',
    path: 'src/x.ts',
  };
  assertEquals(
    parseClientMessage(JSON.stringify(repo)),
    { ok: true, msg: repo } as never,
  );
  const repoRoot = { ...repo, id: 'r2', path: '' };
  assertEquals(
    parseClientMessage(JSON.stringify(repoRoot)),
    { ok: true, msg: repoRoot } as never,
  );
  const inContainer = {
    type: 'reveal_path',
    id: 'r3',
    container: 'c1',
    path: '/workspaces/app/src',
  };
  assertEquals(
    parseClientMessage(JSON.stringify(inContainer)),
    { ok: true, msg: inContainer } as never,
  );
  for (
    const bad of [
      { localFolder: '/a', root: 'a', path: '' },
      { localFolder: '/a', root: '/a' },
      { root: '/a', path: '' },
      { container: 'c1', path: 'src' },
      { container: 'c1', path: '/workspaces/app/../etc' },
      { container: '', path: '/workspaces' },
    ]
  ) {
    assertEquals(
      rejected({ type: 'reveal_path', id: 'r4', ...bad }).code,
      'bad_request',
    );
  }
});

Deno.test('parseClientMessage: container file messages take an absolute path without .. or NUL', () => {
  for (
    const type of [
      'list_container_dir',
      'read_container_file',
      'preview_container_file',
    ]
  ) {
    for (const path of ['/', '/etc/hosts', '/home/me/.config']) {
      const msg = { type, id: 'f1', container: 'c1', path };
      assertEquals(
        parseClientMessage(JSON.stringify(msg)),
        { ok: true, msg } as never,
      );
    }
    for (
      const path of [undefined, '', 'etc', '/etc/../root', '/etc/\0x']
    ) {
      assertEquals(
        rejected({ type, id: 'f2', container: 'c1', path }).code,
        'bad_request',
      );
    }
    assertEquals(
      rejected({ type, id: 'f3', path: '/' }).code,
      'bad_request',
    );
  }
});

Deno.test('parseClientMessage: create_file takes a kind and a path that ends in a name', () => {
  for (
    const msg of [
      { path: 'src/new.ts', root: '/src/app', kind: 'file' },
      { path: 'new', root: '/src/app', kind: 'dir' },
      { path: '/home/me/notes.md', kind: 'file' },
      { path: '/tmp/x', kind: 'dir' },
      { path: '/.env', kind: 'file' },
    ]
  ) {
    const full = { type: 'create_file', id: 'n1', container: 'c1', ...msg };
    assertEquals(
      parseClientMessage(JSON.stringify(full)),
      { ok: true, msg: full } as never,
    );
  }
  const rooted = { root: '/src/app', kind: 'file' };
  for (
    const bad of [
      // kind
      { ...rooted, path: 'a', kind: 'link' },
      { ...rooted, path: 'a', kind: undefined },
      // the last segment
      { ...rooted, path: '' },
      { ...rooted, path: 'src/' },
      { ...rooted, path: '.' },
      { ...rooted, path: 'src/..' },
      { ...rooted, path: 'a\0b' },
      // with a root: relative, no ..
      { ...rooted, path: '/etc/x' },
      { ...rooted, path: '../x' },
      { ...rooted, path: 'src/../../x' },
      { root: 'relative', kind: 'file', path: 'a' },
      // without: a container path
      { kind: 'file', path: 'etc/x' },
      { kind: 'file', path: '/etc/../x' },
      { kind: 'file', path: '/etc/' },
      { kind: 'dir', path: '/' },
      { kind: 'file', path: '/tmp/a\0b' },
    ]
  ) {
    const r = rejected({
      type: 'create_file',
      id: 'n2',
      container: 'c1',
      ...bad,
    });
    assertEquals([r.id, r.code], ['n2', 'bad_request'], JSON.stringify(bad));
  }
  assertEquals(
    rejected({ type: 'create_file', id: 'n3', path: '/tmp/x', kind: 'file' })
      .code,
    'bad_request',
  );
});

Deno.test('parseClientMessage: rename_file and delete_file take a named entry, rename a new name', () => {
  for (
    const msg of [
      { type: 'rename_file', path: 'src/a.ts', root: '/src/app', to: 'b.ts' },
      { type: 'rename_file', path: '/home/me/x', to: '.hidden' },
      { type: 'delete_file', path: 'src', root: '/src/app' },
      { type: 'delete_file', path: '/tmp/x' },
    ]
  ) {
    const full = { id: 'r1', container: 'c1', ...msg };
    assertEquals(
      parseClientMessage(JSON.stringify(full)),
      { ok: true, msg: full } as never,
    );
  }
  for (
    const bad of [
      // never the root itself, and the same path rules as create_file
      { type: 'delete_file', root: '/src/app', path: '' },
      { type: 'delete_file', path: '/' },
      { type: 'delete_file', root: '/src/app', path: '../x' },
      { type: 'delete_file', path: 'etc/x' },
      { type: 'rename_file', root: '/src/app', path: '', to: 'x' },
      // the new name: one segment
      { type: 'rename_file', root: '/src/app', path: 'a', to: '' },
      { type: 'rename_file', root: '/src/app', path: 'a', to: '..' },
      { type: 'rename_file', root: '/src/app', path: 'a', to: 'sub/b' },
      { type: 'rename_file', root: '/src/app', path: 'a', to: 'a\0b' },
      { type: 'rename_file', root: '/src/app', path: 'a' },
    ]
  ) {
    const r = rejected({ id: 'r2', container: 'c1', ...bad });
    assertEquals([r.id, r.code], ['r2', 'bad_request'], JSON.stringify(bad));
  }
});

Deno.test('parseClientMessage: write_file takes an existing file, its text and an optional base', () => {
  const hash = 'ab'.repeat(32);
  for (
    const msg of [
      { type: 'write_file', root: '/src/app', path: 'src/a.ts', text: 'x\n' },
      { type: 'write_file', path: '/home/me/.bashrc', text: '' },
      {
        type: 'write_file',
        root: '/src/app',
        path: 'a.md',
        text: 'y',
        base: hash,
      },
    ]
  ) {
    const full = { id: 'w1', container: 'c1', ...msg };
    assertEquals(
      parseClientMessage(JSON.stringify(full)),
      { ok: true, msg: full } as never,
    );
  }
  for (
    const bad of [
      { type: 'write_file', root: '/src/app', path: 'a.md' },
      { type: 'write_file', root: '/src/app', path: 'a.md', text: 1 },
      { type: 'write_file', root: '/src/app', path: '', text: 'x' },
      { type: 'write_file', root: '/src/app', path: '../a', text: 'x' },
      { type: 'write_file', path: 'etc/x', text: 'x' },
      { type: 'write_file', path: '/tmp/x', text: 'x', base: 'abc' },
      { type: 'write_file', path: '/tmp/x', text: 'x', base: 'AB'.repeat(32) },
      { type: 'write_file', path: '/tmp/x', text: 'x', base: 7 },
    ]
  ) {
    const r = rejected({ id: 'w2', container: 'c1', ...bad });
    assertEquals([r.id, r.code], ['w2', 'bad_request'], JSON.stringify(bad));
  }
});

Deno.test('parseClientMessage: open_tab needs root, a path (may be empty) and reuse', () => {
  const base = {
    type: 'open_tab' as const,
    id: 't1',
    container: 'c1',
    root: '/src/app',
    path: '',
    reuse: true,
  };
  assertEquals(parseClientMessage(JSON.stringify(base)), {
    ok: true,
    msg: base,
  });
  assertEquals(
    parseClientMessage(JSON.stringify({ ...base, path: 'lib', reuse: false })),
    { ok: true, msg: { ...base, path: 'lib', reuse: false } },
  );
  for (
    const bad of [
      { reuse: undefined },
      { reuse: 'yes' },
      { root: 'rel' },
      { root: undefined },
      { path: undefined },
      { container: '' },
      { id: undefined },
    ]
  ) {
    const r = parseClientMessage(JSON.stringify({ ...base, ...bad }));
    assert(!r.ok, JSON.stringify(bad));
    assertEquals(r.rejection.code, 'bad_request');
  }
});

Deno.test('parseClientMessage: pin_file takes a project, a repo root and a relative path', () => {
  const base = {
    type: 'pin_file',
    id: 'f1',
    localFolder: '/src/app',
    root: '/src/app',
  };
  for (
    const msg of [
      { ...base, path: '.plans/notes.md' },
      { ...base, path: 'NOTES.md', label: 'Notes' },
    ]
  ) {
    assertEquals(
      parseClientMessage(JSON.stringify(msg)),
      { ok: true, msg } as never,
    );
  }
  // An empty label is no label.
  assertEquals(
    parseClientMessage(JSON.stringify({ ...base, path: 'a', label: '' })),
    { ok: true, msg: { ...base, path: 'a' } } as never,
  );
  for (
    const bad of [
      { ...base, path: '' },
      { ...base, path: '/etc/passwd' },
      { ...base, path: '../x' },
      { ...base, path: 'a/../../x' },
      { ...base, path: 'a\0b' },
      { ...base, path: 'a', label: 3 },
      { ...base, path: 'a', root: 'relative' },
      { ...base, path: 'a', localFolder: 'relative' },
      { ...base, path: 'a', root: undefined },
    ]
  ) {
    const r = rejected(bad);
    assertEquals([r.id, r.code], ['f1', 'bad_request'], JSON.stringify(bad));
  }
});

Deno.test('parseClientMessage: unpin_file, rename_pin and open_pinned name a pin', () => {
  for (
    const msg of [
      { type: 'unpin_file', id: 'f1', pin: 'p1' },
      { type: 'open_pinned', id: 'f1', pin: 'p1' },
      { type: 'rename_pin', id: 'f1', pin: 'p1', label: 'Notes' },
      { type: 'rename_pin', id: 'f1', pin: 'p1', label: '' },
    ]
  ) {
    assertEquals(
      parseClientMessage(JSON.stringify(msg)),
      { ok: true, msg } as never,
    );
  }
  for (
    const bad of [
      { type: 'unpin_file', id: 'f1' },
      { type: 'open_pinned', id: 'f1', pin: '' },
      { type: 'rename_pin', id: 'f1', pin: 'p1' },
      { type: 'rename_pin', id: 'f1', pin: 'p1', label: null },
    ]
  ) {
    const r = rejected(bad);
    assertEquals([r.id, r.code], ['f1', 'bad_request'], JSON.stringify(bad));
  }
});

Deno.test('authorize: /desktop/ needs Bearer <token> and no Origin', () => {
  const host = `127.0.0.1:${PORT}`;
  const path = '/desktop/active-folder';
  const bearer = `Bearer ${TOKEN}`;
  assertEquals(check(path, { host, authorization: bearer }), null);
  for (
    const origin of [`http://127.0.0.1:${PORT}`, 'https://evil.test', 'null']
  ) {
    assertEquals(check(path, { host, authorization: bearer, origin }), 403);
  }
  assertEquals(check(path, { host }), 401);
  assertEquals(
    check(path, { host, authorization: `Bearer ${'b'.repeat(64)}` }),
    401,
  );
  assertEquals(check(path, { host, authorization: TOKEN }), 401);
  assertEquals(check(`${path}?token=${TOKEN}`, { host }), 401);
  assertEquals(
    check(path, { host: `evil.test:${PORT}`, authorization: bearer }),
    403,
  );
  // Other routes are unchanged: a Bearer header does not open /ws, and static needs none.
  assertEquals(check('/ws', { ...wsHeaders(), authorization: bearer }), 401);
  assertEquals(check('/desktop', { host }), null);
});

Deno.test('parseClientMessage: active_pane names a pane or none', () => {
  const ok = (m: unknown) => {
    const r = parseClientMessage(JSON.stringify(m));
    assert(r.ok, JSON.stringify(m));
    return r.msg;
  };
  assertEquals(ok({ type: 'active_pane' }), { type: 'active_pane' });
  assertEquals(ok({ type: 'active_pane', container: 'c', pane_id: 'w1:p1' }), {
    type: 'active_pane',
    container: 'c',
    pane_id: 'w1:p1',
  });
  assertEquals(
    rejected({ type: 'active_pane', container: 'c' }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'active_pane', pane_id: 'p' }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'active_pane', container: '', pane_id: 'p' }).code,
    'bad_request',
  );
  assertEquals(
    rejected({ type: 'active_pane', container: 'c'.repeat(257), pane_id: 'p' })
      .code,
    'bad_request',
  );
  assert(
    parseClientMessage(
      JSON.stringify({
        type: 'active_pane',
        container: 'c'.repeat(256),
        pane_id: 'p',
      }),
    ).ok,
  );
});

Deno.test("activeFolder maps the active pane's cwd through the bind mounts", () => {
  const mounts = [
    {
      type: 'bind' as const,
      source: '/h/foo',
      destination: '/workspaces/foo',
      rw: true,
    },
    {
      type: 'volume' as const,
      source: '/var/lib/docker/v',
      destination: '/data',
      rw: true,
    },
  ];
  const snapshot = (panes: unknown) => ({ panes });
  const active = { container: 'c1', pane_id: 'w1:p1' };
  const found = (cwd: unknown, extra: Record<string, unknown> = {}) => ({
    snapshot: snapshot([{ pane_id: 'w1:p1', cwd, ...extra }, {
      pane_id: 'w1:p2',
      cwd: '/x',
    }]),
    mounts,
    localFolder: '',
  });
  assertEquals(activeFolder(null, found('/workspaces/foo')), {
    ok: false,
    reason: 'no_active_pane',
  });
  assertEquals(activeFolder(active, null), { ok: false, reason: 'no_session' });
  assertEquals(
    activeFolder({ ...active, pane_id: 'w9:p9' }, found('/workspaces/foo')),
    { ok: false, reason: 'no_cwd' },
  );
  assertEquals(activeFolder(active, found(undefined)), {
    ok: false,
    reason: 'no_cwd',
  });
  assertEquals(activeFolder(active, found('')), {
    ok: false,
    reason: 'no_cwd',
  });
  assertEquals(activeFolder(active, found('rel/dir')), {
    ok: false,
    reason: 'no_cwd',
  });
  assertEquals(
    activeFolder(active, { snapshot: null, mounts, localFolder: '' }),
    {
      ok: false,
      reason: 'no_cwd',
    },
  );
  assertEquals(activeFolder(active, found('/tmp')), {
    ok: false,
    reason: 'not_mounted',
  });
  // A volume is not a host folder.
  assertEquals(activeFolder(active, found('/data/x')), {
    ok: false,
    reason: 'not_mounted',
  });
  // The shell's own cwd, never a child's.
  assertEquals(
    activeFolder(
      active,
      found('/workspaces/foo/sub', { foreground_cwd: '/tmp' }),
    ),
    {
      ok: true,
      folder: '/h/foo/sub',
      mount: '/h/foo',
      container: 'c1',
      containerFolder: '/workspaces/foo/sub',
    },
  );
  // `panes` as an object of panes, as Herdr may send it.
  assertEquals(
    activeFolder(active, {
      snapshot: snapshot({ a: { pane_id: 'w1:p1', cwd: '/workspaces/foo' } }),
      mounts,
      localFolder: '',
    }),
    {
      ok: true,
      folder: '/h/foo',
      mount: '/h/foo',
      container: 'c1',
      containerFolder: '/workspaces/foo',
    },
  );
});

Deno.test("activeFolder names the container's own folder as primary when a mount covers it", () => {
  const mounts = [
    {
      type: 'bind' as const,
      source: '/h/wksp',
      destination: '/workspaces/wksp',
      rw: true,
    },
    {
      type: 'bind' as const,
      source: '/h/foo',
      destination: '/workspaces/foo',
      rw: true,
    },
  ];
  const active = { container: 'c1', pane_id: 'p' };
  const at = (cwd: string, localFolder = '/h/wksp') => ({
    snapshot: { panes: [{ pane_id: 'p', cwd }] },
    mounts,
    localFolder,
  });
  const primary = { folder: '/h/wksp', mount: '/h/wksp' };
  assertEquals(activeFolder(active, at('/workspaces/foo/sub')), {
    ok: true,
    folder: '/h/foo/sub',
    mount: '/h/foo',
    container: 'c1',
    containerFolder: '/workspaces/foo/sub',
    primary,
  });
  // The pane's folder is unknown or unmounted: the primary repo still comes back.
  assertEquals(activeFolder(active, at('/tmp')), {
    ok: false,
    reason: 'not_mounted',
    primary,
  });
  assertEquals(activeFolder({ ...active, pane_id: 'x' }, at('/tmp')), {
    ok: false,
    reason: 'no_cwd',
    primary,
  });
  // No mount covers the container's folder, or it has none: no primary.
  assertEquals(activeFolder(active, at('/tmp', '/h/other')), {
    ok: false,
    reason: 'not_mounted',
  });
  assertEquals(activeFolder(active, at('/tmp', '')), {
    ok: false,
    reason: 'not_mounted',
  });
  // Without an active pane or a session there is no container to name.
  assertEquals(activeFolder(null, at('/tmp')), {
    ok: false,
    reason: 'no_active_pane',
  });
  assertEquals(activeFolder(active, null), { ok: false, reason: 'no_session' });
});

Deno.test('parseClientMessage: the pr_* messages take a project, a repo root and their fields', () => {
  const base = { id: 'p1', localFolder: '/src/app', root: '/src/app' };
  const ok = (m: Record<string, unknown>) => {
    const r = parseClientMessage(JSON.stringify(m));
    assert(r.ok, JSON.stringify(m));
    return r.msg;
  };
  assertEquals(ok({ type: 'pr_files', ...base }), {
    type: 'pr_files',
    ...base,
  });
  for (const type of ['pr_diff', 'pr_threads']) {
    assertEquals(ok({ type, ...base, path: 'src/a.ts' }), {
      type,
      ...base,
      path: 'src/a.ts',
    } as unknown);
  }
  assertEquals(
    ok({ type: 'pr_viewed', ...base, path: 'a', viewed: false }),
    { type: 'pr_viewed', ...base, path: 'a', viewed: false },
  );
  assertEquals(
    ok({ type: 'pr_reply', ...base, path: 'a', thread: 'PRRT_1', body: 'hi' }),
    { type: 'pr_reply', ...base, path: 'a', thread: 'PRRT_1', body: 'hi' },
  );
  assertEquals(
    ok({ type: 'pr_resolve', ...base, path: 'a', thread: 'PRRT_1' }),
    { type: 'pr_resolve', ...base, path: 'a', thread: 'PRRT_1' },
  );
  for (
    const bad of [
      { type: 'pr_files', ...base, root: 'rel' },
      { type: 'pr_files', id: 'p1', root: '/src/app' },
      { type: 'pr_diff', ...base },
      { type: 'pr_threads', ...base, path: '' },
      { type: 'pr_viewed', ...base, path: 'a', viewed: 'yes' },
      { type: 'pr_reply', ...base, path: 'a', thread: 'PRRT_1' },
      { type: 'pr_reply', ...base, path: 'a', thread: 'PRRT_1', body: 3 },
      { type: 'pr_resolve', ...base, path: 'a' },
    ]
  ) {
    const r = rejected(bad);
    assertEquals(r.code, 'bad_request', JSON.stringify(bad));
    assertEquals(r.id, 'p1');
  }
});

Deno.test('parseClientMessage: pr_file_at and the pr_pending_* messages', () => {
  const base = { id: 'p1', localFolder: '/src/app', root: '/src/app' };
  const sha = 'a'.repeat(40);
  const same = (m: Record<string, unknown>) => {
    const r = parseClientMessage(JSON.stringify(m));
    assert(r.ok, JSON.stringify(m));
    assertEquals(r.msg as unknown, m);
  };
  same({ type: 'pr_file_at', ...base, path: 'src/a.ts', sha });
  same({ type: 'pr_pending_show', ...base });
  same({ type: 'pr_pending_discard', ...base });
  const comment = {
    type: 'pr_pending_comment',
    ...base,
    path: 'a',
    line: 4,
    side: 'LEFT',
    startLine: null,
    body: 'x',
  };
  same(comment);
  same({ ...comment, side: 'RIGHT', startLine: 3 });
  same({ type: 'pr_pending_reply', ...base, thread: 'PRRT_1', body: 'x' });
  same({ type: 'pr_pending_edit', ...base, comment: 'PRRC_1', body: 'x' });
  same({ type: 'pr_pending_delete', ...base, comment: 'PRRC_1' });
  same({ type: 'pr_pending_submit', ...base, body: '' });
  for (
    const bad of [
      { type: 'pr_file_at', ...base, path: 'a', sha: 'A'.repeat(40) },
      { type: 'pr_file_at', ...base, path: 'a', sha: 'abc' },
      { type: 'pr_file_at', ...base, sha },
      { type: 'pr_pending_show', id: 'p1', root: '/src/app' },
      { ...comment, line: 0 },
      { ...comment, line: 2.5 },
      { ...comment, side: 'BOTH' },
      { ...comment, startLine: 4 },
      { ...comment, startLine: 0 },
      { ...comment, startLine: undefined },
      { ...comment, body: undefined },
      { ...comment, path: '' },
      { type: 'pr_pending_reply', ...base, body: 'x' },
      { type: 'pr_pending_edit', ...base, comment: '', body: 'x' },
      { type: 'pr_pending_delete', ...base },
      { type: 'pr_pending_submit', ...base },
      { type: 'pr_pending_approve', ...base },
    ]
  ) {
    const r = rejected(bad);
    assertEquals(r.code, 'bad_request', JSON.stringify(bad));
  }
});

Deno.test('configEventMatches: a global-config watch reacts to both names', () => {
  const names = GLOBAL_CONFIG_PATHS.map((p) => p.slice(p.lastIndexOf('/') + 1));
  assertEquals(names, ['config.jsonc', 'config.json']);
  const dir = '/home/u/.config/devc';
  assert(configEventMatches([`${dir}/config.jsonc`], names));
  assert(configEventMatches([`${dir}/config.json`], names));
  assert(configEventMatches([`${dir}/x`, `${dir}/config.json`], names));
  assert(!configEventMatches([`${dir}/projects.json`], names));
  assert(!configEventMatches([`${dir}/config.json.tmp`], names));
  // A one-file watch still matches only its own name.
  assert(!configEventMatches([`${dir}/config.jsonc`], ['config.json']));
});

Deno.test('parseClientMessage: view_join takes a view id and a role', () => {
  assertEquals(
    parseClientMessage(
      JSON.stringify({ type: 'view_join', view: 'v1', role: 'sidebar' }),
    ),
    { ok: true, msg: { type: 'view_join', view: 'v1', role: 'sidebar' } },
  );
  assertEquals(
    parseClientMessage(
      JSON.stringify({ type: 'view_join', view: 'a_B-9', role: 'tiles' }),
    ),
    { ok: true, msg: { type: 'view_join', view: 'a_B-9', role: 'tiles' } },
  );
  for (
    const bad of [
      { type: 'view_join', view: 'v1', role: 'main' },
      { type: 'view_join', view: 'v1' },
      { type: 'view_join', view: '', role: 'tiles' },
      { type: 'view_join', view: 'a b', role: 'tiles' },
      { type: 'view_join', view: 'x'.repeat(65), role: 'tiles' },
      { type: 'view_join', view: 7, role: 'tiles' },
    ]
  ) assertEquals(rejected(bad).code, 'bad_request', JSON.stringify(bad));
});

Deno.test('parseClientMessage: view_state checks the state shape, relays it as is', () => {
  const state = {
    tiles: [{ id: 't1', kind: 'pane', extra: { kept: true } }],
    tree: { kind: 'row', children: [] },
    focused: 't1',
  };
  assertEquals(
    parseClientMessage(
      JSON.stringify({ type: 'view_state', view: 'v', state }),
    ),
    { ok: true, msg: { type: 'view_state', view: 'v', state } },
  );
  assertEquals(
    parseClientMessage(
      JSON.stringify({
        type: 'view_state',
        view: 'v',
        state: { tiles: [], tree: null, focused: null },
      }),
    ).ok,
    true,
  );
  for (
    const bad of [
      { type: 'view_state', view: 'v' },
      { type: 'view_state', view: 'v', state: [] },
      { type: 'view_state', view: 'v', state: { tree: null } },
      { type: 'view_state', view: 'v', state: { tiles: {}, tree: null } },
      { type: 'view_state', view: 'v', state: { tiles: [], tree: [] } },
      { type: 'view_state', view: 'v', state: { tiles: [], tree: 'x' } },
      {
        type: 'view_state',
        view: 'v',
        state: { tiles: new Array(501).fill({}), tree: null },
      },
      { type: 'view_state', view: '../x', state: { tiles: [], tree: null } },
    ]
  ) assertEquals(rejected(bad).code, 'bad_request', JSON.stringify(bad));
  const huge = JSON.stringify({
    type: 'view_state',
    view: 'v',
    state: { tiles: [{ title: 'x'.repeat(300 * 1024) }], tree: null },
  });
  const r = parseClientMessage(huge);
  assertEquals(r.ok, false);
});

Deno.test('parseClientMessage: view_intent and sidebar_intent take a known name and ≤ 4 args', () => {
  assertEquals(
    parseClientMessage(
      JSON.stringify({
        type: 'view_intent',
        view: 'v',
        name: 'openPane',
        args: [{ localFolder: '/w', pane_id: 'p1' }, { where: 'right' }],
      }),
    ),
    {
      ok: true,
      msg: {
        type: 'view_intent',
        view: 'v',
        name: 'openPane',
        args: [{ localFolder: '/w', pane_id: 'p1' }, { where: 'right' }],
      },
    },
  );
  for (
    const name of [
      'openPane',
      'openFile',
      'openDiff',
      'reveal',
      'close',
      'keepOpen',
      'save',
      'reload',
      'setZen',
      'prViewed',
    ]
  ) {
    assert(
      parseClientMessage(
        JSON.stringify({ type: 'view_intent', view: 'v', name, args: [] }),
      ).ok,
      name,
    );
  }
  // openDiff's third argument ({compare: 'viewed'}) relays like the others.
  assertEquals(
    parseClientMessage(JSON.stringify({
      type: 'view_intent',
      view: 'v',
      name: 'openDiff',
      args: [{ localFolder: '/w', root: '/w', path: 'a' }, 'stack', {
        compare: 'viewed',
      }],
    })),
    {
      ok: true,
      msg: {
        type: 'view_intent',
        view: 'v',
        name: 'openDiff',
        args: [{ localFolder: '/w', root: '/w', path: 'a' }, 'stack', {
          compare: 'viewed',
        }],
      },
    },
  );
  for (const name of ['revealInContainers', 'setZen', 'prViewed']) {
    assert(
      parseClientMessage(
        JSON.stringify({ type: 'sidebar_intent', view: 'v', name, args: [] }),
      ).ok,
      name,
    );
  }
  for (
    const bad of [
      { type: 'view_intent', view: 'v', name: 'revealInContainers', args: [] },
      { type: 'view_intent', view: 'v', name: 'state', args: [] },
      { type: 'view_intent', view: 'v', name: 'dragSource', args: [] },
      { type: 'view_intent', view: 'v', name: 'openPane' },
      { type: 'view_intent', view: 'v', name: 'openPane', args: {} },
      { type: 'view_intent', view: 'v', name: 'close', args: [1, 2, 3, 4, 5] },
      { type: 'view_intent', view: 'v v', name: 'close', args: [] },
      { type: 'sidebar_intent', view: 'v', name: 'openPane', args: [] },
      {
        type: 'sidebar_intent',
        view: 'v',
        name: 'setZen',
        args: [1, 2, 3, 4, 5],
      },
      { type: 'sidebar_intent', name: 'setZen', args: ['off'] },
    ]
  ) assertEquals(rejected(bad).code, 'bad_request', JSON.stringify(bad));
});
