// Pure checks only: the `test` task has no --allow-net, so nothing here opens a socket.
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert';
import {
  authorize,
  hostAllowed,
  mintToken,
  originAllowed,
  staticPathAllowed,
  tokenMatches,
} from '../web/server.ts';
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
    method: 'pane.split',
    params: { target_pane_id: 'w1:p1', direction: 'right' },
  }));
  assert(ok.ok);
});

Deno.test('parseWebArgs defaults, flags and errors', () => {
  assertEquals(parseWebArgs([]), {
    port: 48228,
    session: DEVC_HERDR_SESSION,
    newToken: false,
  });
  assertEquals(parseWebArgs(['--port', '9000', '--session', 'work']), {
    port: 9000,
    session: 'work',
    newToken: false,
  });
  assertEquals(parseWebArgs(['--port=9001']).port, 9001);
  assertThrows(() => parseWebArgs(['--port']));
  assertThrows(() => parseWebArgs(['--port', '0']));
  assertThrows(() => parseWebArgs(['--port', '70000']));
  assertThrows(() => parseWebArgs(['--port', '12ab']));
  assertThrows(() => parseWebArgs(['--bogus']));
  assertThrows(() => parseWebArgs(['path']));
});

Deno.test('parseWebArgs: --source in both forms and the bare --new-token', () => {
  assertEquals(parseWebArgs(['--source', '../co/devc']).source, '../co/devc');
  assertEquals(parseWebArgs(['--source=/co/devc']).source, '/co/devc');
  assertEquals(parseWebArgs([]).source, undefined);
  assertThrows(() => parseWebArgs(['--source']));
  assertThrows(() => parseWebArgs(['--source=']));
  assertEquals(parseWebArgs(['--new-token']).newToken, true);
  assertThrows(() => parseWebArgs(['--new-token=x']), Error, 'takes no value');
  assertThrows(() => parseWebArgs(['--new-token', '--bogus']));
  assertEquals(
    parseWebArgs(['--new-token', '--source', 'd', '--port', '9']),
    { port: 9, session: DEVC_HERDR_SESSION, source: 'd', newToken: true },
  );
});
